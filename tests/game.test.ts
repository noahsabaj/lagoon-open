import { describe, expect, it } from "vitest";
import { CAST, DW, emptyMatchStats, HW, L, NET, VENUES } from "../src/core/constants";
import type { BallState, GameState } from "../src/core/types";
import { chooseAIShot } from "../src/game/ai";
import { defaultCareer, evaluateUnlocks, upgradeMedal } from "../src/game/career";
import { mkPlayer } from "../src/game/engine";
import { ReplaySystem } from "../src/game/replay";
import { applyPointToScore, checkLineProximity, isInCourt } from "../src/game/rules";
import { advanceEndless, createEndless, createTournament, recordTournamentResult } from "../src/game/tournament";
import { physStep } from "../src/physics/ballPhysics";
import { launchBall } from "../src/physics/solver";
import { CHAT_COOLDOWN_MS, CHAT_MAX_LEN, ChatController, sanitizeChatText } from "../src/ui/chat";

function makeBall(): BallState {
  return {
    x: 0, y: 1.5, z: 2.0, vx: 0, vy: 0, vz: 0,
    w: { x: 0, y: 0, z: 0 },
    rotX: 0, rotY: 0, rotZ: 0,
    visible: true, live: true, serve: false, netted: false, touched: null,
    lastHitter: 0, lastSlot: 0, bounceCount: 0,
    mph: 0, rocket: false, crit: false, shotTag: "drive", splashed: false,
  };
}

function makeGame(format: GameState["config"]["format"] = "3games", discipline: GameState["config"]["discipline"] = "singles"): GameState {
  return {
    mode: "match", phase: "rally", paused: false,
    config: { discipline, format, venue: "pier", sky: "auto", oppId: "reef", oppPartnerId: "pippa", partnerId: "sunny" },
    pts: [0, 0], games: [0, 0], tiebreak: false, tbPts: [0, 0],
    server: 0, serverSlot: 0, faults: 0, timer: 0, tossT: 0, tossed: false,
    lastSwing: -9, now: 0, winner: -1, rally: 0, strokes: 0, hitstop: 0, slowMo: 0,
    lobArmed: false, lastSkillDelta: 0, newUnlocks: [],
    stats: emptyMatchStats(),
  };
}

describe("240Hz Surface Physics & Pier Water Drop-off", () => {
  it("bounces higher and slower on Coral Cove Clay than Emerald Terrace Grass", () => {
    const runBounce = (venueId: "cove" | "terrace") => {
      const b = makeBall();
      b.x = 0; b.y = 1.2; b.z = 5;
      b.vx = 0; b.vy = -8.0; b.vz = 18.0;
      b.w = { x: 260, y: 0, z: 0 }; // heavy topspin
      for (let i = 0; i < 400; i++) {
        const ev = physStep(b, 1 / 240, VENUES[venueId], true);
        if (ev === "bounce") return { vy: b.vy, vz: b.vz };
      }
      throw new Error("Ball never bounced");
    };

    const clay = runBounce("cove");
    const grass = runBounce("terrace");
    expect(clay.vy).toBeGreaterThan(grass.vy);
    expect(grass.vz).toBeGreaterThan(clay.vz);
  });

  it("drops off the pier edge and splashes into lagoon water", () => {
    const b = makeBall();
    b.x = 15.5; // well beyond pier deckHalfX (13.0)
    b.y = 0.8;
    b.z = 10.0;
    b.vx = 4; b.vy = -2; b.vz = 0;
    let splashed = false;
    for (let i = 0; i < 400; i++) {
      const ev = physStep(b, 1 / 240, VENUES.pier, true);
      if (ev === "splash") {
        splashed = true;
        break;
      }
    }
    expect(splashed).toBe(true);
    expect(b.splashed).toBe(true);
    expect(b.y).toBeCloseTo(VENUES.pier.waterY, 2);
  });

  it("launches shots cleanly across the net via iterative solver", () => {
    const b = makeBall();
    const mph = launchBall(b, 2.2, NET + 8.5, { mph: 90, top: 240, side: 80, clear: 0.3, tag: "drive" });
    expect(mph).toBeGreaterThan(60);
    expect(b.vz).toBeGreaterThan(0);
    expect(b.live).toBe(true);
  });
});

describe("Scoring Rules, Doubles Bounds, Tiebreaks & Hawk-Eye", () => {
  it("enforces Singles vs Doubles court tramlines and detects Hawk-Eye close calls", () => {
    expect(isInCourt(HW + 0.5, NET + 5, false, "singles")).toBe(false);
    expect(isInCourt(HW + 0.5, NET + 5, false, "doubles")).toBe(true);
    expect(isInCourt(DW + 0.5, NET + 5, false, "doubles")).toBe(false);

    const g = makeGame("3games", "singles");
    const closeOut = checkLineProximity(HW + 0.11, NET + 6, false, false, "singles", g);
    expect(closeOut.isIn).toBe(false);
    expect(closeOut.isCloseCall).toBe(true);
    expect(closeOut.lineLabel).toBe("Sideline");
  });

  it("enters a 7-point tiebreak at 6-6 in a Full 6-Game Set and awards match cleanly", () => {
    const g = makeGame("6games", "singles");
    g.games = [6, 5];
    g.pts = [0, 3];
    const enter = applyPointToScore(g, 1);
    expect(enter.isGame).toBe(true);
    expect(enter.enteredTiebreak).toBe(true);
    expect(g.tiebreak).toBe(true);
    expect(g.games).toEqual([6, 6]);

    // Score 6-6 in tiebreak -> win by 2!
    for (let i = 0; i < 6; i++) {
      applyPointToScore(g, 0);
      applyPointToScore(g, 1);
    }
    expect(g.winner).toBe(-1);
    applyPointToScore(g, 0);
    expect(g.winner).toBe(-1);
    const fin = applyPointToScore(g, 0);
    expect(fin.isMatch).toBe(true);
    expect(g.winner).toBe(0);
    expect(g.games).toEqual([7, 6]);
  });

  it("rotates through all 4 player slots in Doubles", () => {
    const g = makeGame("3games", "doubles");
    const slots = [g.serverSlot];
    for (let k = 0; k < 4; k++) {
      g.pts = [3, 0];
      applyPointToScore(g, 0);
      slots.push(g.serverSlot);
    }
    expect(slots).toEqual([0, 1, 2, 3, 0]);
  });
});

describe("AI, Career Unlocks, Tournament, Endless & Replay", () => {
  it("produces tactical AI shots and scales fatigue errors smoothly", () => {
    const cpu = mkPlayer(1, 1, "baseline", 0, L, 4.5);
    const you = mkPlayer(0, 0, "baseline", -2.5, 0, 5.8);
    const b = makeBall();
    b.z = L - 0.2;
    const dec = chooseAIShot(cpu, CAST.pippa, b, you, "singles", 4, 1.0, false);
    expect(["drive", "slice", "lob", "drop", "volley", "smash"]).toContain(dec.tag);
    expect(Number.isFinite(dec.tx)).toBe(true);
  });

  it("unlocks cosmetic rackets, trails, and Secret Boss Captain Sol via Career milestones", () => {
    const career = defaultCareer();
    expect(career.bossUnlocked).toBe(false);

    upgradeMedal(career, "rings", 4800);
    expect(career.trainingMedals.rings).toBe("gold");
    career.cupsWon = 1;
    const newly = evaluateUnlocks(career);
    expect(career.bossUnlocked).toBe(true);
    expect(career.unlockedRackets).toContain("carbon");
    expect(career.unlockedRackets).toContain("gold");
    expect(career.unlockedTrails).toContain("plasma");
    expect(newly.length).toBeGreaterThan(0);
  });

  it("advances Lagoon Cup Tournament and King of the Pier Endless streaks", () => {
    const career = defaultCareer();
    const t = createTournament("singles", "3games", "pier", career);
    expect(t.rounds.length).toBe(3);
    expect(recordTournamentResult(t, true, "3–1").tournamentOver).toBe(false);
    expect(t.round).toBe(1);
    expect(recordTournamentResult(t, true, "3–2").tournamentOver).toBe(false);
    expect(t.round).toBe(2);
    const fin = recordTournamentResult(t, true, "3–0");
    expect(fin.champion).toBe(true);

    const end = createEndless("singles");
    const next = advanceEndless(end, false);
    expect(end.wins).toBe(1);
    expect(end.paceMult).toBeGreaterThan(1.0);
    expect(next.oppId).toBeTruthy();
  });

  it("records and smoothly interpolates slow-mo replays and manages Hawk-Eye lifecycle", () => {
    const rep = new ReplaySystem();
    const b = makeBall();
    const ps = [mkPlayer(0, 0, "baseline", 0, 0, 5.8), mkPlayer(1, 1, "baseline", 0, L, 4.2)];
    for (let i = 0; i < 40; i++) {
      b.z = i * 0.5;
      b.y = 1.0 + Math.sin(i * 0.15);
      rep.record(1 / 60, b, ps);
    }
    expect(rep.triggerReplay("ACE REPLAY")).toBe(true);
    expect(rep.active).toBe(true);
    // Two 120Hz sub-steps must smoothly advance ball position every single display frame (no slideshow stepping)
    const f1 = rep.stepReplay(1 / 120);
    const f2 = rep.stepReplay(1 / 120);
    expect(f1).not.toBeNull();
    expect(f2).not.toBeNull();
    expect(f2!.bz).toBeGreaterThan(f1!.bz);
    expect(rep.skipAny()).toBe(true);
    expect(rep.active).toBe(false);

    rep.triggerHawkEye(HW + 0.05, NET + 5, false, 0.05, "Sideline");
    expect(rep.hawkeye.active).toBe(true);
    expect(rep.hawkeye.distCm).toBe(5);
    expect(rep.stepHawkEye(3.0)).toBe(false);
  });

  it("sanitizes, throttles, mutes, and retains LAN chat session history cleanly", () => {
    expect(sanitizeChatText("  hello\u0007\n   world  ")).toBe("hello world");
    expect(sanitizeChatText("a".repeat(250)).length).toBe(CHAT_MAX_LEN);

    const sent: Array<{ text: string; quick: boolean }> = [];
    const sounds: boolean[] = [];
    const chat = new ChatController({
      onSend: (text, quick) => { sent.push({ text, quick }); return true; },
      onSound: (isRemote) => sounds.push(isRemote),
      getMyName: () => "Noah",
      getPeerName: () => "Buddy",
      isLanReady: () => true,
      isLiveLanMatch: () => true,
    });

    expect(chat.send("   ", false, 1000)).toBe(false);
    expect(chat.send("Nice serve!", false, 1000)).toBe(true);
    // Cooldown prevents instant spam burst
    expect(chat.send("Spam!", false, 1000 + CHAT_COOLDOWN_MS - 50)).toBe(false);
    expect(chat.send("What a save!", true, 1000 + CHAT_COOLDOWN_MS + 10)).toBe(true);
    expect(sent).toEqual([
      { text: "Nice serve!", quick: false },
      { text: "What a save!", quick: true },
    ]);

    // Peer incoming message triggers remote sound when unmuted
    chat.receivePeer("Buddy", "GG!", true, 2000);
    expect(sounds).toEqual([false, false, true]);
    expect(chat.messages.length).toBe(3);

    // Muting silences incoming sound and tracks unread count
    chat.toggleMute();
    chat.receivePeer("Buddy", "Rematch?", false, 2600);
    expect(sounds.length).toBe(3);
    expect(chat.unread).toBe(1);

    // Session reset clears history and unread count on LAN disconnect
    chat.clearSession();
    expect(chat.messages.length).toBe(0);
    expect(chat.unread).toBe(0);
  });
});
