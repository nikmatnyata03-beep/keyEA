// ============================================================
// Seven Sigma — Generator license key
// Format : QQX-XXXXX-XXXXX-XXXXX (huruf besar tanpa I/O/0/1)
// ============================================================

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomBlock(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function generateKey() {
  return 'QQX-' + randomBlock(5) + '-' + randomBlock(5) + '-' + randomBlock(5);
}
