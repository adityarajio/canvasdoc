import { createEngine } from './runtime-engine.js';

const PGLITE_URL = 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite/dist/index.js';

const engine = createEngine({
  importModule: async (code) => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      return await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  loadPglite: async () => {
    const { PGlite } = await import(PGLITE_URL);
    return await PGlite.create();
  },
});

self.onmessage = async (e) => {
  const { id, job } = e.data;
  try {
    self.postMessage({ id, ok: true, result: await engine.run(job) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};