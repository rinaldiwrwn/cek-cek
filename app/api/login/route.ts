import { NextResponse } from 'next/server';
import { checkPassword, COOKIE, sessionValue } from '@/lib/auth';

export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({}));
  if (typeof password !== 'string' || !checkPassword(password)) {
    await new Promise((r) => setTimeout(r, 800)); // memperlambat tebak-tebakan password
    return NextResponse.json({ error: 'Password salah' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, sessionValue(), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 86400, path: '/',
  });
  return res;
}
