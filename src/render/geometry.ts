import * as THREE from "three";
import { L, lerp, NETH, POST_H, POST_X, TAU } from "../core/constants";
import type { RGB } from "../core/types";
import { vnoise2 } from "./textures";

export const WHITE: RGB = [1, 1, 1];
export const rgb = (a: RGB): THREE.Color => new THREE.Color().setRGB(a[0], a[1], a[2]);

export class MeshBuilder {
  public p: number[] = [];
  public n: number[] = [];
  public u: number[] = [];
  public c: number[] = [];
  public i: number[] = [];
  public v = 0;

  public vert(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    col: RGB
  ): number {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.u.push(u, v);
    this.c.push(col[0], col[1], col[2]);
    return this.v++;
  }

  public tri(a: number, b: number, c: number): void {
    this.i.push(a, b, c);
  }

  public quad(a: number, b: number, c: number, d: number): void {
    this.i.push(a, b, c, a, c, d);
  }

  public addBox(
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    col: RGB,
    uvScale = 0
  ): void {
    const F: Array<[RGB, RGB, RGB]> = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
      [[0, 1, 0], [0, 0, -1], [1, 0, 0]],
      [[0, -1, 0], [0, 0, 1], [1, 0, 0]],
      [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
      [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    ];
    for (const [N, U, V] of F) {
      const b = this.v;
      const sx = N[0] * hx, sy = N[1] * hy, sz = N[2] * hz;
      const ux = U[0] * hx, uy = U[1] * hy, uz = U[2] * hz;
      const vx = V[0] * hx, vy = V[1] * hy, vz = V[2] * hz;
      const pts: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (let k = 0; k < 4; k++) {
        const px = cx + sx + ux * pts[k][0] + vx * pts[k][1];
        const py = cy + sy + uy * pts[k][0] + vy * pts[k][1];
        const pz = cz + sz + uz * pts[k][0] + vz * pts[k][1];
        const tu = uvScale ? px / uvScale : pts[k][0] * 0.5 + 0.5;
        const tv = uvScale ? pz / uvScale : pts[k][1] * 0.5 + 0.5;
        this.vert(px, py, pz, N[0], N[1], N[2], tu, tv, col);
      }
      this.quad(b, b + 1, b + 2, b + 3);
    }
  }

  public addCyl(
    cx: number,
    cy: number,
    cz: number,
    r0: number,
    r1: number,
    y0: number,
    y1: number,
    seg: number,
    col: RGB,
    caps = true
  ): void {
    const b = this.v;
    const dy = y1 - y0;
    const dr = r0 - r1;
    const nl = Math.hypot(dy, dr) || 1;
    const nr = dy / nl;
    const ny = dr / nl;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      this.vert(cx + ca * r0, cy + y0, cz + sa * r0, ca * nr, ny, sa * nr, i / seg, 0, col);
      this.vert(cx + ca * r1, cy + y1, cz + sa * r1, ca * nr, ny, sa * nr, i / seg, 1, col);
    }
    for (let i = 0; i < seg; i++) {
      const k = b + i * 2;
      this.quad(k, k + 2, k + 3, k + 1);
    }
    if (caps && r1 > 1e-4) {
      const tc = this.vert(cx, cy + y1, cz, 0, 1, 0, 0.5, 0.5, col);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * TAU;
        this.vert(cx + Math.cos(a) * r1, cy + y1, cz + Math.sin(a) * r1, 0, 1, 0, 0.5, 0.5, col);
      }
      for (let i = 0; i < seg; i++) this.tri(tc, tc + 1 + i + 1, tc + 1 + i);
    }
    if (caps && r0 > 1e-4) {
      const bc = this.vert(cx, cy + y0, cz, 0, -1, 0, 0.5, 0.5, col);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * TAU;
        this.vert(cx + Math.cos(a) * r0, cy + y0, cz + Math.sin(a) * r0, 0, -1, 0, 0.5, 0.5, col);
      }
      for (let i = 0; i < seg; i++) this.tri(bc, bc + 1 + i, bc + 1 + i + 1);
    }
  }

  public addSphere(
    cx: number,
    cy: number,
    cz: number,
    rx: number,
    ry: number,
    rz: number,
    segU: number,
    segV: number,
    col: RGB
  ): void {
    const b = this.v;
    for (let j = 0; j <= segV; j++) {
      const th = (j / segV) * Math.PI;
      const st = Math.sin(th);
      const ct = Math.cos(th);
      for (let i = 0; i <= segU; i++) {
        const ph = (i / segU) * TAU;
        const nx = st * Math.cos(ph);
        const ny = ct;
        const nz = st * Math.sin(ph);
        const nl = Math.hypot(nx / rx, ny / ry, nz / rz) || 1;
        this.vert(
          cx + nx * rx,
          cy + ny * ry,
          cz + nz * rz,
          nx / rx / nl,
          ny / ry / nl,
          nz / rz / nl,
          i / segU,
          1 - j / segV,
          col
        );
      }
    }
    const row = segU + 1;
    for (let j = 0; j < segV; j++) {
      for (let i = 0; i < segU; i++) {
        const a = b + j * row + i;
        this.quad(a, a + 1, a + row + 1, a + row);
      }
    }
  }

  public build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

export const buildPrim = (fn: (b: MeshBuilder) => void): THREE.BufferGeometry => {
  const b = new MeshBuilder();
  fn(b);
  return b.build();
};

function buildCourtGeo(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const x0 = -9.5, x1 = 9.5, z0 = -5.0, z1 = L + 5.0;
  const v0 = b.vert(x0, 0.015, z0, 0, 1, 0, 0, 0, WHITE);
  const v1 = b.vert(x1, 0.015, z0, 0, 1, 0, 1, 0, WHITE);
  const v2 = b.vert(x1, 0.015, z1, 0, 1, 0, 1, 1, WHITE);
  const v3 = b.vert(x0, 0.015, z1, 0, 1, 0, 0, 1, WHITE);
  b.quad(v0, v3, v2, v1);
  return b.build();
}

function buildNetGeo(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const nx = 44, ny = 8;
  const netTop = (x: number) => {
    const ax = Math.abs(x) / POST_X;
    return NETH + (POST_H - NETH) * ax * ax;
  };
  for (let j = 0; j <= ny; j++) {
    const ty = j / ny;
    for (let i = 0; i <= nx; i++) {
      const tx = i / nx;
      const x = lerp(-POST_X, POST_X, tx);
      const y = ty * (netTop(x) - 0.05);
      b.vert(x, y, 0, 0, 0, -1, tx * 28, ty * 4.5, WHITE);
    }
  }
  const row = nx + 1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * row + i;
      b.quad(a, a + 1, a + row + 1, a + row);
    }
  }
  return b.build();
}

function buildNetTapeGeo(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const nx = 44;
  const col: RGB = [0.96, 0.94, 0.88];
  const netTop = (x: number) => {
    const ax = Math.abs(x) / POST_X;
    return NETH + (POST_H - NETH) * ax * ax;
  };
  for (let i = 0; i <= nx; i++) {
    const x = lerp(-POST_X, POST_X, i / nx);
    const yt = netTop(x);
    b.vert(x, yt - 0.055, -0.022, 0, 0, -1, 0, 0, col);
    b.vert(x, yt, -0.022, 0, 0.5, -0.86, 0, 1, col);
    b.vert(x, yt, 0.022, 0, 0.5, 0.86, 0, 1, col);
    b.vert(x, yt - 0.055, 0.022, 0, 0, 1, 0, 0, col);
  }
  for (let i = 0; i < nx; i++) {
    const k = i * 4;
    b.quad(k, k + 4, k + 5, k + 1);
    b.quad(k + 1, k + 5, k + 6, k + 2);
    b.quad(k + 2, k + 6, k + 7, k + 3);
  }
  return b.build();
}

export const ISLANDS: Array<[number, number, number, number, number, RGB]> = [
  [-58, 92, 26, 13, 18, [0.16, 0.24, 0.20]],
  [-22, 108, 16, 7.5, 12, [0.18, 0.25, 0.22]],
  [48, 98, 22, 10.5, 16, [0.15, 0.22, 0.19]],
  [82, 74, 18, 8, 14, [0.17, 0.24, 0.20]],
  [-86, 56, 20, 9, 15, [0.16, 0.23, 0.20]],
];

export function islandPoint(
  def: [number, number, number, number, number, RGB],
  a: number,
  t: number
): [number, number, number] {
  const [cx, cz, rx, h, rz] = def;
  const r = 1 - t * 0.96;
  const cr = r * (0.82 + 0.18 * Math.sin(a * 3 + cx) + 0.1 * Math.cos(a * 5 + cz));
  return [cx + Math.cos(a) * rx * cr, -1.6 + Math.pow(t, 0.85) * h, cz + Math.sin(a) * rz * cr];
}

function buildIslandsGeo(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const sand: RGB = [0.68, 0.56, 0.36];
  for (const def of ISLANDS) {
    const col = def[5];
    const segU = 48, segV = 16, base = b.v;
    for (let j = 0; j <= segV; j++) {
      const t = j / segV;
      for (let i = 0; i <= segU; i++) {
        const a = (i / segU) * TAU;
        const [px, py, pz] = islandPoint(def, a, t);
        const jitter = (vnoise2(px * 0.4, pz * 0.4) - 0.5) * 0.12;
        const c: RGB =
          t < 0.16
            ? sand
            : t < 0.22
            ? [lerp(sand[0], col[0], 0.5), lerp(sand[1], col[1], 0.5), lerp(sand[2], col[2], 0.5)]
            : [col[0] * (0.8 + t * 0.4 + jitter), col[1] * (0.8 + t * 0.4 + jitter), col[2] * (0.8 + t * 0.4 + jitter)];
        const ny = 0.55 + 0.45 * t;
        const nx = Math.cos(a) * (1 - t * 0.5);
        const nz = Math.sin(a) * (1 - t * 0.5);
        const nl = Math.hypot(nx, ny, nz) || 1;
        b.vert(
          px,
          py + (t > 0.2 ? (vnoise2(px * 0.5, pz * 0.5) - 0.5) * 0.8 : 0),
          pz,
          nx / nl,
          ny / nl,
          nz / nl,
          i / segU,
          t,
          c
        );
      }
    }
    const row = segU + 1;
    for (let j = 0; j < segV; j++) {
      for (let i = 0; i < segU; i++) {
        const a = base + j * row + i;
        b.quad(a, a + 1, a + row + 1, a + row);
      }
    }
  }
  const g = b.build();
  g.computeVertexNormals();
  return g;
}

function buildCrowdGeos() {
  const head = buildPrim((b) => b.addSphere(0, 0.68, 0.01, 0.105, 0.115, 0.105, 8, 6, WHITE));
  const hair = new THREE.SphereGeometry(1, 8, 5, 0, TAU, 0, Math.PI * 0.5);
  hair.scale(0.112, 0.1, 0.112);
  hair.rotateX(-0.35);
  hair.translate(0, 0.70, -0.005);
  const shirt = buildPrim((b) => {
    b.addBox(0, 0.34, 0, 0.16, 0.21, 0.10, WHITE);
    b.addSphere(0, 0.53, 0, 0.16, 0.05, 0.10, 8, 4, WHITE);
  });
  const shorts = buildPrim((b) => b.addBox(0, 0.08, 0.05, 0.15, 0.08, 0.13, WHITE));
  const armR = buildPrim((b) => {
    b.addBox(0.05, -0.15, 0.02, 0.045, 0.15, 0.045, WHITE);
    b.addSphere(0.05, -0.31, 0.02, 0.045, 0.045, 0.045, 6, 4, WHITE);
  });
  const armL = buildPrim((b) => {
    b.addBox(-0.05, -0.15, 0.02, 0.045, 0.15, 0.045, WHITE);
    b.addSphere(-0.05, -0.31, 0.02, 0.045, 0.045, 0.045, 6, 4, WHITE);
  });
  return { head, hair, shirt, shorts, armR, armL };
}

function buildSeagullWingGeo(): THREE.BufferGeometry {
  return buildPrim((b) => {
    const v0 = b.vert(0, 0, 0.08, 0, 1, 0, 0, 0, WHITE);
    const v1 = b.vert(0, 0, -0.08, 0, 1, 0, 0, 1, WHITE);
    const v2 = b.vert(0.45, 0.04, -0.02, 0, 1, 0, 1, 0.5, WHITE);
    b.tri(v0, v2, v1);
  });
}

export function createSharedGeos() {
  return {
    court: buildCourtGeo(),
    net: buildNetGeo(),
    netTape: buildNetTapeGeo(),
    islands: buildIslandsGeo(),
    crowd: buildCrowdGeos(),
    gullWing: buildSeagullWingGeo(),
    ball: buildPrim((b) => b.addSphere(0, 0, 0, 1, 1, 1, 32, 22, WHITE)),
    torus: new THREE.TorusGeometry(1, 0.1, 16, 48),
  };
}

export type SharedGeos = ReturnType<typeof createSharedGeos>;
