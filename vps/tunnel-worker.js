// vps-tunnel — WebSocket ⇄ TCP relay (Cloudflare Workers TCP sockets)
// Khusus untuk SSH ke VPS trading yang jalur langsungnya bermasalah.
// Route: wss://vps-tunnel.darussolah.workers.dev/<TUNNEL_TOKEN>?t=IP:PORT
import { connect } from "cloudflare:sockets";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Gate: token rahasia di path
    const token = url.pathname.replace(/^\//, "");
    if (!token || token !== env.TUNNEL_TOKEN) {
      return new Response("not found", { status: 404 });
    }
    // Hanya WebSocket
    const upgrade = req.headers.get("Upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("websocket only", { status: 426 });
    }
    // Target dibatasi: hanya VPS trading (debug: + port probe & 1.1.1.1)
    const target = url.searchParams.get("t") || "";
    const allowed = new Set([
      "45.66.153.147:20268",
      "45.66.153.147:3389",
      "1.1.1.1:80",
    ]);
    if (!allowed.has(target)) {
      return new Response("target not allowed", { status: 403 });
    }

    let tcp;
    try {
      tcp = connect(target); // TCP mentah ke VPS:20268 (port SSH non-std)
    } catch (e) {
      return new Response("tcp connect failed: " + e.message, { status: 502 });
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();

    // TCP → WebSocket
    (async () => {
      const reader = tcp.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          server.send(value);
        }
      } catch (e) {
        // koneksi putus
      }
      try { server.close(); } catch (e) {}
    })();

    // WebSocket → TCP (harus binary frame)
    const writer = tcp.writable.getWriter();
    server.addEventListener("message", async (ev) => {
      if (typeof ev.data === "string") return; // abaikan frame teks
      try {
        await writer.write(new Uint8Array(ev.data));
      } catch (e) {
        try { server.close(); } catch (e2) {}
      }
    });
    server.addEventListener("close", async () => {
      try { await writer.close(); } catch (e) {}
    });
    server.addEventListener("error", async () => {
      try { await writer.close(); } catch (e) {}
    });

    return new Response(null, { status: 101, webSocket: pair[0] });
  },
};
