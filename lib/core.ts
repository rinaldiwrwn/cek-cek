// Inti sistem: sinkron postingan & komentar, komentar terjadwal, dan data untuk dashboard.
import { getKv, q, setKv } from './db';
import * as ig from './ig';
import { amountText, cleanUsername, parseCaption, splitUsernames } from './parse';
import { autoReplyTargets, autoWinnerReason, DM_TEMPLATE, dmMessage, evaluate, SNIPER_MS, winnerBidForDm, type CommentIn } from './bids';

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
  // Bid yang dihapus otomatis tidak sah; akunnya tetap di daftar akun sah sampai kamu sendiri yang mengeluarkannya.
  await q(
    `UPDATE comments SET deleted_at = $2 WHERE post_id = $1 AND deleted_at IS NULL
       AND id NOT IN (SELECT jsonb_array_elements_text($3::jsonb))`,
    [postId, now, JSON.stringify(list.map((c) => c.id))],
  );
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
    { openBid: p.open_bid, increment: p.increment, maxJump: p.max_jump, closeAt: toMs(p.close_at), ownUsername: me?.username || null, sniperMinBids: SNIPER_MIN_BIDS },
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
    await autoReplies().catch(noteError);
    if (!loop || !hot || Date.now() - started > 50_000) break;
    await sleep(4_000);
  }
  await syncAutoResults().catch(noteError);
  await autoDms().catch(noteError);
  await Promise.all(timers);
}

// ---------- Data dashboard ----------

/** Daftar akun sah: akun yang bid-nya pernah kamu sahkan. Berlaku di semua lelang, sekarang dan berikutnya. */
export async function setVerified(raw: string, on: boolean) {
  const username = cleanUsername(raw);
  if (!username) throw new Error('Username tidak valid');
  // Mengesahkan akun hasil impor menjadikannya akun sah "manual" (sudah kamu cek sendiri).
  if (on) await q("INSERT INTO bidders (username, verified_at, source) VALUES ($1, $2, 'manual') ON CONFLICT (username) DO UPDATE SET source = 'manual'", [username, iso(Date.now())]);
  else await q('DELETE FROM bidders WHERE username = $1', [username]);
}

/** Memasukkan banyak akun sekaligus ke daftar akun sah (mis. dari file followers). */
export async function importVerified(raw: unknown[]) {
  const names = [...new Set(raw.map((r) => cleanUsername(String(r))).filter((u): u is string => !!u))].slice(0, 50_000);
  let added = 0;
  for (let i = 0; i < names.length; i += 500) {
    const r = await q(
      `INSERT INTO bidders (username, verified_at, source)
       SELECT jsonb_array_elements_text($1::jsonb), $2::timestamptz, 'import' ON CONFLICT DO NOTHING RETURNING username`,
      [JSON.stringify(names.slice(i, i + 500)), iso(Date.now())],
    );
    added += r.length;
  }
  return { found: names.length, added };
}

/**
 * Menambahkan banyak akun sekaligus yang sudah kamu cek sendiri (mis. dari screenshot followers). Berbeda dari impor
 * file, akun ini berstatus akun sah biasa, dan akun hasil impor yang ikut disebut dinaikkan menjadi akun sah biasa.
 */
export async function addVerifiedMany(text: string) {
  const { valid, invalid } = splitUsernames(text);
  if (valid.length > 2000) throw new Error('Terlalu banyak sekaligus (maksimal 2.000 username)');
  let added = 0;
  let upgraded = 0;
  if (valid.length) {
    const json = JSON.stringify(valid);
    added = (await q(
      `INSERT INTO bidders (username, verified_at, source)
       SELECT jsonb_array_elements_text($1::jsonb), $2::timestamptz, 'manual' ON CONFLICT DO NOTHING RETURNING username`,
      [json, iso(Date.now())],
    )).length;
    upgraded = (await q(
      `UPDATE bidders SET source = 'manual' WHERE source = 'import' AND username IN (SELECT jsonb_array_elements_text($1::jsonb)) RETURNING username`,
      [json],
    )).length;
  }
  return { found: valid.length, added, upgraded, invalid };
}

/** Mengeluarkan semua akun hasil impor followers; akun yang kamu sahkan sendiri tidak ikut. */
export async function removeImported() {
  const r = await q("DELETE FROM bidders WHERE source = 'import' RETURNING username");
  return r.length;
}

export async function listVerified() {
  const r = await q('SELECT username, verified_at, source FROM bidders ORDER BY username');
  return r.map((b) => ({ username: b.username as string, at: toMs(b.verified_at)!, source: b.source as 'manual' | 'import' }));
}

const AUTO_WINDOW = 48 * 60 * MIN; // lelang yang close lebih lama dari ini tidak lagi ditetapkan otomatis
const AUTO_GRACE = 30_000; // beri waktu komentar menit-menit terakhir yang telat terbaca

/**
 * Menetapkan pemenang bawaan untuk lelang yang sudah close: bid sah tertinggi, kalau bid itu sudah kamu sahkan
 * atau akunnya ada di daftar akun sah. Hasil otomatis ikut berubah kalau keputusanmu berubah; hasil yang
 * kamu tetapkan sendiri tidak pernah disentuh.
 */
export async function syncAutoResults() {
  const now = Date.now();
  const posts = await q(`SELECT * FROM posts WHERE close_at IS NOT NULL AND close_at < $1 AND close_at > $2`, [iso(now - AUTO_GRACE), iso(now - AUTO_WINDOW)]);
  if (!posts.length) return;
  const ids = JSON.stringify(posts.map((p) => p.id));
  const [comments, results, me] = await Promise.all([
    q(`SELECT * FROM comments WHERE post_id IN (SELECT jsonb_array_elements_text($1::jsonb))`, [ids]),
    q(`SELECT * FROM results WHERE post_id IN (SELECT jsonb_array_elements_text($1::jsonb))`, [ids]),
    getKv<{ username: string }>('me'),
  ]);
  const names = JSON.stringify([...new Set(comments.map((c) => c.username as string))]);
  const sources = new Map(
    (await q(`SELECT username, source FROM bidders WHERE username IN (SELECT jsonb_array_elements_text($1::jsonb))`, [names])).map((b) => [b.username as string, b.source as 'manual' | 'import']),
  );
  const byPost = new Map<string, CommentIn[]>();
  for (const c of comments) {
    const list = byPost.get(c.post_id) || [];
    list.push({ id: c.id, parentId: c.parent_id, username: c.username, text: c.text, ts: toMs(c.ts)!, deleted: c.deleted_at != null, override: c.override });
    byPost.set(c.post_id, list);
  }
  const existing = new Map(results.map((r) => [r.post_id as string, r]));
  for (const p of posts) {
    const cur = existing.get(p.id);
    if (cur && !cur.auto) continue; // keputusan manual tidak disentuh
    const { top } = evaluate(byPost.get(p.id) || [], {
      openBid: p.open_bid, increment: p.increment, maxJump: p.max_jump, closeAt: toMs(p.close_at), ownUsername: me?.username || null,
      sniperMinBids: SNIPER_MIN_BIDS, verified: new Set(sources.keys()),
    });
    const why = autoWinnerReason(top, top ? sources.get(top.username) : undefined);
    if (!top || !why) {
      if (cur) await q('DELETE FROM results WHERE post_id = $1 AND auto', [p.id]);
      continue;
    }
    if (cur && cur.username === top.username && cur.amount === top.amount && cur.note === why) continue;
    await q(
      `INSERT INTO results (post_id, status, username, amount, title, close_at, decided_at, note, auto) VALUES ($1,'winner',$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (post_id) DO UPDATE SET status='winner', username=$2, amount=$3, title=$4, close_at=$5, decided_at=$6, note=$7, auto=true WHERE results.auto`,
      [p.id, top.username, top.amount, p.title, p.close_at, iso(Date.now()), why],
    );
  }
}

/**
 * Membalas komentar bidder di Instagram (mis. "bid 250rb sah yaa"). Balasan ke sebuah balasan dikirim ke
 * komentar induknya, karena Instagram hanya menerima balasan ke komentar tingkat atas.
 */
export async function replyToBid(commentId: string, text: string, again = false) {
  const message = String(text || '').trim();
  if (!message || message.length > 300) throw new Error('Balasan harus 1 sampai 300 karakter');
  const c = (await q('SELECT * FROM comments WHERE id = $1', [commentId]))[0];
  if (!c) throw new Error('Komentar tidak ditemukan');
  if (c.deleted_at) throw new Error('Komentar ini sudah dihapus di Instagram');
  // Ditandai dulu supaya dua ketukan beruntun tidak mengirim dua balasan.
  const claim = await q(
    `UPDATE comments SET replied_at = $2, reply_text = $3, reply_auto = false, reply_failed_at = NULL, reply_error = NULL
     WHERE id = $1 AND ($4::boolean OR replied_at IS NULL) RETURNING id`,
    [commentId, iso(Date.now()), message, again],
  );
  if (!claim.length) throw new Error('Komentar ini sudah kamu balas');
  try {
    await ig.postReply(c.parent_id || c.id, message);
  } catch (e) {
    await q(
      'UPDATE comments SET replied_at = $2, reply_text = $3, reply_auto = $4, reply_failed_at = $5, reply_error = $6 WHERE id = $1',
      [commentId, c.replied_at, c.reply_text, c.reply_auto, c.reply_failed_at, c.reply_error],
    );
    throw e;
  }
}

// ---------- Balasan otomatis ----------

const AUTO_REPLY_MAX_AGE = 15 * MIN; // bid yang lebih lama dari ini tidak dibalas otomatis
const AUTO_REPLY_PER_TICK = 5; // paling banyak sekian balasan per putaran, diberi jeda
const AUTO_REPLY_PER_HOUR = Math.max(1, Number(process.env.AUTO_REPLY_MAX_PER_HOUR ?? 40) || 40);
const autoReplyText = (total: number) => (process.env.AUTO_REPLY_TEXT || 'bid {total} sah yaa').replace('{total}', amountText(total));

export async function getAutoReply() {
  const v = await getKv<{ on: boolean; since: number }>('autoReply');
  return { on: !!v?.on, since: v?.since ?? null };
}

/** Menyalakan balasan otomatis. Hanya bid yang masuk setelah dinyalakan yang dibalas. */
export async function setAutoReply(on: boolean) {
  await setKv('autoReply', { on, since: Date.now() });
}

/**
 * Membalas "bid [total] sah yaa" ke bid berawalan "+" dari akun sah yang sudah "Disahkan otomatis". Aman diulang:
 * tiap komentar ditandai dulu sebelum dikirim, dan yang gagal tidak dicoba lagi (bisa dibalas manual).
 */
export async function autoReplies() {
  const cfg = await getAutoReply();
  if (!cfg.on || !cfg.since) return;
  const now = Date.now();
  const sentLastHour = Number((await q('SELECT count(*)::int AS n FROM comments WHERE replied_at > $1', [iso(now - 60 * MIN)]))[0]?.n ?? 0);
  let budget = Math.min(AUTO_REPLY_PER_TICK, AUTO_REPLY_PER_HOUR - sentLastHour);
  if (budget <= 0) return;

  const posts = await q(`SELECT * FROM posts WHERE close_at IS NULL OR close_at > $1`, [iso(now - 10 * MIN)]);
  if (!posts.length) return;
  const ids = JSON.stringify(posts.map((p) => p.id));
  const [comments, me] = await Promise.all([
    q(`SELECT * FROM comments WHERE post_id IN (SELECT jsonb_array_elements_text($1::jsonb))`, [ids]),
    getKv<{ username: string }>('me'),
  ]);
  const names = JSON.stringify([...new Set(comments.map((c) => c.username as string))]);
  const sources = await q(`SELECT username FROM bidders WHERE username IN (SELECT jsonb_array_elements_text($1::jsonb))`, [names]);
  const verified = new Set(sources.map((b) => b.username as string));
  const byPost = new Map<string, CommentIn[]>();
  for (const c of comments) {
    const list = byPost.get(c.post_id) || [];
    list.push({
      id: c.id, parentId: c.parent_id, username: c.username, text: c.text, ts: toMs(c.ts)!, deleted: c.deleted_at != null, override: c.override,
      repliedAt: toMs(c.replied_at), replyFailedAt: toMs(c.reply_failed_at),
    });
    byPost.set(c.post_id, list);
  }
  for (const p of posts) {
    if (budget <= 0) break;
    const { rows } = evaluate(byPost.get(p.id) || [], {
      openBid: p.open_bid, increment: p.increment, maxJump: p.max_jump, closeAt: toMs(p.close_at), ownUsername: me?.username || null,
      sniperMinBids: SNIPER_MIN_BIDS, verified,
    });
    for (const r of autoReplyTargets(rows, { since: cfg.since, now, maxAgeMs: AUTO_REPLY_MAX_AGE })) {
      if (budget <= 0) break;
      const message = `${r.parentId ? `@${r.username} ` : ''}${autoReplyText(r.amount!)}`;
      const claim = await q(
        `UPDATE comments SET replied_at = $2, reply_text = $3, reply_auto = true
         WHERE id = $1 AND replied_at IS NULL AND reply_failed_at IS NULL RETURNING id`,
        [r.id, iso(Date.now()), message],
      );
      if (!claim.length) continue; // sudah dibalas oleh proses lain
      budget--;
      try {
        await ig.postReply(r.parentId || r.id, message);
      } catch (e) {
        const msg = String((e as Error)?.message || e);
        await q(
          'UPDATE comments SET replied_at = NULL, reply_text = NULL, reply_auto = false, reply_failed_at = $2, reply_error = $3 WHERE id = $1',
          [r.id, iso(Date.now()), msg.slice(0, 300)],
        );
        await noteError(`Balasan otomatis ke @${r.username} gagal: ${msg}`);
      }
      await sleep(1200); // jeda antar balasan
    }
  }
}

// ---------- DM ke pemenang ----------

const dmTemplate = () => process.env.AUTO_DM_TEXT || DM_TEMPLATE;
const AUTO_DM_DELAY = Math.max(0, Number(process.env.AUTO_DM_DELAY_MIN ?? 3)) * MIN; // masa tenang setelah pemenang ditetapkan
const AUTO_DM_PER_TICK = 3;
const DM_WINDOW = 6.9 * 24 * 60 * MIN; // Instagram: DM lewat komentar paling lambat 7 hari sejak komentar dibuat

export async function getAutoDm() {
  const v = await getKv<{ on: boolean; since: number }>('autoDm');
  return { on: !!v?.on, since: v?.since ?? null };
}

/** Menyalakan DM otomatis. Hanya lelang yang close setelah dinyalakan yang diproses. */
export async function setAutoDm(on: boolean) {
  await setKv('autoDm', { on, since: Date.now() });
}

/** Menilai semua komentar sebuah lelang dengan aturan dan daftar akun sah yang berlaku sekarang. */
async function evalPost(postId: string) {
  const [post, comments, me] = await Promise.all([
    q('SELECT * FROM posts WHERE id = $1', [postId]),
    q('SELECT * FROM comments WHERE post_id = $1', [postId]),
    getKv<{ username: string }>('me'),
  ]);
  if (!post.length) return null;
  const names = JSON.stringify([...new Set(comments.map((c) => c.username as string))]);
  const sources = await q(`SELECT username FROM bidders WHERE username IN (SELECT jsonb_array_elements_text($1::jsonb))`, [names]);
  const p = post[0];
  const { rows } = evaluate(
    comments.map((c) => ({ id: c.id, parentId: c.parent_id, username: c.username, text: c.text, ts: toMs(c.ts)!, deleted: c.deleted_at != null, override: c.override })),
    { openBid: p.open_bid, increment: p.increment, maxJump: p.max_jump, closeAt: toMs(p.close_at), ownUsername: me?.username || null, sniperMinBids: SNIPER_MIN_BIDS, verified: new Set(sources.map((b) => b.username as string)) },
  );
  return { post: p, rows };
}

/**
 * Mengirim DM ke pemenang lewat komentarnya. Ditandai dulu supaya tidak terkirim dua kali; hasilnya (terkirim atau
 * gagal beserta alasannya) disimpan di hasil lelang.
 */
async function deliverDm(postId: string, username: string, comment: { id: string; ts: number }, text: string, auto: boolean) {
  if (Date.now() - comment.ts > DM_WINDOW) throw new Error('Komentar bid itu sudah lebih dari 7 hari, melewati batas Instagram untuk DM lewat komentar');
  const claim = await q(
    `UPDATE results SET dm_status = 'sending', dm_username = $2, dm_at = $3, dm_error = NULL, dm_auto = $4
     WHERE post_id = $1 AND status = 'winner' AND username = $2
       AND NOT ((COALESCE(dm_status, '') = 'sent' AND COALESCE(dm_username, '') = $2) OR (COALESCE(dm_status, '') = 'sending' AND dm_at > $5))
     RETURNING post_id`,
    [postId, username, iso(Date.now()), auto, iso(Date.now() - 5 * MIN)],
  );
  if (!claim.length) throw new Error('DM ke pemenang ini sudah terkirim atau sedang dikirim');
  try {
    await ig.sendPrivateReply(comment.id, text);
    await q(`UPDATE results SET dm_status = 'sent', dm_at = $2 WHERE post_id = $1`, [postId, iso(Date.now())]);
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 300);
    await q(`UPDATE results SET dm_status = 'failed', dm_error = $2 WHERE post_id = $1`, [postId, msg]);
    throw e;
  }
}

/** Kirim manual: untuk pemenang yang tidak memenuhi syarat DM otomatis, atau untuk mencoba pertama kali. */
export async function sendWinnerDm(postId: string, text: string) {
  const message = String(text || '').trim();
  if (message.length > 900) throw new Error('Pesan terlalu panjang');
  const res = (await q('SELECT * FROM results WHERE post_id = $1', [postId]))[0];
  if (!res || res.status !== 'winner') throw new Error('Belum ada pemenang yang ditetapkan');
  const finalText = message || dmMessage(dmTemplate(), res.title, res.amount);
  const ev = await evalPost(postId);
  if (!ev) throw new Error('Lelang tidak ditemukan');
  const mine = ev.rows.filter((r) => !r.own && !r.deleted && r.username === res.username);
  // Utamakan bid dengan nominal kemenangan, lalu komentar terbaru dari pemenang itu.
  const pick = [...mine.filter((r) => r.isBid && r.amount === res.amount), ...mine].sort((a, b) => Number(b.isBid && b.amount === res.amount) - Number(a.isBid && a.amount === res.amount) || b.ts - a.ts)[0];
  if (!pick) throw new Error('Tidak ada komentar pemenang ini yang bisa dibalas lewat DM');
  await deliverDm(postId, res.username, pick, finalText, false);
}

/**
 * DM otomatis ke pemenang: hanya untuk hasil lelang yang sudah lewat masa tenang, yang bid kemenangannya sudah
 * disahkan dan tidak melanggar aturan. Perubahan keputusan selama masa tenang membatalkannya. Yang gagal tidak
 * dicoba lagi otomatis.
 */
export async function autoDms() {
  const cfg = await getAutoDm();
  if (!cfg.on || !cfg.since) return;
  const now = Date.now();
  const due = await q(
    `SELECT * FROM results WHERE status = 'winner' AND close_at > $1 AND decided_at <= $2
       AND NOT ((COALESCE(dm_status, '') IN ('sent', 'failed') AND COALESCE(dm_username, '') = username)
             OR (COALESCE(dm_status, '') = 'sending' AND dm_at > $3))`,
    [iso(cfg.since), iso(now - AUTO_DM_DELAY), iso(now - 5 * MIN)],
  );
  let budget = AUTO_DM_PER_TICK;
  for (const res of due) {
    if (budget <= 0) break;
    const ev = await evalPost(res.post_id);
    if (!ev) continue;
    const bid = winnerBidForDm(ev.rows, { username: res.username, amount: res.amount });
    if (!bid) continue; // tidak memenuhi syarat: tidak ada DM otomatis, bisa dikirim manual
    budget--;
    try {
      await deliverDm(res.post_id, res.username, bid, dmMessage(dmTemplate(), res.title, res.amount), true);
    } catch (e) {
      await noteError(`DM otomatis ke @${res.username} gagal: ${String((e as Error)?.message || e)}`);
    }
    await sleep(1200);
  }
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
    `INSERT INTO results (post_id, status, username, amount, title, close_at, decided_at, note, auto) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
     ON CONFLICT (post_id) DO UPDATE SET status=$2, username=$3, amount=$4, title=$5, close_at=$6, decided_at=$7, note=$8, auto=false`,
    [postId, win ? 'winner' : 'none', win ? r.username : null, win ? Math.round(r.amount!) : null, post.title, post.close_at, iso(Date.now()), r.note ? String(r.note).slice(0, 200) : null],
  );
}

export async function setOverride(commentId: string, value: 'valid' | 'invalid' | 'wrong' | null) {
  const r = await q('UPDATE comments SET override = $2 WHERE id = $1 RETURNING username', [commentId, value]);
  // Sah memasukkan akun ke daftar akun sah. Tolak hanya membatalkan bid ini; daftar tidak berubah.
  if (r.length && value === 'valid') await setVerified(r[0].username, true);
}

export async function getState() {
  const [posts, comments, events, bidders, total, results, me, lastError, lastOk, autoReply, autoDm] = await Promise.all([
    q(`SELECT * FROM posts WHERE ${VISIBLE} ORDER BY close_at ASC NULLS LAST, posted_at ASC`),
    q(`SELECT c.* FROM comments c JOIN posts p ON p.id = c.post_id WHERE ${VISIBLE.replace(/close_at|in_latest/g, 'p.$&')}`),
    q('SELECT * FROM events'),
    q('SELECT b.username, b.source FROM bidders b WHERE b.username IN (SELECT DISTINCT username FROM comments)'),
    q('SELECT count(*)::int AS n FROM bidders'),
    q('SELECT * FROM results ORDER BY close_at DESC NULLS LAST'),
    getKv<{ username: string }>('me'),
    getKv<{ message: string; at: number }>('lastError'),
    getKv<number>('lastOk'),
    getAutoReply(),
    getAutoDm(),
  ]);

  const verified = new Set(bidders.map((b) => b.username as string));
  const imported = new Set(bidders.filter((b) => b.source === 'import').map((b) => b.username as string));
  const byPost = new Map<string, CommentIn[]>();
  for (const c of comments) {
    const list = byPost.get(c.post_id) || [];
    list.push({ id: c.id, parentId: c.parent_id, username: c.username, text: c.text, ts: toMs(c.ts)!, deleted: c.deleted_at != null, deletedAt: toMs(c.deleted_at), override: c.override, repliedAt: toMs(c.replied_at), repliedAuto: !!c.reply_auto, replyFailedAt: toMs(c.reply_failed_at), replyError: c.reply_error });
    byPost.set(c.post_id, list);
  }

  return {
    now: Date.now(),
    mock: ig.isMock(),
    setup: { token: ig.hasToken(), cron: !!process.env.CRON_SECRET },
    me: me?.username || null,
    lastError: lastError && (!lastOk || lastError.at > lastOk) ? lastError : null,
    texts: texts(),
    autoReply,
    autoDm,
    dmTemplate: dmTemplate(),
    verifiedCount: Number(total[0]?.n ?? 0),
    results: results.map((r) => ({
      postId: r.post_id as string, status: r.status as 'winner' | 'none', username: r.username as string | null,
      amount: r.amount as number | null, title: r.title as string, closeAt: toMs(r.close_at), note: r.note as string | null, auto: !!r.auto,
      dmText: dmMessage(dmTemplate(), r.title, r.amount),
      dm: r.dm_status ? { status: r.dm_status as 'sending' | 'sent' | 'failed', username: r.dm_username as string | null, at: toMs(r.dm_at), error: r.dm_error as string | null, auto: !!r.dm_auto } : null,
    })),
    posts: posts.map((p) => {
      const closeAt = toMs(p.close_at);
      const { rows, top } = evaluate(byPost.get(p.id) || [], {
        openBid: p.open_bid, increment: p.increment, maxJump: p.max_jump, closeAt, ownUsername: me?.username || null, sniperMinBids: SNIPER_MIN_BIDS, verified, imported,
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
