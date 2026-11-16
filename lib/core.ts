// Inti sistem: sinkron postingan & komentar, komentar terjadwal, dan data untuk dashboard.
import { getKv, q, setKv } from './db';
import * as ig from './ig';
import { cleanUsername, parseBid, parseCaption } from './parse';
import { evaluate, SNIPER_MS, type CommentIn } from './bids';

const MIN = 60_000;
const LOOKAHEAD = 75_000; // komentar yang jatuh tempo dalam 75 detik diambil oleh tick ini
const MISSED_AFTER = 20_000; // lebih telat dari ini tidak dikirim otomatis
const SNIPER_MIN_BIDS = Math.max(0, Number(process.env.SNIPER_MIN_BIDS ?? 2) || 0); // Sniper Zone hanya diumumkan kalau bid sah minimal sebanyak ini
const CLOSE_LEAD = 1_000; // "Close" dikirim di detik ke-59 sebelum jam close

export type Kind = 'ten' | 'sniper' | 'close';
const TEN_MS = 10 * MIN; // pengumuman 10 menit sebelum close
export const texts = () => ({
  ten: process.env.TEN_TEXT || '10 MENIT MENUJU CLOSE!',
  sniper: process.env.SNIPER_TEXT || '🎯 SNIPER ZONE! 🎯',
  close: process.env.CLOSE_TEXT || '❌ LELANG CLOSED! ❌',
});

const iso = (ms: number) => new Date(ms).toISOString();
const toMs = (v: unknown) => (v == null ? null : new Date(v as string).getTime());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const noteError = (e: unknown) => setKv('lastError', { message: String((e as Error)?.message || e), at: Date.now() }).catch(() => {});

// ---------- Postingan ----------

async function ensureEvents(postId: string, closeAt: number | null) {
  if (closeAt == null) {
    await q(`DELETE FROM events WHERE post_id = $1 AND status IN ('pending','missed')`, [postId]);
    return;
  }
  // Jadwal yang sudah terkirim / sedang diproses tidak diubah; yang terlewat atau gagal dijadwalkan ulang kalau jamnya berubah.
  await q(
    `INSERT INTO events (post_id, kind, due_at) VALUES ($1,'ten',$4), ($1,'sniper',$2), ($1,'close',$3)
     ON CONFLICT (post_id, kind) DO UPDATE SET
       status = CASE WHEN events.due_at <> EXCLUDED.due_at THEN 'pending' ELSE events.status END,
       error = CASE WHEN events.due_at <> EXCLUDED.due_at THEN NULL ELSE events.error END,
       due_at = EXCLUDED.due_at
     WHERE events.status IN ('pending','missed','failed','skipped')`,
    [postId, iso(closeAt - SNIPER_MS), iso(closeAt - CLOSE_LEAD), iso(closeAt - TEN_MS)],
  );
}

export async function syncMedia(force = false) {
  // Saat berpindah antara mode demo dan akun asli, data mode sebelumnya dibuang supaya tidak tercampur.
  const mode = ig.isMock() ? 'mock' : 'real';
  const prev = await getKv<string>('mode');
  if (prev !== mode) {
    if (prev) for (const t of ['posts', 'comments', 'events', 'bidders', 'results']) await q(`DELETE FROM ${t}`);
    await setKv('mode', mode);
    force = true;
  }
  const last = await getKv<number>('mediaSyncedAt');
  if (!force && last && Date.now() - last < 5 * MIN) return;
  await setKv('mediaSyncedAt', Date.now());

  await setKv('me', await ig.getMe());
  const media = await ig.listMedia(9);
  const existing = new Map((await q('SELECT * FROM posts')).map((p) => [p.id as string, p]));
  await q('UPDATE posts SET in_latest = false');

  await Promise.all(
    media.map(async (m) => {
      const parsed = parseCaption(m.caption);
      const ex = existing.get(m.id);
      const manual = ex?.manual || {};
      // Nilai yang sudah kamu ubah manual tidak ditimpa oleh hasil baca caption.
      const v = {
        title: manual.title ? ex!.title : parsed.title,
        openBid: manual.openBid ? ex!.open_bid : parsed.openBid,
        increment: manual.increment ? ex!.increment : parsed.increment,
        maxJump: manual.maxJump ? ex!.max_jump : parsed.maxJump,
        closeAt: manual.closeAt ? toMs(ex!.close_at) : parsed.closeAt,
      };
      await q(
        `INSERT INTO posts (id, permalink, caption, thumb, posted_at, title, open_bid, increment, max_jump, close_at, in_latest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
         ON CONFLICT (id) DO UPDATE SET permalink=$2, caption=$3, thumb=$4, posted_at=$5, title=$6,
           open_bid=$7, increment=$8, max_jump=$9, close_at=$10, in_latest=true`,
        [m.id, m.permalink, m.caption, m.thumb, iso(m.ts), v.title, v.openBid, v.increment, v.maxJump, v.closeAt == null ? null : iso(v.closeAt)],
      );
      await ensureEvents(m.id, v.closeAt);
    }),
  );
}

export type PostPatch = {
  title?: string;
  openBid?: number | null;
  increment?: number | null;
  maxJump?: number | null;
  closeAt?: number | null;
  autoComment?: boolean;
};

export async function updatePost(id: string, patch: PostPatch) {
  const cols: Record<string, string> = { title: 'title', openBid: 'open_bid', increment: 'increment', maxJump: 'max_jump', closeAt: 'close_at' };
  const sets: string[] = [];
  const params: unknown[] = [id];
  const manual: Record<string, true> = {};
  for (const [key, col] of Object.entries(cols)) {
    if (!(key in patch)) continue;
    let val = (patch as any)[key];
    if (key === 'closeAt') val = val == null ? null : iso(Number(val));
    else if (key !== 'title') val = val == null || val === '' ? null : Math.round(Number(val));
    if (typeof val === 'number' && !Number.isFinite(val)) throw new Error('Angka tidak valid');
    params.push(val);
    sets.push(`${col} = $${params.length}`);
    manual[key] = true;
  }
  if (typeof patch.autoComment === 'boolean') {
    params.push(patch.autoComment);
    sets.push(`auto_comment = $${params.length}`);
  }
  if (!sets.length) return;
  params.push(JSON.stringify(manual));
  sets.push(`manual = manual || $${params.length}::jsonb`);
  const r = await q(`UPDATE posts SET ${sets.join(', ')} WHERE id = $1 RETURNING close_at`, params);
  if (r.length && 'closeAt' in patch) await ensureEvents(id, toMs(r[0].close_at));
}

/** Postingan terlama dari 9 terakhir close di startAt, berikutnya mundur stepMin menit, dan seterusnya. */
export async function setSequence(startAt: number, stepMin = 5) {
  if (!Number.isFinite(startAt) || !(stepMin > 0)) throw new Error('Jam tidak valid');
  const posts = await q('SELECT id FROM posts WHERE in_latest ORDER BY posted_at ASC');
  for (const [i, p] of posts.entries()) await updatePost(p.id, { closeAt: startAt + i * stepMin * MIN });
  return posts.length;
}

// ---------- Komentar ----------

/** Seberapa sering komentar sebuah postingan dicek, tergantung jarak ke jam close. null = berhenti. */
function syncInterval(closeAt: number | null, now: number): number | null {
  if (closeAt == null) return 5 * MIN;
  const d = closeAt - now;
  if (d > 60 * MIN) return 5 * MIN;
  if (d > 10 * MIN) return MIN;
  if (d > -2 * MIN) return 8_000;
  if (d > -30 * MIN) return 2 * MIN;
  if (d > -24 * 60 * MIN) return 30 * MIN;
  return null;
}
const isHot = (closeAt: number | null, now: number) => closeAt != null && closeAt - now <= 10 * MIN && closeAt - now > -2 * MIN;

const VISIBLE = `(in_latest OR close_at > now() - interval '24 hours')`;

async function syncComments(postId: string) {
  const list = await ig.listComments(postId);
  const now = iso(Date.now());
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const params: unknown[] = [postId, now];
    const values = chunk.map((c) => {
      params.push(c.id, c.parentId, c.username, c.text, iso(c.ts));
      const n = params.length;
      return `($${n - 4}, $1, $${n - 3}, $${n - 2}, $${n - 1}, $${n}, $2)`;
    });
    await q(
      `INSERT INTO comments (id, post_id, parent_id, username, text, ts, first_seen) VALUES ${values.join(',')}
       ON CONFLICT (id) DO UPDATE SET deleted_at = NULL`,
      params,
    );
  }
  // Komentar yang pernah terlihat tapi sekarang hilang ditandai dihapus; salinannya tetap disimpan.
  const gone = await q(
    `UPDATE comments SET deleted_at = $2 WHERE post_id = $1 AND deleted_at IS NULL
       AND id NOT IN (SELECT jsonb_array_elements_text($3::jsonb)) RETURNING username, text`,
    [postId, now, JSON.stringify(list.map((c) => c.id))],
  );
  // Akun yang menghapus bid dikeluarkan dari daftar akun sah.
  for (const c of gone) if (parseBid(c.text)) await setVerified(c.username, false);
}

async function syncDuePosts(): Promise<boolean> {
  const now = Date.now();
  const posts = await q(`SELECT id, close_at, last_sync FROM posts WHERE ${VISIBLE}`);
  let hot = false;
  await Promise.all(
    posts.map(async (p) => {
      const closeAt = toMs(p.close_at);
      hot ||= isHot(closeAt, now);
      const every = syncInterval(closeAt, now);
      if (every == null) return;
      // Diklaim lewat database supaya dua proses yang berjalan bersamaan tidak mengecek postingan yang sama.
      const claimed = await q(
        `UPDATE posts SET last_sync = $2 WHERE id = $1 AND (last_sync IS NULL OR last_sync <= $3) RETURNING id`,
        [p.id, iso(now), iso(now - every)],
      );
      if (!claimed.length) return;
      try {
        await syncComments(p.id);
        await setKv('lastOk', now);
      } catch (e) {
        await noteError(e);
      }
    }),
  );
  return hot;
}

/** Sinkron ringan tanpa menunggu jadwal komentar; dipakai mode demo sebelum data dibaca. */
export async function refresh() {
  await syncMedia();
  await syncDuePosts();
}

// ---------- Komentar terjadwal ----------

async function send(postId: string, kind: Kind) {
  const message = texts()[kind];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const commentId = await ig.postComment(postId, message);
      await q(`UPDATE events SET status='sent', sent_at=$3, comment_id=$4, error=NULL WHERE post_id=$1 AND kind=$2`, [postId, kind, iso(Date.now()), commentId]);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  const msg = String((lastErr as Error)?.message || lastErr);
  await q(`UPDATE events SET status='failed', error=$3 WHERE post_id=$1 AND kind=$2`, [postId, kind, msg]);
  await noteError(lastErr);
}

/** Jumlah bid yang saat ini dihitung sah di sebuah lelang (bid yang kamu tolak tidak ikut). */
async function countValidBids(postId: string) {
  const [post, comments, me] = await Promise.all([
    q('SELECT * FROM posts WHERE id = $1', [postId]),
    q('SELECT * FROM comments WHERE post_id = $1', [postId]),
    getKv<{ username: string }>('me'),
  ]);
  if (!post.length) return 0;
  const p = post[0];
  const { rows } = evaluate(
    comments.map((c) => ({ id: c.id, parentId: c.parent_id, username: c.username, text: c.text, ts: toMs(c.ts)!, deleted: c.deleted_at != null, override: c.override })),
    { openBid: p.open_bid, increment: p.increment, maxJump: p.max_jump, closeAt: toMs(p.close_at), ownUsername: me?.username || null },
  );
  return rows.filter((r) => r.isBid && r.valid).length;
}

async function fire(ev: { post_id: string; kind: Kind; due_at: unknown }) {
  const due = toMs(ev.due_at)!;
  const gated = ev.kind === 'sniper' && SNIPER_MIN_BIDS > 0;
  await sleep(due - Date.now() - (gated ? 4000 : 1500));
  // Cek ulang sesaat sebelum kirim: auto-komentar bisa saja dimatikan atau jamnya diubah.
  const r = await q(
    `SELECT e.status, e.due_at, p.auto_comment FROM events e JOIN posts p ON p.id = e.post_id WHERE e.post_id=$1 AND e.kind=$2`,
    [ev.post_id, ev.kind],
  );
  if (!r.length || r[0].status !== 'claimed') return;
  if (!r[0].auto_comment || toMs(r[0].due_at) !== due) {
    await q(`UPDATE events SET status='pending' WHERE post_id=$1 AND kind=$2 AND status='claimed'`, [ev.post_id, ev.kind]);
    return;
  }
  if (gated) {
    // Ambil komentar terbaru dulu, lalu lewati pengumuman kalau bid sah belum cukup.
    await syncComments(ev.post_id).catch(noteError);
    const n = await countValidBids(ev.post_id);
    if (n < SNIPER_MIN_BIDS) {
      await q(`UPDATE events SET status='skipped', error=$3 WHERE post_id=$1 AND kind=$2 AND status='claimed'`, [
        ev.post_id, ev.kind, `Bid sah baru ${n}, minimal ${SNIPER_MIN_BIDS}`,
      ]);
      return;
    }
  }
  await sleep(due - Date.now());
  await send(ev.post_id, ev.kind);
}

/** Mengembalikan komentar ke status terjadwal, mis. setelah uji kirim yang komentarnya sudah dihapus di Instagram. */
export async function resetEvent(postId: string, kind: Kind) {
  await q(
    `UPDATE events SET status='pending', sent_at=NULL, comment_id=NULL, error=NULL
     WHERE post_id=$1 AND kind=$2 AND status IN ('sent','failed','missed','skipped')`,
    [postId, kind],
  );
}

export async function sendNow(postId: string, kind: Kind) {
  const r = await q(
    `UPDATE events SET status='claimed', claimed_at=$3 WHERE post_id=$1 AND kind=$2 AND status IN ('pending','missed','failed','skipped') RETURNING kind`,
    [postId, kind, iso(Date.now())],
  );
  if (!r.length) throw new Error('Komentar ini sudah terkirim atau sedang diproses');
  await send(postId, kind);
}

/** Dipanggil tiap menit oleh cron (loop = true) dan tiap beberapa detik oleh dashboard yang sedang terbuka. */
export async function tick(loop: boolean) {
  const started = Date.now();
  if (!ig.hasToken()) return;
  try {
    await syncMedia();
  } catch (e) {
    await noteError(e);
  }

  const now = Date.now();
  await q(`UPDATE events SET status='missed' WHERE status='pending' AND due_at < $1`, [iso(now - MISSED_AFTER)]);
  await q(
    `UPDATE events SET status='failed', error='Proses berhenti sebelum komentar terkirim' WHERE status='claimed' AND due_at < $1`,
    [iso(now - 3 * MIN)],
  );
  const claimed = await q(
    `UPDATE events e SET status='claimed', claimed_at=$1 FROM posts p
     WHERE p.id = e.post_id AND p.auto_comment AND e.status='pending' AND e.due_at <= $2
     RETURNING e.post_id, e.kind, e.due_at`,
    [iso(now), iso(now + LOOKAHEAD)],
  );
  const timers = claimed.map((ev) => fire(ev as any).catch(noteError));

  // Saat ada lelang mendekati close, cron terus mengecek komentar selama ±55 detik sampai tick berikutnya.
  for (;;) {
    const hot = await syncDuePosts().catch(() => false);
    if (!loop || !hot || Date.now() - started > 50_000) break;
    await sleep(4_000);
  }
  await Promise.all(timers);
}

// ---------- Data dashboard ----------

/** Daftar akun sah: akun yang bid-nya pernah kamu sahkan. Berlaku di semua lelang, sekarang dan berikutnya. */
export async function setVerified(raw: string, on: boolean) {
  const username = cleanUsername(raw);
  if (!username) throw new Error('Username tidak valid');
  if (on) await q('INSERT INTO bidders (username, verified_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [username, iso(Date.now())]);
  else await q('DELETE FROM bidders WHERE username = $1', [username]);
}

/** Memasukkan banyak akun sekaligus ke daftar akun sah (mis. dari file followers). */
export async function importVerified(raw: unknown[]) {
  const names = [...new Set(raw.map((r) => cleanUsername(String(r))).filter((u): u is string => !!u))].slice(0, 50_000);
  let added = 0;
  for (let i = 0; i < names.length; i += 500) {
    const r = await q(
      `INSERT INTO bidders (username, verified_at)
       SELECT jsonb_array_elements_text($1::jsonb), $2::timestamptz ON CONFLICT DO NOTHING RETURNING username`,
      [JSON.stringify(names.slice(i, i + 500)), iso(Date.now())],
    );
    added += r.length;
  }
  return { found: names.length, added };
}

export async function listVerified() {
  const r = await q('SELECT username, verified_at FROM bidders ORDER BY username');
  return r.map((b) => ({ username: b.username as string, at: toMs(b.verified_at)! }));
}

/** Menetapkan hasil lelang: pemenang (akun + nominal), "No Winner", atau null untuk membatalkan penetapan. */
export async function setResult(postId: string, r: { status: 'winner' | 'none'; username?: string; amount?: number; note?: string } | null) {
  if (!r) {
    await q('DELETE FROM results WHERE post_id = $1', [postId]);
    return;
  }
  const post = (await q('SELECT title, close_at FROM posts WHERE id = $1', [postId]))[0];
  if (!post) throw new Error('Lelang tidak ditemukan');
  const win = r.status === 'winner';
  if (win && (!r.username || !Number.isFinite(r.amount))) throw new Error('Pemenang tidak lengkap');
  await q(
    `INSERT INTO results (post_id, status, username, amount, title, close_at, decided_at, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (post_id) DO UPDATE SET status=$2, username=$3, amount=$4, title=$5, close_at=$6, decided_at=$7, note=$8`,
    [postId, win ? 'winner' : 'none', win ? r.username : null, win ? Math.round(r.amount!) : null, post.title, post.close_at, iso(Date.now()), r.note ? String(r.note).slice(0, 200) : null],
  );
}

export async function setOverride(commentId: string, value: 'valid' | 'invalid' | 'wrong' | null) {
  const r = await q('UPDATE comments SET override = $2 WHERE id = $1 RETURNING username', [commentId, value]);
  // Sah memasukkan akun ke daftar akun sah. Tolak hanya membatalkan bid ini; daftar tidak berubah.
  if (r.length && value === 'valid') await setVerified(r[0].username, true);
}

export async function getState() {
  const [posts, comments, events, bidders, results, me, lastError, lastOk] = await Promise.all([
    q(`SELECT * FROM posts WHERE ${VISIBLE} ORDER BY close_at ASC NULLS LAST, posted_at ASC`),
    q(`SELECT c.* FROM comments c JOIN posts p ON p.id = c.post_id WHERE ${VISIBLE.replace(/close_at|in_latest/g, 'p.$&')}`),
    q('SELECT * FROM events'),
    q('SELECT username FROM bidders'),
    q('SELECT * FROM results ORDER BY close_at DESC NULLS LAST'),
    getKv<{ username: string }>('me'),
    getKv<{ message: string; at: number }>('lastError'),
    getKv<number>('lastOk'),
  ]);

  const verified = new Set(bidders.map((b) => b.username as string));
  const byPost = new Map<string, CommentIn[]>();
  for (const c of comments) {
    const list = byPost.get(c.post_id) || [];
    list.push({ id: c.id, parentId: c.parent_id, username: c.username, text: c.text, ts: toMs(c.ts)!, deleted: c.deleted_at != null, deletedAt: toMs(c.deleted_at), override: c.override });
    byPost.set(c.post_id, list);
  }

  return {
    now: Date.now(),
    mock: ig.isMock(),
    setup: { token: ig.hasToken(), cron: !!process.env.CRON_SECRET },
    me: me?.username || null,
    lastError: lastError && (!lastOk || lastError.at > lastOk) ? lastError : null,
    texts: texts(),
    verifiedCount: bidders.length,
    results: results.map((r) => ({
      postId: r.post_id as string, status: r.status as 'winner' | 'none', username: r.username as string | null,
      amount: r.amount as number | null, title: r.title as string, closeAt: toMs(r.close_at), note: r.note as string | null,
    })),
    posts: posts.map((p) => {
      const closeAt = toMs(p.close_at);
      const { rows, top } = evaluate(byPost.get(p.id) || [], {
        openBid: p.open_bid, increment: p.increment, maxJump: p.max_jump, closeAt, ownUsername: me?.username || null, verified,
      });
      const ev: Record<string, unknown> = {};
      for (const e of events) {
        if (e.post_id === p.id) ev[e.kind] = { dueAt: toMs(e.due_at), status: e.status, sentAt: toMs(e.sent_at), error: e.error };
      }
      return {
        id: p.id as string, title: p.title as string, permalink: p.permalink as string, thumb: p.thumb as string | null,
        closeAt, openBid: p.open_bid as number | null, increment: p.increment as number | null, maxJump: p.max_jump as number | null,
        autoComment: p.auto_comment as boolean, lastSync: toMs(p.last_sync),
        events: ev as Partial<Record<Kind, { dueAt: number; status: string; sentAt: number | null; error: string | null }>>,
        top: top ? { amount: top.amount!, username: top.username, ts: top.ts } : null,
        rows: rows.reverse(),
      };
    }),
  };
}

export type State = Awaited<ReturnType<typeof getState>>;
