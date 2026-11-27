# Lagoon Open — WebRTC Signaling Worker

Lightweight Cloudflare Worker + Durable Object that relays only the initial ~2 KB WebRTC SDP/ICE handshake for 4-letter room codes (e.g. `PALM`). Once connected, all gameplay traffic flows direct browser-to-browser via WebRTC `RTCDataChannel`.

## Deploy to Cloudflare Workers (Free Tier)

```bash
cd server/signaling
npx wrangler login
npx wrangler deploy
```

Then configure the deployed URL in Lagoon Open either:
- At build time via `.env`: `VITE_SIGNAL_URL=wss://lagoon-open-signaling.<your-subdomain>.workers.dev`
- Or directly inside the **Online & LAN** lobby under **Advanced → Signaling Server**.

## Local Development

No Cloudflare account is required to test WebRTC room codes locally: `python3 lagoon-server.py` serves the exact same `/signal/<CODE>` WebSocket protocol on `ws://localhost:8765`.
