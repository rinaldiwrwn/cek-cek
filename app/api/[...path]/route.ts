import { after, NextResponse } from 'next/server';
import { checkPassword, COOKIE, cronAuthed, isAuthed, sessionValue } from '@/lib/auth';
import { addVerifiedMany, getState, syncAllComments, syncPostNow, importVerified, listVerified, refresh, removeImported, replyToBid, sendWinnerDm, testDm, setAutoDm, setAutoReply, setAutoFollowup, setCustomer, removeCustomer, processFollowup, resetEvent, sendNow, setOverride, setResult, setSequence, setVerified, syncAutoResults, syncMedia, tick, updatePost } from '@/lib/core';
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
    else if (b.type === 'testdm' && typeof b.username === 'string') return json({ ok: true, ...(await testDm(String(b.id), b.username, typeof b.text === 'string' ? b.text : undefined, !!b.preview)) });
    else if (b.type === 'autodm') await setAutoDm(!!b.on);
    else if (b.type === 'autofollowup') await setAutoFollowup(!!b.on);
    else if (b.type === 'customer') await setCustomer(String(b.username ?? ''), Number(b.ongkir), String(b.greeting ?? 'om'));
    else if (b.type === 'delcustomer') await removeCustomer(String(b.username ?? ''));
    else if (b.type === 'followup' && typeof b.username === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(String(b.day))) await processFollowup(b.username, String(b.day), true);
    else if (b.type === 'dm') await sendWinnerDm(String(b.id), String(b.text ?? ''));
    else if (b.type === 'autoreply') await setAutoReply(!!b.on);
    else if (b.type === 'reply') await replyToBid(String(b.id), String(b.text), !!b.again);
    else if (b.type === 'verify' && typeof b.username === 'string') await setVerified(b.username, !!b.on);
    else if (b.type === 'addmany' && typeof b.text === 'string') {
      const r = await addVerifiedMany(b.text);
      await syncAutoResults().catch(() => {});
      return json({ ok: true, ...r });
    } else if (b.type === 'import' && Array.isArray(b.usernames)) {
      const r = await importVerified(b.usernames);
      await syncAutoResults().catch(() => {});
      return json({ ok: true, ...r });
    } else if (b.type === 'unimport') {
      const removed = await removeImported();
      await syncAutoResults().catch(() => {});
      return json({ ok: true, removed });
    }
    else if (b.type === 'sequence') await setSequence(Number(b.startAt), 5);
    else if (b.type === 'result') {
      await setResult(String(b.id), b.status === 'winner' || b.status === 'none' ? { status: b.status, username: b.username, amount: Number(b.amount), note: b.note } : null);
    } else if (b.type === 'reload') {
      await syncMedia(true);
      await syncAllComments(); // komentar juga dibaca ulang, bukan hanya daftar postingan
    } else if (b.type === 'sync') await syncPostNow(String(b.id));
    else return json({ error: 'Aksi tidak dikenal' }, 400);
    await syncAutoResults().catch(() => {}); // pemenang bawaan ikut menyesuaikan keputusan terbaru
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

  if (name === 'verified' && !post) return json({ list: await listVerified() });
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
