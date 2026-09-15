// ============================================================
// Quantum Queen X — License Server
// Cloudflare Worker (zero-dependency) : API lisensi + dashboard assets
// ------------------------------------------------------------
// Routing:
//   /api/v1/*   -> endpoint EA  (src/api.js)
//   /api/admin/*-> endpoint admin dashboard (src/admin.js)
//   lainnya     -> static assets ./public (dashboard)
// ============================================================

import { optionsResponse, json } from './util.js';
import { handleApi } from './api.js';
import { handleAdmin } from './admin.js';

const worker = {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return optionsResponse();

    if (path.startsWith('/api/v1/')) {
      try {
        return await handleApi(request, env, path);
      } catch (e) {
        return json({ ok: false, error: 'SERVER_ERROR', message: String(e && e.message || e) }, 500);
      }
    }

    if (path.startsWith('/api/admin/')) {
      try {
        return await handleAdmin(request, env, path, url);
      } catch (e) {
        return json({ ok: false, error: 'SERVER_ERROR', message: String(e && e.message || e) }, 500);
      }
    }

    // Non-API: serahkan ke Workers Assets (dashboard).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ ok: true, product: env.PRODUCT_NAME || 'Quantum Queen X',
      message: 'License server berjalan. Dashboard: sertakan folder ./public pada deploy.' });
  },
};

export default worker;
