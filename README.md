# Lelang Monitor

Dashboard untuk memantau bid di komentar 9 postingan feed Instagram terakhir, dan mengirim komentar
otomatis "10 Menit" (10 menit sebelum close), "Sniper Zone" (5 menit sebelum close), serta "Close" (detik ke-59 sebelum jam close).

## Cara kerja

- Postingan, caption, dan komentar diambil lewat API resmi Instagram.
- Open bid, kelipatan, max jump, tanggal dan jam close dibaca dari caption. Semuanya bisa dikoreksi di dashboard.
- Bid dibaca dari komentar (`150`, `2.100`, `+50`, `bid 250k`, `150 gan`, `ob`). Nominal dalam ribuan rupiah.
- Penanda (terlambat, belum pernah bid di sniper zone, bukan kelipatan, dsb.) hanya saran.
  Tombol **Sah** / **Tolak** menentukan keputusan akhir, dan `+50` dihitung dari bid sah tertinggi.
- Semua komentar disimpan sejak pertama terlihat. Bid yang dihapus bertanda "⚠ Terhapus" dan otomatis tidak sah (bisa kamu sahkan lagi dengan ✅). Akunnya tidak
  dikeluarkan dari daftar akun sah; itu kamu yang menentukan.
- Tiap bid punya dua tombol: ✅ Sah dan ❌ Tolak.
- Menekan **Sah** memasukkan akun ke daftar akun sah: bid berikutnya dari akun itu, di lelang mana pun, langsung
  bertanda "✓ Akun sah". **Tolak** hanya membatalkan bid itu dan tidak mengubah daftar. Akun hanya keluar dari daftar kalau
  kamu mengeluarkannya sendiri lewat panel Akun sah atau lewat tanda "✓ Akun sah" di bid-nya. Bid dari akun di luar daftar bertanda "Belum dicek".
- "Atur jam close berurutan" mengisi jam close 9 postingan terakhir sekaligus: postingan terlama di jam yang kamu pilih, berikutnya tiap 5 menit.
- Tombol ikon ⟳ di pojok kanan atas memuat ulang halaman, untuk mengambil versi dashboard terbaru setelah ada pembaruan.
- Dua tombol notifikasi terpisah: **Notif bid** (bid dan komentar masuk, bid terhapus) dan **Notif otomasi** (komentar
  terjadwal dan balasan otomatis: terkirim, gagal, dilewati), masing-masing dengan hitungan yang belum dilihat. Mengetuk
  satu notifikasi membuka lelangnya, menggulir kartunya ke layar, dan menyorot bid-nya.
- Bid dari akun yang ada di daftar akun sah otomatis berstatus "Disahkan otomatis" (✅ menyala). Status itu tidak berlaku
  kalau bid-nya kena penanda (sama atau lebih rendah dari bid sebelumnya, terhapus, terlambat, bukan kelipatan, lewat
  max jump, dan sebagainya), dan keputusan ✅ atau ❌ yang kamu tekan sendiri selalu menang.
- Pemenang bawaan: setelah lelang close, bid sah tertinggi otomatis menjadi pemenang kalau bid itu sudah kamu sahkan (✅)
  atau akunnya ada di daftar akun sah. Hasil otomatis ikut berubah kalau keputusanmu berubah, dan tidak pernah menimpa
  hasil yang kamu tetapkan sendiri.
- Di lelang yang sudah close, **Tetapkan hasil lelang** mencatat pemenang (usulan: bid sah tertinggi) atau **No Winner**.
  Hasil bisa diubah kapan saja lewat **Ubah**, termasuk mencatat pemenang sebagai Bid & Run. Tombol **Pemenang**
  menampilkan rekap per akun: total win, total nilai, dan barang yang dimenangkan.
- Panel Akun sah menerima banyak username sekaligus (pisahkan dengan spasi, koma, atau baris baru). Akun yang ditambahkan
  begini berstatus akun sah biasa. Panel itu juga bisa mengimpor file followers dari "Download your information" Instagram (`followers_1.json` atau `.html`).
  Akun hasil impor bertanda "impor" dan bisa dikeluarkan sekaligus lewat **Batalkan impor**; mengesahkannya dengan ✅
  menjadikannya akun sah biasa.
- Tombol **Akun sah** di bagian atas menampilkan seluruh daftar akun sah; akun bisa ditambah atau dikeluarkan dari sana.
- Tombol **💬 Balas sah** muncul hanya di bid berawalan "+" (mis. +50) yang sudah disahkan (✅ atau "Disahkan otomatis").
  Menekannya mengirim balasan ke komentar bidder di Instagram (bawaan: "bid [total] sah yaa", bisa diedit sebelum
  terkirim). Bid yang sudah dibalas bertanda "✓ Sudah dibalas".
- **Auto-balas bid +** (mati bawaan): kalau dinyalakan, bid berawalan "+" dari akun sah yang berstatus "Disahkan otomatis"
  langsung dibalas "bid [total] sah yaa". Hanya bid yang masuk setelah dinyalakan dan masih baru (15 menit) yang dibalas,
  dan hanya kalau totalnya pasti: bid acuan yang menjadi dasar penjumlahan juga sudah disahkan (kalau acuannya dari akun
  yang belum dicek, balasan ditahan dan bid-nya bertanda "Total belum pasti"). Paling banyak 5 balasan per putaran dengan jeda, dan 40 balasan per jam (`AUTO_REPLY_MAX_PER_HOUR`). Balasan yang gagal
  tidak dicoba lagi dan bisa dibalas manual. Teksnya bisa diganti lewat `AUTO_REPLY_TEXT` (pakai `{total}`).
- **DM ke pemenang** lewat "Private Reply" pada komentar bid pemenang (satu DM per komentar, dalam 7 hari). Tombol
  **✉ Kirim DM** di hasil lelang mengirim manual (teks bisa diedit). **Auto-DM pemenang** (mati bawaan) mengirim sendiri
  "Menang yaa untuk lelang [nama barang] di harga [harga menang] 🥳" sekitar 3 menit setelah pemenang ditetapkan, hanya kalau bid kemenangannya sudah
  disahkan (akun sah otomatis atau ✅ manual) dan tidak melanggar aturan lelang (terlambat, bukan kelipatan, sniper zone,
  lewat max jump, terhapus, dan sebagainya). Hanya lelang yang close setelah dinyalakan; mengubah hasil lelang selama
  masa tenang membatalkan DM yang belum terkirim; yang gagal tidak dicoba lagi otomatis. Butuh izin pesan di token
  (`instagram_manage_messages`) dan "Allow access to messages" di pengaturan Instagram.
- Tombol **Ulang** di samping komentar yang sudah terkirim mengembalikannya ke status terjadwal (untuk uji kirim
  yang komentarnya sudah dihapus di Instagram).
- Sniper Zone hanya aktif kalau lelang itu punya minimal 2 bid sah sebelum zonanya dimulai. Kalau kurang, komentar
  "Sniper Zone" otomatis dilewati (masih bisa dikirim manual lewat Kirim), dan aturan sniper di penilaian bid tidak berlaku:
  bid dari akun baru di 5 menit terakhir tidak ditandai.
- Komentar otomatis **mati secara bawaan**. Nyalakan per postingan atau lewat "Aktifkan semua auto-komentar".

## Mencoba tanpa Instagram

```
npm install
npm run demo
```

Buka http://localhost:3000. Datanya palsu, tidak ada yang dikirim ke Instagram, dan mode demo tidak pernah
memakai database asli walaupun `DATABASE_URL` terisi.

## Memasang di Vercel

1. **Vercel**: import repo ini sebagai project baru (pastikan project tersambung ke repo ini, bukan repo lain).
2. **Database**: di project Vercel buka tab Storage, tambahkan Neon (Postgres). `DATABASE_URL` terisi sendiri.
3. **Meta**: di developers.facebook.com buat app dengan use case "Manage messaging & content on Instagram",
   sambungkan business portfolio, buka "API setup with Unified login", tambahkan akun lelang, lalu buat token akses.
   Catat juga ID akun Instagram (angka) yang ditampilkan di sana.
4. **Variabel** (Settings > Environment Variables): `DASHBOARD_PASSWORD`, `CRON_SECRET`, `IG_ACCESS_TOKEN`, `IG_USER_ID`. Deploy ulang.
5. **Pemicu per menit**: di cron-job.org buat job tiap menit ke
   `https://ALAMAT-KAMU.vercel.app/api/cron` dengan header `Authorization: Bearer <CRON_SECRET>`.

Token diperpanjang otomatis oleh sistem selama pemicu berjalan.

## Batasan

- Komentar terjadwal dikirim tepat di detiknya, tapi Instagram bisa menampilkannya 1–3 detik kemudian.
  Sah atau tidaknya bid sebaiknya dinilai dari jam komentar bidder.
- Kalau pemicu telat, komentar masih dikirim sampai 20 detik setelah jadwal. Lebih dari itu ditandai
  "tidak terkirim" dan bisa dikirim manual dari detail postingan.
- Mendekati close, komentar dicek tiap ±8 detik. Di luar itu tiap 1–5 menit.

## Tes

```
npm test
```
