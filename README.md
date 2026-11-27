# Lagoon Open

Motion-controlled 3D arcade tennis across three tropical lagoon venues, powered by **TypeScript, Vite, Three.js**, and **Blender 5.3 hero 3D models** (`.glb`) — built to run 100% offline.

## Highlights

- **3 Distinct Tropical Venues with Real Surface Physics:**
  - **Lagoon Pier (Hard):** Balanced bounce and pace on a timber pier over reflective lagoon water.
  - **Coral Cove (Clay):** Higher topspin kick, slower court pace, terracotta dust puffs, sliding footwork, and Mediterranean stone archways.
  - **Emerald Terrace (Grass):** Fast, low-skidding slices on striped lawn turf with a coastal clubhouse pavilion.
- **4 Lighting Presets:** Resort Noon, Golden Hour, Twilight, and **Night Floodlights** with starlit skies and stadium light towers.
- **Wii-Style Pure Auto-Run Gameplay:**
  - Classic toss-and-hit **130+ MPH Rocket Serves**, early/late timing placement, topspin drives, slices, lobs, volleys, smashes, **drop shots**, **visual power charge meter**, and **automatic desperation dive saves**.
  - Grounded contact ball drop-shadows, overhead smash star cues, and real pier edge drop-offs with lagoon **water splashes**.
- **6 Core Rivals + Secret Boss Captain Sol:** Distinct AI playstyles, visible wind-up telegraphs, and rally-pressure fatigue.
- **Game Modes & Progression:**
  - **Singles (1v1) & Doubles (2v2)** — Classic Wii Sports Dual-Control by default + optional AI Partner toggle.
  - **Selectable Match Formats:** 1-Game Sprint, First to 3 Games, and Full 6-Game Set with 7-point Tiebreak.
  - **Lagoon Cup Tournament:** 3-round knockout bracket with 3D trophy ceremony.
  - **King of the Pier:** Endless 1-game sudden-death challenger streak with escalating pace.
  - **3 Training Drills:** Target Rings (60s), Rally Endurance, and Serve & Return Blitz with Bronze/Silver/Gold medals.
  - **Live 3D Avatar & Racket Customizer:** Customize skin, hair, hats, kit, jersey number, left/right handedness, and unlockable Blender rackets & swing trails.
- **Living Court, Broadcast & Audio:**
  - Seated head-tracking umpire, animated ball kids, cheering instanced crowd, live 3D LED courtside scoreboard, skippable slow-mo **Instant Replays**, and close-line **Hawk-Eye** zooms.
  - Procedural Wii Resort–style tropical Web Audio soundtrack, Web Speech API umpire callouts, surface/splash acoustics, and independent Master / Music / SFX / Voice sliders.
- **Controllers:** Mouse (LMB tap/hold charge + RMB slice + opt-in hover-flick), Keyboard, Touch, **Gamepad API** (Xbox / PlayStation / Switch Pro with rumble), and **WebHID Wii Remote** (handedness, calibration G-meter, optional MotionPlus gyro).
- **Upgraded LAN Multiplayer:** Host-authoritative WebSocket relay with synced venue/format/Singles-or-Doubles lobby settings, synced custom avatars & rackets, live ping (ms), and post-match stats & rematch.

## Quick Start

```bash
npm install
npm run dev      # Local dev server (http://localhost:5173)
npm run build    # Type-check & build offline bundle into ./dist/
npm test         # Run Vitest physics, rules, AI & career unit tests
```

## LAN Multiplayer

1. Build the game once: `npm install && npm run build`
2. Start the LAN relay & static server on the host computer:
   - **macOS / Linux:** `python3 lagoon-server.py` (or double-click `Start-Lagoon-Server.command`)
   - **Windows:** double-click `Start-Lagoon-Server.bat` (or run `py -3 lagoon-server.py`)
3. **Host:** Open `http://localhost:8765`, choose **LAN Match**, configure court/mode, and press **Host Game**.
4. **Guest:** Open `http://<host-lan-ip>:8765` in a browser, choose **LAN Match**, and press **Join Game**.
5. Host presses **Start Match**!

## 3D Modeling Pipeline

Hero 3D assets live in `public/models/` (`.glb`) and are reproducibly built via Blender 5.3 Python scripts under `tools/blender/`.

---

Lagoon Open is a fan-made game and is not affiliated with or endorsed by Nintendo. "Wii" is a trademark of Nintendo.
