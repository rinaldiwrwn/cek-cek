import { after, NextResponse } from 'next/server';
import { cronAuthed } from '@/lib/auth';
import { tick } from '@/lib/core';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

// Dipanggil tiap menit oleh pemicu luar (mis. cron-job.org). Langsung menjawab, lalu bekerja di belakang layar.
async function handle(req: Request) {
  if (!cronAuthed(req)) return NextResponse.json({ error: 'Tidak diizinkan' }, { status: 401 });
  after(() => tick(true).catch(console.error));
  return NextResponse.json({ ok: true });
}
export { handle as GET, handle as POST };
