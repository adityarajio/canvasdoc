import { NextResponse } from 'next/server';
import { compileTs } from '@/lib/compile';

const MAX_CODE = 50_000;

type FileIn = { id: string; type: string; code: string };

export async function POST(req: Request) {
  let body: { files?: FileIn[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!Array.isArray(body.files) || body.files.some((f) => typeof f?.code !== 'string' || f.code.length > MAX_CODE)) {
    return NextResponse.json({ error: 'Expected files: [{ id, type, code }] with code under 50k characters.' }, { status: 400 });
  }

  const files = body.files.map((f) =>
    // SQL is executed as-is by Postgres; everything else goes through the TypeScript compiler
    f.type === 'database' ? { id: f.id, js: '', fns: [], diagnostics: [] } : { id: f.id, ...compileTs(f.code) }
  );
  return NextResponse.json({ files });
}