// ============================================================
// Seven Sigma — Endpoint admin dashboard (Bearer token)
//   POST   /api/admin/login              -> token
//   GET    /api/admin/stats              -> ringkasan
//   GET    /api/admin/keys               -> daftar key + device
//   POST   /api/admin/keys               -> generate key (batch)
//   POST   /api/admin/keys/:id/update    -> edit label/durasi/perpanjang/max device
//   POST   /api/admin/keys/:id/toggle    -> revoke / aktifkan
//   POST   /api/admin/keys/:id/reset     -> lepas binding device
//   DELETE /api/admin/keys/:id           -> hapus key permanen
//   GET    /api/admin/keys/:id/logs      -> riwayat 1 key
//   GET    /api/admin/logs               -> aktivitas global
//   GET    /api/admin/activity           -> data grafik aktivitas harian (?days=7|30)
//   GET    /api/admin/settings           -> pengaturan (telegram; token ter-mask)
//   POST   /api/admin/settings           -> simpan pengaturan telegram
//   POST   /api/admin/telegram/test      -> kirim pesan tes
//   POST   /api/admin/password           -> ganti password admin (PBKDF2, dari dashboard)
// ============================================================

import { json, now, fmtTime, clientIp, readJson, fail } from './util.js';
import { issueToken, verifyToken, adminPasswordIsDefault, verifyPassword, hashPassword } from './auth.js';
import { generateKey } from './keys.js';
import { log } from './license.js';
import { getSetting, setSetting, tgSend, tgTest, maskToken, notifyEvent } from './settings.js';

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
    warn_default_password: await adminPasswordIsDefault(env) });
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

// ------------------------------------------------------------------- edit / perpanjang key
// Body (semua opsional):
//   label        : ubah label/catatan
//   duration_days: ubah durasi bawaan (hanya berlaku utk key BELUM aktif)
//   extend_days  : perpanjang — key aktif: expires_at digeser dari max(now, expires_at);
//                  key belum aktif: duration_days ditambah
//   max_devices  : ubah batas device (tidak boleh < device terikat)
async function updateKey(request, env, id) {
  const body = await readJson(request);
  const row = await env.DB.prepare('SELECT * FROM license_keys WHERE id = ?').bind(id).first();
  if (!row) return fail('NOT_FOUND', 'Key tidak ditemukan.', 404);

  const ts = now();
  const sets = [];
  const args = [];
  const notes = [];

  // --- label ---
  if (body.label !== undefined && body.label !== null) {
    sets.push('label = ?'); args.push(String(body.label).slice(0, 120));
    notes.push('label diubah');
  }

  // --- max_devices ---
  if (body.max_devices !== undefined && body.max_devices !== null && body.max_devices !== '') {
    const md = parseInt(body.max_devices, 10);
    if (!Number.isFinite(md) || md < 1 || md > 10) {
      return fail('INVALID_REQUEST', 'Maks device harus 1-10.', 400);
    }
    const usedRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE key_id = ?')
      .bind(id).first();
    const used = usedRow ? (usedRow.n || 0) : 0;
    if (md < used) {
      return fail('INVALID_REQUEST',
        'Maks device tidak boleh lebih kecil dari device terikat saat ini (' + used + ').', 400);
    }
    sets.push('max_devices = ?'); args.push(md);
    notes.push('maks device ' + row.max_devices + ' -> ' + md);
  }

  // --- extend_days (perpanjang) ---
  const extRaw = parseInt(body.extend_days, 10);
  const extend = Number.isFinite(extRaw) ? Math.max(0, Math.min(3650, extRaw)) : 0;
  if (extend > 0) {
    if (row.activated_at && row.expires_at) {
      // Key aktif: geser dari tanggal expired (atau dari sekarang bila sudah lewat)
      const base = Math.max(ts, row.expires_at);
      sets.push('expires_at = ?'); args.push(base + extend * 86400);
      notes.push('perpanjang ' + extend + ' hari');
    } else {
      // Belum aktivasi: durasi bawaan ditambah
      const cur = (row.duration_days === null || row.duration_days === undefined) ? 0 : row.duration_days;
      sets.push('duration_days = ?'); args.push(Math.min(3650, cur + extend));
      notes.push('durasi bawaan +' + extend + ' hari');
    }
  }

  // --- duration_days (key belum aktif saja) ---
  if (body.duration_days !== undefined && body.duration_days !== null && body.duration_days !== '') {
    const dd = parseInt(body.duration_days, 10);
    if (!Number.isFinite(dd) || dd < 0 || dd > 3650) {
      return fail('INVALID_REQUEST', 'Durasi harus 0-3650 hari (0 = lifetime).', 400);
    }
    if (row.activated_at) {
      if (!(extend > 0)) {
        return fail('INVALID_REQUEST',
          'Key sudah aktif — gunakan "Perpanjang (hari)" untuk mengubah masa berlaku.', 400);
      }
    } else {
      sets.push('duration_days = ?'); args.push(dd);
      notes.push('durasi bawaan -> ' + dd + ' hari');
    }
  }

  if (!sets.length) return fail('INVALID_REQUEST', 'Tidak ada perubahan yang dikirim.', 400);

  args.push(id);
  await env.DB.prepare('UPDATE license_keys SET ' + sets.join(', ') + ' WHERE id = ?').bind(...args).run();
  await log(env.DB, id, row.key, '', '', '', 'ADMIN_EDIT',
    'Key diedit: ' + (notes.join(', ') || '-') );

  const fresh = await env.DB.prepare('SELECT * FROM license_keys WHERE id = ?').bind(id).first();
  return json({ ok: true, key: { ...fresh, key_norm: undefined },
    message: 'Key diperbarui (' + notes.join(', ') + ').' });
}

// ------------------------------------------------------------------- toggle/reset/delete
async function toggleKey(request, env, id) {
  const body = await readJson(request);
  const status = body.status === 'revoked' ? 'revoked' : 'active';
  const row = await env.DB.prepare('SELECT key FROM license_keys WHERE id = ?').bind(id).first();
  const r = await env.DB.prepare('UPDATE license_keys SET status = ? WHERE id = ?')
    .bind(status, id).run();
  if (!r.meta || r.meta.changes === 0) return fail('NOT_FOUND', 'Key tidak ditemukan.', 404);
  await log(env.DB, id, row ? row.key : '', '', '', '', status === 'revoked' ? 'ADMIN_REVOKE' : 'ADMIN_ENABLE',
    'Status diubah menjadi ' + status);
  await notifyEvent(null, env, { event: status === 'revoked' ? 'ADMIN_REVOKE' : 'ADMIN_ENABLE',
    key: row ? row.key : '', detail: 'Status key diubah menjadi ' + status + ' dari dashboard' });
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

// ------------------------------------------------------------------- grafik aktivitas
// Bucket harian dari checkin_logs + key dibuat. Aman lintas env (bucket di JS).
async function activity(request, env, url) {
  const daysRaw = parseInt(url.searchParams.get('days'), 10);
  const days = (daysRaw === 30) ? 30 : 7;
  const ts = now();
  const since = ts - days * 86400;

  const buckets = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date((ts - i * 86400) * 1000);
    const p = (n) => String(n).padStart(2, '0');
    const dayKey = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
    buckets[dayKey] = { day: dayKey, valid: 0, activate: 0, blocked: 0, admin: 0 };
  }

  const BLOCKED = { DEVICE_LIMIT: 1, REVOKED: 1, EXPIRED: 1, NOT_FOUND: 1, INVALID: 1 };
  const ADMIN = { ADMIN_CREATE: 1, ADMIN_EDIT: 1, ADMIN_REVOKE: 1, ADMIN_ENABLE: 1,
    ADMIN_RESET: 1, ADMIN_DELETE: 1, ADMIN_PWCHANGE: 1 };

  const logs = await env.DB.prepare(
    'SELECT event, created_at FROM checkin_logs WHERE created_at >= ? ORDER BY created_at ASC'
  ).bind(since).all();
  for (const l of (logs.results || [])) {
    const d = new Date(l.created_at * 1000);
    const p = (n) => String(n).padStart(2, '0');
    const dayKey = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
    const b = buckets[dayKey];
    if (!b) continue;
    if (l.event === 'VALID') b.valid++;
    else if (l.event === 'ACTIVATE') b.activate++;
    else if (BLOCKED[l.event]) b.blocked++;
    else if (ADMIN[l.event]) b.admin++;
  }

  const keysCreated = await env.DB.prepare(
    'SELECT created_at FROM license_keys WHERE created_at >= ?').bind(since).all();
  for (const k of (keysCreated.results || [])) {
    const d = new Date(k.created_at * 1000);
    const p = (n) => String(n).padStart(2, '0');
    const dayKey = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
    const b = buckets[dayKey];
    if (b) b.admin++; // key dibuat dihitung di seri admin (ubah label di FE)
  }

  const series = Object.values(buckets);
  const totals = series.reduce((a, b) => ({
    valid: a.valid + b.valid, activate: a.activate + b.activate,
    blocked: a.blocked + b.blocked, admin: a.admin + b.admin,
  }), { valid: 0, activate: 0, blocked: 0, admin: 0 });

  return json({ ok: true, days, series, totals, generated_at: ts });
}

// ------------------------------------------------------------------- settings (telegram)
async function getSettings(env) {
  const [token, chatId, enabled] = await Promise.all([
    getSetting(env.DB, 'tg_bot_token'),
    getSetting(env.DB, 'tg_chat_id'),
    getSetting(env.DB, 'tg_enabled'),
  ]);
  return json({ ok: true,
    tg_bot_token_masked: token ? maskToken(token) : '',
    tg_has_token: !!token,
    tg_chat_id: chatId || '',
    tg_enabled: enabled !== '0' && !!(token && chatId),
  });
}

async function saveSettings(request, env) {
  const body = await readJson(request);
  let changed = [];
  if (body.tg_bot_token !== undefined) {
    const t = String(body.tg_bot_token || '').trim();
    if (t && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(t) && !t.includes('•')) {
      return fail('INVALID_REQUEST', 'Format bot token tidak valid (harus seperti 123456789:ABC...).', 400);
    }
    // Kosong = hapus; ber-mask = biarkan (tidak berubah)
    if (t === '') { await setSetting(env.DB, 'tg_bot_token', ''); changed.push('bot token dikosongkan'); }
    else if (!t.includes('•')) { await setSetting(env.DB, 'tg_bot_token', t); changed.push('bot token disimpan'); }
  }
  if (body.tg_chat_id !== undefined) {
    const c = String(body.tg_chat_id || '').trim();
    if (c && !/^-?\d{3,}$/.test(c)) {
      return fail('INVALID_REQUEST', 'Chat ID harus berupa angka (mis. 123456789 atau -1001234567890).', 400);
    }
    await setSetting(env.DB, 'tg_chat_id', c);
    changed.push('chat ID disimpan');
  }
  if (body.tg_enabled !== undefined) {
    await setSetting(env.DB, 'tg_enabled', body.tg_enabled ? '1' : '0');
    changed.push('notifikasi ' + (body.tg_enabled ? 'diaktifkan' : 'dimatikan'));
  }
  await log(env.DB, null, '', '', '', '', 'ADMIN_EDIT',
    'Pengaturan disimpan: ' + (changed.join(', ') || 'tanpa perubahan'));
  return json({ ok: true, message: changed.length ? 'Pengaturan disimpan.' : 'Tidak ada perubahan.' });
}

// ------------------------------------------------------------------- ganti password
async function changePassword(request, env) {
  const body = await readJson(request);
  const current = String(body.current_password || '');
  const next = String(body.new_password || '');
  const confirm = String(body.confirm_password || '');

  if (!(await verifyPassword(env, current))) {
    return fail('WRONG_PASSWORD', 'Password saat ini salah.', 401);
  }
  if (next.length < 8) {
    return fail('INVALID_REQUEST', 'Password baru minimal 8 karakter.', 400);
  }
  if (next !== confirm) {
    return fail('INVALID_REQUEST', 'Konfirmasi password tidak sama.', 400);
  }
  if (next === current) {
    return fail('INVALID_REQUEST', 'Password baru harus berbeda dari password lama.', 400);
  }

  const hash = await hashPassword(next);
  await setSetting(env.DB, 'admin_pw_hash', hash);
  await log(env.DB, null, '', '', '', '', 'ADMIN_PWCHANGE', 'Password admin diganti dari dashboard');
  await notifyEvent(null, env, { event: 'ADMIN_PWCHANGE', key: '',
    detail: 'Password admin dashboard baru saja diganti' });

  return json({ ok: true,
    message: 'Password diganti. Semua sesi login lain otomatis keluar — silakan login ulang.' });
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
export async function handleAdmin(request, env, path, url, ctx) {
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
  if (path === '/api/admin/activity' && request.method === 'GET') return activity(request, env, url);
  if (path === '/api/admin/settings' && request.method === 'GET') return getSettings(env);
  if (path === '/api/admin/settings' && request.method === 'POST') return saveSettings(request, env);
  if (path === '/api/admin/telegram/test' && request.method === 'POST') {
    const r = await tgTest(env);
    await log(env.DB, null, '', '', '', '', 'ADMIN_EDIT',
      'Tes Telegram: ' + (r.ok ? 'berhasil' : 'gagal' + (r.error ? ' (' + r.error + ')' : '')));
    return json({ ...r }, r.ok ? 200 : 400);
  }
  if (path === '/api/admin/password' && request.method === 'POST') return changePassword(request, env);

  if (seg[2] === 'keys' && idOk && seg[4] === 'update' && request.method === 'POST') {
    return updateKey(request, env, id);
  }
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
