import { NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { sendNow, setOverride, setSequence, syncMedia, updatePost } from '@/lib/core';

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!(await isAuthed())) return NextResponse.json({ error: 'Belum login' }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  try {
    if (b.type === 'post') await updatePost(String(b.id), b.patch || {});
    else if (b.type === 'override') await setOverride(String(b.id), ['valid', 'invalid'].includes(b.value) ? b.value : null);
    else if (b.type === 'send' && (b.kind === 'sniper' || b.kind === 'close')) await sendNow(String(b.id), b.kind);
    else if (b.type === 'sequence') await setSequence(Number(b.startAt), 5);
    else if (b.type === 'reload') await syncMedia(true);
    else return NextResponse.json({ error: 'Aksi tidak dikenal' }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 400 });
  }
}
