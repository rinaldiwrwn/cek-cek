import { after, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { tick } from '@/lib/core';

export const maxDuration = 120;

// Dipanggil oleh dashboard yang sedang terbuka: data lebih segar dan jadi cadangan kalau cron telat.
export async function POST() {
  if (!(await isAuthed())) return NextResponse.json({ error: 'Belum login' }, { status: 401 });
  after(() => tick(false).catch(console.error));
  return NextResponse.json({ ok: true });
}
