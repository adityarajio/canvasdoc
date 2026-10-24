export type FnInfo = { name: string; params: string[]; async: boolean };
export type NodeJob = { id: string; label: string; type: 'client' | 'service' | 'database'; file?: string; code: string; js: string; fns: FnInfo[] };
export type Job = { nodes: NodeJob[]; chain: string[]; envCode: string; schema: string };

export type RunEvent =
  | { type: 'enter'; ms: number; nodeId: string; from: string | null; method: string; path: string }
  | { type: 'exit'; ms: number; nodeId: string; status: number }
  | { type: 'log'; ms: number; nodeId: string | null; level: string; text: string }
  | { type: 'issue'; ms: number; nodeId: string | null; kind: string; message: string };

export type Hop = {
  from: string | null;
  to: string;
  method: string;
  path: string;
  reqHeaders: Record<string, string>;
  reqBody: unknown;
  status: number;
  resBody: unknown;
  ms: number;
};
export type Issue = { nodeId: string | null; kind: string; message: string; ms: number };

export type RunResult = {
  ok: boolean;
  events: RunEvent[];
  hops: Hop[];
  issues: Issue[];
  nodeStatus: Record<string, 'success' | 'error'>;
  clientResult: unknown;
  response: { status: number; body: unknown } | null;
  root: Issue | null;
  durationMs: number;
};

let worker: Worker | null = null;
let seq = 0;

export function runJob(job: Job, timeoutMs = 20000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (!worker) worker = new Worker('/runtime-worker.js', { type: 'module' });
    const w = worker;
    const id = ++seq;

    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };
    const kill = () => {
      w.terminate();
      if (worker === w) worker = null;
    };
    const timer = setTimeout(() => {
      cleanup();
      kill();
      reject(new Error(`Execution timed out after ${timeoutMs / 1000}s (an infinite loop, or a Promise that never resolves).`));
    }, timeoutMs);
    const onMessage = (e: MessageEvent) => {
      if (e.data?.id !== id) return;
      cleanup();
      if (e.data.ok) resolve(e.data.result as RunResult);
      else reject(new Error(e.data.error));
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      kill();
      reject(new Error(e.message || 'The execution worker crashed or could not be loaded (is public/runtime-worker.js present?).'));
    };

    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage({ id, job });
  });
}