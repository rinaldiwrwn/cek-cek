import { NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { getState } from '@/lib/core';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAuthed())) return NextResponse.json({ error: 'Belum login' }, { status: 401 });
  try {
    return NextResponse.json(await getState());
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}
