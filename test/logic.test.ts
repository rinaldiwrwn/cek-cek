import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBid, parseCaption } from '../lib/parse';
import { evaluate, type CommentIn } from '../lib/bids';

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
  assert.deepEqual(v('@teman 300 gan'), { kind: 'abs', value: 300, sure: false });
  assert.equal(v('diameter 47mm ya?'), null);
  assert.equal(v('close jam 19:00?'), null);
  assert.equal(v('mantap min'), null);
});

const c = (id: number, username: string, text: string, secBeforeClose: number, extra: Partial<CommentIn> = {}): CommentIn => ({
  id: String(id), parentId: null, username, text, ts: CLOSE - secBeforeClose * 1000, deleted: false, override: null, ...extra,
});
const rules = { openBid: 100, increment: 50, maxJump: 300, closeAt: CLOSE, ownUsername: 'lelang' };

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

test('keputusan manual dan bid dihapus', () => {
  const { rows, top } = evaluate(
    [
      c(1, 'a', '100', 3600),
      c(2, 'b', '150', 3500, { deleted: true }),
      c(3, 'c', '+50', 3400), // dihitung dari 100 karena 150 dihapus
      c(4, 'd', '500', 3300, { override: 'valid' }), // lewat max jump tapi disahkan manual
      c(5, 'e', '+50', 3200, { override: 'invalid' }),
    ],
    rules,
  );
  assert.equal(rows[1].valid, false);
  assert.equal(rows[2].amount, 150);
  assert.equal(rows[3].valid, true);
  assert.equal(rows[4].amount, 550);
  assert.equal(top?.id, '4');
});
