/*
 The ENVIRONMENT: stand-ins for everything that lives OUTSIDE your nodes
 (HTTP client, Stripe, a DB driver, error classes...). It is just code: every
 `export` becomes a global in all nodes, like an import or a service you depend on.
 Edit it freely. The engine itself contains no names like "stripe" or "db".
  __rt.call(target, request)sends a request to another node
(target = a node/service name like "payment-service", or null for the next node)
__rt.sleep(ms) waits
 */
export const DEFAULT_ENV_JS = `// ENVIRONMENT: stand-ins for everything outside your nodes' code.
// Every export becomes a global in all nodes (like imports / services you depend on).

export class AuthError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
  }
}

// HTTP client (axios-style): talks to the next node. Throws on 4xx/5xx like axios does.
async function send(method, path, body, opts = {}) {
  const res = await __rt.call(null, { method, path, body, headers: opts.headers });
  if (res.status >= 400) {
    const err = new Error('Request failed with status ' + res.status + (res.data && res.data.error ? ': ' + res.data.error : ''));
    err.response = res;
    throw err;
  }
  return res;
}
export const api = {
  get: (path, opts) => send('GET', path, undefined, opts),
  post: (path, body, opts) => send('POST', path, body, opts),
  put: (path, body, opts) => send('PUT', path, body, opts),
  delete: (path, opts) => send('DELETE', path, undefined, opts),
};

// Proxy a request to another service by name. Returns the response (does not throw on 4xx/5xx).
export const forwardTo = (service, req) =>
  __rt.call(service, { method: req.method, path: req.path, headers: req.headers, body: req.body });

// Payment provider stand-in (async, like the real one)
export const stripe = {
  charge: async ({ amount, currency } = {}) => {
    await __rt.sleep(40);
    return { id: 'ch_' + Math.random().toString(36).slice(2, 10), amount, currency, status: 'succeeded' };
  },
};

// Database driver: sends the next node's SQL its parameters. Throws the real Postgres error on failure.
export const db = {
  query: async (params = []) => {
    const res = await __rt.call(null, { method: 'POST', path: '/query', body: { params } });
    if (res.status >= 400) throw new Error(res.data && res.data.error ? res.data.error : 'database error');
    return res.data;
  },
};
`;

export const DEFAULT_SCHEMA_SQL = `-- Real PostgreSQL (runs in your browser). This runs before every execution.
CREATE TABLE transactions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER        NOT NULL,
  amount     NUMERIC(10, 2) NOT NULL,
  status     TEXT           NOT NULL,
  created_at TIMESTAMPTZ    DEFAULT now()
);
`;