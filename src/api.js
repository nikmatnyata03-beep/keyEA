// ============================================================
// Seven Sigma — Endpoint untuk EA & publik (dipanggil via WebRequest MT5)
//   GET  /api/v1/ping      -> cek server hidup
//   POST /api/v1/validate  -> validasi berkala (EA semua versi)
//   POST /api/v1/activate  -> aktivasi/ikatan device pertama kali
//   POST /api/v1/stats     -> push statistik portofolio (EA v4.6+, realtime)
//   POST /api/v1/check     -> cek status key (PUBLIK, utk halaman /check)
// ============================================================

import { json, now, fmtTime, clientIp, readJson, fail } from './util.js';
import { coreValidate, coreStatsPush } from './license.js';

function payloadToResult(res, ts) {
  const row = res.row || {};
  return json({
    ok: true,
    valid: !!res.valid,
    error: res.error || '',
    message: res.message || '',
    license: row.key || '',
    account: row.last_account || '',
    activated_at: row.activated_at || 0,
    activated_at_str: fmtTime(row.activated_at),
    expires_ts: row.expires_at || 0,
    expires_at: fmtTime(row.expires_at),
    server_ts: ts,
    server_time: fmtTime(ts),
  });
}

export async function handlePing(env) {
  const ts = now();
  return json({ ok: true, product: env.PRODUCT_NAME || 'Seven Sigma',
    server_ts: ts, server_time: fmtTime(ts) });
}

async function handleValidate(request, env, ctx) {
  const ts = now();
  const body = await readJson(request);
  const ip = clientIp(request);
  // Statistik portofolio opsional dari EA (objek stats lengkap ala MQL5 Signal)
  const stats = (body.stats && typeof body.stats === 'object' && !Array.isArray(body.stats))
    ? body.stats : null;
  const res = await coreValidate(env.DB, {
    key: body.key || body.license_key || '',
    account: (body.account === undefined || body.account === null) ? '' : String(body.account),
    broker: body.broker || '',
    stats,
  }, ip, ctx);
  return payloadToResult(res, ts);
}

// Heartbeat statistik — EA v4.6 mengirim portofolio berkala (default 5 menit)
// tanpa menulis log validasi. Respons valid:false membuat EA memaksa
// validasi lisensi penuh pada tick berikutnya (revoke/expire terdeteksi cepat).
async function handleStats(request, env) {
  const ts = now();
  const body = await readJson(request);
  const ip = clientIp(request);
  const stats = (body.stats && typeof body.stats === 'object' && !Array.isArray(body.stats))
    ? body.stats : null;
  const res = await coreStatsPush(env.DB, {
    key: body.key || body.license_key || '',
    account: (body.account === undefined || body.account === null) ? '' : String(body.account),
    broker: body.broker || '',
    stats,
  }, ip);
  return json({
    ok: true,
    valid: !!res.valid,
    error: res.error || '',
    message: res.message || '',
    expires_ts: (res.row && res.row.expires_at) || 0,
    server_ts: ts,
  });
}

// ---------------- cek key publik (halaman /check) ----------------
// Rate limit: maks 20 permintaan per IP per jam (tabel check_rate).
const CHECK_RATE_LIMIT = 20;
const CHECK_WINDOW = 3600;

async function rateLimitCheck(db, ip) {
  const ts = now();
  const row = await db.prepare('SELECT * FROM check_rate WHERE ip = ?').bind(ip).first();
  if (!row || ts - row.window_start >= CHECK_WINDOW) {
    await db.prepare(
      'INSERT INTO check_rate (ip, window_start, n) VALUES (?, ?, 1) ON CONFLICT(ip) DO UPDATE SET window_start = excluded.window_start, n = 1'
    ).bind(ip, ts).run();
    return true;
  }
  if ((row.n || 0) >= CHECK_RATE_LIMIT) return false;
  await db.prepare('UPDATE check_rate SET n = n + 1 WHERE ip = ?').bind(ip).run();
  return true;
}

async function handlePublicCheck(request, env) {
  const ip = clientIp(request);
  if (!(await rateLimitCheck(env.DB, ip))) {
    return fail('RATE_LIMITED', 'Terlalu banyak permintaan. Coba lagi dalam satu jam.', 429);
  }
  const body = await readJson(request);
  const keyNorm = String(body.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!keyNorm) return fail('INVALID_REQUEST', 'Masukkan license key Anda.', 400);

  const row = await env.DB.prepare('SELECT * FROM license_keys WHERE key_norm = ?')
    .bind(keyNorm).first();
  if (!row) {
    return json({ ok: true, found: false, status: 'not_found',
      message: 'Key tidak ditemukan. Periksa kembali penulisan key Anda.' });
  }
  const ts = now();
  const expired = !!(row.expires_at && ts >= row.expires_at);
  const devCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE key_id = ?')
    .bind(row.id).first();
  const status = row.status === 'revoked' ? 'revoked' : (expired ? 'expired' : 'active');
  return json({
    ok: true,
    found: true,
    status,
    activated: !!row.activated_at,
    activated_at_str: fmtTime(row.activated_at),
    expires_at_str: row.expires_at ? fmtTime(row.expires_at) : '',
    lifetime: !row.expires_at,
    days_left: (row.expires_at && !expired) ? Math.max(0, Math.ceil((row.expires_at - ts) / 86400)) : 0,
    max_devices: row.max_devices,
    devices_used: devCount ? (devCount.n || 0) : 0,
  });
}

export async function handleApi(request, env, path, ctx) {
  if (path === '/api/v1/ping' && request.method === 'GET') return handlePing(env);
  if (path === '/api/v1/validate' && request.method === 'POST') return handleValidate(request, env, ctx);
  if (path === '/api/v1/activate' && request.method === 'POST') return handleValidate(request, env, ctx);
  if (path === '/api/v1/stats' && request.method === 'POST') return handleStats(request, env);
  if (path === '/api/v1/check' && request.method === 'POST') return handlePublicCheck(request, env);
  return json({ ok: false, error: 'NOT_FOUND', message: 'Endpoint tidak ditemukan.' }, 404);
}
