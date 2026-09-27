// ============================================================
// Seven Sigma — Auth admin: token HMAC-SHA256 tanpa dependency
// Format token : "<expiry_epoch>.<hmac_hex(expiry_epoch, secret)>"
// ============================================================

const enc = new TextEncoder();

async function hmacHex(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function adminSecret(env) {
  return env.ADMIN_PASSWORD || 'quantum-queen-admin';
}

export function adminPasswordIsDefault(env) {
  return !env.ADMIN_PASSWORD;
}

// Verifikasi password dengan perbandingan constant-time (anti timing attack):
// kedua sisi di-HMAC lalu dibandingkan via safeEqual sehingga isi password
// tidak bocor dari durasi perbandingan.
export async function verifyPassword(env, password) {
  const expected = env.ADMIN_PASSWORD || 'quantum-queen-admin';
  const a = await hmacHex('pw-cmp', String(password || ''));
  const b = await hmacHex('pw-cmp', expected);
  return safeEqual(a, b);
}

const TOKEN_TTL = 24 * 3600; // 24 jam

export async function issueToken(env) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL;
  const sig = await hmacHex(String(exp), adminSecret(env));
  return { token: exp + '.' + sig, expires_in: TOKEN_TTL };
}

export async function verifyToken(env, authorizationHeader) {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) return false;
  const token = authorizationHeader.slice(7).trim();
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = parseInt(expStr, 10);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
  const expect = await hmacHex(expStr, adminSecret(env));
  return safeEqual(sig, expect);
}
