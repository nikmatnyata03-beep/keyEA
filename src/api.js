// ============================================================
// Quantum Queen X — Endpoint untuk EA (dipanggil via WebRequest MT5)
//   GET  /api/v1/ping      -> cek server hidup
//   POST /api/v1/validate  -> validasi berkala
//   POST /api/v1/activate  -> aktivasi/ikatan device pertama kali
// ============================================================

import { json, now, fmtTime, clientIp, readJson } from './util.js';
import { coreValidate } from './license.js';

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
  return json({ ok: true, product: env.PRODUCT_NAME || 'Quantum Queen X',
    server_ts: ts, server_time: fmtTime(ts) });
}

async function handleValidate(request, env) {
  const ts = now();
  const body = await readJson(request);
  const ip = clientIp(request);
  // Statistik portofolio opsional dari EA (objek stats lengkap ala MQL5 Signal)
  const stats = (body.stats && typeof body.stats === 'object' && !Array.isArray(body.stats))
    ? body.stats : null;
  const res = await coreValidate(env.DB, {
    key: body.key || body.license_key || '',
    account: body.account !== undefined ? String(body.account) : '',
    broker: body.broker || '',
    stats,
  }, ip);
  return payloadToResult(res, ts);
}

export async function handleApi(request, env, path) {
  if (path === '/api/v1/ping' && request.method === 'GET') return handlePing(env);
  if (path === '/api/v1/validate' && request.method === 'POST') return handleValidate(request, env);
  if (path === '/api/v1/activate' && request.method === 'POST') return handleValidate(request, env);
  return json({ ok: false, error: 'NOT_FOUND', message: 'Endpoint tidak ditemukan.' }, 404);
}
