import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountText, extractUsernames, parseBid, parseCaption, splitUsernames } from '../lib/parse';
import { autoReplyTargets, autoWinnerReason, DM_TEMPLATE, dmMessage, evaluate, parseTestBid, winnerBidForDm, type CommentIn } from '../lib/bids';

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

test('bid yang melanggar aturan ditolak otomatis dan tidak perlu dicek lagi', () => {
  const v = { ...rules, maxJump: null, verified: new Set(['a']) }; // tanpa batas max jump supaya angkanya sederhana
  const { rows } = evaluate(
    [
      c(1, 'a', '1100', 3600), // disahkan otomatis
      c(2, 'a', '1100', 3500), // sama dengan bid sebelumnya: ditolak otomatis
      c(3, 'u', '1050', 3400), // akun belum dicek, lebih rendah: ditolak otomatis
      c(4, 'u', '1220', 3300), // bukan kelipatan: ditolak otomatis
      c(5, 'u', '1150', 3200), // akun belum dicek, tidak melanggar: tetap perlu dicek
      c(6, 'u', '1200', 3100, { override: 'valid' }), // keputusanmu menang: tidak ditolak otomatis
      c(7, 'a', '1250', -5), // terlambat
      c(8, 'a', '1300', 3000, { override: 'invalid' }), // sudah kamu tolak sendiri: bukan "otomatis"
    ],
    v,
  );
  const rej = Object.fromEntries(rows.map((r) => [r.id, r.autoRejected]));
  assert.deepEqual(rej, { 1: false, 2: true, 3: true, 4: true, 5: false, 6: false, 7: true, 8: false });
  assert.equal(rows.find((r) => r.id === '5')!.autoApproved, false); // tetap menunggu keputusanmu
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

test('penulisan nominal: rb di bawah sejuta, k untuk sejuta ke atas', () => {
  assert.equal(amountText(50), '50rb');
  assert.equal(amountText(250), '250rb');
  assert.equal(amountText(999), '999rb');
  assert.equal(amountText(1000), '1.000k'); // Rp1.000.000
  assert.equal(amountText(1500), '1.500k'); // Rp1.500.000
  assert.equal(amountText(12500), '12.500k'); // Rp12.500.000
});

test('isi DM pemenang memuat nama barang dan harga menang', () => {
  assert.equal(dmMessage(DM_TEMPLATE, 'Disney Mickey Mouse By Sega Quartz Watch', 250), 'Menang yaa untuk lelang Disney Mickey Mouse By Sega Quartz Watch di harga 250rb 🥳');
  assert.equal(dmMessage(DM_TEMPLATE, 'Seiko 5', 1500), 'Menang yaa untuk lelang Seiko 5 di harga 1.500k 🥳');
  assert.equal(dmMessage(DM_TEMPLATE, '', 100), 'Menang yaa untuk lelang ini di harga 100rb 🥳');
  // {tautan} diisi alamat postingan; tanpa tautan, barisnya dibuang rapi
  assert.equal(dmMessage(DM_TEMPLATE, 'Jam A', 300, 'https://www.instagram.com/p/AbC/'), 'Menang yaa untuk lelang Jam A di harga 300rb 🥳\nhttps://www.instagram.com/p/AbC/');
  assert.equal(dmMessage(`${DM_TEMPLATE}\n{tautan}`, 'Jam A', 300, null), 'Menang yaa untuk lelang Jam A di harga 300rb 🥳');
  assert.equal(dmMessage('{harga} untuk {barang}, {barang}!', 'Jam A', 50), '50rb untuk Jam A, Jam A!');
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
  // harga bergantung pada bid belum dicek (akun sah +50 di atas bid akun belum dicek): tidak boleh sampai bid acuan disahkan
  const rantai = [c(1, 'a', '100', 3600), c(2, 'u', '+50', 3500), c(3, 'b', '+50', 3400)];
  assert.equal(win(rantai, 'b', 200), null);
  assert.equal(win(rantai.map((x) => (x.id === '2' ? { ...x, override: 'valid' as const } : x)), 'b', 200), '3');
  // nominal tidak sama dengan hasil lelang: tidak ada bid yang cocok
  assert.equal(win([c(1, 'a', '100', 3600), c(2, 'b', '150', 3500)], 'b', 200), null);
});

test('bid uji dari akun uji: bohongan, bebas aturan, tidak memengaruhi bid asli', () => {
  assert.equal(parseTestBid('Tes, 300'), 300);
  assert.equal(parseTestBid('tes 1500'), 1500);
  assert.equal(parseTestBid('test: 250k'), 250);
  assert.equal(parseTestBid('tes'), null);
  assert.equal(parseTestBid('+50'), null);
  assert.equal(parseTestBid('testimoni 300'), null);
  assert.equal(parseTestBid('Tes, OB', 100), 100); // OB = harga open bid lelangnya
  assert.equal(parseTestBid('tes ob'), null); // tanpa open bid, tidak terbaca

  process.env.TEST_ACCOUNTS = 'sakatimepiece';
  try {
    const v = { ...rules, verified: new Set(['a']) };
    const { rows, top } = evaluate(
      [
        c(1, 'a', '100', 3600),
        c(2, 'sakatimepiece', 'Tes, 300', -50), // setelah close dan melompat 200: bid uji bebas aturan
        c(3, 'orang_lain', 'Tes, 300', -40), // akun biasa: bid biasa yang melanggar aturan
        c(4, 'sakatimepiece', 'OB', 3000), // bukan format uji: bid biasa
        c(5, 'sakatimepiece', 'tes 120', 2900, { deleted: true }), // terhapus: tidak sah
        c(6, 'sakatimepiece', 'tes 120', 2800, { override: 'invalid' }), // ditolak manual: tidak sah
        c(7, 'a', '+50', 2700), // +50 dihitung dari bid asli (100), bukan dari bid uji 300
      ],
      v,
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(by[2].isTest, true);
    assert.equal(by[2].valid, true);
    assert.deepEqual(by[2].flags, []);
    assert.equal(by[2].amount, 300);
    assert.equal(by[3].isTest, false);
    assert.equal(by[3].valid, false); // terlambat, bukan bid uji
    assert.equal(by[4].isTest, false);
    assert.equal(by[5].valid, false);
    assert.equal(by[6].valid, false);
    assert.equal(by[7].amount, 150);
    assert.equal(top?.id, '7'); // bid uji tidak pernah menjadi bid tertinggi
    // bisa dipilih sebagai pemenang uji dan memenuhi syarat DM
    assert.equal(winnerBidForDm(rows, { username: 'sakatimepiece', amount: 300 })?.id, '2');
    // di luar akun uji, format yang sama tidak punya keistimewaan
    delete process.env.TEST_ACCOUNTS;
    assert.equal(evaluate([c(1, 'a', '100', 3600), c(2, 'sakatimepiece', 'Tes, 300', -50)], v).rows[1].isTest, false);
  } finally {
    delete process.env.TEST_ACCOUNTS;
  }
});

test('nama variabel akun uji: TEST_ACCOUNTS atau TEST_ACCOUNT, beberapa akun dipisah koma', () => {
  const v = { ...rules, verified: new Set<string>() };
  const isTest = (env: Record<string, string>) => {
    delete process.env.TEST_ACCOUNTS; delete process.env.TEST_ACCOUNT;
    Object.assign(process.env, env);
    return evaluate([c(1, 'sakatimepiece', 'Tes, 300', -50)], v).rows[0].isTest;
  };
  try {
    assert.equal(isTest({ TEST_ACCOUNTS: 'rinaldiwrwn,sakatimepiece' }), true);
    assert.equal(isTest({ TEST_ACCOUNTS: '@RinaldiWrwn, SakaTimePiece' }), true);
    assert.equal(isTest({ TEST_ACCOUNT: 'sakatimepiece' }), true); // salah ketik tanpa S tetap bekerja
    assert.equal(isTest({ TEST_ACCOUNTS: 'rinaldiwrwn' }), false);
    assert.equal(isTest({}), false);
  } finally {
    delete process.env.TEST_ACCOUNTS; delete process.env.TEST_ACCOUNT;
  }
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

test('chat lanjutan: rekap pelanggan lama dan permintaan alamat pelanggan baru', async () => {
  const { recapMessage, decideFollowup, dayKey } = await import('../lib/followup');
  // Satu barang, sapaan om, tanpa info transfer.
  assert.equal(recapMessage({ amounts: [300], ongkir: 39, greeting: 'om', packing: 5 }).text, 'Untuk totalnya jadi 300+5+39=344rb yaa om');
  // Empat barang: harga+packing diulang per barang, ongkir di akhir. Sapaan "ka" jadi "kaa", info transfer ikut.
  const r = recapMessage({ amounts: [350, 200, 100, 120], ongkir: 18, greeting: 'ka', transfer: '123 a/n X', packing: 5 });
  assert.equal(r.total, 350 + 200 + 100 + 120 + 4 * 5 + 18);
  assert.equal(r.text, 'Untuk totalnya jadi 350+5+200+5+100+5+120+5+18=808rb yaa kaa\n\nTransfernya kesini ya kaa:\n123 a/n X');
  // Total sejuta ke atas memakai penulisan k.
  assert.match(recapMessage({ amounts: [1500], ongkir: 20, packing: 5 }).text, /=1\.525k yaa om/);

  // Sapaan: om, ka (ditulis kaa), atau custom yang ditulis persis seperti diketik. Kosong menjadi om, dirapikan dan dibatasi 20 karakter.
  const { formatGreeting, greetingKind } = await import('../lib/followup');
  assert.deepEqual(['man', 'mann', 'NANGG', 'nAnGg', ' bro  BESAR ', 'Mann'].map(formatGreeting), ['man', 'mann', 'NANGG', 'nAnGg', 'bro BESAR', 'Mann']);
  assert.deepEqual(['om', 'OM', 'ka', 'KA', 'kaa', '', null].map(formatGreeting), ['om', 'om', 'ka', 'ka', 'ka', 'om', 'om']);
  assert.deepEqual(['om', 'ka', 'kaa', 'Mann', ''].map(greetingKind), ['om', 'ka', 'ka', 'custom', 'om']);
  assert.equal(formatGreeting('x'.repeat(40)), 'x'.repeat(20));
  assert.equal(formatGreeting('a\nb'), 'a b');
  const sap = (g: string | null | undefined) => recapMessage({ amounts: [300], ongkir: 10, greeting: g, packing: 5 }).text.split('\n')[0];
  assert.equal(sap('Mann'), 'Untuk totalnya jadi 300+5+10=315rb yaa Mann');
  assert.equal(sap('mann'), 'Untuk totalnya jadi 300+5+10=315rb yaa mann');
  assert.equal(sap('ka'), 'Untuk totalnya jadi 300+5+10=315rb yaa kaa');
  assert.equal(sap(''), 'Untuk totalnya jadi 300+5+10=315rb yaa om');
  assert.equal(sap(null), 'Untuk totalnya jadi 300+5+10=315rb yaa om');

  // Ongkir desimal ditulis dengan koma, sama seperti webapp ongkir.
  assert.equal(recapMessage({ amounts: [350], ongkir: 18.5, greeting: 'om', packing: 5 }).text, 'Untuk totalnya jadi 350+5+18,5=373,5rb yaa om');

  assert.equal(dayKey(Date.parse('2026-11-23T18:00:00Z')), '2026-11-24'); // 01.00 WIB sudah hari berikutnya

  const now = Date.parse('2026-11-24T10:00:00Z');
  const base = { now, firstDmAt: now - 3_600_000, undecided: 0, customer: { ongkir: 18, greeting: 'ka' }, lastReplyAt: now - 60_000 };
  const w = (id: string, amount: number, dmSent = true) => ({ postId: id, amount, closeAt: now - 7_200_000 + Number(id) * 1000, dmSent });
  // Belum membalas, atau balasan lebih lama dari DM: menunggu.
  assert.equal(decideFollowup({ ...base, wins: [w('1', 100)], lastReplyAt: null }).action, 'wait');
  assert.equal(decideFollowup({ ...base, wins: [w('1', 100)], lastReplyAt: base.firstDmAt - 1 }).action, 'wait');
  // Pelanggan baru: langsung minta alamat, tidak menunggu lelang lain.
  const nu = decideFollowup({ ...base, customer: null, wins: [w('1', 100)], undecided: 3 });
  assert.deepEqual([nu.action, (nu as any).kind], ['send', 'new']);
  assert.match((nu as any).text, /alamat lengkap dan kontak penerimanya/);
  // Pelanggan lama: tunggu lelang lain yang belum selesai, dan DM kemenangan lain yang belum terkirim.
  assert.equal(decideFollowup({ ...base, wins: [w('1', 100)], undecided: 2 }).action, 'wait');
  assert.equal(decideFollowup({ ...base, wins: [w('1', 100), w('2', 50, false)] }).action, 'wait');
  // Kirim manual boleh melewati syarat itu.
  assert.equal(decideFollowup({ ...base, wins: [w('1', 100), w('2', 50, false)], force: true }).action, 'send');
  // Semua siap: jumlah sesuai urutan close.
  const ok = decideFollowup({ ...base, wins: [w('2', 200), w('1', 100)] }) as any;
  assert.equal(ok.kind, 'recap');
  assert.match(ok.text, /100\+5\+200\+5\+18=328rb/);
  // Jendela balasan 24 jam: sudah lewat, tidak dikirim otomatis.
  assert.equal(decideFollowup({ ...base, wins: [w('1', 100)], firstDmAt: now - 48 * 3_600_000, lastReplyAt: now - 24 * 3_600_000 }).action, 'expired');
});
