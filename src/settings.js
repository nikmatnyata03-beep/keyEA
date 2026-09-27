// ============================================================
// Seven Sigma — Settings (KV D1) + Notifikasi Telegram
// Semua konfigurasi runtime (password hash admin, bot token)
// disimpan di tabel settings agar bisa diubah dari dashboard
// tanpa deploy ulang / wrangler CLI.
// ============================================================

import { now, fmtTime } from './util.js';

// ---------------- KV helpers ----------------
export async function getSetting(db, k) {
  const row = await db.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first();
  return row ? row.v : null;
}

export async function setSetting(db, k, v) {
  await db.prepare(
    'INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
  ).bind(k, String(v)).run();
}

export async function delSetting(db, k) {
  await db.prepare('DELETE FROM settings WHERE k = ?').bind(k).run();
}

// ---------------- Telegram ----------------
const TG_API = 'https://api.telegram.org';

async function tgConfig(env) {
  const [token, chatId, enabled] = await Promise.all([
    getSetting(env.DB, 'tg_bot_token'),
    getSetting(env.DB, 'tg_chat_id'),
    getSetting(env.DB, 'tg_enabled'),
  ]);
  return { token, chatId, enabled: enabled !== '0' && !!(token && chatId) };
}

// Kirim pesan Telegram; SELALU aman dipanggil (tidak pernah throw,
// gagal kirim hanya diabaikan agar alur lisensi tidak terganggu).
export async function tgSend(env, text) {
  try {
    const cfg = await tgConfig(env);
    if (!cfg.enabled) return { ok: false, skipped: true };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(TG_API + '/bot' + cfg.token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'HTML',
        disable_web_page_preview: true }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    return { ok: res.ok };
  } catch (_e) {
    return { ok: false };
  }
}

// Uji koneksi dari dashboard (balikin error asli supaya bisa dikoreksi).
export async function tgTest(env) {
  const cfg = await tgConfig(env);
  if (!cfg.token || !cfg.chatId) {
    return { ok: false, error: 'Bot token / Chat ID belum diisi.' };
  }
  try {
    const res = await fetch(TG_API + '/bot' + cfg.token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId,
        text: '✅ <b>Seven Sigma</b>\nTes notifikasi berhasil. Notifikasi lisensi akan dikirim ke chat ini.' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      return { ok: false, error: 'Telegram: ' + (data.description || ('HTTP ' + res.status)) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Tidak dapat menghubungi api.telegram.org: ' + String(e && e.message || e) };
  }
}

// Mask token utk ditampilkan di dashboard (jangan bocahkan penuh).
export function maskToken(t) {
  if (!t) return '';
  if (t.length <= 10) return '•••••';
  return t.slice(0, 6) + '••••••••' + t.slice(-4);
}

// ---------------- Notifikasi event lisensi ----------------
// Event noisy (dicoba berulang tiap recheck EA) dibatasi 1 notif per
// key+event per 24 jam berdasarkan riwayat checkin_logs.
const THROTTLED_EVENTS = { NOT_FOUND: 1, REVOKED: 1, EXPIRED: 1, INVALID: 1 };

export async function notifyEvent(ctx, env, { event, key, account, broker, detail, ip }) {
  try {
    const cfg = await tgConfig(env);
    if (!cfg.enabled) return;

    if (THROTTLED_EVENTS[event]) {
      const since = now() - 86400;
      const r = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM checkin_logs WHERE event = ? AND key_text = ? AND created_at >= ?"
      ).bind(event, key || '', since).first();
      if (r && (r.n || 0) > 1) return; // sudah pernah dinotif 24 jam terakhir
    }

    const ICON = {
      ACTIVATE: '🟢', DEVICE_LIMIT: '🚫', REVOKED: '⛔', EXPIRED: '⏰',
      NOT_FOUND: '❓', INVALID: '⚠️', ADMIN_REVOKE: '⛔', ADMIN_ENABLE: '🔓',
    };
    const title = {
      ACTIVATE: 'Device BARU terikat (aktivasi)',
      DEVICE_LIMIT: 'Percobaan pakai key di device lain!',
      REVOKED: 'Validasi dengan key DINONAKTIFKAN',
      EXPIRED: 'Validasi dengan key KADALUARSA',
      NOT_FOUND: 'Key tidak ditemukan',
      INVALID: 'Request tidak valid',
      ADMIN_REVOKE: 'Key dinonaktifkan oleh admin',
      ADMIN_ENABLE: 'Key diaktifkan kembali oleh admin',
    }[event] || event;

    let msg = ICON[event] || '🔔';
    msg += ' <b>Seven Sigma — ' + title + '</b>\n';
    if (key) msg += 'Key   : <code>' + escHtml(key) + '</code>\n';
    if (account) msg += 'Akun  : <code>' + escHtml(account) + '</code>' + (broker ? ' (' + escHtml(broker) + ')' : '') + '\n';
    if (ip) msg += 'IP    : ' + escHtml(ip) + '\n';
    if (detail) msg += 'Info  : ' + escHtml(detail) + '\n';
    msg += 'Waktu : ' + fmtTime(now()) + ' UTC';

    const p = tgSend(env, msg);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    else await p;
  } catch (_e) { /* notifikasi tidak boleh mengganggu alur utama */ }
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
