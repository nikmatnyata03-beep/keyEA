# 7σ Seven Sigma — License Server (Cloudflare Workers + D1)

Server lisensi online untuk Expert Advisor **Seven Sigma 4.3 (MT5)** dengan aturan
**1 Device = 1 Key**: satu license key hanya boleh aktif di satu nomor akun trading MT5.
Termasuk dashboard admin untuk generate key dan memantau semua user (akun, broker, IP,
check-in terakhir, riwayat validasi).

- **Runtime:** Cloudflare Workers (zero-dependency, tanpa framework)
- **Database:** Cloudflare D1 (SQLite terdistribusi)
- **Dashboard:** static SPA di folder `public/` (dilayani Workers Assets, tanpa build)
- **Biaya:** cukup paket free Cloudflare untuk skala kecil-menengah

---

## 1. Struktur Proyek

```
cloudflare-license/
├── wrangler.toml        # konfigurasi worker + binding D1 + assets
├── schema.sql           # skema tabel D1 (license_keys, devices, checkin_logs)
├── package.json         # script deploy (wrangler)
├── .gitignore           # pengecualian git (node_modules, .wrangler, dll)
├── public/
│   └── index.html       # dashboard admin (login, generate, monitor, revoke)
└── src/
    ├── index.js         # entry worker + routing
    ├── util.js          # helper (json, waktu, IP, normalisasi key)
    ├── auth.js          # token HMAC-SHA256 untuk dashboard
    ├── keys.js          # generator key QQX-XXXXX-XXXXX-XXXXX
    ├── license.js       # logika inti validasi + ikat device
    ├── api.js           # endpoint EA: /api/v1/ping|validate|activate
    └── admin.js         # endpoint dashboard: /api/admin/*
```

## 2. Deploy ke Cloudflare (± 5 menit)

Prasyarat: akun Cloudflare gratis + Node.js di komputer Anda.

```bash
cd cloudflare-license
npm install          # memasang wrangler (tool deploy Cloudflare)
npx wrangler login   # login via browser
```

**Langkah 1 — buat database D1** lalu salin `database_id` ke `wrangler.toml`:

```bash
npx wrangler d1 create quantum-queen-license
```

**Langkah 2 — buat tabel** (jalankan ulang setiap kali `schema.sql` berubah):

```bash
npx wrangler d1 execute quantum-queen-license --remote --file=./schema.sql
```

**Langkah 3 — set password admin dashboard** (WAJIB, jangan pakai default):

```bash
npx wrangler secret put ADMIN_PASSWORD
# ketik password Anda, lalu Enter
```

**Langkah 4 — deploy:**

```bash
npx wrangler deploy
```

Catat URL yang muncul, misalnya:
`https://quantum-queen-license.<subdomain>.workers.dev`
Dengan anggaran tertentu Anda juga bisa memakai custom domain sendiri via dashboard Cloudflare.

**Langkah 5 — buka dashboard:** `<URL>/` → login dengan `ADMIN_PASSWORD` → generate key pertama.

## 2b. Deploy Alternatif: GitHub → Cloudflare (auto-deploy tiap push)

Cara ini tidak butuh Node.js di komputer — cukup browser dan akun GitHub.

**A. Push proyek ke GitHub:**

```bash
cd cloudflare-license
git init
git add .
git commit -m "Seven Sigma license server"
git branch -M main
git remote add origin https://github.com/<USERNAME>/quantum-queen-license.git
git push -u origin main
```

**B. Buat database D1 lewat dashboard** (tanpa CLI):

1. Dashboard Cloudflare → **Storage & Databases → D1 → Create**
2. Nama: `quantum-queen-license` → Create
3. Buka tab **Console** → salin seluruh isi `schema.sql` → tempel → **Execute**
4. Salin **Database ID** dari halaman detail database

**C. Isi `database_id` di `wrangler.toml`**, lalu commit & push:

```bash
git add wrangler.toml
git commit -m "set database id"
git push
```

**D. Hubungkan repo ke Workers:**

1. Dashboard → **Workers & Pages → Create → Workers → Import a repository**
2. Authorize GitHub → pilih repo `quantum-queen-license`
3. Build settings: biarkan default (Cloudflare otomatis membaca `wrangler.toml`,
   deploy command `npx wrangler deploy`) → **Deploy**
4. Setelah selesai: **Settings → Variables and Secrets → Add** →
   type **Secret**, name `ADMIN_PASSWORD`, isi password dashboard Anda
5. Buka URL workers.dev → login dashboard → generate key pertama

> Mulai sekarang setiap `git push` ke `main` otomatis men-deploy versi terbaru.

## 3. Setup sisi MetaTrader 5 (wajib)

WebRequest hanya diizinkan ke URL yang terdaftar eksplisit:

1. MT5 → **Tools → Options → Expert Advisors**
2. Centang **Allow WebRequest for listed URL**
3. Tambahkan: `https://quantum-queen-license.<subdomain>.workers.dev`

Lalu pada dialog input EA, grup **`>>>> License / Aktivasi`**:

| Input | Isi |
|---|---|
| `YoLic_LicenseKey` | key dari admin, contoh `QQX-ABCDE-FGHJK-LMNPQ` (boleh dengan/tanpa tanda hubung) |
| `InpLicenseApiUrl` | URL Workers dari langkah deploy |
| `InpLicenseRecheckMinutes` | interval validasi ulang ke server (default 60, min. 5) |
| `InpLicenseGraceHours` | toleransi offline bila server/internet mati (default 72 jam) |

## 4. Perilaku EA Hasil Modifikasi

| Skenario | Perilaku |
|---|---|
| Key valid + akun cocok | EA berjalan; jurnal mencetak mode lisensi & masa berlaku |
| Key dipakai pertama kali | Akun MT5 otomatis terikat ke key (slot 1/1) |
| Key dipakai di akun lain | Ditolak `DEVICE_LIMIT`, dialog muncul, EA tidak jalan |
| Admin revoke / key kadaluarsa | Dialog warning → `INIT_FAILED`, dan saat berjalan: notifikasi + `ExpertRemove()` (EA lepas dari chart) |
| Server/internet mati | Grace period `InpLicenseGraceHours` jam sejak validasi sukses terakhir, lalu EA berhenti |
| Key dikosongkan | Mode **trial 30 hari** (file penanda di folder Common, lama 14 hari diperpanjang jadi 30) |
| Strategy Tester / Optimasi | Validasi dilewati (backtest selalu bisa) |

Log yang muncul di tab Journal saat start:

```
Seven Sigma | License mode: ONLINE | berlaku sampai 2026.10.15 06:42 (waktu server)
Seven Sigma | License: ONLINE | Key: QQX-... | Akun: 12345678
```

## 5. API Ringkas

| Endpoint | Metode | Keterangan |
|---|---|---|
| `/api/v1/ping` | GET | cek server + waktu (dipakai untuk tes whitelist) |
| `/api/v1/activate` | POST | `{key, account, broker}` → ikat device (idempotent) |
| `/api/v1/validate` | POST | `{key, account, broker}` → validasi berkala (auto-bind slot kosong) |
| `/api/admin/login` | POST | `{password}` → token HMAC 24 jam |
| `/api/admin/stats` | GET | ringkasan angka dashboard |
| `/api/admin/keys` | GET/POST | daftar key / generate batch (quantity, durasi, max device) |
| `/api/admin/keys/:id/toggle` | POST | revoke atau aktifkan ulang |
| `/api/admin/keys/:id/reset` | POST | lepas ikatan device (untuk ganti akun pembeli) |
| `/api/admin/keys/:id` | DELETE | hapus permanen + riwayat |
| `/api/admin/keys/:id/logs` | GET | riwayat satu key |
| `/api/admin/logs` | GET | aktivitas global terbaru |

Respons validasi sukses:

```json
{
  "ok": true,
  "valid": true,
  "message": "License valid sampai 2026-10-15 06:42:00 UTC.",
  "expires_ts": 1792046390,
  "expires_at": "2026-10-15 06:42:00",
  "server_ts": 1789454390
}
```

Respons ditolak: `"valid": false` dengan `error` salah satu dari
`NOT_FOUND | REVOKED | EXPIRED | DEVICE_LIMIT | INVALID_REQUEST`.

## 6. Keamanan & Catatan Operasional

- Password admin disimpan sebagai secret terenkripsi Cloudflare; token dashboard ber-HMAC dan kedaluwarsa dalam 24 jam.
- Semua endpoint API mengizinkan CORS terbuka agar fleksibel; kredensial tetap aman karena key adalah credential-nya.
- Perubahan jam sistem user tidak memengaruhi keputusan: masa aktif dihitung penuh di server.
- Log `checkin_logs` tumbuh seiring waktu; bersihkan berkala bila perlu:
  `DELETE FROM checkin_logs WHERE created_at < strftime('%s','now') - 90*86400;`
- Untuk pindah hosting/custom domain, cukup ubah DNS dan `wrangler.toml`; EA tinggal diperbarui nilai `InpLicenseApiUrl`-nya.

## 7. Uji Cepat Tanpa MT5

```bash
# kesehatan server
curl https://<URL>/api/v1/ping

# simulasikan validasi dari EA
curl -X POST https://<URL>/api/v1/validate \
  -H "content-type: application/json" \
  -d '{"key":"QQX-XXXX-XXXXX-XXXXX","account":"12345678","broker":"Broker Anda"}'
```
