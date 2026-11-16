import { after, NextResponse } from 'next/server';
import { checkPassword, COOKIE, cronAuthed, isAuthed, sessionValue } from '@/lib/auth';
import { getState, refresh, resetEvent, sendNow, setOverride, setSequence, setVerified, syncMedia, tick, updatePost } from '@/lib/core';
import { isMock } from '@/lib/ig';

// Semua endpoint ada di satu fungsi. Mode demo menyimpan datanya di memori, dan di Vercel
// tiap fungsi punya memori sendiri, jadi endpoint yang terpisah tidak akan melihat data yang sama.
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => NextResponse.json(body, { status });
const denied = () => json({ error: 'Belum login' }, 401);

async function login(req: Request) {
  const { password } = await req.json().catch(() => ({}));
  if (typeof password !== 'string' || !checkPassword(password)) {
    await new Promise((r) => setTimeout(r, 800)); // memperlambat tebak-tebakan password
    return json({ error: 'Password salah' }, 401);
  }
  const res = json({ ok: true });
  res.cookies.set(COOKIE, sessionValue(), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 86400, path: '/',
  });
  return res;
}

async function action(req: Request) {
  const b = await req.json().catch(() => ({}));
  try {
    if (b.type === 'post') await updatePost(String(b.id), b.patch || {});
    else if (b.type === 'override') await setOverride(String(b.id), ['valid', 'invalid', 'wrong'].includes(b.value) ? b.value : null);
    else if (b.type === 'send' && ['ten', 'sniper', 'close'].includes(b.kind)) await sendNow(String(b.id), b.kind);
    else if (b.type === 'reset' && ['ten', 'sniper', 'close'].includes(b.kind)) await resetEvent(String(b.id), b.kind);
    else if (b.type === 'verify' && typeof b.username === 'string') await setVerified(b.username, !!b.on);
    else if (b.type === 'sequence') await setSequence(Number(b.startAt), 5);
    else if (b.type === 'reload') await syncMedia(true);
    else return json({ error: 'Aksi tidak dikenal' }, 400);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error).message) }, 400);
  }
}

async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const name = (await ctx.params).path.join('/');
  const post = req.method === 'POST';

  if (name === 'login' && post) return login(req);

  // Dipanggil tiap menit oleh pemicu luar (mis. cron-job.org). Langsung menjawab, lalu bekerja di belakang layar.
  if (name === 'cron') {
    if (!cronAuthed(req)) return json({ error: 'Tidak diizinkan' }, 401);
    after(() => tick(true).catch(console.error));
    return json({ ok: true });
  }

  if (!(await isAuthed())) return denied();

  if (name === 'state' && !post) {
    try {
      if (isMock()) await refresh(); // demo: pastikan data palsu sudah ada di memori fungsi ini
      return json(await getState());
    } catch (e) {
      return json({ error: String((e as Error).message) }, 500);
    }
  }
  // Dipanggil oleh dashboard yang sedang terbuka: data lebih segar dan jadi cadangan kalau cron telat.
  if (name === 'tick' && post) {
    after(() => tick(false).catch(console.error));
    return json({ ok: true });
  }
  if (name === 'action' && post) return action(req);
  return json({ error: 'Tidak ditemukan' }, 404);
}

export { handle as GET, handle as POST };
