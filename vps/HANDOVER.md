# HANDOVER — Seven Sigma Project (untuk agen berikutnya / zcode)

> **BACA FILE INI DULU SEBELUM NGAPAPOIN.** Ini memori lengkap proyek. Lanjutkan dari
> bagian "STATUS AKTIF" di bawah. Bahasa user: Indonesia santai (gw/lu).
> Semua kredensial ada di `/home/z/my-project/.secrets/credentials.env` (chmod 600).

## 1. PETA PROYEK

| Path | Isi |
|---|---|
| `cloudflare-license/` | **Server lisensi** Cloudflare Workers + D1 (zero-dep). Produksi: `https://quantum-queen-license.darussolah.workers.dev` |
| `download/` | Deliverable user: **EA Seven Sigma 4.6** (`Seven Sigma 4.6 - License Online.mq5`, `SevenSigma-46-LicenseOnline.mq5`, zip), zip server final, CHANGELOG, README |
| `keyEA-repo/` | Clone GitHub `nikmatnyata03-beep/keyEA` (sync repo; 395MB — cukup `git clone` ulang, jangan di-zip) |
| `scripts/` | Automasi: `vps_ssh.py`, `wss_tcp_bridge.py`, `patch_ea_46.py`, `test_v46_features.sh` (37/37 PASS), dll |
| `vps-tunnel/` | Worker CF relay TCP→WS buat SSH darurat ke VPS (deployed, lihat §4) |
| `mini-services/license-preview/` | Preview server lokal (Bun + D1 shim, port 3030) |
| `.secrets/credentials.env` | SEMUA kredensial (GitHub PAT, CF token, VPS, admin password, akun panel provider) |
| `worklog.md` | Log kerja semua task sebelumnya (Task 1–20) |

## 2. ARSITEKTUR SINGKAT

- EA MQL5 v4.6 (MetaTrader 5) → validasi lisensi + push stats tiap 5 menit ke Worker.
- Worker endpoints: `/api/v1/validate`, `/api/v1/stats` (EA), `/api/v1/check` (publik), admin dashboard `/` (Bloomberg dark), password admin = PBKDF2 di D1 (default awal `[REDACTED]`).
- D1: `quantum-queen-license` (id `d6953e25-fc13-40ca-befa-0b88f4ae7b7f`), akun CF `27f9d19e916a7ab071db7b2ad8f05b94`.
- Deploy: `cd cloudflare-license && export CLOUDFLARE_API_TOKEN=$(grep '^CLOUDFLARE_API_TOKEN=' ../.secrets/credentials.env | cut -d= -f2-) && bunx wrangler deploy` (+ `wrangler d1 execute quantum-queen-license --remote --file=schema.sql` bila skema berubah — migrasi idempoten).
- GitHub sync: push ke `keyEA` (PAT tersimpan via git credential helper + di .secrets).

## 3. STATUS AKTIF — VPS TRADING (BELUM SELESAI, INI TASK YANG JALAN)

**Tujuan:** setup VPS (vpsmurah.co.id, Jakarta) untuk jalanin MT5 + EA 7σ via Wine 24/7.
**VPS:** Ubuntu 24.04.5 LTS, 1 vCPU, 2 GB RAM, 19 GB disk, IP `45.66.153.147`, SSH port `20268`, user `root`, password di .secrets. Provider panel: `my.vpsmurah.co.id` (login `nikmattrial@gmail.com` / `[REDACTED]` — kredensial juga di .secrets).

**SUDAH JADI di VPS (tersimpan di disk, hilang hanya kalau reinstall):**
- apt update + full upgrade + reboot (kernel baru jalan)
- swap 2 GB (`/swapfile`, fstab, `vm.swappiness=15`)
- UFW aktif: `20268/tcp LIMIT IN`, `3389/tcp ALLOW IN`, default deny
- fail2ban aktif; tool dasar + `xvfb x11-utils` terinstall

**MASALAH TERBUKA (ini kenapa task berhenti):**
- sshd TIDAK menjawab dari semua jalur: direct (dari sandbox), via tunnel CF, bahkan dari PC user (`Connection timed out` di level TCP).
- Kernel hidup: ICMP ping OK (26 ms dari PC user), probe via tunnel CF: port 3389 langsung RST, port 20268 menggantung tanpa SYN-ACK.
- Hipotesis: (a) sshd wedged karena flood scanner bot port non-standar (MaxStartups default 10 kehabisan), ATAU (b) anti-DDoS provider memblokir port 20268.
- Turnstile Cloudflare di panel provider MENGGAGALKAN login otomatis headless (token `cf-turnstile-response` selalu kosong; API `POST https://my.vpsmurah.co.id/api/auth/login` butuh `turnstile_token` valid → 400).

**LANGKAH RESUME (urutan):**
1. Tes dulu — mungkin udah sembuh sendiri: `python3 scripts/vps_ssh.py --test` (atau via tunnel §4).
2. Kalau masih mati → minta user login panel `my.vpsmurah.co.id` → **Reboot** VPS → tunggu 2 mnt → tes lagi.
3. Begitu SSH hidup → LANGSUNG jalanin (anti wedged lagi):
   `printf 'LoginGraceTime 20\nMaxStartups 3:20:8\nMaxAuthTries 3\n' > /etc/ssh/sshd_config.d/99-hardening.conf && systemctl restart ssh`
4. Plan B kalau SSH mati terus: minta user F12 → Console di panel → `copy(localStorage.getItem("vpsmurah_token"))` → paste ke chat → pakai token itu buat API panel (`Authorization: Bearer <token>`, base `/api`) → cari endpoint reboot/VNC (bedah bundle `/assets/index-*.js`, axios baseURL `/api`).
5. Setelah SSH hidup, eksekusi setup lengkap (semua via `scripts/vps_ssh.py` atau tunnel):
   a. Hardening sshd (atas) → b. Install WineHQ: `dpkg --add-architecture i386; mkdir -pm755 /etc/apt/keyrings; wget -qO /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/ubuntu/dists/noble/winehq-noble.key; wget -qP /etc/apt/keyrings https://dl.winehq.org/wine-builds/ubuntu/dists/noble/winehq-noble.sources; apt update; apt install -y --install-recommends winehq-stable cabextract winetricks`
   c. Desktop+RDP: `apt install -y xfce4 xfce4-terminal xrdp dbus-x11; adduser xrdp ssl-cert; echo startxfce4 > /root/.xsession; systemctl enable --now xrdp`
   d. MT5: `export WINEPREFIX=/root/.wine WINEDEBUG=-all; wineboot -i; winetricks -q corefonts; cd /tmp; wget -O mt5setup.exe https://download.mql5.com/cdn/web/just.global.markets.ltd/mt5/justmarkets5setup.exe (fallback: https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe); xvfb-run -a wine mt5setup.exe /auto`
   e. Upload EA: `python3 scripts/vps_ssh.py --put "<file EA dari download/>" "/root/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Experts/"`
   f. systemd service auto-start MT5 (Xvfb + wine terminal64.exe, Restart=always)
   g. Verifikasi ping ke server JustMarkets tampil di window login MT5 (user login akun tradingnya sendiri via RDP 3389)
6. Catatan bisnis: user jual EA (lisensi max device per key). Kalau VPS jadi device kedua → naikkan `max_devices` dari dashboard (fitur edit key v4.6).

## 4. TUNNEL DARURAT (ASSET PENTING — JANGAN DIHAPUS)

Worker `vps-tunnel` (URL `https://vps-tunnel.darussolah.workers.dev`, version `89a9a647`): relay WS⇄TCP, hanya mengizinkan target `45.66.153.147:{20268,3389}` + `1.1.1.1:80`. Token di `vps-tunnel/token.txt` + `wrangler.toml [vars]`.
Redeploy: `cd vps-tunnel && export CLOUDFLARE_API_TOKEN=$(grep '^CLOUDFLARE_API_TOKEN=' ../.secrets/credentials.env | cut -d= -f2-) && bunx wrangler deploy`.
Pakai: `nohup python3 scripts/wss_tcp_bridge.py > /tmp/bridge.log 2>&1 &` lalu `python3 scripts/vps_ssh.py --host 127.0.0.1 --port 2222 "<cmd>"`.
⚠️ Setelah VPS stabil + setup beres: kembalikan allowlist worker ke `20268` saja (edit `worker.js`, lihat git history file ini).

## 5. GOTCHAS (PELAJARAN MAHAL — JANGAN DIULANG)

1. **Turnstile** menghalau headless (agent-browser) — jangan buang waktu; pakai user/API token.
2. **`ping`/ICMP & /dev/tcp trick bisa crash shell sandbox** (403 broken session) — pakai curl/paramiko/python saja untuk diagnosa.
3. `ufw limit` untuk SSH: konsepnya oke, tapi saat sshd flood tetap bisa buntu; hardening sshd (LoginGraceTime/MaxStartups) yang benar-benar menolong.
4. EA .mq5 = **BOM + CRLF murni** — patch HANYA via `scripts/patch_ea_46.py` (atomic, assert anchor). Jangan edit sembarangan.
5. VPS 1 vCPU: apt upgrade bisa >5 menit — set timeout besar (560s+) dan jangan asal retry saat timeout connect; cek dulu dengan probe murah.
6. IM mode: balas singkat, Indonesia santai, pakai tabel; user bukan teknisi — jangan lempar jargon tanpa langkah praktis.
7. Bash tool sesekali mati (403 broken session) — nunggu turn berikutnya biasanya sembuh; jangan buang turn untuk debug tool.

## 6. DEFINITION OF DONE untuk task VPS ini

MT5 v4.6 jalan 24/7 di VPS (auto-restart), user bisa RDP untuk lihat, EA tersambung ke server lisensi (device terdaftar), ping ke broker wajar (<80 ms), laporan akhir ke user + update worklog.md.
