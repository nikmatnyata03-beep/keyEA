// ============================================================
// Quantum Queen X — Endpoint admin dashboard (Bearer token)
//   POST   /api/admin/login              -> token
//   GET    /api/admin/stats              -> ringkasan
//   GET    /api/admin/keys               -> daftar key + device
//   POST   /api/admin/keys               -> generate key (batch)
//   POST   /api/admin/keys/:id/toggle    -> revoke / aktifkan
//   POST   /api/admin/keys/:id/reset     -> lepas binding device
//   DELETE /api/admin/keys/:id           -> hapus key permanen
//   GET    /api/admin/keys/:id/logs      -> riwayat 1 key
//   GET    /api/admin/logs               -> aktivitas global
// ============================================================

import { json, now, fmtTime, clientIp, readJson, fail } from './util.js';
import { issueToken, verifyToken, adminPasswordIsDefault } from './auth.js';
import { generateKey } from './keys.js';
import { log } from './license.js';

async function guard(request, env) {
  return verifyToken(env, request.headers.get('authorization'));
}

// ------------------------------------------------------------------- login
async function login(request, env) {
  const body = await readJson(request);
  const password = String(body.password || '');
  if (!password || password !== (env.ADMIN_PASSWORD || 'quantum-queen-admin')) {
    return fail('WRONG_PASSWORD', 'Password admin salah.', 401);
  }
  const t = await issueToken(env);
  return json({ ok: true, token: t.token, expires_in: t.expires_in,
    warn_default_password: adminPasswordIsDefault(env) });
}

// ------------------------------------------------------------------- stats
async function stats(env) {
  const ts = now();
  const q = async (sql) => {
    const r = await env.DB.prepare(sql).first();
    return r ? (r.n || 0) : 0;
  };
  const total = await q('SELECT COUNT(*) AS n FROM license_keys');
  const active = await q("SELECT COUNT(*) AS n FROM license_keys WHERE status='active'");
  const revoked = await q("SELECT COUNT(*) AS n FROM license_keys WHERE status='revoked'");
  const bound = await q('SELECT COUNT(*) AS n FROM license_keys WHERE activated_at IS NOT NULL');
  const expired = await q(
    "SELECT COUNT(*) AS n FROM license_keys WHERE expires_at IS NOT NULL AND expires_at <= " + ts);
  const devices = await q('SELECT COUNT(*) AS n FROM devices');
  const checkins24h = await q(
    'SELECT COUNT(*) AS n FROM checkin_logs WHERE event=\'VALID\' AND created_at >= ' + (ts - 86400));
  return json({ ok: true, total, active, revoked, bound, expired, devices, checkins24h,
    server_time: fmtTime(ts) });
}

// ------------------------------------------------------------------- list keys
async function listKeys(env) {
  const keys = await env.DB.prepare(
    'SELECT * FROM license_keys ORDER BY created_at DESC LIMIT 500').all();
  const devices = await env.DB.prepare(
    'SELECT * FROM devices ORDER BY first_seen ASC').all();
  const byKey = {};
  for (const d of (devices.results || [])) {
    (byKey[d.key_id] = byKey[d.key_id] || []).push({
      account: d.account, broker: d.broker,
      first_seen: d.first_seen, first_seen_str: fmtTime(d.first_seen),
      last_seen: d.last_seen, last_seen_str: fmtTime(d.last_seen),
      last_ip: d.last_ip,
    });
  }
  const ts = now();
  const rows = (keys.results || []).map((k) => ({
    ...k,
    key_norm: undefined,
    created_at_str: fmtTime(k.created_at),
    activated_at_str: fmtTime(k.activated_at),
    expires_at_str: fmtTime(k.expires_at),
    last_checkin_at_str: fmtTime(k.last_checkin_at),
    is_expired: !!(k.expires_at && ts >= k.expires_at),
    is_bound: !!k.activated_at,
    devices: byKey[k.id] || [],
  }));
  return json({ ok: true, keys: rows });
}

// ------------------------------------------------------------------- create keys
async function createKeys(request, env) {
  const body = await readJson(request);
  const label = String(body.label || '').slice(0, 120);
  const rawDur = parseInt(body.duration_days, 10);
  const duration = Math.max(0, Math.min(3650, Number.isFinite(rawDur) ? rawDur : 30));
  const maxDevices = Math.max(1, Math.min(10, parseInt(body.max_devices, 10) || 1));
  const quantity = Math.max(1, Math.min(50, parseInt(body.quantity, 10) || 1));
  const ts = now();
  const created = [];
  for (let i = 0; i < quantity; i++) {
    let key = generateKey();
    // hindari tabrakan sangat kecil kemungkinannya
    for (let attempt = 0; attempt < 5; attempt++) {
      const dup = await env.DB.prepare('SELECT id FROM license_keys WHERE key_norm = ?')
        .bind(key.replace(/-/g, '')).first();
      if (!dup) break;
      key = generateKey();
    }
    await env.DB.prepare(
      'INSERT INTO license_keys (key, key_norm, label, status, duration_days, max_devices, created_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(key, key.replace(/-/g, ''), label, 'active', duration, maxDevices, ts).run();
    created.push(key);
  }
  await log(env.DB, null, created[0] || '', '', '', '', 'ADMIN_CREATE',
    quantity + ' key dibuat (durasi ' + duration + ' hari, max device ' + maxDevices + ')');
  return json({ ok: true, created });
}

// ------------------------------------------------------------------- toggle/reset/delete
async function toggleKey(request, env, id) {
  const body = await readJson(request);
  const status = body.status === 'revoked' ? 'revoked' : 'active';
  const r = await env.DB.prepare('UPDATE license_keys SET status = ? WHERE id = ?')
    .bind(status, id).run();
  if (!r.meta || r.meta.changes === 0) return fail('NOT_FOUND', 'Key tidak ditemukan.', 404);
  await log(env.DB, id, '', '', '', '', status === 'revoked' ? 'ADMIN_REVOKE' : 'ADMIN_ENABLE',
    'Status diubah menjadi ' + status);
  return json({ ok: true, status });
}

async function resetKey(env, id) {
  await env.DB.prepare('DELETE FROM devices WHERE key_id = ?').bind(id).run();
  await env.DB.prepare(
    'UPDATE license_keys SET activated_at = NULL, expires_at = NULL WHERE id = ?'
  ).bind(id).run();
  await log(env.DB, id, '', '', '', '', 'ADMIN_RESET', 'Binding device dihapus admin');
  return json({ ok: true, message: 'Binding device dihapus. Key akan ter-aktivasi ulang pada pemakaian berikutnya.' });
}

async function deleteKey(env, id) {
  await env.DB.prepare('DELETE FROM checkin_logs WHERE key_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM devices WHERE key_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM license_keys WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ------------------------------------------------------------------- logs
async function keyLogs(request, env, id, url) {
  const limit = Math.min(200, parseInt(url.searchParams.get('limit'), 10) || 100);
  const rows = await env.DB.prepare(
    'SELECT * FROM checkin_logs WHERE key_id = ? ORDER BY created_at DESC LIMIT ' + limit
  ).bind(id).all();
  return json({ ok: true, logs: (rows.results || []).map(fmtLog) });
}

async function allLogs(request, env, url) {
  const limit = Math.min(200, parseInt(url.searchParams.get('limit'), 10) || 50);
  const rows = await env.DB.prepare(
    'SELECT * FROM checkin_logs ORDER BY created_at DESC LIMIT ' + limit).all();
  return json({ ok: true, logs: (rows.results || []).map(fmtLog) });
}

function fmtLog(l) {
  return { ...l, created_at_str: fmtTime(l.created_at) };
}

// ------------------------------------------------------------------- router
export async function handleAdmin(request, env, path, url) {
  if (path === '/api/admin/login' && request.method === 'POST') return login(request, env);

  const authed = await guard(request, env);
  if (!authed) return fail('UNAUTHORIZED', 'Token tidak valid / kadaluarsa. Login ulang.', 401);

  const seg = path.split('/').filter(Boolean); // ['api','admin',...]

  if (path === '/api/admin/stats' && request.method === 'GET') return stats(env);
  if (path === '/api/admin/keys' && request.method === 'GET') return listKeys(env);
  if (path === '/api/admin/keys' && request.method === 'POST') return createKeys(request, env);
  if (path === '/api/admin/logs' && request.method === 'GET') return allLogs(request, env, url);

  if (seg[2] === 'keys' && seg[3] && seg[4] === undefined && request.method === 'DELETE') {
    return deleteKey(env, parseInt(seg[3], 10));
  }
  if (seg[2] === 'keys' && seg[3] && seg[4] === 'toggle' && request.method === 'POST') {
    return toggleKey(request, env, parseInt(seg[3], 10));
  }
  if (seg[2] === 'keys' && seg[3] && seg[4] === 'reset' && request.method === 'POST') {
    return resetKey(env, parseInt(seg[3], 10));
  }
  if (seg[2] === 'keys' && seg[3] && seg[4] === 'logs' && request.method === 'GET') {
    return keyLogs(request, env, parseInt(seg[3], 10), url);
  }

  return json({ ok: false, error: 'NOT_FOUND', message: 'Endpoint admin tidak ditemukan.' }, 404);
}
