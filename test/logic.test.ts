import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsernames, parseBid, parseCaption, splitUsernames } from '../lib/parse';
import { autoReplyTargets, autoWinnerReason, evaluate, winnerBidForDm, type CommentIn } from '../lib/bids';

const CAPTION = `⌚️ LELANG DIMULAI ⌚️
Mohon 𝗕𝗔𝗖𝗔 𝗗𝗘𝗦𝗞𝗥𝗜𝗣𝗦𝗜

✅ OPEN BID: 100rb
✅ Kelipatan Bid: 50rb
✅ Max Jump Bid: 300rb
🔥 NO BIN 🔥

⌚️Disney Mickey Mouse By Sega Quartz Watch⌚️
Diameter: 47mm

⏺️ DIMULAI: SEKARANG
⏺️ TUTUP: Senin 16/11/2026
⏺️ PUKUL: 19:00 WIB, LEWAT 1 DETIK TIDAK SAH
❕𝗕𝗜𝗔𝗬𝗔 𝗣𝗔𝗖𝗞𝗜𝗡𝗚 sebesar 5rb/lelang`;

const CLOSE = Date.UTC(2026, 10, 16, 12, 0, 0); // 19:00 WIB

test('caption', () => {
  assert.deepEqual(parseCaption(CAPTION), {
    title: 'Disney Mickey Mouse By Sega Quartz Watch',
    openBid: 100, increment: 50, maxJump: 300, closeAt: CLOSE,
  });
  assert.equal(parseCaption('halo semua').closeAt, null);
});

test('bid dari komentar', () => {
  const v = (s: string) => parseBid(s);
  assert.deepEqual(v('150'), { kind: 'abs', value: 150, sure: true });
  assert.deepEqual(v('2.100'), { kind: 'abs', value: 2100, sure: true });
  assert.deepEqual(v('2500'), { kind: 'abs', value: 2500, sure: true });
  assert.deepEqual(v('+50'), { kind: 'rel', value: 50, sure: true });
  assert.deepEqual(v('+ 50'), { kind: 'rel', value: 50, sure: true });
  assert.deepEqual(v('bid 200'), { kind: 'abs', value: 200, sure: true });
  assert.deepEqual(v('150rb'), { kind: 'abs', value: 150, sure: true });
  assert.deepEqual(v('1,5jt'), { kind: 'abs', value: 1500, sure: true });
  assert.deepEqual(v('150.000'), { kind: 'abs', value: 150, sure: true });
  assert.deepEqual(v('150 🙏'), { kind: 'abs', value: 150, sure: true });
  assert.deepEqual(v('@teman 300 gan'), { kind: 'abs', value: 300, sure: true });
  assert.deepEqual(v('bid 250k'), { kind: 'abs', value: 250, sure: true });
  assert.deepEqual(v('ob 100'), { kind: 'abs', value: 100, sure: true });
  assert.deepEqual(v('OB gan'), { kind: 'ob', value: 0, sure: true });
  assert.deepEqual(v('300 kalau boleh nego'), { kind: 'abs', value: 300, sure: false });
  assert.equal(v('obral ya'), null);
  assert.equal(v('diameter 47mm ya?'), null);
  assert.equal(v('close jam 19:00?'), null);
  assert.equal(v('mantap min'), null);
});

const c = (id: number, username: string, text: string, secBeforeClose: number, extra: Partial<CommentIn> = {}): CommentIn => ({
  id: String(id), parentId: null, username, text, ts: CLOSE - secBeforeClose * 1000, deleted: false, override: null, ...extra,
});
const rules = { openBid: 100, increment: 50, maxJump: 300, closeAt: CLOSE, ownUsername: 'lelang' };

test('banyak username sekaligus', () => {
  const r = splitUsernames('@Himalaya.auto, cos_jam_\nwarung_jam_second  nama salah!  himalaya.auto\n@x');
  assert.deepEqual(r.valid, ['himalaya.auto', 'cos_jam_', 'warung_jam_second', 'nama', 'salah', 'x'].filter((u) => u !== 'salah'));
  assert.deepEqual(r.invalid, ['salah!']);
  assert.deepEqual(splitUsernames('').valid, []);
});

test('username dari file followers', () => {
  const lama = JSON.stringify([
    { title: '', media_list_data: [], string_list_data: [{ href: 'https://www.instagram.com/budi.watch', value: 'budi.watch', timestamp: 1 }] },
    { title: '', string_list_data: [{ href: 'https://www.instagram.com/Tono_Jam', value: 'Tono_Jam', timestamp: 2 }] },
  ]);
  assert.deepEqual(extractUsernames(lama), ['budi.watch', 'tono_jam']);
  const baru = JSON.stringify({ relationships_followers: [{ title: 'arloji_sby', string_list_data: [{ href: 'https://www.instagram.com/_u/arloji_sby', timestamp: 3 }] }] });
  assert.deepEqual(extractUsernames(baru), ['arloji_sby']);
  const html = '<a target="_blank" href="https://www.instagram.com/kolektor88">kolektor88</a><a href="https://www.instagram.com/dimas_r">dimas_r</a>';
  assert.deepEqual(extractUsernames(html), ['kolektor88', 'dimas_r']);
  assert.deepEqual(extractUsernames('@satu\ndua, tiga!\nsatu'), ['satu', 'dua']);
});

test('penilaian bid', () => {
  const { rows, top } = evaluate(
    [
      c(1, 'a', '100', 3600),
      c(2, 'b', '+50', 3000), // 150
      c(3, 'c', '120', 2900), // tidak naik + bukan kelipatan
      c(4, 'a', '600', 2800), // lewat max jump
      c(5, 'lelang', '🎯 SNIPER ZONE! 🎯', 300),
      c(6, 'a', '+50', 200), // 200, berhak sniper
      c(7, 'z', '+50', 100), // belum pernah bid
      c(8, 'b', '+50', 0), // 250, tepat di jam close masih sah
      c(9, 'a', '+50', -1), // terlambat 1 detik
    ],
    rules,
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by[2].amount, 150);
  assert.deepEqual(by[3].flags, ['tidakNaik', 'kelipatan']);
  assert.deepEqual(by[4].flags, ['maxJump']);
  assert.equal(by[5].isBid, false);
  assert.equal(by[6].valid, true);
  assert.deepEqual(by[7].flags, ['sniper']);
  assert.equal(by[8].valid, true);
  assert.deepEqual(by[9].flags, ['terlambat']);
  assert.equal(top?.id, '8');
  assert.equal(top?.amount, 250);
});

test('Sniper Zone tidak aktif kalau bid sah kurang dari 2', () => {
  // Hanya 1 bid sah sebelum sniper zone: aturan sniper tidak berlaku, bid dari akun baru tetap masuk.
  const sepi = evaluate([c(1, 'a', '100', 3600), c(2, 'z', '+50', 100)], rules);
  assert.deepEqual(sepi.rows[1].flags, []);
  assert.equal(sepi.rows[1].valid, true);
  // 2 bid sah sebelum sniper zone: aktif, akun baru ditandai.
  const ramai = evaluate([c(1, 'a', '100', 3600), c(2, 'b', '+50', 3000), c(3, 'z', '+50', 100)], rules);
  assert.deepEqual(ramai.rows[2].flags, ['sniper']);
  assert.equal(ramai.rows[2].valid, false);
  // Bid yang kamu tolak tidak dihitung untuk mengaktifkan Sniper Zone.
  const tolak = evaluate([c(1, 'a', '100', 3600), c(2, 'b', '+50', 3000, { override: 'invalid' }), c(3, 'z', '+50', 100)], rules);
  assert.deepEqual(tolak.rows[2].flags, []);
});

test('bid dari akun sah disahkan otomatis', () => {
  const { rows } = evaluate(
    [
      c(1, 'a', '100', 3600), // akun sah, tanpa penanda
      c(2, 'b', '100', 3500), // akun sah, tapi sama dengan bid sebelumnya
      c(3, 'a', '+50', 3400), // akun sah, 150
      c(4, 'z', '+50', 3300), // bukan akun sah
      c(5, 'b', '+50', 3200, { deleted: true }), // akun sah, tapi bid dihapus
      c(6, 'a', '+50', 3100, { override: 'invalid' }), // keputusanmu menang
      c(7, 'a', '600', 3000), // akun sah, tapi lewat max jump
    ],
    { ...rules, verified: new Set(['a', 'b']) },
  );
  assert.deepEqual(rows.map((r) => r.autoApproved), [true, false, true, false, false, false, false]);
  assert.deepEqual(rows.map((r) => r.relative), [false, false, true, true, true, true, false]);
  assert.deepEqual(rows[1].flags, ['tidakNaik']);
  assert.equal(rows[3].valid, true); // bukan akun sah: tetap dihitung sementara, tapi belum dicek
});

test('balasan otomatis hanya untuk bid + yang disahkan otomatis dan masih baru', () => {
  const now = CLOSE - 3_000_000;
  const since = now - 2_000_000;
  const { rows } = evaluate(
    [
      c(1, 'a', '100', 3600), // sebelum fitur dinyalakan
      c(2, 'a', '+50', 3200), // akun sah, baru, berawalan +  -> dibalas
      c(3, 'z', '+50', 3100), // bukan akun sah
      c(4, 'a', '+50', 3050, { repliedAt: 1 }), // sudah dibalas
      c(5, 'a', '+50', 3040, { replyFailedAt: 1 }), // pernah gagal
      c(6, 'a', '300', 3030), // bukan berawalan +
      c(7, 'a', '+50', 3020, { deleted: true }), // terhapus
      c(8, 'a', '+50', 4100), // lama: lewat batas umur
    ],
    { ...rules, verified: new Set(['a']) },
  );
  const ids = autoReplyTargets(rows, { since, now, maxAgeMs: 900_000 }).map((r) => r.id);
  assert.deepEqual(ids, ['2']);
});

test('total bid + yang bergantung pada bid belum dicek tidak dibalas otomatis', () => {
  const now = CLOSE - 3_000_000;
  const opts = { since: now - 2_000_000, now, maxAgeMs: 900_000 };
  const comments = [
    c(1, 'b', '100', 3600), // akun sah, angka biasa: pasti
    c(2, 'u', '+50', 3300), // akun BELUM dicek, +50: total 150 belum pasti
    c(3, 'a', '+50', 3200), // akun sah, +50: totalnya 200 bergantung pada bid 'u'
  ];
  const v = { ...rules, verified: new Set(['a', 'b']) };
  const before = evaluate(comments, v).rows;
  assert.equal(before[2].autoApproved, true);
  assert.equal(before[2].amount, 200);
  assert.equal(before[2].solid, false); // acuannya belum dicek
  assert.deepEqual(autoReplyTargets(before, opts).map((r) => r.id), []);

  // 'u' disahkan manual: rantainya pasti, bid 'a' berhak dibalas.
  const sah = evaluate(comments.map((x) => (x.id === '2' ? { ...x, override: 'valid' as const } : x)), v).rows;
  assert.equal(sah[1].solid, true);
  assert.deepEqual(autoReplyTargets(sah, opts).map((r) => r.id), ['3']);

  // 'u' ditolak: total bid 'a' dihitung ulang dari bid 100 menjadi 150, dan rantainya pasti.
  const tolak = evaluate(comments.map((x) => (x.id === '2' ? { ...x, override: 'invalid' as const } : x)), v).rows;
  assert.equal(tolak[2].amount, 150);
  assert.deepEqual(autoReplyTargets(tolak, opts).map((r) => r.id), ['3']);

  // Acuannya angka biasa dari akun yang belum dicek juga membuat totalnya belum pasti.
  const abs = evaluate([c(1, 'u', '100', 3600), c(2, 'a', '+50', 3300)], v).rows;
  assert.equal(abs[1].solid, false);
});

test('DM pemenang hanya untuk bid yang disahkan dan tidak melanggar aturan', () => {
  const v = { ...rules, verified: new Set(['a', 'b']) };
  const win = (cs: CommentIn[], user: string, amount: number) => winnerBidForDm(evaluate(cs, v).rows, { username: user, amount })?.id ?? null;

  // akun sah, bid bersih: boleh
  assert.equal(win([c(1, 'a', '100', 3600), c(2, 'b', '150', 3500)], 'b', 150), '2');
  // akun belum dicek (bid tetap dihitung sementara): tidak boleh
  assert.equal(win([c(1, 'a', '100', 3600), c(2, 'u', '150', 3500)], 'u', 150), null);
  // akun belum dicek tapi kamu sahkan manual: boleh
  assert.equal(win([c(1, 'a', '100', 3600), c(2, 'u', '150', 3500, { override: 'valid' })], 'u', 150), '2');
  // kamu sahkan manual, tapi bid melanggar kelipatan: tidak boleh
  assert.equal(win([c(1, 'a', '100', 3600), c(2, 'u', '120', 3500, { override: 'valid' })], 'u', 120), null);
  // terlambat (setelah close), meski disahkan manual: tidak boleh
  assert.equal(win([c(1, 'a', '100', 3600), c(2, 'a', '150', -2, { override: 'valid' })], 'a', 150), null);
  // bid terhapus: tidak boleh
  assert.equal(win([c(1, 'a', '100', 3600), c(2, 'b', '150', 3500, { deleted: true })], 'b', 150), null);
  // sniper zone aktif (2 bid sah sebelumnya), akun baru bid di 5 menit terakhir: tidak boleh
  assert.equal(win([c(1, 'a', '100', 3600), c(2, 'b', '150', 3500), c(3, 'u', '200', 100, { override: 'valid' })], 'u', 200), null);
  // nominal tidak sama dengan hasil lelang: tidak ada bid yang cocok
  assert.equal(win([c(1, 'a', '100', 3600), c(2, 'b', '150', 3500)], 'b', 200), null);
});

test('pemenang bawaan', () => {
  const top = (extra: Partial<CommentIn> = {}) => evaluate([c(1, 'a', '100', 3600), c(2, 'b', '+50', 3000, extra)], rules).top;
  assert.equal(autoWinnerReason(top(), undefined), null); // belum disahkan dan bukan akun sah
  assert.equal(autoWinnerReason(top(), 'manual'), 'Otomatis · akun sah');
  assert.equal(autoWinnerReason(top(), 'import'), 'Otomatis · akun sah dari impor followers');
  assert.equal(autoWinnerReason(top({ override: 'valid' }), undefined), 'Otomatis · bid sudah disahkan');
  // Bid tertinggi ditolak: bid sah tertinggi berpindah ke akun 'a', jadi yang dinilai adalah akun 'a'.
  assert.equal(top({ override: 'invalid' })?.username, 'a');
  assert.equal(autoWinnerReason(top({ override: 'invalid' }), undefined), null);
  assert.equal(autoWinnerReason(null, 'manual'), null);
});

test('keputusan manual dan bid dihapus', () => {
  const { rows, top } = evaluate(
    [
      c(1, 'a', 'ob', 3600),
      c(2, 'b', '150', 3500, { deleted: true }),
      c(3, 'c', '+50', 3400), // 150: dihitung dari bid sah sebelumnya (100), bid yang terhapus tidak jadi acuan
      c(4, 'd', '500', 3300, { override: 'valid' }), // lewat max jump tapi disahkan manual
      c(5, 'e', '+50', 3200, { override: 'invalid' }),
      c(6, 'f', '+50', 3100, { override: 'wrong' }),
    ],
    rules,
  );
  assert.equal(rows[0].amount, 100);
  assert.equal(rows[1].valid, false); // terhapus: otomatis tidak sah
  assert.deepEqual(rows[1].flags, ['dihapus']);
  assert.equal(rows[2].amount, 150);
  assert.equal(rows[3].valid, true);
  assert.equal(rows[4].amount, 550);
  assert.equal(rows[5].valid, false);
  assert.equal(top?.id, '4');

  // Bid terhapus bisa disahkan kembali secara manual.
  const kembali = evaluate([c(1, 'a', '100', 3600, { deleted: true, override: 'valid' })], rules);
  assert.equal(kembali.rows[0].valid, true);
  assert.equal(kembali.top?.id, '1');
});
