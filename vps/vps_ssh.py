#!/usr/bin/env python3
"""vps_ssh.py — Helper SSH ke VPS trading (password auth via paramiko).

Usage:
  python3 vps_ssh.py --test                          # tes koneksi + info sistem
  python3 vps_ssh.py "<command>"                     # eksekusi 1 command
  python3 vps_ssh.py --timeout 300 "<command>"       # command lama (detik)
  python3 vps_ssh.py --put <lokal> <remote>          # upload file via SFTP
  python3 vps_ssh.py --get <remote> <lokal>          # download file via SFTP

Kredensial otomatis dibaca dari /home/z/my-project/.secrets/credentials.env
(VPS_HOST / VPS_PORT / VPS_USER / VPS_PASSWORD).
Override: --host --port --user --password
"""
import argparse
import sys

import paramiko

SECRETS = "/home/z/my-project/.secrets/credentials.env"


def load_creds():
    creds = {}
    with open(SECRETS) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip()
                if k.startswith("VPS_"):
                    creds[k] = v
    host = creds.get("VPS_HOST", "")
    if host.startswith("("):
        host = ""  # placeholder "(BELUM DIISI)"
    return (
        host,
        creds.get("VPS_PORT", "22"),
        creds.get("VPS_USER", "root"),
        creds.get("VPS_PASSWORD", ""),
    )


def connect(host, port, user, pw, timeout=15):
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(
        hostname=host,
        port=int(port),
        username=user,
        password=pw,
        timeout=timeout,
        banner_timeout=timeout,
        auth_timeout=timeout,
        look_for_keys=False,
        allow_agent=False,
    )
    return cli


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host")
    ap.add_argument("--port")
    ap.add_argument("--user")
    ap.add_argument("--password")
    ap.add_argument("--timeout", type=int, default=180, help="detik")
    ap.add_argument("--put", nargs=2, metavar=("LOKAL", "REMOTE"))
    ap.add_argument("--get", nargs=2, metavar=("REMOTE", "LOKAL"))
    ap.add_argument("--test", action="store_true")
    ap.add_argument("cmd", nargs="*")
    args = ap.parse_args()

    dh, dp, du, dpw = load_creds()
    host = args.host or dh
    port = args.port or dp
    user = args.user or du
    pw = args.password or dpw

    if not host:
        print("ERROR: VPS_HOST belum diisi di credentials.env (dan tidak ada --host).")
        sys.exit(2)

    try:
        cli = connect(host, port, user, pw)
    except Exception as e:
        print(f"CONNECT_GAGAL: {type(e).__name__}: {e}")
        sys.exit(3)

    print(f"CONNECT_OK {user}@{host}:{port}")

    if args.test:
        cmds = (
            'echo "== OS =="; cat /etc/os-release | grep PRETTY_NAME; uname -r; '
            'echo "== CPU =="; nproc; '
            'echo "== RAM (MB) =="; free -m | head -2; '
            'echo "== DISK =="; df -h / | tail -1; '
            'echo "== UPTIME =="; uptime'
        )
    elif args.put:
        sftp = cli.open_sftp()
        sftp.put(args.put[0], args.put[1])
        sftp.close()
        print(f"UPLOAD_OK {args.put[0]} -> {args.put[1]}")
        cli.close()
        return
    elif args.get:
        sftp = cli.open_sftp()
        sftp.get(args.get[0], args.get[1])
        sftp.close()
        print(f"DOWNLOAD_OK {args.get[0]} -> {args.get[1]}")
        cli.close()
        return
    elif args.cmd:
        cmds = " ".join(args.cmd)
    else:
        print("ERROR: tidak ada perintah. Lihat --help.")
        cli.close()
        sys.exit(2)

    try:
        stdin, stdout, stderr = cli.exec_command(cmds, timeout=args.timeout)
        out = stdout.read().decode(errors="replace")
        err = stderr.read().decode(errors="replace")
        rc = stdout.channel.recv_exit_status()
        if out:
            print(out, end="" if out.endswith("\n") else "\n")
        if err:
            print(f"[stderr]\n{err}", end="" if err.endswith("\n") else "\n")
        print(f"EXIT_CODE={rc}")
    except Exception as e:
        print(f"EXEC_GAGAL: {type(e).__name__}: {e}")
        sys.exit(4)
    finally:
        cli.close()


if __name__ == "__main__":
    main()
