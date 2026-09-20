// ============================================================
// Seven Sigma — License Server : Utilitas umum (zero-dependency)
// ============================================================

export function now() {
  return Math.floor(Date.now() / 1000);
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
      'cache-control': 'no-store',
    },
  });
}

export function fail(error, message, status = 400) {
  return json({ ok: false, valid: false, error, message }, status);
}

export function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
    },
  });
}

// Format epoch detik -> "YYYY-MM-DD HH:MM:SS" (UTC)
export function fmtTime(epochSeconds) {
  if (!epochSeconds) return '-';
  const d = new Date(epochSeconds * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds())
  );
}

export function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

export async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (_e) {
    return {};
  }
}

// Normalisasi key input: buang semua kecuali A-Z0-9, uppercase
export function normalizeKey(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
