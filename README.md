# Lelang Monitor

Dashboard untuk memantau bid di komentar 9 postingan feed Instagram terakhir, dan mengirim komentar
otomatis "10 Menit" (10 menit sebelum close), "Sniper Zone" (5 menit sebelum close), serta "Close" (detik ke-59 sebelum jam close).

## Cara kerja

- Postingan, caption, dan komentar diambil lewat API resmi Instagram.
- Open bid, kelipatan, max jump, tanggal dan jam close dibaca dari caption. Semuanya bisa dikoreksi di dashboard.
- Bid dibaca dari komentar (`150`, `2.100`, `+50`, `bid 250k`, `150 gan`, `ob`). Nominal dalam ribuan rupiah.
- Penanda (terlambat, belum pernah bid di sniper zone, bukan kelipatan, dsb.) hanya saran.
  Tombol **Sah** / **Tolak** menentukan keputusan akhir, dan `+50` dihitung dari bid sah tertinggi.
- Semua komentar disimpan sejak pertama terlihat. Bid yang dihapus tetap dihitung dan diberi tanda "⚠ Terhapus".
- Tiap bid punya tiga tombol: ✅ Sah, ❌ Tolak, 😂 Salah bid.
- Menekan **Sah** memasukkan akun ke daftar akun sah: bid berikutnya dari akun itu, di lelang mana pun, langsung
  bertanda "✓ Akun sah". **Salah bid** membatalkan satu bid tanpa mengubah daftar. Akun keluar dari daftar kalau kamu menekan **Tolak**, kalau ia menghapus bid, atau kalau
  kamu mengetuk tanda "✓ Akun sah". Bid dari akun di luar daftar bertanda "Belum dicek".
- "Atur jam close berurutan" mengisi jam close 9 postingan terakhir sekaligus: postingan terlama di jam yang kamu pilih, berikutnya tiap 5 menit.
- Tombol **Akun sah** di bagian atas menampilkan seluruh daftar akun sah; akun bisa ditambah atau dikeluarkan dari sana.
- Tombol **Ulang** di samping komentar yang sudah terkirim mengembalikannya ke status terjadwal (untuk uji kirim
  yang komentarnya sudah dihapus di Instagram).
- Komentar otomatis **mati secara bawaan**. Nyalakan per postingan atau lewat "Aktifkan semua auto-komentar".

## Mencoba tanpa Instagram

```
npm install
npm run demo
```

Buka http://localhost:3000. Datanya palsu dan tidak ada yang dikirim ke Instagram.

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
