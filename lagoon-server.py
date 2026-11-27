#!/usr/bin/env python3
"""
Lagoon Open - LAN server (macOS / Windows / Linux, Python 3 standard library only)

Relays WebSocket messages between host and guest browsers, and serves the built Vite
game bundle from ./dist/ (including .html, .js, .css, .glb 3D models, and offline fonts)
so a buddy can simply browse to http://<host-address>:8765

Build first:   npm install && npm run build
Run it with:   python3 lagoon-server.py          (Mac / Linux, from this folder)
               py lagoon-server.py               (Windows)
Optional port: python3 lagoon-server.py 9000
Stop it with Ctrl+C (or close the window).
"""
import base64
import collections
import hashlib
import json
import mimetypes
import os
import re
import socket
import struct
import sys
import threading
import urllib.parse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME = 4 * 1024 * 1024
MAX_ROOM_PEERS = 10  # Up to 4 players + 6 spectators
SIGNAL_PATH_RE = re.compile(r"^/signal/([A-Za-z0-9]{4})/?$")

MIME_EXTRA = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
}

clients = []
clients_lock = threading.Lock()
next_cid = 1
signal_rooms = {}  # code -> {"next_seq": int, "peers": {peer_id: (Client, is_host)}}
signal_lock = threading.Lock()
print_lock = threading.Lock()


def log(msg):
    with print_lock:
        print(msg, flush=True)


def ip_rank(ip):
    if ip.startswith("192.168."):
        return 0
    if ip.startswith("10."):
        return 1
    if ip.startswith("172."):
        try:
            if 16 <= int(ip.split(".")[1]) <= 31:
                return 3
        except ValueError:
            pass
    return 2


def lan_ips():
    ips = set()
    for probe in ("10.255.255.255", "192.168.255.255", "8.8.8.8"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((probe, 1))
            ips.add(s.getsockname()[0])
            s.close()
        except OSError:
            pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            ips.add(ip)
    except OSError:
        pass
    ips = [ip for ip in ips if not ip.startswith(("127.", "169.254.", "0."))]
    return sorted(ips, key=lambda ip: (ip_rank(ip), ip))


class Client:
    def __init__(self, sock, addr, cid=""):
        self.sock = sock
        self.addr = addr
        self.cid = cid
        self.alive = True
        self._cond = threading.Condition()
        self._reliable = collections.deque()
        self._latest_snap = None
        self._writer = threading.Thread(target=self._write_loop, daemon=True)
        self._writer.start()

    @staticmethod
    def _frame(opcode, data):
        n = len(data)
        if n < 126:
            hdr = struct.pack("!BB", 0x80 | opcode, n)
        elif n < 65536:
            hdr = struct.pack("!BBH", 0x80 | opcode, 126, n)
        else:
            hdr = struct.pack("!BBQ", 0x80 | opcode, 127, n)
        return hdr + data

    def send(self, opcode, data, coalescable=False):
        if not self.alive:
            return
        pkt = self._frame(opcode, data)
        with self._cond:
            if not self.alive:
                return
            if coalescable:
                # Overwrite any unsent pure state snapshot so Wi-Fi hiccups never cause bufferbloat!
                self._latest_snap = pkt
            else:
                if len(self._reliable) > 128:
                    self._reliable.popleft()
                self._reliable.append(pkt)
            self._cond.notify()

    def close(self):
        with self._cond:
            self.alive = False
            self._cond.notify_all()
        try:
            self.sock.close()
        except OSError:
            pass

    def _write_loop(self):
        while True:
            with self._cond:
                while self.alive and not self._reliable and self._latest_snap is None:
                    self._cond.wait(timeout=1.0)
                if not self.alive:
                    return
                # Reliable control/event/ping packets always preempt coalescable state snapshots
                if self._reliable:
                    pkt = self._reliable.popleft()
                else:
                    pkt = self._latest_snap
                    self._latest_snap = None
            try:
                self.sock.sendall(pkt)
            except OSError:
                self.close()
                return


class Reader:
    def __init__(self, sock):
        self.sock = sock
        self.buf = b""

    def read_until(self, marker, limit=16384):
        while marker not in self.buf:
            if len(self.buf) > limit:
                return None
            chunk = self.sock.recv(4096)
            if not chunk:
                return None
            self.buf += chunk
        i = self.buf.index(marker) + len(marker)
        out, self.buf = self.buf[:i], self.buf[i:]
        return out

    def read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(max(4096, n - len(self.buf)))
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out


def unmask(data, mask):
    n = len(data)
    if n == 0:
        return data
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


def count():
    with clients_lock:
        return len(clients)


def sys_msg(self_id=None):
    with clients_lock:
        ids = [c.cid for c in clients]
    msg = {"t": "sys", "count": len(ids), "peers": ids, "ips": lan_ips()}
    if self_id:
        msg["id"] = self_id
    return json.dumps(msg).encode("utf-8")


def broadcast_sys():
    with clients_lock:
        snap = list(clients)
    for c in snap:
        c.send(1, sys_msg(c.cid))


def is_coalescable_snapshot(opcode, data):
    # Pure periodic state snapshot without embedded events/phase-critical flags
    return opcode == 1 and b'"t":"s"' in data[:48] and b'"ev":[' not in data


def relay(sender, opcode, data):
    coalescable = is_coalescable_snapshot(opcode, data)
    target_id = None
    out_data = data
    if opcode == 1:
        try:
            obj = json.loads(data.decode("utf-8"))
            if isinstance(obj, dict):
                target_id = obj.get("to")
                obj["from"] = sender.cid
                out_data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        except (ValueError, UnicodeDecodeError):
            pass

    with clients_lock:
        snap = list(clients)
    for c in snap:
        if c is sender:
            continue
        if target_id and c.cid != target_id:
            continue
        c.send(opcode, out_data, coalescable=coalescable)


def read_ws_messages(client, reader, on_message):
    frag = bytearray()
    frag_op = 1
    while client.alive:
        b0, b1 = reader.read_exact(2)
        fin = b0 & 0x80
        op = b0 & 0x0F
        masked = b1 & 0x80
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack("!H", reader.read_exact(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", reader.read_exact(8))[0]
        if n > MAX_FRAME:
            return
        mask = reader.read_exact(4) if masked else None
        data = reader.read_exact(n)
        if mask:
            data = unmask(data, mask)
        if op == 8:
            client.send(8, b"")
            return
        if op == 9:
            client.send(10, data)
            continue
        if op == 10:
            continue
        if op in (1, 2):
            frag = bytearray()
            frag_op = op
        frag += data
        if fin:
            on_message(frag_op, bytes(frag))
            frag = bytearray()


def ws_loop(client, reader):
    read_ws_messages(client, reader, lambda op, payload: relay(client, op, payload))


def signal_send(client, obj):
    client.send(1, json.dumps(obj, separators=(",", ":")).encode("utf-8"))


def handle_signal_ws(sock, addr, reader, hdrs, code, want_host):
    code = code.upper()
    with signal_lock:
        room = signal_rooms.get(code)
        if room is None:
            if not want_host:
                sock.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 14\r\nConnection: close\r\n\r\nRoom not found")
                return
            room = {"next_seq": 1, "peers": {}}
            signal_rooms[code] = room
        has_host = any(is_h for _, is_h in room["peers"].values())
        if want_host and has_host:
            sock.sendall(b"HTTP/1.1 409 Conflict\r\nContent-Length: 23\r\nConnection: close\r\n\r\nRoom already has a host")
            return
        if not want_host and not has_host:
            sock.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 14\r\nConnection: close\r\n\r\nRoom not found")
            return
        if len(room["peers"]) >= MAX_ROOM_PEERS:
            sock.sendall(b"HTTP/1.1 409 Conflict\r\nContent-Length: 12\r\nConnection: close\r\n\r\nRoom is full")
            return
        peer_id = "host" if want_host else f"p{room['next_seq']}"
        if not want_host:
            room["next_seq"] += 1

    accept = base64.b64encode(
        hashlib.sha1(hdrs["sec-websocket-key"].encode("ascii") + WS_GUID).digest()
    ).decode("ascii")
    sock.sendall(
        (
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode("ascii")
    )
    client = Client(sock, addr, cid=peer_id)
    host_client = None
    peer_count = 0
    with signal_lock:
        room = signal_rooms.get(code)
        if room is None:
            client.close()
            return
        room["peers"][peer_id] = (client, want_host)
        peer_count = len(room["peers"])
        for pid, (c, is_h) in room["peers"].items():
            if is_h:
                host_client = (pid, c)
                break

    log(f"[signal:{code}] + {peer_id} ({peer_count} in room)")
    signal_send(client, {
        "t": "welcome",
        "id": peer_id,
        "isHost": want_host,
        "hostId": host_client[0] if host_client else peer_id,
        "count": peer_count,
    })
    if not want_host and host_client:
        signal_send(host_client[1], {"t": "peer-joined", "peerId": peer_id, "count": peer_count})

    def on_sig_msg(op, payload):
        if op != 1:
            return
        try:
            msg = json.loads(payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        if not isinstance(msg, dict):
            return
        kind = msg.get("t")
        if kind in ("offer", "answer", "ice"):
            to_id = str(msg.get("to") or "")
            with signal_lock:
                r = signal_rooms.get(code)
                target = r["peers"].get(to_id)[0] if (r and to_id in r["peers"]) else None
            if target:
                msg["from"] = peer_id
                signal_send(target, msg)
        elif kind == "ping":
            signal_send(client, {"t": "pong", "ts": msg.get("ts")})

    try:
        read_ws_messages(client, reader, on_sig_msg)
    finally:
        client.close()
        to_close = []
        notify_host = None
        remaining = 0
        with signal_lock:
            room = signal_rooms.get(code)
            if room and peer_id in room["peers"]:
                del room["peers"][peer_id]
                remaining = len(room["peers"])
                if want_host:
                    to_close = [c for c, _ in room["peers"].values()]
                    room["peers"].clear()
                    del signal_rooms[code]
                else:
                    for _, (c, is_h) in room["peers"].items():
                        if is_h:
                            notify_host = c
                            break
                    if not room["peers"]:
                        del signal_rooms[code]
        for other in to_close:
            signal_send(other, {"t": "host-left"})
            other.close()
        if notify_host:
            signal_send(notify_host, {"t": "peer-left", "peerId": peer_id, "count": remaining})
        log(f"[signal:{code}] - {peer_id} ({remaining} left)")


def resolve_dist_file(url_path):
    clean = urllib.parse.unquote(url_path.split("?", 1)[0])
    if clean in ("", "/", "/index.html"):
        rel = "index.html"
    else:
        rel = clean.lstrip("/")
    dist_real = os.path.realpath(DIST)
    full = os.path.realpath(os.path.join(dist_real, rel))
    if not (full == dist_real or full.startswith(dist_real + os.sep)):
        return None
    if os.path.isfile(full):
        return full
    return None


def serve_http(sock, path):
    fp = resolve_dist_file(path)
    ext = ""
    if fp:
        with open(fp, "rb") as f:
            body = f.read()
        ext = os.path.splitext(fp)[1].lower()
        ctype = MIME_EXTRA.get(ext) or mimetypes.guess_type(fp)[0] or "application/octet-stream"
        status = "200 OK"
    elif not os.path.isfile(os.path.join(DIST, "index.html")):
        body = b"Lagoon Open build not found in ./dist/. Run 'npm install && npm run build' first."
        status, ctype = "503 Service Unavailable", "text/plain; charset=utf-8"
    else:
        body, status, ctype = b"Not found", "404 Not Found", "text/plain"

    cache = "public, max-age=86400" if ext in (".glb", ".gltf", ".woff2", ".woff", ".png", ".jpg", ".svg") else "no-store"
    head = (
        f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
        f"Cache-Control: {cache}\r\nConnection: close\r\n\r\n"
    )
    sock.sendall(head.encode("ascii") + body)


def handle(sock, addr):
    client = None
    try:
        sock.settimeout(None)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        reader = Reader(sock)
        head = reader.read_until(b"\r\n\r\n")
        if head is None:
            return
        lines = head.decode("latin-1").split("\r\n")
        parts = lines[0].split(" ")
        path = parts[1] if len(parts) > 1 else "/"
        hdrs = {}
        for ln in lines[1:]:
            if ":" in ln:
                k, v = ln.split(":", 1)
                hdrs[k.strip().lower()] = v.strip()
        if hdrs.get("upgrade", "").lower() == "websocket" and "sec-websocket-key" in hdrs:
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 32768)
            except OSError:
                pass
            parsed_url = urllib.parse.urlsplit(path)
            sig_m = SIGNAL_PATH_RE.match(parsed_url.path)
            if sig_m:
                qs = urllib.parse.parse_qs(parsed_url.query)
                want_host = (qs.get("role", [""])[0] == "host")
                handle_signal_ws(sock, addr, reader, hdrs, sig_m.group(1), want_host)
                return

            global next_cid
            accept = base64.b64encode(
                hashlib.sha1(hdrs["sec-websocket-key"].encode("ascii") + WS_GUID).digest()
            ).decode("ascii")
            sock.sendall(
                (
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                ).encode("ascii")
            )
            with clients_lock:
                cid = f"c{next_cid}"
                next_cid += 1
                client = Client(sock, addr, cid=cid)
                clients.append(client)
            log(f"[+] Player {cid} connected from {addr[0]}  ({count()} online)")
            broadcast_sys()
            ws_loop(client, reader)
        else:
            serve_http(sock, path)
    except (OSError, ConnectionError, ValueError, struct.error):
        pass
    finally:
        if client is not None:
            client.close()
            with clients_lock:
                if client in clients:
                    clients.remove(client)
            log(f"[-] Player {client.cid} disconnected  ({count()} online)")
            broadcast_sys()
        try:
            sock.close()
        except OSError:
            pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name != "nt":
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind(("0.0.0.0", PORT))
    except OSError as e:
        print(f"\nCould not start the server on port {PORT}: {e}")
        print("Is another copy already running? Close it, or pass a different port number.")
        sys.exit(1)
    srv.listen(64)
    srv.settimeout(1.0)

    ips = lan_ips()
    print()
    print(f"  LAGOON OPEN - LAN server running on port {PORT}")
    print("  ------------------------------------------------")
    print(f"  On THIS computer: open http://localhost:{PORT} , choose 'LAN Match', press 'Host Game'.")
    if ips:
        print("  Your buddy opens:  " + "   ".join(f"http://{ip}:{PORT}" for ip in ips))
    else:
        print("  No LAN address found - are you connected to Wi-Fi / Ethernet?")
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print("  WARNING: ./dist/index.html not found! Run 'npm install && npm run build' first.")
    print("  Press Ctrl+C (or close this window) to stop the server.")
    print(flush=True)

    try:
        while True:
            try:
                sock, addr = srv.accept()
            except socket.timeout:
                continue
            threading.Thread(target=handle, args=(sock, addr), daemon=True).start()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        srv.close()


if __name__ == "__main__":
    main()
