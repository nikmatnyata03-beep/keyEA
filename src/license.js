// ============================================================
// Seven Sigma — Logika inti validasi lisensi (1 device 1 key)
// Dipakai oleh endpoint /api/v1/validate dan /api/v1/activate
// ============================================================

import { now, fmtTime, normalizeKey } from './util.js';

/**
 * Validasi key + akun trading.
 * @param {D1Database} db  binding D1 (atau shim bun:sqlite pada preview)
 * @param {object} p       { key, account, broker }
 * @param {string} ip      IP client
 * @returns {{valid:boolean, error?:string, message:string, row?:object, event:string}}
 */
export async function coreValidate(db, p, ip) {
  const ts = now();
  const keyNorm = normalizeKey(p.key);
  const account = String(p.account || '').trim();
  const broker = String(p.broker || '').trim();

  // Statistik trading opsional dari EA (balance, equity, W/L, dll)
  const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const hasStats = !!p.stats && ['balance','equity','float_pl','wins','losses','closed_pl']
    .some((f) => p.stats[f] !== undefined && p.stats[f] !== null && p.stats[f] !== '');
  const st = hasStats ? {
    balance: num(p.stats.balance), equity: num(p.stats.equity), float_pl: num(p.stats.float_pl),
    wins: Math.max(0, Math.round(num(p.stats.wins))), losses: Math.max(0, Math.round(num(p.stats.losses))),
    closed_pl: num(p.stats.closed_pl !== undefined && p.stats.closed_pl !== null ? p.stats.closed_pl : p.stats.profit_closed),
  } : null;
  // JSON portofolio lengkap ala MQL5 Signal (curve, monthly, history, dll)
  let statsFull = null;
  if (p.stats) {
    try { statsFull = JSON.stringify(p.stats).slice(0, 500000); } catch (_e) { statsFull = null; }
  }

  if (!keyNorm || !account) {
    return { valid: false, error: 'INVALID_REQUEST', event: 'INVALID',
      message: 'Parameter key dan account wajib diisi.' };
  }

  const row = await db.prepare('SELECT * FROM license_keys WHERE key_norm = ?')
    .bind(keyNorm).first();

  // --- Key tidak ditemukan -----------------------------------------------
  if (!row) {
    await log(db, null, keyNorm, account, broker, ip, 'NOT_FOUND',
      'Key tidak terdaftar di server');
    return { valid: false, error: 'NOT_FOUND', event: 'NOT_FOUND',
      message: 'License key tidak ditemukan. Periksa kembali input Anda.' };
  }

  // --- Direvoke admin -----------------------------------------------------
  if (row.status === 'revoked') {
    await log(db, row.id, row.key, account, broker, ip, 'REVOKED', 'Key status revoked');
    return { valid: false, error: 'REVOKED', event: 'REVOKED', row,
      message: 'License key telah dinonaktifkan oleh admin. Hubungi support.' };
  }

  // --- Kadaluarsa ----------------------------------------------------------
  if (row.expires_at && ts >= row.expires_at) {
    await log(db, row.id, row.key, account, broker, ip, 'EXPIRED',
      'Key kadaluarsa per ' + fmtTime(row.expires_at));
    return { valid: false, error: 'EXPIRED', event: 'EXPIRED', row,
      message: 'Masa aktif license key telah berakhir per ' + fmtTime(row.expires_at) + ' UTC.' };
  }

  // --- Binding device -------------------------------------------------------
  const device = await db.prepare(
    'SELECT * FROM devices WHERE key_id = ? AND account = ?'
  ).bind(row.id, account).first();

  if (!device) {
    const countRow = await db.prepare(
      'SELECT COUNT(*) AS n FROM devices WHERE key_id = ?'
    ).bind(row.id).first();
    const used = countRow ? countRow.n : 0;

    if (used >= row.max_devices) {
      const owner = await db.prepare(
        'SELECT account, broker FROM devices WHERE key_id = ? ORDER BY first_seen ASC LIMIT 1'
      ).bind(row.id).first();
      const ownerInfo = owner ? ('akun ' + owner.account + (owner.broker ? ' (' + owner.broker + ')' : '')) : 'device lain';
      await log(db, row.id, row.key, account, broker, ip, 'DEVICE_LIMIT',
        'Ditolak: sudah terikat ' + ownerInfo);
      return { valid: false, error: 'DEVICE_LIMIT', event: 'DEVICE_LIMIT', row,
        message: 'Key sudah terikat pada ' + ownerInfo + '. Minta admin reset device untuk pindah akun.' };
    }

    // Slot tersedia -> bind sekarang (aktivasi pertama / setelah reset)
    if (statsFull) {
      await db.prepare(
        'INSERT INTO devices (key_id, account, broker, first_seen, last_seen, last_ip, balance, equity, float_pl, wins, losses, closed_pl, stats_at, stats_full) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(row.id, account, broker, ts, ts, ip, st ? st.balance : 0, st ? st.equity : 0, st ? st.float_pl : 0, st ? st.wins : 0, st ? st.losses : 0, st ? st.closed_pl : 0, ts, statsFull).run();
    } else if (st) {
      await db.prepare(
        'INSERT INTO devices (key_id, account, broker, first_seen, last_seen, last_ip, balance, equity, float_pl, wins, losses, closed_pl, stats_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(row.id, account, broker, ts, ts, ip, st.balance, st.equity, st.float_pl, st.wins, st.losses, st.closed_pl, ts).run();
    } else {
      await db.prepare(
        'INSERT INTO devices (key_id, account, broker, first_seen, last_seen, last_ip) VALUES (?,?,?,?,?,?)'
      ).bind(row.id, account, broker, ts, ts, ip).run();
    }

    if (!row.activated_at) {
      const dur = (row.duration_days === null || row.duration_days === undefined) ? 30 : row.duration_days;
      const expires = ts + dur * 86400;
      await db.prepare(
        'UPDATE license_keys SET activated_at = ?, expires_at = ? WHERE id = ?'
      ).bind(ts, expires, row.id).run();
      row.activated_at = ts;
      row.expires_at = expires;
    }
    await log(db, row.id, row.key, account, broker, ip, 'ACTIVATE',
      'Device baru terikat (slot ' + (used + 1) + '/' + row.max_devices + ')');
  } else {
    if (statsFull) {
      await db.prepare(
        'UPDATE devices SET last_seen = ?, last_ip = ?, broker = ?, balance = ?, equity = ?, float_pl = ?, wins = ?, losses = ?, closed_pl = ?, stats_at = ?, stats_full = ? WHERE id = ?'
      ).bind(ts, ip, broker || device.broker, st ? st.balance : device.balance, st ? st.equity : device.equity, st ? st.float_pl : device.float_pl, st ? st.wins : device.wins, st ? st.losses : device.losses, st ? st.closed_pl : device.closed_pl, ts, statsFull, device.id).run();
    } else if (st) {
      await db.prepare(
        'UPDATE devices SET last_seen = ?, last_ip = ?, broker = ?, balance = ?, equity = ?, float_pl = ?, wins = ?, losses = ?, closed_pl = ?, stats_at = ? WHERE id = ?'
      ).bind(ts, ip, broker || device.broker, st.balance, st.equity, st.float_pl, st.wins, st.losses, st.closed_pl, ts, device.id).run();
    } else {
      await db.prepare(
        'UPDATE devices SET last_seen = ?, last_ip = ?, broker = ? WHERE id = ?'
      ).bind(ts, ip, broker || device.broker, device.id).run();
    }
  }

  // --- Sukses -----------------------------------------------------------------
  await db.prepare(
    'UPDATE license_keys SET last_checkin_at = ?, last_account = ?, last_broker = ?, last_ip = ? WHERE id = ?'
  ).bind(ts, account, broker, ip, row.id).run();

  await log(db, row.id, row.key, account, broker, ip, 'VALID', 'Validasi berhasil');

  const fresh = await db.prepare('SELECT * FROM license_keys WHERE id = ?')
    .bind(row.id).first();
  return { valid: true, event: 'VALID', row: fresh,
    message: 'License valid sampai ' + fmtTime(fresh.expires_at) + ' UTC.' };
}

export async function log(db, keyId, keyText, account, broker, ip, event, detail) {
  await db.prepare(
    'INSERT INTO checkin_logs (key_id, key_text, account, broker, ip, event, detail, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(keyId || null, keyText || '', account || '', broker || '', ip || '',
    event, detail || '', now()).run();
}
