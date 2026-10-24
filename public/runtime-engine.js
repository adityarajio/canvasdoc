
const HOP_WAIT_MS = 1500;
const LAYER_TIMEOUT_MS = 8000;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function hostOf(target) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(String(target));
  return m ? m[1] : String(target);
}

function formatErr(e) {
  if (e && typeof e === 'object') {
    const name = e.name && e.name !== 'Error' ? e.name : 'Error';
    return `${name}: ${e.message ?? String(e)}`;
  }
  return `Error: ${String(e)}`;
}

const wire = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function matchPath(pattern, path, prefix) {
  if (pattern === '/' && prefix) return {};
  const keys = [];
  const src = pattern
    .split('/')
    .map((seg) => (seg.startsWith(':') ? (keys.push(seg.slice(1)), '([^/]+)') : seg === '*' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  const m = new RegExp('^' + src + (prefix ? '(?=/|$)' : '/?$')).exec(path);
  return m ? Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) : null;
}

class App {
  constructor() {
    this._layers = [];
    this.locals = {};
  }
  use(...args) {
    const path = typeof args[0] === 'string' ? args.shift() : '/';
    for (const fn of args.flat()) this._layers.push({ method: null, path, prefix: true, fn });
    return this;
  }
  all(path, ...fns) {
    for (const fn of fns.flat()) this._layers.push({ method: null, path, prefix: false, fn });
    return this;
  }
  listen() { return { close() {} }; }
  set() { return this; }
  enable() { return this; }
  disable() { return this; }
  _match(method, path) {
    const out = [];
    for (const l of this._layers) {
      if (l.method && l.method !== method) continue;
      const params = matchPath(l.path, path, l.prefix);
      if (params) out.push({ fn: l.fn, params });
    }
    return out;
  }
}
for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
  App.prototype[verb] = function (path, ...fns) {
    if (verb === 'get' && fns.length === 0) return undefined; // app.get('setting')
    for (const fn of fns.flat()) this._layers.push({ method: verb.toUpperCase(), path, prefix: false, fn });
    return this;
  };
}

class Res {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = undefined;
    this.finished = false;
    this._cbs = [];
  }
  status(c) { this.statusCode = c; return this; }
  set(k, v) {
    if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) this.headers[a.toLowerCase()] = String(b);
    else this.headers[String(k).toLowerCase()] = String(v);
    return this;
  }
  setHeader(k, v) { return this.set(k, v); }
  header(k, v) { return this.set(k, v); }
  get(k) { return this.headers[String(k).toLowerCase()]; }
  type(t) { return this.set('content-type', t === 'json' ? 'application/json' : t); }
  get headersSent() { return this.finished; }
  onFinish(f) { this._cbs.push(f); }
  _finish(body) {
    if (this.finished) throw new Error('ERR_HTTP_HEADERS_SENT: Cannot set headers after they are sent to the client');
    this.finished = true;
    this.body = body;
    for (const f of this._cbs) f();
    return this;
  }
  json(o) { this.set('content-type', 'application/json'); return this._finish(wire(o)); }
  send(x) {
    if (x !== null && typeof x === 'object') return this.json(x);
    if (!this.headers['content-type']) this.set('content-type', 'text/html; charset=utf-8');
    return this._finish(x);
  }
  end(x) { return this._finish(x); }
  sendStatus(c) { this.statusCode = c; return this.send(String(c)); }
}

function normalizeRequest(init = {}) {
  let path = init.path ?? '/';
  let query = init.query ?? {};
  if (typeof init.url === 'string') path = init.url;
  const q = path.indexOf('?');
  if (q >= 0) {
    query = { ...Object.fromEntries(new URLSearchParams(path.slice(q + 1))), ...query };
    path = path.slice(0, q);
  }
  if (!path.startsWith('/')) path = '/' + path;
  const headers = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
  if (init.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  return { method: String(init.method ?? 'GET').toUpperCase(), path, query, headers, body: wire(init.body) };
}

function makeReq(r) {
  const qs = Object.keys(r.query).length ? '?' + new URLSearchParams(r.query).toString() : '';
  return {
    method: r.method, path: r.path, url: r.path + qs, originalUrl: r.path + qs,
    headers: r.headers, body: r.body, query: r.query, params: {}, ip: '127.0.0.1',
    get(h) { return this.headers[String(h).toLowerCase()]; },
    header(h) { return this.headers[String(h).toLowerCase()]; },
  };
}

function makeResponse(out) {
  const body = out.body;
  const headers = { ...(out.headers ?? {}) };
  Object.defineProperty(headers, 'get', { value: (k) => headers[String(k).toLowerCase()], enumerable: false });
  return {
    status: out.status, ok: out.status >= 200 && out.status < 300, statusText: String(out.status),
    headers, data: body, body,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

export function createEngine({ importModule, loadPglite }) {
  let pg = null;
  const ensureDb = async () => (pg ??= await loadPglite());

  async function run(job) {
    const { nodes, chain, envCode = '', schema = '', hopWaitMs = HOP_WAIT_MS } = job;
    const t0 = performance.now();
    const now = () => Math.round(performance.now() - t0);
    const events = [];
    const hops = [];
    const issues = [];
    const tracked = [];
    const stack = [];
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const ctxs = new Map();
    const saved = new Map();
    let clientResult;
    let finalResponse = null;

    const emit = (e) => events.push({ ms: now(), ...e });
    const current = () => stack[stack.length - 1] ?? null;
    const addIssue = (nodeId, kind, message) => {
      issues.push({ nodeId, kind, message, ms: now() });
      emit({ type: 'issue', nodeId, kind, message });
    };
    const setGlobal = (k, v) => {
      if (!saved.has(k)) saved.set(k, { had: k in globalThis, val: globalThis[k] });
      globalThis[k] = v;
    };
    const restoreGlobals = () => {
      for (const [k, s] of saved) {
        if (s.had) globalThis[k] = s.val;
        else delete globalThis[k];
      }
    };

    /* ---------- Promise tracking: finds a missing `await` on ANY async function the environment provides ---------- */
    const trackPromise = (label, p, owner) => {
      const rec = { label, nodeId: owner, awaited: false, reported: false };
      tracked.push(rec);
      p.catch(() => {}); // an unawaited rejection must not crash the run
      return {
        then(a, b) { rec.awaited = true; return p.then(a, b); },
        catch(b) { rec.awaited = true; return p.catch(b); },
        finally(f) { rec.awaited = true; return p.finally(f); },
        [Symbol.toStringTag]: 'Promise',
      };
    };
    const wrapFn = (label, fn) => (...args) => {
      const owner = current(); // the caller, captured BEFORE the call (the call may push the callee onto the stack)
      const r = fn(...args);
      return r && typeof r.then === 'function' ? trackPromise(label, r, owner) : r;
    };
    const wrapValue = (label, v, depth = 0) => {
      if (typeof v === 'function') return /^class[\s{]/.test(Function.prototype.toString.call(v)) ? v : wrapFn(label, v);
      if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && depth < 3) {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wrapValue(`${label}.${k}`, x, depth + 1)]));
      }
      return v;
    };
    const checkUnawaited = (nodeId) => {
      for (const rec of tracked) {
        if (rec.nodeId === nodeId && !rec.awaited && !rec.reported) {
          rec.reported = true;
          addIssue(nodeId, 'unawaited', `Missing await: ${rec.label}() returned a Promise that was never awaited, so the code received a Promise instead of its result (reading properties from it gives undefined).`);
        }
      }
    };

    /* ---------- virtual network ---------- */
    const resolveTarget = (target, fromId) => {
      const next = () => chain[chain.indexOf(fromId) + 1] ?? null;
      if (!target) return next();
      const host = hostOf(target);
      if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(host) || host.startsWith('/')) return next();
      const s = norm(host);
      const hit =
        nodes.find((n) => n.id !== fromId && (norm(n.label) === s || norm(n.file) === s)) ??
        nodes.find((n) => n.id !== fromId && s.length >= 3 && (norm(n.label).includes(s) || s.includes(norm(n.label))));
      if (!hit) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (no node matches this service name)`), { code: 'ENOTFOUND' });
      return hit.id;
    };

    const rt = {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      call: async (target, init) => {
        const from = current();
        const toId = resolveTarget(target, from);
        if (!toId) throw Object.assign(new Error('connect ECONNREFUSED: this node has no downstream service'), { code: 'ECONNREFUSED' });
        return makeResponse(await dispatch(toId, normalizeRequest(init), from));
      },
    };

    const virtualFetch = wrapFn('fetch', async (url, init = {}) => {
      const href = String(url);
      const isAbs = /^[a-z][a-z0-9+.-]*:\/\//i.test(href);
      const host = isAbs ? hostOf(href) : '';
      let path = href;
      if (isAbs) { try { const u = new URL(href); path = u.pathname + u.search; } catch { path = '/'; } }
      const known = !isAbs || /^(localhost|127\.0\.0\.1)$/i.test(host) || nodes.some((n) => norm(n.label) === norm(host) || norm(n.file) === norm(host));
      if (!known) throw new TypeError(`fetch failed: network access to "${host}" is disabled in the sandbox (only other nodes are reachable)`);
      let body = init.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* keep string */ } }
      const headers = init.headers && typeof init.headers.entries === 'function' ? Object.fromEntries(init.headers.entries()) : init.headers;
      return rt.call(isAbs ? host : null, { method: init.method, path, headers, body });
    });

    /* ---------- running a node ---------- */
    const pickEntry = (node, ctx, role) => {
      const list = (node.fns ?? []).map((f) => ({ ...f, fn: ctx.ns.__fns__?.[f.name] })).filter((f) => typeof f.fn === 'function');
      if (typeof ctx.ns.default === 'function') list.push({ name: 'default', params: [], fn: ctx.ns.default });
      const arity = (f) => Math.max(f.params.length, f.fn.length);
      if (role === 'client') return (list.filter((f) => arity(f) === 0).pop() ?? list[list.length - 1])?.fn;
      return (list.find((f) => /^req/i.test(f.params[0] ?? '')) ?? list.filter((f) => arity(f) >= 2).pop())?.fn;
    };

    const runLayer = (fn, args, res) =>
      new Promise((resolve) => {
        let settled = false;
        const timers = [];
        const done = (v) => { if (!settled) { settled = true; timers.forEach(clearTimeout); resolve(v); } };
        res.onFinish(() => done({ type: 'finished' }));
        timers.push(setTimeout(() => done({ type: 'timeout' }), LAYER_TIMEOUT_MS));
        Promise.resolve()
          .then(() => fn(...args, (arg) => done({ type: 'next', arg })))
          .then(
            () => { if (res.finished) done({ type: 'finished' }); else timers.push(setTimeout(() => done({ type: 'silent' }), hopWaitMs)); },
            (error) => done({ type: 'throw', error })
          );
      });

    const runChain = async (layers, req, res, nodeId) => {
      let error = null;
      for (const layer of layers) {
        if (res.finished) return;
        const isErrHandler = layer.fn.length === 4;
        if (error ? !isErrHandler : isErrHandler) continue;
        if (layer.params) req.params = layer.params;
        const out = await runLayer(layer.fn, isErrHandler ? [error, req, res] : [req, res], res);
        if (out.type === 'finished') return;
        if (out.type === 'next') { if (out.arg && out.arg !== 'route') error = out.arg; else if (isErrHandler) error = null; continue; }
        if (out.type === 'throw') { error = out.error; continue; }
        if (out.type === 'timeout') { addIssue(nodeId, 'timeout', `Handler did not finish within ${LAYER_TIMEOUT_MS / 1000}s (a Promise that never resolves, or an infinite loop?).`); return; }
        if (out.type === 'silent') { addIssue(nodeId, 'no-response', 'Handler finished without sending a response (no res.send / res.json / res.end, and next() was not called). The caller would hang.'); return; }
      }
      if (res.finished) return;
      if (error) {
        addIssue(nodeId, 'thrown', formatErr(error));
        res.status(error.status || error.statusCode || 500);
        res.json({ error: error.message ?? String(error) });
      } else {
        addIssue(nodeId, 'no-response', `Every handler called next() but none responded, so the request falls through (Cannot ${req.method} ${req.path}).`);
        res.status(404);
        res.json({ error: `Cannot ${req.method} ${req.path}` });
      }
    };

    const handleService = async (node, req) => {
      const ctx = ctxs.get(node.id);
      const res = new Res();
      const rq = makeReq(req);
      let layers = ctx.app._match(req.method, req.path);
      if (!layers.length) {
        const fn = pickEntry(node, ctx, 'service');
        if (fn) layers = [{ fn }];
      }
      if (!layers.length) {
        addIssue(node.id, 'no-handler', `No route (app.use / app.${req.method.toLowerCase()}) and no exported handler function matches ${req.method} ${req.path}.`);
        return { status: 404, headers: {}, body: { error: `Cannot ${req.method} ${req.path}` } };
      }
      await runChain(layers, rq, res, node.id);
      checkUnawaited(node.id);
      return res.finished
        ? { status: res.statusCode, headers: res.headers, body: res.body }
        : { status: 504, headers: {}, body: { error: 'No response was sent by this service' } };
    };

    const runSql = async (node, req) => {
      const db = await ensureDb();
      const params = Array.isArray(req.body?.params) ? req.body.params : [];
      try {
        let r;
        if (params.length) r = await db.query(node.code, params);
        else { const all = await db.exec(node.code); r = all[all.length - 1] ?? { rows: [] }; }
        const rows = wire(r.rows ?? []);
        return { status: 200, headers: { 'content-type': 'application/json' }, body: { rows, rowCount: r.affectedRows ?? rows.length } };
      } catch (e) {
        addIssue(node.id, 'sql', `PostgreSQL error${e?.code ? ' ' + e.code : ''}: ${e?.message ?? e}`);
        return { status: 500, headers: {}, body: { error: e?.message ?? String(e), code: e?.code } };
      }
    };

    const dispatch = async (toId, req, fromId) => {
      const node = nodeById.get(toId);
      emit({ type: 'enter', nodeId: toId, from: fromId, method: req.method, path: req.path });
      const start = performance.now();
      stack.push(toId);
      let out;
      try {
        out = node.type === 'database' ? await runSql(node, req) : await handleService(node, req);
      } catch (e) {
        addIssue(toId, 'thrown', formatErr(e));
        out = { status: 500, headers: {}, body: { error: e?.message ?? String(e) } };
      } finally {
        const i = stack.lastIndexOf(toId);
        if (i >= 0) stack.splice(i, 1);
      }
      const ms = Math.round(performance.now() - start);
      emit({ type: 'exit', nodeId: toId, status: out.status, ms });
      hops.push({ from: fromId, to: toId, method: req.method, path: req.path, reqHeaders: req.headers, reqBody: req.body, status: out.status, resHeaders: out.headers, resBody: out.body, ms });
      return out;
    };

    const finish = () => {
      restoreGlobals();
      const nodeStatus = {};
      for (const e of events) if (e.type === 'enter') nodeStatus[e.nodeId] = 'success';
      for (const e of events) if (e.type === 'exit' && e.status >= 400) nodeStatus[e.nodeId] = 'error';
      for (const i of issues) if (i.nodeId) nodeStatus[i.nodeId] = 'error';
      const ok = issues.length === 0 && (finalResponse ? finalResponse.status < 400 : true);
      return { ok, events, hops, issues, nodeStatus, clientResult, response: finalResponse, root: issues[0] ?? null, durationMs: now() };
    };

    /* ---------- 1. database ---------- */
    if (nodes.some((n) => n.type === 'database')) {
      try {
        const db = await ensureDb();
        await db.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
        if (schema.trim()) await db.exec(schema);
      } catch (e) {
        addIssue(null, 'database', `Database setup failed: ${e?.message ?? e}`);
        return finish();
      }
    }

    /* ---------- 2. sandbox globals ---------- */
    const realConsole = globalThis.console;
    const captured = {};
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      captured[level] = (...args) => {
        const text = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
        emit({ type: 'log', nodeId: current(), level, text });
        realConsole?.[level]?.(...args);
      };
    }
    setGlobal('console', captured);
    setGlobal('__rt', rt);
    setGlobal('fetch', virtualFetch);
    setGlobal('XMLHttpRequest', undefined);
    setGlobal('WebSocket', undefined);
    const expressFn = () => globalThis.app;
    expressFn.json = () => (req, res, next) => next();
    expressFn.urlencoded = expressFn.json;
    setGlobal('express', expressFn);

    /* ---------- 3. environment (stand-ins for everything outside the nodes) ---------- */
    try {
      const envNs = await importModule(envCode);
      for (const [k, v] of Object.entries(envNs)) if (k !== 'default') setGlobal(k, wrapValue(k, v));
    } catch (e) {
      addIssue(null, 'environment', `Environment failed to load: ${formatErr(e)}`);
      return finish();
    }

    /* ---------- 4. load every node (last first, so a client can call at top level) ---------- */
    for (const id of [...chain].reverse()) {
      const node = nodeById.get(id);
      if (node.type === 'database') continue;
      const app = new App();
      setGlobal('app', app);
      stack.push(id);
      try {
        const ns = await importModule(node.js);
        ctxs.set(id, { app, ns });
      } catch (e) {
        addIssue(id, 'load', formatErr(e));
        stack.pop();
        return finish();
      }
      stack.pop();
    }

    /* ---------- 5. execute ---------- */
    const first = nodeById.get(chain[0]);
    if (first.type === 'client') {
      emit({ type: 'enter', nodeId: first.id, from: null, method: '', path: '' });
      stack.push(first.id);
      try {
        const fn = pickEntry(first, ctxs.get(first.id), 'client');
        if (fn && hops.length === 0) {
          const r = await fn();
          try { clientResult = wire(r); } catch { clientResult = String(r); }
        }
        checkUnawaited(first.id);
      } catch (e) {
        addIssue(first.id, 'thrown', formatErr(e));
      } finally {
        stack.pop();
      }
      emit({ type: 'exit', nodeId: first.id, status: 200, ms: now() });
      finalResponse = hops.find((h) => h.from === first.id) ?? null;
    } else {
      const req = normalizeRequest(job.request ?? { method: 'POST', path: '/', body: {} });
      const out = await dispatch(first.id, req, null);
      finalResponse = { status: out.status, resBody: out.body };
    }
    if (finalResponse && finalResponse.resBody !== undefined) finalResponse = { status: finalResponse.status, body: finalResponse.resBody ?? finalResponse.body };
    return finish();
  }

  return { run };
}