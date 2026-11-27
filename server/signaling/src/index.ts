/**
 * Lagoon Open — Minimal Cloudflare Workers + Durable Objects WebRTC Signaling Relay
 *
 * Handles only tiny ~2 KB SDP Offer/Answer + ICE candidate handshakes for 4-letter
 * room codes (e.g. wss://<worker>.workers.dev/signal/PALM). All gameplay traffic flows
 * direct browser-to-browser via WebRTC RTCDataChannel once connected.
 *
 * Deploy (Cloudflare free tier: 100k req/day):
 *   cd server/signaling && npx wrangler deploy
 */

interface Env {
  ROOMS: DurableObjectNamespace;
}

interface PeerMeta {
  id: string;
  isHost: boolean;
}

const MAX_ROOM_PEERS = 10; // Up to 4 players + 6 spectators

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/signal\/([A-Za-z0-9]{4})\/?$/);
    if (!match) {
      if (url.pathname === "/" || url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, service: "lagoon-open-signaling" }), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }

    const code = match[1].toUpperCase();
    const id = env.ROOMS.idFromName(code);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};

export class RoomSignalingDO {
  private peers = new Map<WebSocket, PeerMeta>();
  private nextSeq = 1;

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const wantHost = url.searchParams.get("role") === "host";

    if (this.peers.size >= MAX_ROOM_PEERS) {
      return new Response("Room is full", { status: 409 });
    }

    const existingHost = this.findHost();
    if (wantHost && existingHost) {
      return new Response("Room already has a host", { status: 409 });
    }
    if (!wantHost && !existingHost) {
      return new Response("Room not found", { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const peerId = wantHost ? "host" : `p${this.nextSeq++}`;
    const meta: PeerMeta = { id: peerId, isHost: wantHost };
    this.peers.set(server, meta);

    // Tell the newcomer its assigned peerId and current hostId
    this.sendJson(server, {
      t: "welcome",
      id: peerId,
      isHost: wantHost,
      hostId: wantHost ? peerId : existingHost!.meta.id,
      count: this.peers.size,
    });

    // Notify host when a remote peer joins so host initiates the WebRTC offer
    if (!wantHost && existingHost) {
      this.sendJson(existingHost.ws, { t: "peer-joined", peerId, count: this.peers.size });
    }

    server.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (!msg || typeof msg !== "object") return;
        const kind = msg.t;
        if (kind === "offer" || kind === "answer" || kind === "ice") {
          const to = String(msg.to || "");
          const target = this.findById(to);
          if (target) {
            this.sendJson(target.ws, { ...msg, from: meta.id });
          }
        } else if (kind === "ping") {
          this.sendJson(server, { t: "pong", ts: msg.ts });
        }
      } catch {
        // ignore malformed JSON
      }
    });

    const cleanup = () => {
      if (!this.peers.has(server)) return;
      this.peers.delete(server);
      if (meta.isHost) {
        // Host left the room: notify all remaining signaling sockets and close cleanly
        for (const [ws] of this.peers) {
          this.sendJson(ws, { t: "host-left" });
          try { ws.close(1000, "Host left"); } catch { /* ignore */ }
        }
        this.peers.clear();
      } else {
        const host = this.findHost();
        if (host) {
          this.sendJson(host.ws, { t: "peer-left", peerId: meta.id, count: this.peers.size });
        }
      }
    };

    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }

  private findHost(): { ws: WebSocket; meta: PeerMeta } | null {
    for (const [ws, meta] of this.peers) {
      if (meta.isHost) return { ws, meta };
    }
    return null;
  }

  private findById(id: string): { ws: WebSocket; meta: PeerMeta } | null {
    for (const [ws, meta] of this.peers) {
      if (meta.id === id) return { ws, meta };
    }
    return null;
  }

  private sendJson(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // socket already closed
    }
  }
}
