// ============================================================
// Seven Sigma — Endpoint admin dashboard (Bearer token)
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
import { issueToken, verifyToken, adminPasswordIsDefault, verifyPassword } from './auth.js';
import { generateKey } from './keys.js';
import { log } from './license.js';

async function guard(request, env) {
  return verifyToken(env, request.headers.get('authorization'));
}

// ------------------------------------------------------------------- login
async function login(request, env) {
  const body = await readJson(request);
  const password = String(body.password || '');
  if (!password || !(await verifyPassword(env, password))) {
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
    let stats = null;
    if (d.stats_full) {
      try { stats = JSON.parse(d.stats_full); } catch (_e) { stats = null; }
    }
    (byKey[d.key_id] = byKey[d.key_id] || []).push({
      account: d.account, broker: d.broker,
      first_seen: d.first_seen, first_seen_str: fmtTime(d.first_seen),
      last_seen: d.last_seen, last_seen_str: fmtTime(d.last_seen),
      last_ip: d.last_ip,
      balance: d.balance, equity: d.equity, float_pl: d.float_pl,
      wins: d.wins, losses: d.losses, closed_pl: d.closed_pl,
      stats_at: d.stats_at, stats_at_str: fmtTime(d.stats_at),
      stats,
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
    // Cek duplikat lalu insert; UNIQUE race (request admin simultan) ->
    // regenerasi key, maksimal 5 percobaan.
    let inserted = false;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const dup = await env.DB.prepare('SELECT id FROM license_keys WHERE key_norm = ?')
        .bind(key.replace(/-/g, '')).first();
      if (dup) { key = generateKey(); continue; }
      try {
        await env.DB.prepare(
          'INSERT INTO license_keys (key, key_norm, label, status, duration_days, max_devices, created_at) VALUES (?,?,?,?,?,?,?)'
        ).bind(key, key.replace(/-/g, ''), label, 'active', duration, maxDevices, ts).run();
        inserted = true;
      } catch (_e) { key = generateKey(); }
    }
    if (!inserted) continue;
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
  const row = await env.DB.prepare('SELECT key FROM license_keys WHERE id = ?').bind(id).first();
  await env.DB.prepare('DELETE FROM checkin_logs WHERE key_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM devices WHERE key_id = ?').bind(id).run();
  const r = await env.DB.prepare('DELETE FROM license_keys WHERE id = ?').bind(id).run();
  if (!r.meta || r.meta.changes === 0) return fail('NOT_FOUND', 'Key tidak ditemukan.', 404);
  await log(env.DB, null, row ? row.key : '', '', '', '', 'ADMIN_DELETE',
    'Key dihapus permanen beserta device & riwayatnya');
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
  const id = seg[3] !== undefined ? parseInt(seg[3], 10) : NaN;
  const idOk = Number.isInteger(id) && id > 0;

  if (path === '/api/admin/stats' && request.method === 'GET') return stats(env);
  if (path === '/api/admin/keys' && request.method === 'GET') return listKeys(env);
  if (path === '/api/admin/keys' && request.method === 'POST') return createKeys(request, env);
  if (path === '/api/admin/logs' && request.method === 'GET') return allLogs(request, env, url);

  if (seg[2] === 'keys' && idOk && seg[4] === undefined && request.method === 'DELETE') {
    return deleteKey(env, id);
  }
  if (seg[2] === 'keys' && idOk && seg[4] === 'toggle' && request.method === 'POST') {
    return toggleKey(request, env, id);
  }
  if (seg[2] === 'keys' && idOk && seg[4] === 'reset' && request.method === 'POST') {
    return resetKey(env, id);
  }
  if (seg[2] === 'keys' && idOk && seg[4] === 'logs' && request.method === 'GET') {
    return keyLogs(request, env, id, url);
  }

  return json({ ok: false, error: 'NOT_FOUND', message: 'Endpoint admin tidak ditemukan.' }, 404);
}
