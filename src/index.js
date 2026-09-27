// ============================================================
// Seven Sigma — License Server
// Cloudflare Worker (zero-dependency) : API lisensi + dashboard assets
// ------------------------------------------------------------
// Routing:
//   /api/v1/*   -> endpoint EA + cek key publik (src/api.js)
//   /api/admin/*-> endpoint admin dashboard (src/admin.js)
//   /check      -> halaman cek key publik (public/check.html)
//   lainnya     -> static assets ./public (dashboard)
// ============================================================

import { optionsResponse, json } from './util.js';
import { handleApi } from './api.js';
import { handleAdmin } from './admin.js';

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return optionsResponse();

    if (path.startsWith('/api/v1/')) {
      try {
        return await handleApi(request, env, path, ctx);
      } catch (e) {
        return json({ ok: false, error: 'SERVER_ERROR', message: String(e && e.message || e) }, 500);
      }
    }

    if (path.startsWith('/api/admin/')) {
      try {
        return await handleAdmin(request, env, path, url, ctx);
      } catch (e) {
        return json({ ok: false, error: 'SERVER_ERROR', message: String(e && e.message || e) }, 500);
      }
    }

    // Halaman cek key publik: /check -> check.html
    if (path === '/check' || path === '/check/') {
      const target = new URL('/check.html', url.origin);
      if (env.ASSETS) return env.ASSETS.fetch(new Request(target.toString()));
    }

    // Non-API: serahkan ke Workers Assets (dashboard).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ ok: true, product: env.PRODUCT_NAME || 'Seven Sigma',
      message: 'License server berjalan. Dashboard: sertakan folder ./public pada deploy.' });
  },
};

export default worker;
