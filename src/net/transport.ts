import type { NetMode } from "../core/types";

export const NET_PORT = 8765;
export type DeliveryMode = "reliable" | "unreliable";

export interface TransportHandlers {
  onReady: (localId: string) => void;
  onPeerOpen: (peerId: string) => void;
  onPeerClose: (peerId: string, reason?: string) => void;
  onMessage: (fromPeerId: string, msg: Record<string, unknown>) => void;
  onSysInfo?: (ips: string[], peerIds: string[]) => void;
  onError: (message: string) => void;
  onClose: (reason?: string) => void;
}

export interface NetTransport {
  readonly kind: NetMode;
  readonly localId: string;
  readonly isHost: boolean;
  sendTo(peerId: string, payload: unknown, mode?: DeliveryMode): void;
  broadcast(payload: unknown, mode?: DeliveryMode, excludePeerId?: string): void;
  getBufferedAmount(peerId: string): number;
  close(): void;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
];

export function resolveDefaultSignalUrl(): string {
  const envUrl = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_SIGNAL_URL;
  if (envUrl && envUrl.trim()) return envUrl.trim().replace(/\/+$/, "");
  try {
    const saved = localStorage.getItem("lagoon-signal-url");
    if (saved && saved.trim()) return saved.trim().replace(/\/+$/, "");
  } catch {
    // ignore storage errors
  }
  if (typeof location !== "undefined" && location.protocol.startsWith("http") && location.host) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  }
  return `ws://localhost:${NET_PORT}`;
}

export function normalizeSignalUrl(raw: string): string {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return resolveDefaultSignalUrl();
  if (/^https:\/\//i.test(trimmed)) return trimmed.replace(/^https:\/\//i, "wss://");
  if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:\/\//i, "ws://");
  if (!/^wss?:\/\//i.test(trimmed)) return `wss://${trimmed}`;
  return trimmed;
}

interface RtcPeerEntry {
  peerId: string;
  pc: RTCPeerConnection;
  ctrl: RTCDataChannel | null;
  state: RTCDataChannel | null;
  pendingIce: RTCIceCandidateInit[];
  remoteDescSet: boolean;
  opened: boolean;
  closed: boolean;
}

/**
 * Star-topology WebRTC P2P transport backed by dual RTCDataChannels per peer:
 * - "ctrl"  (ordered, reliable)   for lobby, chat, swings, discrete match events, pings
 * - "state" (unordered, 0 retries) for 30Hz state snapshots & nudges with zero head-of-line blocking
 */
export class WebRtcTransport implements NetTransport {
  public readonly kind: NetMode = "online";
  public localId = "";
  public readonly isHost: boolean;

  private sigWs: WebSocket | null = null;
  private peers = new Map<string, RtcPeerEntry>();
  private closed = false;
  private hostId = "host";
  private readyFired = false;
  private iceServers: RTCIceServer[];

  constructor(
    private roomCode: string,
    isHost: boolean,
    private signalBaseUrl: string,
    private handlers: TransportHandlers,
    extraIceServers?: RTCIceServer[]
  ) {
    this.isHost = isHost;
    this.iceServers = extraIceServers && extraIceServers.length ? [...DEFAULT_ICE_SERVERS, ...extraIceServers] : DEFAULT_ICE_SERVERS;
    this.connectSignaling();
  }

  private connectSignaling(): void {
    const base = normalizeSignalUrl(this.signalBaseUrl);
    const url = `${base}/signal/${encodeURIComponent(this.roomCode)}?role=${this.isHost ? "host" : "guest"}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.handlers.onError(`Invalid signaling server URL (${base}).`);
      return;
    }
    this.sigWs = ws;

    ws.onerror = () => {
      if (this.closed) return;
      if (!this.readyFired) {
        this.handlers.onError(
          this.isHost
            ? `Couldn't reach signaling server (${base}). Start lagoon-server.py locally or configure a deployed Cloudflare signaling URL in Advanced.`
            : `Couldn't join room ${this.roomCode}. Check the 4-letter code and make sure the host's room is open.`
        );
      }
    };

    ws.onclose = () => {
      if (this.closed) return;
      // For guests, closing signaling AFTER P2P opens is expected!
      if (!this.isHost && this.readyFired) return;
      if (this.isHost && !this.readyFired) {
        this.handlers.onError(`Disconnected from signaling server (${base}).`);
        this.handlers.onClose("Signaling disconnected");
      } else if (!this.isHost && !this.readyFired) {
        this.handlers.onError(`Room ${this.roomCode} was not found or is full.`);
        this.handlers.onClose("Room unavailable");
      }
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        void this.onSignalMessage(msg);
      } catch {
        // ignore malformed signaling packet
      }
    };
  }

  private sendSignal(obj: unknown): void {
    if (this.sigWs && this.sigWs.readyState === WebSocket.OPEN) {
      this.sigWs.send(JSON.stringify(obj));
    }
  }

  private async onSignalMessage(msg: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    switch (msg.t) {
      case "welcome": {
        this.localId = String(msg.id || (this.isHost ? "host" : "guest"));
        this.hostId = String(msg.hostId || "host");
        if (this.isHost && !this.readyFired) {
          this.readyFired = true;
          this.handlers.onReady(this.localId);
        }
        break;
      }
      case "peer-joined": {
        if (!this.isHost) return;
        const peerId = String(msg.peerId || "");
        if (!peerId) return;
        await this.createOfferForPeer(peerId);
        break;
      }
      case "peer-left": {
        if (!this.isHost) return;
        const peerId = String(msg.peerId || "");
        const entry = this.peers.get(peerId);
        if (entry && !entry.opened) {
          this.teardownPeer(peerId, "Peer left before connecting");
        }
        break;
      }
      case "host-left": {
        if (this.isHost) return;
        if (!this.readyFired) {
          this.handlers.onError("The host closed the room.");
          this.close();
          this.handlers.onClose("Host closed the room");
        }
        break;
      }
      case "offer": {
        if (this.isHost) return;
        const from = String(msg.from || this.hostId);
        this.hostId = from;
        await this.handleOfferFromHost(from, msg.sdp as RTCSessionDescriptionInit);
        break;
      }
      case "answer": {
        if (!this.isHost) return;
        const from = String(msg.from || "");
        const entry = this.peers.get(from);
        if (!entry || entry.closed) return;
        await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit));
        entry.remoteDescSet = true;
        await this.flushPendingIce(entry);
        break;
      }
      case "ice": {
        const from = String(msg.from || "");
        const cand = msg.candidate as RTCIceCandidateInit | undefined;
        if (!cand) return;
        const entry = this.peers.get(from);
        if (!entry || entry.closed) return;
        if (entry.remoteDescSet) {
          try {
            await entry.pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch {
            // ignore late or duplicate ICE candidates
          }
        } else {
          entry.pendingIce.push(cand);
        }
        break;
      }
    }
  }

  private createPeerEntry(peerId: string): RtcPeerEntry {
    const existing = this.peers.get(peerId);
    if (existing) this.teardownPeer(peerId);

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry: RtcPeerEntry = {
      peerId,
      pc,
      ctrl: null,
      state: null,
      pendingIce: [],
      remoteDescSet: false,
      opened: false,
      closed: false,
    };
    this.peers.set(peerId, entry);

    pc.onicecandidate = (ev) => {
      if (ev.candidate && !this.closed) {
        this.sendSignal({ t: "ice", to: peerId, candidate: ev.candidate.toJSON() });
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "closed" || st === "disconnected") {
        // Give transient Wi-Fi blips a brief grace window on "disconnected"
        if (st === "disconnected") {
          window.setTimeout(() => {
            if (!entry.closed && (pc.connectionState === "disconnected" || pc.connectionState === "failed")) {
              this.teardownPeer(peerId, "Connection lost");
            }
          }, 3500);
        } else {
          this.teardownPeer(peerId, "Connection closed");
        }
      }
    };

    return entry;
  }

  private bindChannel(entry: RtcPeerEntry, ch: RTCDataChannel, isCtrl: boolean): void {
    if (isCtrl) entry.ctrl = ch;
    else entry.state = ch;

    ch.onopen = () => {
      if (entry.closed || this.closed) return;
      if (isCtrl && !entry.opened) {
        entry.opened = true;
        if (!this.isHost && !this.readyFired) {
          this.readyFired = true;
          this.handlers.onReady(this.localId);
        }
        this.handlers.onPeerOpen(entry.peerId);
        // Guest no longer needs signaling once direct P2P channels are open
        if (!this.isHost && entry.state?.readyState === "open") {
          this.closeSignalingOnly();
        }
      } else if (!isCtrl && !this.isHost && entry.opened) {
        this.closeSignalingOnly();
      }
    };

    ch.onmessage = (ev) => {
      if (entry.closed || this.closed) return;
      try {
        const parsed = JSON.parse(String(ev.data)) as Record<string, unknown>;
        this.handlers.onMessage(entry.peerId, parsed);
      } catch {
        // ignore malformed packets
      }
    };

    if (isCtrl) {
      ch.onclose = () => {
        if (!entry.closed) this.teardownPeer(entry.peerId, "Peer disconnected");
      };
    }
  }

  private async createOfferForPeer(peerId: string): Promise<void> {
    const entry = this.createPeerEntry(peerId);
    const ctrl = entry.pc.createDataChannel("ctrl", { ordered: true });
    const state = entry.pc.createDataChannel("state", { ordered: false, maxRetransmits: 0 });
    this.bindChannel(entry, ctrl, true);
    this.bindChannel(entry, state, false);

    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.sendSignal({ t: "offer", to: peerId, sdp: entry.pc.localDescription });
    } catch {
      this.teardownPeer(peerId, "Failed to create WebRTC offer");
    }
  }

  private async handleOfferFromHost(hostId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const entry = this.createPeerEntry(hostId);
    entry.pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      this.bindChannel(entry, ch, ch.label === "ctrl");
    };
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      entry.remoteDescSet = true;
      await this.flushPendingIce(entry);
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      this.sendSignal({ t: "answer", to: hostId, sdp: entry.pc.localDescription });
    } catch {
      this.handlers.onError("WebRTC handshake failed. Try rejoining the room.");
      this.teardownPeer(hostId, "Handshake failed");
    }
  }

  private async flushPendingIce(entry: RtcPeerEntry): Promise<void> {
    const q = entry.pendingIce.splice(0);
    for (const c of q) {
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        // ignore
      }
    }
  }

  private teardownPeer(peerId: string, reason?: string): void {
    const entry = this.peers.get(peerId);
    if (!entry || entry.closed) return;
    entry.closed = true;
    this.peers.delete(peerId);
    const wasOpen = entry.opened;
    try { entry.ctrl?.close(); } catch { /* ignore */ }
    try { entry.state?.close(); } catch { /* ignore */ }
    try { entry.pc.close(); } catch { /* ignore */ }
    if (wasOpen && !this.closed) {
      this.handlers.onPeerClose(peerId, reason);
      if (!this.isHost) {
        this.handlers.onClose(reason || "Host disconnected");
      }
    }
  }

  private closeSignalingOnly(): void {
    const ws = this.sigWs;
    this.sigWs = null;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  public sendTo(peerId: string, payload: unknown, mode: DeliveryMode = "reliable"): void {
    const entry = this.peers.get(peerId);
    if (!entry || entry.closed) return;
    const ch =
      mode === "unreliable" && entry.state && entry.state.readyState === "open"
        ? entry.state
        : entry.ctrl;
    if (ch && ch.readyState === "open") {
      try {
        ch.send(JSON.stringify(payload));
      } catch {
        // ignore send errors on closing channel
      }
    }
  }

  public broadcast(payload: unknown, mode: DeliveryMode = "reliable", excludePeerId?: string): void {
    const raw = JSON.stringify(payload);
    for (const [pid, entry] of this.peers) {
      if (pid === excludePeerId || entry.closed) continue;
      const ch =
        mode === "unreliable" && entry.state && entry.state.readyState === "open"
          ? entry.state
          : entry.ctrl;
      if (ch && ch.readyState === "open") {
        try {
          ch.send(raw);
        } catch {
          // ignore
        }
      }
    }
  }

  public getBufferedAmount(peerId: string): number {
    const entry = this.peers.get(peerId);
    if (!entry) return 0;
    return (entry.state?.bufferedAmount || 0) + (entry.ctrl?.bufferedAmount || 0);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeSignalingOnly();
    for (const pid of Array.from(this.peers.keys())) {
      const entry = this.peers.get(pid);
      if (!entry) continue;
      entry.closed = true;
      try { entry.ctrl?.close(); } catch { /* ignore */ }
      try { entry.state?.close(); } catch { /* ignore */ }
      try { entry.pc.close(); } catch { /* ignore */ }
    }
    this.peers.clear();
  }
}

/**
 * Offline Local LAN transport over lagoon-server.py WebSocket relay.
 * Supports up to 4 human players + 6 spectators using peer IDs and targeted routing.
 */
export class LanWsTransport implements NetTransport {
  public readonly kind: NetMode = "lan";
  public localId = "";
  public readonly isHost: boolean;

  private ws: WebSocket | null = null;
  private knownPeers = new Set<string>();
  private readyFired = false;
  private closed = false;

  constructor(
    hostAddr: string,
    isHost: boolean,
    private handlers: TransportHandlers
  ) {
    this.isHost = isHost;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${hostAddr}/`);
    } catch {
      this.handlers.onError(`That address doesn't look right (${hostAddr}).`);
      return;
    }
    this.ws = ws;

    ws.onerror = () => {
      if (this.closed) return;
      this.handlers.onError(
        isHost
          ? `Couldn't reach the LAN server on this computer. Run <b>npm run build</b> &amp; start <b>python3 lagoon-server.py</b> (or <b>Start-Lagoon-Server</b>), then press Host again.`
          : `Couldn't reach <b>${hostAddr}</b>. Check the address, confirm the host's server is open, and allow firewall access.`
      );
    };

    ws.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      this.ws = null;
      this.handlers.onClose("Disconnected from the LAN server.");
    };

    ws.onmessage = (ev) => {
      if (this.closed) return;
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (msg.t === "sys") {
          if (typeof msg.id === "string" && !this.localId) {
            this.localId = msg.id;
          }
          const ips = Array.isArray(msg.ips) ? (msg.ips as string[]) : [];
          const peerList = Array.isArray(msg.peers) ? (msg.peers as string[]) : [];
          if (!this.readyFired && this.localId) {
            this.readyFired = true;
            this.handlers.onReady(this.localId);
          }
          this.handlers.onSysInfo?.(ips, peerList);
          const nextSet = new Set(peerList.filter((id) => id !== this.localId));
          for (const id of nextSet) {
            if (!this.knownPeers.has(id)) {
              this.knownPeers.add(id);
              this.handlers.onPeerOpen(id);
            }
          }
          for (const id of Array.from(this.knownPeers)) {
            if (!nextSet.has(id)) {
              this.knownPeers.delete(id);
              this.handlers.onPeerClose(id, "Disconnected");
            }
          }
          return;
        }
        const from = typeof msg.from === "string" ? msg.from : "peer";
        this.handlers.onMessage(from, msg);
      } catch {
        // ignore malformed packets
      }
    };
  }

  public sendTo(peerId: string, payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const obj = payload && typeof payload === "object" ? { ...(payload as Record<string, unknown>), to: peerId } : payload;
    this.ws.send(JSON.stringify(obj));
  }

  public broadcast(payload: unknown, _mode?: DeliveryMode, excludePeerId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (excludePeerId) {
      for (const pid of this.knownPeers) {
        if (pid !== excludePeerId) this.sendTo(pid, payload);
      }
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  public getBufferedAmount(): number {
    return this.ws ? this.ws.bufferedAmount : 0;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    this.knownPeers.clear();
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try { ws.close(); } catch { /* ignore */ }
    }
  }
}
