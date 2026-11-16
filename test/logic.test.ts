import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsernames, parseBid, parseCaption } from '../lib/parse';
import { autoWinnerReason, evaluate, type CommentIn } from '../lib/bids';

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
  assert.deepEqual(rows[1].flags, ['tidakNaik']);
  assert.equal(rows[3].valid, true); // bukan akun sah: tetap dihitung sementara, tapi belum dicek
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
