// ============================================================
// Seven Sigma — Auth admin: token HMAC-SHA256 tanpa dependency
// Format token : "<expiry_epoch>.<hmac_hex(expiry_epoch, secret)>"
// ------------------------------------------------------------
// Password admin bisa berasal dari:
//   1. settings.admin_pw_hash (PBKDF2, diubah dari dashboard) — prioritas
//   2. secret env ADMIN_PASSWORD (wrangler secret put)        — fallback
//   3. default "quantum-queen-admin"                          — terakhir
// Secret token mengikuti sumber password aktif sehingga ganti
// password dari dashboard otomatis mematikan semua token lama.
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

// ---------------- PBKDF2 password hashing (zero-dependency) ----------------
const PBKDF2_ITER = 120000;

async function pbkdf2Hex(password, saltBytes, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, base, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Format tersimpan: "pbkdf2$<iter>$<saltHex>$<hashHex>"
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = [...salt].map((b) => b.toString(16).padStart(2, '0')).join('');
  const hash = await pbkdf2Hex(String(password), salt, PBKDF2_ITER);
  return 'pbkdf2$' + PBKDF2_ITER + '$' + saltHex + '$' + hash;
}

export async function verifyPasswordHash(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 2000000) return false;
    const salt = new Uint8Array(parts[2].match(/.{2}/g).map((h) => parseInt(h, 16)));
    const hash = await pbkdf2Hex(String(password), salt, iterations);
    return safeEqual(hash, parts[3]);
  } catch (_e) {
    return false;
  }
}

// ---------------- sumber password aktif ----------------
export async function adminPasswordIsDefault(env) {
  if (env.DB) {
    try {
      const r = await env.DB.prepare("SELECT v FROM settings WHERE k = 'admin_pw_hash'").first();
      if (r && r.v) return false; // password custom dari dashboard
    } catch (_e) { /* lanjut cek env */ }
  }
  return !env.ADMIN_PASSWORD;
}

export async function hasPasswordHash(env) {
  if (!env.DB) return false;
  try {
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k = 'admin_pw_hash'").first();
    return !!(r && r.v);
  } catch (_e) { return false; }
}

// Verifikasi password: hash dashboard dulu, lalu env/default.
export async function verifyPassword(env, password) {
  const pw = String(password || '');
  if (env.DB) {
    try {
      const r = await env.DB.prepare("SELECT v FROM settings WHERE k = 'admin_pw_hash'").first();
      if (r && r.v) return verifyPasswordHash(pw, r.v);
    } catch (_e) { /* jatuh ke env */ }
  }
  const expected = env.ADMIN_PASSWORD || 'quantum-queen-admin';
  const a = await hmacHex('pw-cmp', pw);
  const b = await hmacHex('pw-cmp', expected);
  return safeEqual(a, b);
}

// Secret token = string password aktif (hash bila ada) -> ganti password
// dari dashboard otomatis membatalkan semua token sesi lama.
export async function adminSecret(env) {
  if (env.DB) {
    try {
      const r = await env.DB.prepare("SELECT v FROM settings WHERE k = 'admin_pw_hash'").first();
      if (r && r.v) return 'hash:' + r.v;
    } catch (_e) { /* jatuh ke env */ }
  }
  return env.ADMIN_PASSWORD || 'quantum-queen-admin';
}

const TOKEN_TTL = 24 * 3600; // 24 jam

export async function issueToken(env) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL;
  const sig = await hmacHex(String(exp), await adminSecret(env));
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
  const expect = await hmacHex(expStr, await adminSecret(env));
  return safeEqual(sig, expect);
}
