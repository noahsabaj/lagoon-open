import { describe, expect, it } from "vitest";
import {
  generateRoomCode,
  isValidRoomCode,
  makeSeededRng,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  VENUES,
} from "../src/core/constants";
import type { BallState } from "../src/core/types";
import { mkPlayer } from "../src/game/engine";
import {
  fastForwardBall,
  MAX_REWIND_TICKS,
  restoreBall,
  snapshotBall,
  StateHistoryRing,
  SwingPredictor,
} from "../src/net/prediction";
import { normalizeSignalUrl } from "../src/net/transport";
import { ChatController } from "../src/ui/chat";

function makeBall(): BallState {
  return {
    x: 0, y: 1.4, z: 3.0, vx: 2.5, vy: 5.5, vz: 18.0,
    w: { x: 220, y: 0, z: 40 },
    rotX: 0, rotY: 0, rotZ: 0,
    visible: true, live: true, serve: false, netted: false, touched: null,
    lastHitter: 0, lastSlot: 0, bounceCount: 0,
    mph: 85, rocket: false, crit: false, shotTag: "drive", splashed: false,
  };
}

describe("Room Codes, Seeded RNG & Signaling URLs", () => {
  it("generates unambiguous 4-letter room codes and normalizes user input", () => {
    for (let i = 0; i < 60; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(4);
      expect(isValidRoomCode(code)).toBe(true);
      for (const ch of code) {
        expect(ROOM_CODE_ALPHABET).toContain(ch);
      }
      expect(code).not.toMatch(/[IO01]/);
    }

    expect(normalizeRoomCode("  pa-lm! ")).toBe("PALM");
    expect(normalizeRoomCode("abcdef")).toBe("ABCD");
    expect(isValidRoomCode("PALM")).toBe(true);
    expect(isValidRoomCode("P4LM")).toBe(true);
    expect(isValidRoomCode("PA")).toBe(false);
    expect(isValidRoomCode("P!LM")).toBe(false);
  });

  it("produces deterministic sequences from makeSeededRng for matching guest/host swings", () => {
    const a = makeSeededRng(42);
    const b = makeSeededRng(42);
    const c = makeSeededRng(43);

    const seqA = Array.from({ length: 12 }, () => a(-1.5, 2.5));
    const seqB = Array.from({ length: 12 }, () => b(-1.5, 2.5));
    const seqC = Array.from({ length: 12 }, () => c(-1.5, 2.5));

    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(-1.5);
      expect(v).toBeLessThanOrEqual(2.5);
    }
  });

  it("normalizes signaling server URLs cleanly", () => {
    expect(normalizeSignalUrl("https://signal.example.com/")).toBe("wss://signal.example.com");
    expect(normalizeSignalUrl("http://localhost:8765/")).toBe("ws://localhost:8765");
    expect(normalizeSignalUrl("wss://room.lagoon.dev///")).toBe("wss://room.lagoon.dev");
  });
});

describe("Lag-Compensated Rewind Ring & Guest Swing Prediction / Rollback", () => {
  it("records 60Hz snapshots, clamps rewind depth to MAX_REWIND_TICKS, and fast-forwards ball physics", () => {
    const ring = new StateHistoryRing();
    const b = makeBall();
    const players = [
      mkPlayer(0, 0, "baseline", 0, 0, 5.8),
      mkPlayer(1, 1, "baseline", 0, 23.77, 4.5),
      mkPlayer(2, 0, "net", -2, 8.2, 5.6),
      mkPlayer(3, 1, "net", 2, 15.5, 4.5),
    ];

    for (let tick = 1; tick <= 20; tick++) {
      b.z = 2 + tick * 0.4;
      players[0].x = tick * 0.1;
      ring.push(tick, b, players);
    }

    // Exact lookup within window
    const hit = ring.lookup(16);
    expect(hit).not.toBeNull();
    expect(hit!.frame.tick).toBe(16);
    expect(hit!.rewindTicks).toBe(4);
    expect(hit!.frame.ball.z).toBeCloseTo(2 + 16 * 0.4, 4);

    // Requested rewind deeper than MAX_REWIND_TICKS clamps cleanly to latest - MAX_REWIND_TICKS
    const clamped = ring.lookup(1);
    expect(clamped).not.toBeNull();
    expect(clamped!.frame.tick).toBe(20 - MAX_REWIND_TICKS);
    expect(clamped!.rewindTicks).toBe(MAX_REWIND_TICKS);

    // Fast-forward advances ball smoothly with 240Hz venue physics
    const copy = makeBall();
    restoreBall(copy, snapshotBall(b));
    const zBefore = copy.z;
    fastForwardBall(copy, 0.08, VENUES.pier);
    expect(copy.z).toBeGreaterThan(zBefore + 1.0);
  });

  it("holds local prediction until host ack, suppresses duplicate FX on match, and rolls back on divergence", () => {
    const pred = new SwingPredictor();
    const b = makeBall();
    const auth = makeBall();

    // 1. Begin prediction at seq 7
    pred.begin({ seq: 7, sentAtMs: 1000, predictedHit: true, predictedPhase: "rally", predictedHitter: 0 });
    expect(pred.pending?.seq).toBe(7);
    expect(pred.shouldHoldPrediction(6, 1040)).toBe(true);
    expect(pred.reconcile(auth, b, 6, 40, VENUES.pier, 1040)).toBe("hold");

    // 2. Host acks seq 7 with near-identical ball trajectory -> matched + suppress duplicate events!
    auth.x = b.x + 0.08;
    auth.y = b.y - 0.03;
    auth.z = b.z + 0.06;
    const matched = pred.reconcile(auth, b, 7, 0, VENUES.pier, 1065);
    expect(matched).toBe("matched");
    expect(pred.shouldSuppressEvent(7)).toBe(true);
    expect(pred.shouldSuppressEvent(8)).toBe(false);
    // Smoothly blended toward auth rather than snapping hard
    expect(b.x).toBeGreaterThan(0);
    expect(b.x).toBeLessThan(auth.x);

    // 3. New prediction seq 8 diverges strongly (e.g. opponent poached a volley first!) -> rollback!
    pred.begin({ seq: 8, sentAtMs: 2000, predictedHit: true, predictedPhase: "rally", predictedHitter: 0 });
    auth.x = b.x + 2.8;
    auth.z = b.z - 3.2;
    auth.vz = -19.0;
    auth.lastHitter = 1;
    const rolled = pred.reconcile(auth, b, 8, 0, VENUES.pier, 2060);
    expect(rolled).toBe("rollback");
    expect(b.x).toBeCloseTo(auth.x, 4);
    expect(b.z).toBeCloseTo(auth.z, 4);
    expect(b.vz).toBeCloseTo(auth.vz, 4);
    // Rollback un-suppresses seq 8 so host's authoritative SFX/VFX plays cleanly
    expect(pred.shouldSuppressEvent(8)).toBe(false);
  });
});

describe("Multi-Peer Room Chat & Spectator Badges", () => {
  it("tracks player slot tags and [SPEC] spectator senderSlot cleanly", () => {
    const sent: string[] = [];
    const chat = new ChatController({
      onSend: (text) => { sent.push(text); return true; },
      onSound: () => {},
      getMyName: () => "Viewer",
      getPeerName: () => "Room PALM",
      getMySlot: () => "spec",
      isLanReady: () => true,
      isLiveLanMatch: () => true,
    });

    expect(chat.send("Great rally!", false, 1000)).toBe(true);
    expect(sent).toEqual(["Great rally!"]);
    expect(chat.messages[0].senderSlot).toBe("spec");

    chat.receivePeer("Alice", "Nice lob!", true, 1200, 0);
    chat.receivePeer("Bob", "Got it!", false, 1500, 3);
    chat.receivePeer("Fan", "Go Team A!", false, 1800, "spec");

    expect(chat.messages.map((m) => m.senderSlot)).toEqual(["spec", 0, 3, "spec"]);
  });
});
