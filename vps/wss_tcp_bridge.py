#!/usr/bin/env python3
"""wss_tcp_bridge.py — Bridge lokal: TCP listen <-> WebSocket <-> Worker CF.

Pakai: python3 wss_tcp_bridge.py [listen_port]
Default listen: 127.0.0.1:2222 -> wss://vps-tunnel.darussolah.workers.dev/<token>?t=IP:PORT
"""
import socketserver
import ssl
import sys
import threading

import websocket  # pip websocket-client

SECRETS = "/home/z/my-project/.secrets/credentials.env"
TOKEN_FILE = "/home/z/my-project/vps-tunnel/token.txt"
WORKER = "wss://vps-tunnel.darussolah.workers.dev/{token}?t=45.66.153.147:20268"
LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 2222


def build_url():
    token = open(TOKEN_FILE).read().strip()
    return WORKER.format(token=token)


def handle(conn):
    url = build_url()
    try:
        ws = websocket.create_connection(
            url,
            timeout=25,
            sslopt={"cert_reqs": ssl.CERT_NONE},
            skip_utf8_validation=True,
        )
    except Exception as e:
        print(f"[bridge] ws gagal: {e}", flush=True)
        try:
            conn.close()
        except Exception:
            pass
        return

    def pump_ws_to_tcp():
        try:
            while True:
                data = ws.recv()
                if data is None or data == "":
                    break
                if isinstance(data, bytes):
                    conn.sendall(data)
        except Exception:
            pass
        finally:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass

    t = threading.Thread(target=pump_ws_to_tcp, daemon=True)
    t.start()
    try:
        while True:
            data = conn.recv(65536)
            if not data:
                break
            ws.send_binary(data)
    except Exception:
        pass
    finally:
        try:
            ws.close()
        except Exception:
            pass


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        handle(self.request)


class Srv(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    print(f"[bridge] listen 127.0.0.1:{LISTEN_PORT} -> {WORKER.split('?')[0]}", flush=True)
    Srv(("127.0.0.1", LISTEN_PORT), Handler).serve_forever()
