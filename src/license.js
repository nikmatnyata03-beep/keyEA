// ============================================================
// Seven Sigma — Logika inti validasi lisensi (1 device 1 key)
// Dipakai oleh endpoint /api/v1/validate dan /api/v1/activate
// ============================================================

import { now, fmtTime, normalizeKey } from './util.js';
import { notifyEvent } from './settings.js';

/**
 * Validasi key + akun trading.
 * @param {D1Database} db  binding D1 (atau shim bun:sqlite pada preview)
 * @param {object} p       { key, account, broker }
 * @param {string} ip      IP client
 * @param {object} ctx     Workers ctx (waitUntil) utk notifikasi — opsional
 * @returns {{valid:boolean, error?:string, message:string, row?:object, event:string}}
 */
export async function coreValidate(db, p, ip, ctx) {
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
    await notifyEvent(ctx, { DB: db }, { event: 'NOT_FOUND', key: keyNorm, account, broker, ip,
      detail: 'Percobaan validasi dengan key yang tidak terdaftar' });
    return { valid: false, error: 'NOT_FOUND', event: 'NOT_FOUND',
      message: 'License key tidak ditemukan. Periksa kembali input Anda.' };
  }

  // --- Direvoke admin -----------------------------------------------------
  if (row.status === 'revoked') {
    await log(db, row.id, row.key, account, broker, ip, 'REVOKED', 'Key status revoked');
    await notifyEvent(ctx, { DB: db }, { event: 'REVOKED', key: row.key, account, broker, ip,
      detail: 'Percobaan validasi dengan key yang telah dinonaktifkan' });
    return { valid: false, error: 'REVOKED', event: 'REVOKED', row,
      message: 'License key telah dinonaktifkan oleh admin. Hubungi support.' };
  }

  // --- Kadaluarsa ----------------------------------------------------------
  if (row.expires_at && ts >= row.expires_at) {
    await log(db, row.id, row.key, account, broker, ip, 'EXPIRED',
      'Key kadaluarsa per ' + fmtTime(row.expires_at));
    await notifyEvent(ctx, { DB: db }, { event: 'EXPIRED', key: row.key, account, broker, ip,
      detail: 'Percobaan validasi dengan key kadaluarsa per ' + fmtTime(row.expires_at) + ' UTC' });
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
      await notifyEvent(ctx, { DB: db }, { event: 'DEVICE_LIMIT', key: row.key, account, broker, ip,
        detail: 'Key sudah terikat ' + ownerInfo + ' — ada percobaan pakai dari akun lain' });
      return { valid: false, error: 'DEVICE_LIMIT', event: 'DEVICE_LIMIT', row,
        message: 'Key sudah terikat pada ' + ownerInfo + '. Minta admin reset device untuk pindah akun.' };
    }

    // Slot tersedia -> bind ATOMIK: cek slot + insert dalam satu statement
    // (mencegah dua validate simultan melewati max_devices).
    let bindRes;
    if (statsFull) {
      bindRes = await db.prepare(
        'INSERT INTO devices (key_id, account, broker, first_seen, last_seen, last_ip, balance, equity, float_pl, wins, losses, closed_pl, stats_at, stats_full) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM devices WHERE key_id = ?) < ?'
      ).bind(row.id, account, broker, ts, ts, ip,
        st ? st.balance : 0, st ? st.equity : 0, st ? st.float_pl : 0,
        st ? st.wins : 0, st ? st.losses : 0, st ? st.closed_pl : 0, ts, statsFull,
        row.id, row.max_devices).run();
    } else if (st) {
      bindRes = await db.prepare(
        'INSERT INTO devices (key_id, account, broker, first_seen, last_seen, last_ip, balance, equity, float_pl, wins, losses, closed_pl, stats_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM devices WHERE key_id = ?) < ?'
      ).bind(row.id, account, broker, ts, ts, ip,
        st.balance, st.equity, st.float_pl, st.wins, st.losses, st.closed_pl, ts,
        row.id, row.max_devices).run();
    } else {
      bindRes = await db.prepare(
        'INSERT INTO devices (key_id, account, broker, first_seen, last_seen, last_ip) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM devices WHERE key_id = ?) < ?'
      ).bind(row.id, account, broker, ts, ts, ip, row.id, row.max_devices).run();
    }
    const inserted = bindRes && bindRes.meta ? (bindRes.meta.changes || 0) : 0;
    if (!inserted) {
      // Kalah race: slot baru saja terisi request lain.
      await log(db, row.id, row.key, account, broker, ip, 'DEVICE_LIMIT',
        'Ditolak: slot device penuh (race)');
      await notifyEvent(ctx, { DB: db }, { event: 'DEVICE_LIMIT', key: row.key, account, broker, ip,
        detail: 'Slot device penuh (race) — percobaan dari akun ' + account });
      return { valid: false, error: 'DEVICE_LIMIT', event: 'DEVICE_LIMIT', row,
        message: 'Key sudah terikat pada device lain. Minta admin reset device untuk pindah akun.' };
    }

    const freshCnt = await db.prepare('SELECT COUNT(*) AS n FROM devices WHERE key_id = ?')
      .bind(row.id).first();
    const slotUsed = freshCnt ? freshCnt.n : used + 1;
    await log(db, row.id, row.key, account, broker, ip, 'ACTIVATE',
      'Device baru terikat (slot ' + slotUsed + '/' + row.max_devices + ')');
    await notifyEvent(ctx, { DB: db }, { event: 'ACTIVATE', key: row.key, account, broker, ip,
      detail: 'Device baru terikat (slot ' + slotUsed + '/' + row.max_devices + ')' });
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

  // Aktivasi idempoten: diulang tiap validate bila belum tersimpan, sehingga
  // kegagalan sebagian (device terikat tapi expiry kosong) pulih sendiri.
  // duration_days = 0 berarti LIFETIME: activated_at terisi, expires_at NULL
  // (dashboard menampilkan "Tanpa batas", cek kadaluarsa melewati NULL).
  if (!row.activated_at) {
    const dur = (row.duration_days === null || row.duration_days === undefined) ? 30 : row.duration_days;
    const expires = dur > 0 ? ts + dur * 86400 : null;
    await db.prepare(
      'UPDATE license_keys SET activated_at = ?, expires_at = ? WHERE id = ?'
    ).bind(ts, expires, row.id).run();
    row.activated_at = ts;
    row.expires_at = expires;
  }

  // --- Sukses -----------------------------------------------------------------
  await db.prepare(
    'UPDATE license_keys SET last_checkin_at = ?, last_account = ?, last_broker = ?, last_ip = ? WHERE id = ?'
  ).bind(ts, account, broker, ip, row.id).run();

  await log(db, row.id, row.key, account, broker, ip, 'VALID', 'Validasi berhasil');

  const fresh = await db.prepare('SELECT * FROM license_keys WHERE id = ?')
    .bind(row.id).first();
  return { valid: true, event: 'VALID', row: fresh,
    message: fresh.expires_at
      ? 'License valid sampai ' + fmtTime(fresh.expires_at) + ' UTC.'
      : 'License valid tanpa batas waktu (lifetime).' };
}

/**
 * Push statistik berkala dari EA v4.6 (/api/v1/stats) — heartbeat portofolio.
 * Bedanya dengan validate: TIDAK membuat binding baru, TIDAK menulis log
 * checkin (anti spam feed), TIDAK memicu keputusan lisensi — hanya
 * menyegarkan angka (balance/equity/W/L/kurva) + last_seen.
 * Bila lisensi ternyata sudah revoked/expired, dibalaskan valid:false
 * supaya EA langsung memaksa validasi penuh pada tick berikutnya.
 */
export async function coreStatsPush(db, p, ip) {
  const ts = now();
  const keyNorm = normalizeKey(p.key);
  const account = String(p.account || '').trim();
  const broker = String(p.broker || '').trim();

  const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const hasStats = !!p.stats && ['balance','equity','float_pl','wins','losses','closed_pl']
    .some((f) => p.stats[f] !== undefined && p.stats[f] !== null && p.stats[f] !== '');
  const st = hasStats ? {
    balance: num(p.stats.balance), equity: num(p.stats.equity), float_pl: num(p.stats.float_pl),
    wins: Math.max(0, Math.round(num(p.stats.wins))), losses: Math.max(0, Math.round(num(p.stats.losses))),
    closed_pl: num(p.stats.closed_pl !== undefined && p.stats.closed_pl !== null ? p.stats.closed_pl : p.stats.profit_closed),
  } : null;
  let statsFull = null;
  if (p.stats) {
    try { statsFull = JSON.stringify(p.stats).slice(0, 500000); } catch (_e) { statsFull = null; }
  }

  if (!keyNorm || !account) {
    return { valid: false, error: 'INVALID_REQUEST', message: 'Parameter key dan account wajib diisi.' };
  }

  const row = await db.prepare('SELECT * FROM license_keys WHERE key_norm = ?')
    .bind(keyNorm).first();
  if (!row) return { valid: false, error: 'NOT_FOUND', message: 'License key tidak ditemukan.' };
  if (row.status === 'revoked') return { valid: false, error: 'REVOKED', message: 'License key dinonaktifkan.' };
  if (row.expires_at && ts >= row.expires_at) {
    return { valid: false, error: 'EXPIRED', message: 'Masa aktif license key telah berakhir.' };
  }

  const device = await db.prepare(
    'SELECT id, broker FROM devices WHERE key_id = ? AND account = ?'
  ).bind(row.id, account).first();
  // Belum pernah bind -> biarkan /validate yang menangani aktivasi.
  if (!device) return { valid: false, error: 'NOT_ACTIVATED', message: 'Device belum terikat. Lakukan validasi lisensi.' };

  if (statsFull) {
    await db.prepare(
      'UPDATE devices SET last_seen = ?, last_ip = ?, broker = ?, balance = ?, equity = ?, float_pl = ?, wins = ?, losses = ?, closed_pl = ?, stats_at = ?, stats_full = ? WHERE id = ?'
    ).bind(ts, ip, broker || device.broker, st ? st.balance : 0, st ? st.equity : 0, st ? st.float_pl : 0,
      st ? st.wins : 0, st ? st.losses : 0, st ? st.closed_pl : 0, ts, statsFull, device.id).run();
  } else if (st) {
    await db.prepare(
      'UPDATE devices SET last_seen = ?, last_ip = ?, broker = ?, balance = ?, equity = ?, float_pl = ?, wins = ?, losses = ?, closed_pl = ?, stats_at = ? WHERE id = ?'
    ).bind(ts, ip, broker || device.broker, st.balance, st.equity, st.float_pl, st.wins, st.losses, st.closed_pl, ts, device.id).run();
  } else {
    await db.prepare('UPDATE devices SET last_seen = ?, last_ip = ?, broker = ? WHERE id = ?')
      .bind(ts, ip, broker || device.broker, device.id).run();
  }

  // Segarkan info check-in ringan (tanpa baris log — anti spam).
  await db.prepare(
    'UPDATE license_keys SET last_checkin_at = ?, last_account = ?, last_broker = ?, last_ip = ? WHERE id = ?'
  ).bind(ts, account, broker || row.last_broker, ip, row.id).run();

  // Pruning probabilistic: log lebih lama dari 90 hari dibuang (2% request)
  // agar tabel checkin_logs tidak tumbuh tanpa batas.
  if (Math.random() < 0.02) {
    try {
      await db.prepare('DELETE FROM checkin_logs WHERE created_at < ?').bind(ts - 90 * 86400).run();
    } catch (_e) { /* abaikan */ }
  }

  return { valid: true, row, message: 'Stats diperbarui.' };
}

export async function log(db, keyId, keyText, account, broker, ip, event, detail) {
  await db.prepare(
    'INSERT INTO checkin_logs (key_id, key_text, account, broker, ip, event, detail, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(keyId || null, keyText || '', account || '', broker || '', ip || '',
    event, detail || '', now()).run();
}
