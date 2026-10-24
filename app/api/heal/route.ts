import { NextResponse } from 'next/server';
import { healCode } from '@/lib/ai';

const MAX = 20_000;
export const maxDuration = 30;

export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const code = str(b.code, MAX + 1);
  if (!code || code.length > MAX) {
    return NextResponse.json({ success: false, error: '`code` must be a non-empty string under 20k characters.' }, { status: 400 });
  }
  const kind = b.nodeType === 'client' || b.nodeType === 'database' ? b.nodeType : 'service';

  const result = await healCode({
    code,
    kind,
    label: str(b.nodeLabel, 80) || 'Service',
    problem: str(b.problem, 1200) || 'Unknown error',
    trace: str(b.trace, 2500),
    envCode: str(b.envCode, 8000),
    schema: str(b.schema, 3000),
  });
  return NextResponse.json(result);
}