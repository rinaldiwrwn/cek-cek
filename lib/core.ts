// Inti sistem: sinkron postingan & komentar, komentar terjadwal, dan data untuk dashboard.
import { getKv, q, setKv } from './db';
import * as ig from './ig';
import { amountText, cleanUsername, parseBid, parseCaption, splitUsernames } from './parse';
import { dayKey, dayStart, DAY_MS, decideFollowup, recapMessage, REPLY_WINDOW_MS, NEW_CUSTOMER_TEXT, type Win } from './followup';
import { autoReplyTargets, autoWinnerReason, DM_TEMPLATE, dmMessage, evaluate, isTestAccount, SNIPER_MS, testAccounts, winnerBidForDm, type CommentIn } from './bids';

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

/** Membaca komentar sebuah postingan sekarang juga, tanpa menunggu jadwal berkala. */
export async function syncPostNow(postId: string) {
  const r = await q('UPDATE posts SET last_sync = $2 WHERE id = $1 RETURNING id', [postId, iso(Date.now())]);
  if (!r.length) throw new Error('Lelang tidak ditemukan');
  await syncComments(postId);
  await setKv('lastOk', Date.now());
}

/** Membaca komentar semua postingan yang tampil di dashboard sekarang juga. */
export async function syncAllComments() {
  const posts = await q(`SELECT id FROM posts WHERE ${VISIBLE}`);
  await Promise.all(posts.map((p) => syncPostNow(p.id).catch(noteError)));
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
  return 60 * MIN; // lelang lama tetap dibaca tiap jam supaya komentar barunya (termasuk bid uji) muncul di dashboard
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

// Lama permintaan kirim komentar ke Instagram (rata-rata bergerak). Komentar terjadwal dikirim lebih awal sebesar ini
// supaya tayang tepat di detiknya, bukan satu-dua detik sesudahnya.
const LEAD_FACTOR = 0.8;
const postLead = async () => {
  const v = await getKv<{ ms: number }>('postLatency').catch(() => null);
  return Math.round(Math.min(4000, (v?.ms ?? 2000) * LEAD_FACTOR));
};
async function noteLatency(ms: number) {
  if (!(ms >= 100 && ms <= 8000)) return;
  const prev = await getKv<{ ms: number }>('postLatency').catch(() => null);
  await setKv('postLatency', { ms: Math.round(prev ? prev.ms * 0.6 + ms * 0.4 : ms) }).catch(() => {});
}

async function send(postId: string, kind: Kind) {
  const message = texts()[kind];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const t0 = Date.now();
      const commentId = await ig.postComment(postId, message);
      await noteLatency(Date.now() - t0);
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
  return rows.filter((r) => r.isBid && r.valid && !r.isTest).length;
}

async function fire(ev: { post_id: string; kind: Kind; due_at: unknown }) {
  const due = toMs(ev.due_at)!;
  const gated = ev.kind === 'sniper' && SNIPER_MIN_BIDS > 0;
  const lead = await postLead();
  await sleep(due - Date.now() - lead - (gated ? 4500 : 2000));
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
  await ig.warm().catch(() => {});
  await sleep(due - lead - Date.now());
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
    // Di sekitar close, pemenang bawaan dan DM-nya diproses tiap putaran, tidak menunggu putaran berakhir.
    await syncAutoResults().catch(noteError);
    await autoDms().catch(noteError);
    if (!loop || !hot || Date.now() - started > 50_000) break;
    await sleep(4_000);
  }
  await syncAutoResults().catch(noteError);
  await autoDms().catch(noteError);
  await autoFollowups().catch(noteError);
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
// Jeda setelah close sebelum pemenang bawaan ditetapkan, supaya komentar menit-menit terakhir yang telat terbaca ikut dihitung.
const AUTO_GRACE = Math.max(0, Number(process.env.AUTO_RESULT_GRACE_SEC ?? 15)) * 1000;

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
// Masa tunggu setelah pemenang ditetapkan sebelum DM terkirim (bawaan 10 detik). Lelang sudah close, jadi bid sesudahnya
// tidak sah; jedanya hanya memberi kesempatan terakhir bagi keputusan yang kamu ubah.
const AUTO_DM_DELAY = (() => {
  const sec = process.env.AUTO_DM_DELAY_SEC;
  if (sec !== undefined && sec !== '') return Math.max(0, Number(sec) || 0) * 1000;
  const min = process.env.AUTO_DM_DELAY_MIN;
  if (min) return Math.max(0, Number(min) || 0) * MIN;
  return 10_000;
})();
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
    const sent = await ig.sendPrivateReply(comment.id, text);
    await q(`UPDATE results SET dm_status = 'sent', dm_at = $2, dm_recipient = $3 WHERE post_id = $1`, [postId, iso(Date.now()), sent.recipientId || null]);
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 500);
    if ((e as { ambiguous?: boolean })?.ambiguous) {
      // Instagram kadang melapor error padahal DM-nya sampai. Tandai "belum pasti", jangan dicoba lagi otomatis.
      const note = `${msg} (DM mungkin tetap terkirim, cek kotak pesan penerima)`;
      await q(`UPDATE results SET dm_status = 'unsure', dm_error = $2 WHERE post_id = $1`, [postId, note]);
      throw new Error(note);
    }
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
  const link = (await q('SELECT permalink FROM posts WHERE id = $1', [postId]))[0]?.permalink;
  const finalText = message || dmMessage(dmTemplate(), res.title, res.amount, link);
  const ev = await evalPost(postId);
  if (!ev) throw new Error('Lelang tidak ditemukan');
  const mine = ev.rows.filter((r) => !r.own && !r.deleted && r.username === res.username);
  // Utamakan bid dengan nominal kemenangan, lalu komentar terbaru dari pemenang itu.
  const pick = [...mine.filter((r) => r.isBid && r.amount === res.amount), ...mine].sort((a, b) => Number(b.isBid && b.amount === res.amount) - Number(a.isBid && a.amount === res.amount) || b.ts - a.ts)[0];
  if (!pick) throw new Error('Tidak ada komentar pemenang ini yang bisa dibalas lewat DM');
  await deliverDm(postId, res.username, pick, finalText, false);
}

/**
 * Uji kirim DM ke akun lain (mis. akun kedua milikmu) tanpa menetapkan pemenang atau mengubah apa pun di dashboard.
 * Membalas komentar terbaru akun itu di lelang yang dipilih, dengan isi DM pemenang ditambah tautan postingannya.
 * Satu komentar hanya bisa dibalas satu kali oleh Instagram, jadi tiap uji butuh komentar baru.
 */
export async function testDm(postId: string, rawUser: string, text?: string, preview = false) {
  const username = cleanUsername(rawUser);
  if (!username) throw new Error('Username tidak valid');
  const post = (await q('SELECT title, permalink FROM posts WHERE id = $1', [postId]))[0];
  if (!post) throw new Error('Lelang tidak ditemukan');
  type C = { id: string; parentId: string | null; text: string; ts: number };
  let cands: C[] = (await q('SELECT id, parent_id, text, ts FROM comments WHERE post_id = $1 AND username = $2 AND deleted_at IS NULL ORDER BY ts DESC', [postId, username]))
    .map((c) => ({ id: c.id, parentId: c.parent_id, text: c.text, ts: toMs(c.ts)! }));
  if (!cands.length) {
    // Postingan lama tidak disinkronkan lagi, jadi komentarnya dibaca langsung dari Instagram, tanpa disimpan.
    cands = (await ig.listComments(postId)).filter((c) => c.username === username).sort((a, b) => b.ts - a.ts);
  }
  if (!cands.length) throw new Error(`Belum ada komentar dari @${username} di postingan ini. Tulis komentar dulu dari akun itu, lalu coba lagi.`);
  const pick = cands.find((c) => !c.parentId) ?? cands[0];
  const parsed = parseBid(pick.text);
  const tpl = dmTemplate();
  // Harga uji dibaca dari komentar angka biasa ("tes, 300"). Kalau tidak terbaca, dipakai harga contoh dan diberi tahu.
  const hargaContoh = parsed?.kind !== 'abs';
  const harga = parsed?.kind === 'abs' ? amountText(parsed.value) : amountText(300);
  const message = dmMessage((tpl.includes('{tautan}') ? tpl : `${tpl}\n{tautan}`).replace(/\{harga\}/g, harga), post.title, null, post.permalink);
  if (preview) return { username, comment: pick.text, commentAt: pick.ts, hargaContoh, text: message };
  const final = String(text || '').trim() || message;
  if (final.length > 900) throw new Error('Pesan terlalu panjang');
  if (Date.now() - pick.ts > DM_WINDOW) throw new Error('Komentar itu sudah lebih dari 7 hari, melewati batas Instagram untuk DM lewat komentar');
  await ig.sendPrivateReply(pick.id, final);
  return { username, comment: pick.text, text: final, sent: true };
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
    `SELECT * FROM results WHERE status = 'winner' AND close_at > $1 AND close_at < $4 AND decided_at <= $2
       AND NOT ((COALESCE(dm_status, '') IN ('sent', 'failed', 'unsure') AND COALESCE(dm_username, '') = username)
             OR (COALESCE(dm_status, '') = 'sending' AND dm_at > $3))`,
    [iso(cfg.since), iso(now - AUTO_DM_DELAY), iso(now - 5 * MIN), iso(now)],
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
      const link = (await q('SELECT permalink FROM posts WHERE id = $1', [res.post_id]))[0]?.permalink;
      await deliverDm(res.post_id, res.username, bid, dmMessage(dmTemplate(), res.title, res.amount, link), true);
    } catch (e) {
      await noteError(`DM otomatis ke @${res.username} gagal/belum pasti: ${String((e as Error)?.message || e)}`);
    }
    await sleep(1200);
  }
}

// ---------- Chat lanjutan setelah DM pemenang ----------
// Setelah pemenang membalas DM-nya, dikirim pesan lanjutan: rekap total untuk pelanggan lama (ada di daftar, lengkap
// dengan ongkir), atau permintaan alamat untuk pelanggan baru. Instagram hanya mengizinkan pesan kedua setelah
// pelanggan membalas, jadi balasannya dicek lewat percakapan.
const FOLLOWUP_MAX_AGE = 48 * 60 * MIN; // setelah ini grupnya tidak dicek lagi otomatis
const FOLLOWUP_CHECK_GAP = 30_000; // tiap grup dicek paling sering sekali per 30 detik
const FOLLOWUPS_PER_TICK = 6;
const transferInfo = () => process.env.TRANSFER_INFO || '';
const newCustomerText = () => process.env.FOLLOWUP_NEW_TEXT || NEW_CUSTOMER_TEXT;

export async function getAutoFollowup() {
  const v = await getKv<{ on: boolean; since: number }>('autoFollowup');
  return { on: !!v?.on, since: v?.since ?? null };
}

/** Menyalakan chat lanjutan. Hanya DM pemenang yang terkirim setelah dinyalakan yang diproses. */
export async function setAutoFollowup(on: boolean) {
  await setKv('autoFollowup', { on, since: Date.now() });
}

export async function setCustomer(rawUser: string, ongkir: number, greeting: string) {
  const username = cleanUsername(rawUser);
  if (!username) throw new Error('Username tidak valid');
  if (!Number.isFinite(ongkir) || ongkir < 0 || ongkir > 100_000) throw new Error('Ongkir tidak valid (isi dalam ribuan, mis. 18)');
  await q(
    `INSERT INTO customers (username, ongkir, greeting, updated_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (username) DO UPDATE SET ongkir = $2, greeting = $3, updated_at = $4`,
    [username, Math.round(ongkir), greeting === 'ka' ? 'ka' : 'om', iso(Date.now())],
  );
}

export async function removeCustomer(rawUser: string) {
  await q('DELETE FROM customers WHERE username = $1', [cleanUsername(rawUser) || '']);
}

/** Mengumpulkan data satu pemenang pada satu hari (WIB): kemenangan, DM-nya, dan lelang yang belum selesai. */
async function followupContext(username: string, day: string) {
  const start = dayStart(day);
  const now = Date.now();
  const [wins, undecided, customer] = await Promise.all([
    q(`SELECT post_id, amount, close_at, dm_status, dm_username, dm_at, dm_recipient FROM results
       WHERE status = 'winner' AND username = $1 AND close_at >= $2 AND close_at < $3 ORDER BY close_at`, [username, iso(start), iso(start + DAY_MS)]),
    q(`SELECT count(*)::int AS n FROM posts p WHERE p.close_at >= $1 AND p.close_at < $2
         AND (p.close_at > $3 OR (p.close_at > $4 AND NOT EXISTS (SELECT 1 FROM results r WHERE r.post_id = p.id)))`,
      [iso(start), iso(start + DAY_MS), iso(now), iso(now - 2 * 60 * MIN)]),
    q('SELECT ongkir, greeting FROM customers WHERE username = $1', [username]),
  ]);
  const sent = wins.filter((w) => w.dm_status === 'sent' && w.dm_username === username);
  const recipient = [...sent].sort((a, b) => toMs(b.dm_at)! - toMs(a.dm_at)!).find((w) => w.dm_recipient)?.dm_recipient as string | undefined;
  const winList: Win[] = wins.map((w) => ({ postId: w.post_id, amount: w.amount, closeAt: toMs(w.close_at)!, dmSent: w.dm_status === 'sent' && w.dm_username === username }));
  return {
    wins: winList,
    undecided: Number(undecided[0]?.n ?? 0),
    customer: customer.length ? { ongkir: customer[0].ongkir as number, greeting: customer[0].greeting as string } : null,
    firstDmAt: sent.length ? Math.min(...sent.map((w) => toMs(w.dm_at)!)) : now,
    recipient: recipient || null,
  };
}

const FU_OPEN = ['waiting'];

/**
 * Memeriksa satu grup (pemenang + hari): sudah membalas atau belum, lalu mengirim pesan lanjutan kalau syaratnya terpenuhi.
 * manual = dikirim dari tombol: boleh melewati syarat menunggu lelang lain, dan galat dilempar ke pemanggil.
 */
export async function processFollowup(username: string, day: string, manual = false) {
  const now = Date.now();
  await q(`INSERT INTO followups (username, day, status) VALUES ($1,$2,'waiting') ON CONFLICT DO NOTHING`, [username, day]);
  const row = (await q('SELECT * FROM followups WHERE username = $1 AND day = $2', [username, day]))[0];
  if (row.status === 'sending' || row.status === 'sent') {
    if (manual) throw new Error(row.status === 'sent' ? 'Chat lanjutan sudah terkirim' : 'Chat lanjutan sedang dikirim');
    return;
  }
  if (!manual && !FU_OPEN.includes(row.status)) return;
  if (!manual && row.checked_at && now - toMs(row.checked_at)! < FOLLOWUP_CHECK_GAP) return;

  const ctx = await followupContext(username, day);
  const fail = async (msg: string) => {
    await q(`UPDATE followups SET checked_at = $3, reason = $4 WHERE username = $1 AND day = $2`, [username, day, iso(now), msg.slice(0, 300)]);
    if (manual) throw new Error(msg);
  };
  if (!ctx.recipient) return fail('ID penerima DM belum tersimpan (DM dikirim sebelum fitur ini ada, atau Instagram tidak mengembalikannya)');
  let lastReplyAt: number | null = null;
  let debug = '';
  try {
    const r = await ig.lastCustomerMessageAt(ctx.recipient, username);
    lastReplyAt = r.at;
    debug = r.debug;
  } catch (e) {
    debug = `gagal membaca: ${String((e as Error)?.message || e)}`;
    if (!manual) {
      await noteError(`Membaca balasan @${username} gagal: ${String((e as Error)?.message || e)}`);
      return fail(`Gagal membaca balasan: ${String((e as Error)?.message || e)}`);
    }
  }
  // Kirim manual: kamu sudah memutuskan, jadi yang menentukan boleh atau tidaknya adalah Instagram sendiri
  // (pesan di luar jendela 24 jam ditolak dengan error yang ditampilkan), bukan pembacaan balasan di atas.
  if (manual) lastReplyAt = now;
  const d = decideFollowup({ now, wins: ctx.wins, customer: ctx.customer, lastReplyAt, firstDmAt: ctx.firstDmAt, undecided: ctx.undecided, transfer: transferInfo(), newText: newCustomerText(), force: manual });
  if (d.action === 'wait') return fail(debug ? `${d.reason} (${debug})` : d.reason);
  if (d.action === 'expired') {
    await q(`UPDATE followups SET status = 'expired', checked_at = $3, reason = $4 WHERE username = $1 AND day = $2`, [username, day, iso(now), d.reason]);
    if (manual) throw new Error(d.reason);
    return;
  }
  const claim = await q(
    `UPDATE followups SET status = 'sending', kind = $3, text = $4, checked_at = $5, reason = NULL, error = NULL
     WHERE username = $1 AND day = $2 AND status IN ('waiting','failed','expired','unsure') RETURNING username`,
    [username, day, d.kind, d.text, iso(now)],
  );
  if (!claim.length) return;
  try {
    await ig.sendMessage(ctx.recipient, d.text);
    await q(`UPDATE followups SET status = 'sent', sent_at = $3 WHERE username = $1 AND day = $2`, [username, day, iso(Date.now())]);
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 500);
    const unsure = !!(e as { ambiguous?: boolean })?.ambiguous;
    const note = unsure ? `${msg} (pesan mungkin tetap terkirim, cek kotak pesan penerima)` : msg;
    await q(`UPDATE followups SET status = $3, error = $4 WHERE username = $1 AND day = $2`, [username, day, unsure ? 'unsure' : 'failed', note]);
    await noteError(`Chat lanjutan ke @${username} ${unsure ? 'belum pasti' : 'gagal'}: ${note}`);
    if (manual) throw new Error(note);
  }
}

/** Dipanggil tiap tick: memeriksa pemenang yang DM-nya sudah terkirim dan belum diberi chat lanjutan. */
export async function autoFollowups() {
  const cfg = await getAutoFollowup();
  if (!cfg.on || !cfg.since) return;
  const now = Date.now();
  const cand = await q(
    `SELECT username, close_at FROM results WHERE status = 'winner' AND dm_status = 'sent' AND dm_username = username
       AND dm_recipient IS NOT NULL AND dm_at >= $1 AND dm_at > $2`,
    [iso(cfg.since), iso(now - FOLLOWUP_MAX_AGE)],
  );
  const groups = new Map<string, { username: string; day: string }>();
  for (const c of cand) {
    const day = dayKey(toMs(c.close_at)!);
    groups.set(`${c.username}|${day}`, { username: c.username, day });
  }
  let budget = FOLLOWUPS_PER_TICK;
  for (const g of groups.values()) {
    if (budget <= 0) break;
    budget--;
    await processFollowup(g.username, g.day).catch(noteError);
  }
}

/** Diagnosis: apa yang dilihat Instagram untuk pemenang ini (langganan webhook dan isi percakapan). Tidak mengirim apa pun. */
export async function diagnoseFollowup(username: string, day: string) {
  const ctx = await followupContext(username, day);
  return ig.diagnoseChat(ctx.recipient, username);
}

/** Isi chat lanjutan yang akan dikirim untuk sebuah grup, kalau pelanggannya sudah membalas (untuk ditampilkan di dashboard). */
async function followupPreview(username: string, day: string) {
  const ctx = await followupContext(username, day);
  const d = decideFollowup({ now: Date.now(), wins: ctx.wins, customer: ctx.customer, lastReplyAt: Date.now(), firstDmAt: 0, undecided: ctx.undecided, transfer: transferInfo(), newText: newCustomerText(), force: true });
  return d.action === 'send' ? { kind: d.kind, text: d.text } : null;
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
  const [posts, comments, events, bidders, total, results, me, lastError, lastOk, autoReply, autoDm, autoFollowup, customers, followupRows] = await Promise.all([
    q(`SELECT * FROM posts WHERE ${VISIBLE} ORDER BY close_at ASC NULLS LAST, posted_at ASC`),
    q(`SELECT c.* FROM comments c JOIN posts p ON p.id = c.post_id WHERE ${VISIBLE.replace(/close_at|in_latest/g, 'p.$&')}`),
    q('SELECT e.*, c.ts AS ig_ts FROM events e LEFT JOIN comments c ON c.id = e.comment_id'),
    q('SELECT b.username, b.source FROM bidders b WHERE b.username IN (SELECT DISTINCT username FROM comments)'),
    q('SELECT count(*)::int AS n FROM bidders'),
    q('SELECT r.*, p.permalink FROM results r LEFT JOIN posts p ON p.id = r.post_id ORDER BY r.close_at DESC NULLS LAST'),
    getKv<{ username: string }>('me'),
    getKv<{ message: string; at: number }>('lastError'),
    getKv<number>('lastOk'),
    getAutoReply(),
    getAutoDm(),
    getAutoFollowup(),
    q('SELECT username, ongkir, greeting FROM customers ORDER BY username'),
    q(`SELECT * FROM followups WHERE day >= $1 ORDER BY day DESC, username`, [dayKey(Date.now() - 3 * DAY_MS)]),
  ]);
  const followups: { username: string; day: string; status: 'waiting' | 'sending' | 'sent' | 'failed' | 'unsure' | 'expired'; kind: 'recap' | 'new' | null; text: string | null; reason: string | null; error: string | null; sentAt: number | null; preview: { kind: 'recap' | 'new'; text: string } | null }[] = await Promise.all(
    followupRows.map(async (f) => ({
      username: f.username as string, day: f.day as string, status: f.status as 'waiting' | 'sending' | 'sent' | 'failed' | 'unsure' | 'expired',
      kind: f.kind as 'recap' | 'new' | null, text: f.text as string | null, reason: f.reason as string | null, error: f.error as string | null, sentAt: toMs(f.sent_at),
      preview: f.status === 'sent' || f.status === 'sending' ? null : await followupPreview(f.username, f.day).catch(() => null),
    })),
  );

  // Pemenang yang DM-nya sudah terkirim tapi belum punya catatan chat lanjutan (mis. DM terkirim sebelum fitur dinyalakan)
  // tetap ditampilkan, supaya statusnya jelas dan chat lanjutannya bisa dikirim manual.
  {
    const have = new Set(followups.map((f) => `${f.username}|${f.day}`));
    const oldest = dayKey(Date.now() - 3 * DAY_MS);
    for (const r of results) {
      if (r.status !== 'winner' || r.dm_status !== 'sent' || r.dm_username !== r.username || !r.close_at) continue;
      const day = dayKey(toMs(r.close_at)!);
      const key = `${r.username}|${day}`;
      if (day < oldest || have.has(key)) continue;
      have.add(key);
      const early = autoFollowup.on && autoFollowup.since != null && toMs(r.dm_at)! < autoFollowup.since;
      const reason = !r.dm_recipient
        ? 'ID penerima DM tidak tersimpan, jadi balasannya tidak bisa dicek'
        : !autoFollowup.on ? 'Auto-chat lanjutan mati'
        : early ? 'DM terkirim sebelum auto-chat dinyalakan, tidak diproses otomatis' : 'Belum dicek';
      followups.push({ username: r.username as string, day, status: 'waiting', kind: null, text: null, reason, error: null, sentAt: null, preview: await followupPreview(r.username, day).catch(() => null) });
    }
  }

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
    autoFollowup,
    customers: customers.map((c) => ({ username: c.username as string, ongkir: c.ongkir as number, greeting: c.greeting as 'om' | 'ka' })),
    followups,
    transferSet: !!transferInfo(),
    dmDelaySec: AUTO_DM_DELAY / 1000,
    dmTemplate: dmTemplate(),
    testAccounts: [...testAccounts()],
    verifiedCount: Number(total[0]?.n ?? 0),
    results: results.map((r) => ({
      postId: r.post_id as string, status: r.status as 'winner' | 'none', username: r.username as string | null,
      amount: r.amount as number | null, title: r.title as string, closeAt: toMs(r.close_at), note: r.note as string | null, auto: !!r.auto,
      dmText: dmMessage(dmTemplate(), r.title, r.amount, r.permalink),
      test: isTestAccount(r.username),
      dm: r.dm_status ? { status: r.dm_status as 'sending' | 'sent' | 'failed' | 'unsure', username: r.dm_username as string | null, at: toMs(r.dm_at), error: r.dm_error as string | null, auto: !!r.dm_auto } : null,
    })),
    posts: posts.map((p) => {
      const closeAt = toMs(p.close_at);
      const { rows, top } = evaluate(byPost.get(p.id) || [], {
        openBid: p.open_bid, increment: p.increment, maxJump: p.max_jump, closeAt, ownUsername: me?.username || null, sniperMinBids: SNIPER_MIN_BIDS, verified, imported,
      });
      const ev: Record<string, unknown> = {};
      for (const e of events) {
        if (e.post_id === p.id) ev[e.kind] = { dueAt: toMs(e.due_at), status: e.status, sentAt: toMs(e.sent_at), igAt: toMs(e.ig_ts), error: e.error };
      }
      return {
        id: p.id as string, title: p.title as string, permalink: p.permalink as string, thumb: p.thumb as string | null,
        closeAt, openBid: p.open_bid as number | null, increment: p.increment as number | null, maxJump: p.max_jump as number | null,
        autoComment: p.auto_comment as boolean, lastSync: toMs(p.last_sync),
        events: ev as Partial<Record<Kind, { dueAt: number; status: string; sentAt: number | null; igAt: number | null; error: string | null }>>,
        top: top ? { amount: top.amount!, username: top.username, ts: top.ts } : null,
        rows: rows.reverse(),
      };
    }),
  };
}

export type State = Awaited<ReturnType<typeof getState>>;
