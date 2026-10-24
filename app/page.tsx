'use client';
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ServiceNode, type ServiceFlowNode, type NodeStatus } from '@/components/ServiceNode';
import { runJob, type RunResult, type NodeJob, type FnInfo } from '@/lib/runtime';
import { DEFAULT_ENV_JS, DEFAULT_SCHEMA_SQL } from '@/lib/defaults';
import { Play, RotateCcw, Sparkles, Terminal, Bug, Cpu, ChevronDown, ChevronUp } from 'lucide-react';

const SIZE = { width: 360, height: 280 };

const initialNodes: ServiceFlowNode[] = [
  {
    id: '1',
    type: 'serviceNode',
    position: { x: 50, y: 150 },
    ...SIZE,
    data: {
      label: 'Client (Next.js App)',
      type: 'client',
      file: 'checkout.ts',
      status: 'idle',
      code: `const checkout = async () => {\n  const res = await api.post('/pay', {\n    user_id: 42,\n    amount: 49.99,\n    currency: 'USD'\n  }, { headers: { authorization: 'Bearer demo-token' } });\n  return res.data;\n};`,
    },
  },
  {
    id: '2',
    type: 'serviceNode',
    position: { x: 480, y: 150 },
    ...SIZE,
    data: {
      label: 'API Gateway',
      type: 'service',
      file: 'gateway.ts',
      status: 'idle',
      code: `app.use('/pay', async (req, res, next) => {\n  const token = req.headers['authorization'];\n  if (!token) throw new AuthError();\n  const out = await forwardTo('payment-service', req);\n  res.status(out.status).json(out.data);\n});`,
    },
  },
  {
    id: '3',
    type: 'serviceNode',
    position: { x: 910, y: 150 },
    ...SIZE,
    data: {
      label: 'Payment Service',
      type: 'service',
      file: 'paymentHandler.ts',
      status: 'idle',
      code: `export async function handlePay(req, res) {\n  const charge = await stripe.charge({\n    amount: req.body.amount,\n    currency: req.body.currency\n  });\n  await db.query([req.body.user_id, charge.amount]);\n  // BUG: typo .jsn instead of .json\n  return res.jsn({ success: true, id: charge.id });\n}`,
    },
  },
  {
    id: '4',
    type: 'serviceNode',
    position: { x: 1340, y: 150 },
    ...SIZE,
    data: {
      label: 'PostgreSQL DB',
      type: 'database',
      file: 'insert.sql',
      status: 'idle',
      code: `INSERT INTO transactions \n  (user_id, amount, status)\nVALUES \n  ($1, $2, 'PAID')\nRETURNING id;`,
    },
  },
];

const EDGE_COLORS = { idle: '#4f46e5', active: '#eab308', error: '#f43f5e', ok: '#10b981' } as const;
const edgeStyle = (color: string, width = 2) => ({ stroke: color, strokeWidth: width });

const initialEdges: Edge[] = [
  { id: 'e1-2', source: '1', target: '2', animated: false, style: edgeStyle(EDGE_COLORS.idle) },
  { id: 'e2-3', source: '2', target: '3', animated: false, style: edgeStyle(EDGE_COLORS.idle) },
  { id: 'e3-4', source: '3', target: '4', animated: false, style: edgeStyle(EDGE_COLORS.idle) },
];

function computeChain(nodes: ServiceFlowNode[], edges: Edge[]): string[] {
  const targets = new Set(edges.map((e) => e.target));
  let cur: ServiceFlowNode | undefined = nodes.find((n) => !targets.has(n.id)) ?? nodes[0];
  const out: string[] = [];
  while (cur && !out.includes(cur.id)) {
    const here: ServiceFlowNode = cur;
    out.push(here.id);
    const next = edges.find((e) => e.source === here.id);
    cur = next ? nodes.find((n) => n.id === next.target) : undefined;
  }
  return out;
}
type LogLevel = 'info' | 'trace' | 'error' | 'success';
type LogEntry = { id: number; time: string; text: string; level: LogLevel };
type Tab = 'console' | 'network' | 'env';

const LOG_STYLE: Record<LogLevel, string> = {
  info: 'text-neutral-400',
  trace: 'text-amber-300',
  error: 'text-rose-400 font-bold',
  success: 'text-emerald-400',
};

const MAX_LOGS = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pretty = (v: unknown) => {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? 'undefined';
  } catch {
    return String(v);
  }
};

type CompileResponse = {
  files: { id: string; js: string; fns: FnInfo[]; diagnostics: { line: number; message: string }[] }[];
};
type HealResponse = { success: boolean; healedCode?: string; explanation?: string; error?: string };

export default function CanvasDocApp() {
  const nodeTypes = useMemo(() => ({ serviceNode: ServiceNode }), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<ServiceFlowNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);
  const [envCode, setEnvCode] = useState(DEFAULT_ENV_JS);
  const [schema, setSchema] = useState(DEFAULT_SCHEMA_SQL);

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const envRef = useRef(envCode);
  const schemaRef = useRef(schema);
  const resultRef = useRef<RunResult | null>(null);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => { envRef.current = envCode; }, [envCode]);
  useEffect(() => { schemaRef.current = schema; }, [schema]);

  const runningRef = useRef(false);
  const logId = useRef(1);
  const logBoxRef = useRef<HTMLDivElement>(null);

  const [tab, setTab] = useState<Tab>('console');
  const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [isHealing, setIsHealing] = useState(false);
  const [failingNodeId, setFailingNodeId] = useState<string | null>(null);
  const [currentError, setCurrentError] = useState('');
  const [lastResult, setLastResult] = useState<RunResult | null>(null);
  const [terminalLog, setTerminalLog] = useState<LogEntry[]>([
    { id: 0, time: '', text: 'CanvasDoc: code is compiled and really executed in an isolated worker.', level: 'info' },
    { id: 1, time: '', text: 'Press Run to send a real request through the nodes.', level: 'info' },
  ]);

  const addLog = useCallback((text: string, level: LogLevel = 'info') => {
    const entry: LogEntry = { id: ++logId.current, time: new Date().toLocaleTimeString(), text, level };
    setTerminalLog((prev) => [...prev, entry].slice(-MAX_LOGS));
  }, []);

  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [terminalLog, isTerminalCollapsed, tab]);

  const patchNode = useCallback(
    (id: string, patch: Partial<ServiceFlowNode['data']>) =>
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))),
    [setNodes]
  );

  const setEdgeBetween = useCallback(
    (from: string, to: string, color: string, animated: boolean, width = 2) =>
      setEdges((eds) => eds.map((e) => (e.source === from && e.target === to ? { ...e, animated, style: edgeStyle(color, width) } : e))),
    [setEdges]
  );

  const resetVisuals = useCallback(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, status: 'idle' as NodeStatus, message: undefined } })));
    setEdges((eds) => eds.map((e) => ({ ...e, animated: false, style: edgeStyle(EDGE_COLORS.idle) })));
  }, [setNodes, setEdges]);

  const buildTrace = (r: RunResult | null) => {
    if (!r) return '';
    const label = (id: string | null) => nodesRef.current.find((n) => n.id === id)?.data.label ?? 'caller';
    return r.hops
      .map((h) => `${h.method} ${h.path}  ${label(h.from)} -> ${label(h.to)}  status ${h.status}  request=${JSON.stringify(h.reqBody)?.slice(0, 200)}  response=${JSON.stringify(h.resBody)?.slice(0, 300)}`)
      .join('\n');
  };


  const resetCanvas = () => {
    if (runningRef.current || isHealing) return;
    setNodes(initialNodes);
    setEdges(initialEdges);
    setFailingNodeId(null);
    setCurrentError('');
    setLastResult(null);
    resultRef.current = null;
    addLog('Canvas restored to the original demo code.');
  };

  const runPipeline = useCallback(
    async (codeOverrides: Record<string, string> = {}) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setIsSimulating(true);
      setFailingNodeId(null);
      setCurrentError('');
      setLastResult(null);
      resultRef.current = null;
      resetVisuals();

      try {
        const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
        const chain = computeChain(nodesRef.current, edgesRef.current);
        const labelOf = (id: string | null) => (id ? byId.get(id)?.data.label ?? id : 'Environment');
        const codeOf = (id: string) => codeOverrides[id] ?? byId.get(id)!.data.code;

        addLog(`Compiling ${chain.length} nodes...`);
        const cRes = await fetch('/api/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: chain.map((id) => ({ id, type: byId.get(id)!.data.type, code: codeOf(id) })) }),
          signal: AbortSignal.timeout(15000),
        });
        if (!cRes.ok) throw new Error(`Compile service returned HTTP ${cRes.status}`);
        const { files }: CompileResponse = await cRes.json();

        const broken = files.find((f) => f.diagnostics.length > 0);
        if (broken) {
          const d = broken.diagnostics[0];
          const message = `SyntaxError: ${d.message} (line ${d.line})`;
          patchNode(broken.id, { status: 'error', message });
          addLog(`COMPILE FAILED in [${labelOf(broken.id)}]`, 'error');
          broken.diagnostics.forEach((x) => addLog(`  line ${x.line}: ${x.message}`, 'error'));
          setFailingNodeId(broken.id);
          setCurrentError(message);
          return;
        }

        addLog('Executing for real (isolated Web Worker, real Postgres for SQL)...');
        const jobNodes: NodeJob[] = chain.map((id) => {
          const n = byId.get(id)!;
          const f = files.find((x) => x.id === id)!;
          return { id, label: n.data.label, type: n.data.type, file: n.data.file, code: codeOf(id), js: f.js, fns: f.fns };
        });
        const result = await runJob({ nodes: jobNodes, chain, envCode: envRef.current, schema: schemaRef.current });

        for (const ev of result.events) {
          if (ev.type === 'enter') {
            patchNode(ev.nodeId, { status: 'running' });
            if (ev.from) setEdgeBetween(ev.from, ev.nodeId, EDGE_COLORS.active, true, 3);
            addLog(ev.method ? `${ev.method} ${ev.path}  ->  ${labelOf(ev.nodeId)}` : `Running ${labelOf(ev.nodeId)}...`, 'trace');
            await sleep(380);
          } else if (ev.type === 'exit') {
            const status = result.nodeStatus[ev.nodeId] ?? 'success';
            patchNode(ev.nodeId, { status });
            const entered = result.events.find((e) => e.type === 'enter' && e.nodeId === ev.nodeId);
            if (entered && entered.type === 'enter' && entered.from) {
              setEdgeBetween(entered.from, ev.nodeId, ev.status >= 400 ? EDGE_COLORS.error : EDGE_COLORS.ok, false, 3);
            }
            if (ev.nodeId !== chain[0]) addLog(`   ${labelOf(ev.nodeId)} responded ${ev.status} in ${ev.ms}ms`, ev.status >= 400 ? 'error' : 'info');
            await sleep(120);
          } else if (ev.type === 'log') {
            addLog(`[${labelOf(ev.nodeId)}] ${ev.text}`, ev.level === 'error' ? 'error' : ev.level === 'warn' ? 'trace' : 'info');
          } else if (ev.type === 'issue') {
            addLog(`[${labelOf(ev.nodeId)}] ${ev.message}`, 'error');
          }
        }

        // Put the real error text on each failing node
        const firstByNode = new Map<string, string>();
        for (const i of result.issues) if (i.nodeId && !firstByNode.has(i.nodeId)) firstByNode.set(i.nodeId, i.message);
        for (const [id, message] of firstByNode) patchNode(id, { status: 'error', message });

        setLastResult(result);
        resultRef.current = result;

        if (result.ok) {
          setEdges((eds) => eds.map((e) => ({ ...e, animated: false, style: edgeStyle(EDGE_COLORS.ok) })));
          addLog(`Pipeline completed in ${result.durationMs}ms. Client received: ${JSON.stringify(result.clientResult ?? result.response?.body)}`, 'success');
        } else if (result.root) {
          addLog(`Root cause: [${labelOf(result.root.nodeId)}] ${result.root.message}`, 'error');
          if (result.root.nodeId) setFailingNodeId(result.root.nodeId);
          setCurrentError(result.root.message);
        } else {
          addLog(`Pipeline ended with HTTP ${result.response?.status ?? '?'} and no runtime error.`, 'error');
        }
      } catch (err) {
        addLog(`Run failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        runningRef.current = false;
        setIsSimulating(false);
      }
    },
    [addLog, patchNode, resetVisuals, setEdgeBetween, setEdges]
  );

  const healFailingNode = useCallback(async () => {
    if (!failingNodeId || isHealing || runningRef.current) return;
    const target = nodesRef.current.find((n) => n.id === failingNodeId);
    if (!target) {
      setFailingNodeId(null);
      return;
    }

    setIsHealing(true);
    addLog(`Asking the AI to fix [${target.data.label}] using the real error and request trace...`);

    let healed: string | null = null;
    try {
      const res = await fetch('/api/heal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: target.data.code,
          nodeLabel: target.data.label,
          nodeType: target.data.type,
          problem: currentError,
          trace: buildTrace(resultRef.current),
          envCode: envRef.current,
          schema: schemaRef.current,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data: HealResponse = await res.json();
      if (!res.ok || !data.success || typeof data.healedCode !== 'string') {
        addLog(`Self-heal failed: ${data.error ?? `HTTP ${res.status}`}`, 'error');
      } else {
        healed = data.healedCode;
        addLog(`Fix proposed: ${data.explanation ?? 'patch generated'}`, 'success');
        patchNode(target.id, { code: healed, status: 'idle', message: undefined });
        setFailingNodeId(null);
        setCurrentError('');
        addLog('Patch applied. Re-running the pipeline for real to verify...', 'success');
      }
    } catch (err) {
      addLog(`Self-heal failed: ${err instanceof Error ? err.message : 'unknown error'}`, 'error');
    } finally {
      setIsHealing(false);
    }

    if (healed !== null) {
      await sleep(400);
      void runPipeline({ [target.id]: healed });
    }
  }, [failingNodeId, isHealing, currentError, addLog, patchNode, runPipeline]);

  /* ------------------------------- UI ------------------------------- */

  const busy = isSimulating || isHealing;
  const labelOf = (id: string | null) => nodes.find((n) => n.id === id)?.data.label ?? 'caller';

  const tabBtn = (t: Tab, text: string) => (
    <button
      onClick={() => { setTab(t); setIsTerminalCollapsed(false); }}
      className={`px-2.5 py-1 rounded text-[11px] transition ${tab === t && !isTerminalCollapsed ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white hover:bg-neutral-800/60'}`}
    >
      {text}
    </button>
  );

  return (
    <div className="w-screen h-screen bg-neutral-950 flex flex-col font-sans overflow-hidden">
      <header className="h-16 border-b border-neutral-800 px-6 flex items-center justify-between bg-neutral-900/50 backdrop-blur z-20">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-600/30">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-white font-bold text-sm tracking-wide">CanvasDoc</h1>
            <p className="text-[11px] text-neutral-400 font-mono">Spatial IDE: real execution, real requests, AI repair</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={resetCanvas}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-700 text-neutral-300 hover:text-white hover:bg-neutral-800 text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>

          {failingNodeId && (
            <button
              onClick={healFailingNode}
              disabled={busy}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-semibold shadow-lg shadow-emerald-500/20 transition disabled:cursor-not-allowed ${isHealing ? 'opacity-70' : 'animate-pulse'}`}
            >
              <Sparkles className="w-4 h-4" />
              {isHealing ? 'Agent Healing...' : 'Auto-Heal Error'}
            </button>
          )}

          <button
            onClick={() => void runPipeline()}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="w-4 h-4 fill-white" />
            {isSimulating ? 'Running...' : failingNodeId ? 'Re-run' : 'Run'}
          </button>
        </div>
      </header>

      <div className="flex-1 relative min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.2}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} color="#262626" />
          <Controls
            position="top-left"
            className="!bg-neutral-900/90 !backdrop-blur-md !border !border-neutral-800 !rounded-xl !shadow-2xl overflow-hidden [&>button]:!bg-neutral-900 [&>button]:!border-neutral-800 [&>button]:!fill-neutral-300 [&>button:hover]:!bg-neutral-800 [&>button:hover]:!fill-white"
          />
        </ReactFlow>

        <div
          className={`absolute bottom-4 left-6 right-6 bg-black/90 backdrop-blur-md rounded-xl border border-neutral-800 p-4 font-mono text-xs shadow-2xl z-20 flex flex-col transition-all duration-300 ${isTerminalCollapsed ? 'h-12' : 'h-72'}`}
        >
          <div className="flex items-center justify-between pb-2 border-b border-neutral-800 text-neutral-400 select-none">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-neutral-400" />
              {tabBtn('console', 'Console')}
              {tabBtn('network', `Network${lastResult ? ` (${lastResult.hops.length})` : ''}`)}
              {tabBtn('env', 'Environment')}
              {failingNodeId && (
                <span className="flex items-center gap-1.5 text-rose-400 font-bold bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/30 text-[10px] ml-2">
                  <Bug className="w-3 h-3" /> Error Detected
                </span>
              )}
            </div>
            <button
              onClick={() => setIsTerminalCollapsed((c) => !c)}
              className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-white px-2 py-0.5 rounded hover:bg-neutral-800 transition"
            >
              {isTerminalCollapsed ? (<><ChevronUp className="w-3.5 h-3.5" /><span>Expand</span></>) : (<><ChevronDown className="w-3.5 h-3.5" /><span>Minimize</span></>)}
            </button>
          </div>

          {!isTerminalCollapsed && tab === 'console' && (
            <div ref={logBoxRef} className="flex-1 overflow-y-auto mt-2 space-y-1">
              {terminalLog.map((log) => (
                <div key={log.id} className={LOG_STYLE[log.level]}>
                  {log.time && <span className="text-neutral-600">[{log.time}] </span>}
                  {log.text}
                </div>
              ))}
            </div>
          )}

          {!isTerminalCollapsed && tab === 'network' && (
            <div className="flex-1 overflow-y-auto mt-2 space-y-2">
              {!lastResult && <p className="text-neutral-500">Run the pipeline to see the real requests and responses.</p>}
              {lastResult && (
                <>
                  <div className="text-neutral-300">
                    Client received:{' '}
                    <span className={lastResult.ok ? 'text-emerald-400' : 'text-rose-400'}>
                      {lastResult.clientResult !== undefined ? JSON.stringify(lastResult.clientResult) : 'nothing (the call failed or returned undefined)'}
                    </span>
                    <span className="text-neutral-600"> · {lastResult.durationMs}ms total</span>
                  </div>
                  {lastResult.hops.map((h, i) => (
                    <details key={i} className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1.5">
                      <summary className="cursor-pointer select-none">
                        <span className="text-sky-300">{h.method}</span> <span className="text-neutral-200">{h.path}</span>
                        <span className="text-neutral-500"> {labelOf(h.from)} → {labelOf(h.to)} </span>
                        <span className={h.status >= 400 ? 'text-rose-400 font-bold' : 'text-emerald-400'}>{h.status}</span>
                        <span className="text-neutral-600"> {h.ms}ms</span>
                      </summary>
                      <div className="mt-1.5 grid grid-cols-2 gap-2">
                        <div>
                          <div className="text-neutral-500">Request body</div>
                          <pre className="whitespace-pre-wrap text-neutral-300">{pretty(h.reqBody)}</pre>
                        </div>
                        <div>
                          <div className="text-neutral-500">Response body</div>
                          <pre className="whitespace-pre-wrap text-neutral-300">{pretty(h.resBody)}</pre>
                        </div>
                      </div>
                    </details>
                  ))}
                </>
              )}
            </div>
          )}

          {!isTerminalCollapsed && tab === 'env' && (
            <div className="flex-1 mt-2 grid grid-cols-2 gap-3 min-h-0">
              <div className="flex flex-col min-h-0">
                <div className="flex items-center justify-between text-neutral-500 pb-1">
                  <span>Environment (JavaScript): every export becomes a global in all nodes</span>
                  <button className="text-neutral-400 hover:text-white" onClick={() => setEnvCode(DEFAULT_ENV_JS)}>restore default</button>
                </div>
                <textarea
                  value={envCode}
                  onChange={(e) => setEnvCode(e.target.value)}
                  spellCheck={false}
                  className="flex-1 min-h-0 w-full p-2 bg-neutral-950 border border-neutral-800 rounded resize-none outline-none text-neutral-200 text-[11px] leading-relaxed"
                />
              </div>
              <div className="flex flex-col min-h-0">
                <div className="flex items-center justify-between text-neutral-500 pb-1">
                  <span>Database schema (real PostgreSQL), run before every execution</span>
                  <button className="text-neutral-400 hover:text-white" onClick={() => setSchema(DEFAULT_SCHEMA_SQL)}>restore default</button>
                </div>
                <textarea
                  value={schema}
                  onChange={(e) => setSchema(e.target.value)}
                  spellCheck={false}
                  className="flex-1 min-h-0 w-full p-2 bg-neutral-950 border border-neutral-800 rounded resize-none outline-none text-neutral-200 text-[11px] leading-relaxed"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}