import * as THREE from "three";
import { clamp, DW, HW, L, lerp, NET, smoothstep, SVC, TAU, VENUES } from "../core/constants";
import type { RGB, VenueId } from "../core/types";

export function ihash(i: number, j: number): number {
  let n = (i * 374761393 + j * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function vnoise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return lerp(
    lerp(ihash(ix, iy), ihash(ix + 1, iy), ux),
    lerp(ihash(ix, iy + 1), ihash(ix + 1, iy + 1), ux),
    uy
  );
}

function tvnoise(x: number, y: number, per: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const w = (v: number) => ((v % per) + per) % per;
  const h = (a: number, b: number) => ihash(w(a), w(b) + 911);
  return lerp(lerp(h(ix, iy), h(ix + 1, iy), ux), lerp(h(ix, iy + 1), h(ix + 1, iy + 1), ux), uy);
}

function canvasTex(c: HTMLCanvasElement, wrap: THREE.Wrapping, srgb: boolean, aniso: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = wrap;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function heightNormalTex(
  hgt: Float32Array,
  S: number,
  strength: number,
  wrap: boolean,
  aniso: number
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const img = g.createImageData(S, S);
  const d = img.data;
  const at = (x: number, y: number) => {
    if (wrap) {
      x = (x + S) % S;
      y = (y + S) % S;
    } else {
      x = clamp(x, 0, S - 1);
      y = clamp(y, 0, S - 1);
    }
    return hgt[y * S + x];
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const ny = (at(x, y + 1) - at(x, y - 1)) * strength;
      const il = 1 / Math.hypot(nx, ny, 1);
      const i = (y * S + x) * 4;
      d[i] = (nx * il * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * il * 0.5 + 0.5) * 255;
      d[i + 2] = (il * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvasTex(c, wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping, false, aniso);
}

interface CourtTexSet {
  map: THREE.CanvasTexture;
  rough: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
}

function mkCourtTex(venueId: VenueId, aniso: number): CourtTexSet {
  const v = VENUES[venueId];
  const S = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const img = g.createImageData(S, S);
  const d = img.data;

  const rc = document.createElement("canvas");
  rc.width = rc.height = S;
  const rgx = rc.getContext("2d")!;
  const rimg = rgx.createImageData(S, S);
  const rd = rimg.data;

  const hgt = new Float32Array(S * S);
  const x0 = -9.5;
  const z0 = -5.0;
  const spanX = 19.0;
  const spanZ = 33.77;
  const txX = spanX / S;
  const txZ = spanZ / S;
  const cov = (dist: number, hw: number, tx: number) => clamp((hw - Math.abs(dist)) / tx + 0.5, 0, 1);

  for (let py = 0; py < S; py++) {
    const z = z0 + (1 - (py + 0.5) / S) * spanZ;
    for (let px = 0; px < S; px++) {
      const x = x0 + ((px + 0.5) / S) * spanX;
      const inPlay = Math.abs(x) <= DW && z >= 0 && z <= L;
      const baseC = inPlay ? v.inPlayColor : v.outPlayColor;
      let r = baseC[0];
      let gr = baseC[1];
      let b = baseC[2];

      const fine = (ihash(px, py) - 0.5) * (venueId === "cove" ? 16 : 9);
      const grain =
        (vnoise2(x * 1.4, z * 1.4) - 0.5) * (venueId === "cove" ? 20 : 12) +
        (vnoise2(x * 5.5, z * 5.5) - 0.5) * 10 +
        fine;

      // Venue-specific court texture patterns!
      if (venueId === "terrace") {
        // Manicured grass mowing stripes!
        const stripe = Math.floor((z + 10) / 1.45) & 1;
        const stripeMul = stripe ? 1.07 : 0.92;
        // Subtle worn baseline grass patches
        const wearNear = Math.exp(-((x * x) / 6.0 + (z - 0.5) * (z - 0.5) / 1.6));
        const wearFar = Math.exp(-((x * x) / 6.0 + (z - (L - 0.5)) * (z - (L - 0.5)) / 1.6));
        const wear = clamp((wearNear + wearFar) * 0.42, 0, 0.45);
        r = lerp(r * stripeMul, 148, wear);
        gr = lerp(gr * stripeMul, 128, wear);
        b = lerp(b * stripeMul, 74, wear);
      } else if (venueId === "cove") {
        // Red clay brushed streaks & swept dust variation
        const sweep = Math.sin(z * 3.8 + vnoise2(x * 1.2, z * 1.2) * 2.5) * 6;
        r += sweep;
        gr += sweep * 0.55;
        b += sweep * 0.35;
      }

      const warm = 1 + 0.04 * (x / 9.5) + 0.03 * (z / L - 0.5);
      r = clamp(r * warm + grain, 0, 255);
      gr = clamp(gr * warm + grain, 0, 255);
      b = clamp(b * warm + grain, 0, 255);

      // Court lines (singles + doubles + service boxes + center ticks)
      let lc = 0;
      if (z >= -0.04 && z <= L + 0.04) {
        lc = Math.max(lc, cov(Math.abs(x) - DW, 0.036, txX), cov(Math.abs(x) - HW, 0.033, txX));
      }
      if (Math.abs(x) <= DW + 0.04) {
        lc = Math.max(lc, cov(z, 0.048, txZ), cov(z - L, 0.048, txZ));
      }
      if (Math.abs(x) <= HW + 0.03) {
        lc = Math.max(lc, cov(z - (NET - SVC), 0.033, txZ), cov(z - (NET + SVC), 0.033, txZ));
      }
      if (z >= NET - SVC - 0.03 && z <= NET + SVC + 0.03) {
        lc = Math.max(lc, cov(x, 0.033, txX));
      }
      if ((z >= 0 && z <= 0.34) || (z >= L - 0.34 && z <= L)) {
        lc = Math.max(lc, cov(x, 0.033, txX));
      }
      if (lc > 0) {
        r = lerp(r, 248, lc);
        gr = lerp(gr, 245, lc);
        b = lerp(b, 234, lc);
      }

      const idx = (py * S + px) * 4;
      d[idx] = r;
      d[idx + 1] = gr;
      d[idx + 2] = b;
      d[idx + 3] = 255;

      hgt[py * S + px] = fine * 0.06 + (vnoise2(x * 9, z * 9) - 0.5) * (venueId === "cove" ? 0.9 : 0.5) + lc * 0.5;
      const baseRough = venueId === "cove" ? 0.92 : venueId === "terrace" ? 0.88 : inPlay ? 0.74 : 0.84;
      const rough = clamp(lerp(baseRough, 0.46, lc) + (ihash(px + 7, py + 3) - 0.5) * 0.08, 0, 1) * 255;
      rd[idx] = rd[idx + 1] = rd[idx + 2] = rough;
      rd[idx + 3] = 255;
    }
  }

  g.putImageData(img, 0, 0);
  rgx.putImageData(rimg, 0, 0);

  // Scuff / clay slide / grass wear marks near baselines
  g.fillStyle = venueId === "cove" ? "rgba(255,210,180,0.08)" : "rgba(12,38,36,0.055)";
  for (let i = 0; i < 36; i++) {
    const sx = (ihash(i, 11) - 0.5) * 7.4;
    const sz = i & 1 ? 0.4 + ihash(i, 17) * 2.0 : L - 0.4 - ihash(i, 19) * 2.0;
    const cx = ((sx - x0) / spanX) * S;
    const cy = (1 - (sz - z0) / spanZ) * S;
    g.beginPath();
    g.ellipse(cx, cy, 4 + ihash(i, 23) * 9, 2 + ihash(i, 29) * 4, ihash(i, 31) * 3, 0, TAU);
    g.fill();
  }

  // Venue label printed on court apron
  const banner = venueId === "cove" ? "CORAL COVE" : venueId === "terrace" ? "EMERALD TERRACE" : "LAGOON OPEN";
  g.font = "900 32px 'Trebuchet MS','Arial Black',sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "rgba(255,248,236,0.55)";
  const cyNear = (1 - (-2.2 - z0) / spanZ) * S;
  const cyFar = (1 - (L + 2.2 - z0) / spanZ) * S;
  g.save();
  g.translate(S / 2, cyNear);
  g.scale(-1, 1);
  g.fillText(banner, 0, 0);
  g.restore();
  g.save();
  g.translate(S / 2, cyFar);
  g.scale(-1, 1);
  g.fillText(banner, 0, 0);
  g.restore();

  return {
    map: canvasTex(c, THREE.ClampToEdgeWrapping, true, aniso),
    rough: canvasTex(rc, THREE.ClampToEdgeWrapping, false, aniso),
    normal: heightNormalTex(hgt, S, venueId === "cove" ? 0.55 : 0.35, false, aniso),
  };
}

function mkPierTex(aniso: number): { map: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const img = g.createImageData(S, S);
  const d = img.data;
  const hgt = new Float32Array(S * S);

  for (let py = 0; py < S; py++) {
    const v = py / S;
    for (let px = 0; px < S; px++) {
      const plank = px >> 6;
      const localX = px & 63;
      const t = ihash(plank, 3);
      let r = lerp(164, 200, t);
      let gr = lerp(104, 136, t);
      let b = lerp(60, 86, t);
      const wob = Math.sin(v * TAU * 2 + plank) * 1.4;
      const gs = Math.sin((v * 24 + wob) * TAU * 0.5 + localX * 0.35);
      const grain = gs * 9 + (ihash(px, py) - 0.5) * 6;
      const weather = 0.92 + 0.08 * vnoise2(px / 48, py / 48);
      r = (r + grain) * weather;
      gr = (gr + grain * 0.8) * weather;
      b = (b + grain * 0.6) * weather;
      let h = gs * 0.12 + (ihash(px, py) - 0.5) * 0.05 + Math.sin((localX / 63) * Math.PI) * 0.35;
      const butt = (0.17 + plank * 0.37) % 1;
      if (localX < 3 || Math.abs(v - butt) < 0.004) {
        r *= 0.46; gr *= 0.44; b *= 0.42; h = -1.2;
      }
      const nx = localX - 32;
      if (
        Math.abs(nx) < 18 &&
        (Math.hypot(nx - 14, (v - 0.07) * S) < 2.6 ||
          Math.hypot(nx + 14, (v - 0.07) * S) < 2.6 ||
          Math.hypot(nx - 14, (v - butt - 0.03) * S) < 2.6 ||
          Math.hypot(nx + 14, (v - butt - 0.03) * S) < 2.6)
      ) {
        r *= 0.32; gr *= 0.32; b *= 0.34; h -= 0.4;
      }
      const idx = (py * S + px) * 4;
      d[idx] = clamp(r, 0, 255);
      d[idx + 1] = clamp(gr, 0, 255);
      d[idx + 2] = clamp(b, 0, 255);
      d[idx + 3] = 255;
      hgt[py * S + px] = h;
    }
  }
  g.putImageData(img, 0, 0);
  return {
    map: canvasTex(c, THREE.RepeatWrapping, true, aniso),
    normal: heightNormalTex(hgt, S, 0.9, true, aniso),
  };
}

function mkLimestoneTex(aniso: number): { map: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const img = g.createImageData(S, S);
  const d = img.data;
  const hgt = new Float32Array(S * S);

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const row = py >> 6;
      const offX = (px + (row & 1 ? 64 : 0)) & 127;
      const offY = py & 63;
      const tileId = ((px + (row & 1 ? 64 : 0)) >> 7) + row * 17;
      const tv = ihash(tileId, 19);
      let r = lerp(212, 232, tv);
      let gr = lerp(188, 208, tv);
      let b = lerp(154, 174, tv);
      const n = (vnoise2(px / 18, py / 18) - 0.5) * 14 + (ihash(px, py) - 0.5) * 8;
      let h = n * 0.04;
      if (offX < 3 || offY < 3) {
        r *= 0.72; gr *= 0.70; b *= 0.68; h = -0.9;
      }
      const idx = (py * S + px) * 4;
      d[idx] = clamp(r + n, 0, 255);
      d[idx + 1] = clamp(gr + n, 0, 255);
      d[idx + 2] = clamp(b + n, 0, 255);
      d[idx + 3] = 255;
      hgt[py * S + px] = h;
    }
  }
  g.putImageData(img, 0, 0);
  return {
    map: canvasTex(c, THREE.RepeatWrapping, true, aniso),
    normal: heightNormalTex(hgt, S, 0.7, true, aniso),
  };
}

function mkTerraceLawnTex(aniso: number): { map: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const img = g.createImageData(S, S);
  const d = img.data;
  const hgt = new Float32Array(S * S);

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const n = vnoise2(px / 16, py / 16) * 18 + (ihash(px, py) - 0.5) * 14;
      const idx = (py * S + px) * 4;
      d[idx] = clamp(42 + n * 0.6, 0, 255);
      d[idx + 1] = clamp(102 + n, 0, 255);
      d[idx + 2] = clamp(46 + n * 0.5, 0, 255);
      d[idx + 3] = 255;
      hgt[py * S + px] = n * 0.05;
    }
  }
  g.putImageData(img, 0, 0);
  return {
    map: canvasTex(c, THREE.RepeatWrapping, true, aniso),
    normal: heightNormalTex(hgt, S, 0.5, true, aniso),
  };
}

function mkNetTex(aniso: number): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, S, S);
  g.strokeStyle = "rgba(242,238,230,0.95)";
  g.lineWidth = 4.5;
  for (let i = 0; i <= S; i += 32) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke();
  }
  return canvasTex(c, THREE.RepeatWrapping, true, aniso);
}

function mkBallTex(aniso: number): THREE.CanvasTexture {
  const W2 = 256;
  const H2 = 128;
  const c = document.createElement("canvas");
  c.width = W2;
  c.height = H2;
  const g = c.getContext("2d")!;
  const img = g.createImageData(W2, H2);
  const d = img.data;
  const seam: Array<[number, number, number]> = [];
  for (let i = 0; i < 160; i++) {
    const phi = (i / 160) * TAU;
    const th = Math.PI * 0.5 + Math.sin(2 * phi) * 0.62;
    seam.push([Math.sin(th) * Math.cos(phi), Math.cos(th), Math.sin(th) * Math.sin(phi)]);
  }
  for (let py = 0; py < H2; py++) {
    const v = (py + 0.5) / H2;
    const lat = (v - 0.5) * Math.PI;
    const cl = Math.cos(lat);
    const sy = Math.sin(lat);
    for (let px = 0; px < W2; px++) {
      const u = (px + 0.5) / W2;
      const lon = (u - 0.5) * TAU;
      const sx = cl * Math.cos(lon);
      const sz = cl * Math.sin(lon);
      let bestDot = -1;
      for (let i = 0; i < 160; i++) {
        const s = seam[i];
        const dot = sx * s[0] + sy * s[1] + sz * s[2];
        if (dot > bestDot) bestDot = dot;
      }
      const best = Math.acos(clamp(bestDot, -1, 1));
      const fuzz = (ihash(px, py) - 0.5) * 18 + (vnoise2(px * 0.25, py * 0.25) - 0.5) * 16;
      let r = 228 + fuzz;
      let gr = 246 + fuzz * 0.8;
      let b = 52 + fuzz * 0.6;
      const sm = 1 - smoothstep(0.055, 0.082, best);
      const edge = smoothstep(0.055, 0.075, best) * (1 - smoothstep(0.075, 0.11, best));
      r = lerp(r * (1 - edge * 0.22), 250, sm);
      gr = lerp(gr * (1 - edge * 0.22), 248, sm);
      b = lerp(b * (1 - edge * 0.22), 240, sm);
      const idx = (py * W2 + px) * 4;
      d[idx] = clamp(r, 0, 255);
      d[idx + 1] = clamp(gr, 0, 255);
      d[idx + 2] = clamp(b, 0, 255);
      d[idx + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = canvasTex(c, THREE.RepeatWrapping, true, aniso);
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

function mkWaterNormals(aniso: number): THREE.CanvasTexture {
  const S = 256;
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      hgt[y * S + x] =
        tvnoise(u * 8, v * 8, 8) * 0.55 +
        tvnoise(u * 16, v * 16, 16) * 0.28 +
        tvnoise(u * 32, v * 32, 32) * 0.12 +
        Math.sin(TAU * (3 * u + 2 * v)) * 0.05 +
        Math.sin(TAU * (-2 * u + 5 * v)) * 0.03;
    }
  }
  return heightNormalTex(hgt, S, 9.0, true, aniso);
}

export function mkNumberTex(num: number, col: RGB, aniso: number): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, S, S);
  if (num > 0) {
    g.font = "900 94px 'Lilita One','Arial Black',sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    const cs = col.map((v) => Math.round(Math.pow(clamp(v, 0, 1), 1 / 2.2) * 255));
    g.lineWidth = 8;
    g.strokeStyle = "rgba(0,0,0,0.28)";
    g.strokeText(String(num), S / 2, S / 2 + 5);
    g.fillStyle = `rgb(${cs[0]},${cs[1]},${cs[2]})`;
    g.fillText(String(num), S / 2, S / 2 + 5);
  }
  return canvasTex(c, THREE.ClampToEdgeWrapping, true, aniso);
}

export interface TextureBundle {
  getCourt: (venueId: VenueId) => CourtTexSet;
  getDeck: (venueId: VenueId) => { map: THREE.CanvasTexture; normal: THREE.CanvasTexture };
  net: THREE.CanvasTexture;
  ball: THREE.CanvasTexture;
  waterN: THREE.CanvasTexture;
}

export function createTextures(aniso: number): TextureBundle {
  // Generate only the default Lagoon Pier textures upfront (~65% faster initial boot);
  // Coral Cove & Emerald Terrace textures synthesize lazily on first venue selection and stay cached.
  const courtCache: Partial<Record<VenueId, CourtTexSet>> = {
    pier: mkCourtTex("pier", aniso),
  };
  const deckCache: Partial<Record<VenueId, { map: THREE.CanvasTexture; normal: THREE.CanvasTexture }>> = {
    pier: mkPierTex(aniso),
  };
  deckCache.pier!.map.repeat.set(1, 1);

  return {
    getCourt(venueId: VenueId): CourtTexSet {
      let set = courtCache[venueId];
      if (!set) {
        set = mkCourtTex(venueId, aniso);
        courtCache[venueId] = set;
      }
      return set;
    },
    getDeck(venueId: VenueId): { map: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
      let set = deckCache[venueId];
      if (!set) {
        if (venueId === "cove") {
          set = mkLimestoneTex(aniso);
          set.map.repeat.set(4, 5);
          set.normal.repeat.set(4, 5);
        } else if (venueId === "terrace") {
          set = mkTerraceLawnTex(aniso);
          set.map.repeat.set(6, 8);
          set.normal.repeat.set(6, 8);
        } else {
          set = mkPierTex(aniso);
          set.map.repeat.set(1, 1);
        }
        deckCache[venueId] = set;
      }
      return set;
    },
    net: mkNetTex(aniso),
    ball: mkBallTex(aniso),
    waterN: mkWaterNormals(aniso),
  };
}
