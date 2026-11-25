import type { StreamDef, Vec2 } from './types';
import { clamp, lerp, normalize, TAU } from './math';

export interface RiverFrame {
  s: number;
  p: Vec2;
  tangent: Vec2;
  normal: Vec2;
  width: number;
  curvature: number;
}

function catmull(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

export class RiverPath {
  readonly stream: StreamDef;
  readonly frames: RiverFrame[] = [];
  readonly length: number;
  readonly dockS: number;
  readonly bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };

  constructor(stream: StreamDef) {
    this.stream = stream;
    const cps = stream.control;
    const raw: Vec2[] = [];
    const perSegment = 28;
    for (let i = 0; i < cps.length - 1; i++) {
      const p0 = cps[Math.max(0, i - 1)];
      const p1 = cps[i];
      const p2 = cps[i + 1];
      const p3 = cps[Math.min(cps.length - 1, i + 2)];
      for (let j = 0; j < perSegment; j++) raw.push(catmull(p0, p1, p2, p3, j / perSegment));
    }
    raw.push(cps[cps.length - 1]);

    const cumulative: number[] = [0];
    for (let i = 1; i < raw.length; i++) {
      cumulative[i] = cumulative[i - 1] + Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
    }
    this.length = cumulative[cumulative.length - 1];
    this.dockS = clamp(this.length - stream.dockFromEnd, 0, this.length);

    const step = 2;
    let rawIndex = 0;
    for (let s = 0; s <= this.length; s += step) {
      while (rawIndex < cumulative.length - 2 && cumulative[rawIndex + 1] < s) rawIndex++;
      const s0 = cumulative[rawIndex];
      const s1 = cumulative[rawIndex + 1] ?? this.length;
      const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
      const p = {
        x: lerp(raw[rawIndex].x, raw[rawIndex + 1]?.x ?? raw[rawIndex].x, t),
        y: lerp(raw[rawIndex].y, raw[rawIndex + 1]?.y ?? raw[rawIndex].y, t),
      };
      this.addBounds(p);
      this.frames.push({ s, p, tangent: { x: 1, y: 0 }, normal: { x: 0, y: 1 }, width: this.widthAt(s), curvature: 0 });
    }

    for (let i = 0; i < this.frames.length; i++) {
      const prev = this.frames[Math.max(0, i - 1)].p;
      const next = this.frames[Math.min(this.frames.length - 1, i + 1)].p;
      const tangent = normalize({ x: next.x - prev.x, y: next.y - prev.y });
      this.frames[i].tangent = tangent;
      // Left bank normal. Positive curvature means a left turn.
      this.frames[i].normal = { x: -tangent.y, y: tangent.x };
    }

    let lastAngle = Math.atan2(this.frames[0].tangent.y, this.frames[0].tangent.x);
    for (let i = 0; i < this.frames.length; i++) {
      const a = Math.atan2(this.frames[i].tangent.y, this.frames[i].tangent.x);
      let d = a - lastAngle;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      const ds = Math.max(2, this.frames[i].s - (this.frames[i - 1]?.s ?? 0));
      this.frames[i].curvature = i === 0 ? 0 : clamp(d / ds, -0.055, 0.055);
      lastAngle = a;
    }
  }

  private addBounds(p: Vec2) {
    this.bounds.minX = Math.min(this.bounds.minX, p.x);
    this.bounds.maxX = Math.max(this.bounds.maxX, p.x);
    this.bounds.minY = Math.min(this.bounds.minY, p.y);
    this.bounds.maxY = Math.max(this.bounds.maxY, p.y);
  }

  widthAt(s: number): number {
    const st = this.stream;
    let w =
      st.baseWidth +
      2.1 * Math.sin(s * 0.018 + st.id.length * 1.7) +
      1.15 * Math.sin(s * 0.057 + 2.4) +
      0.65 * Math.sin(s * 0.113);
    if (st.widthWaves) {
      for (const z of st.widthWaves) {
        const m = Math.max(0, 1 - Math.abs(s - (z.start + z.end) / 2) / ((z.end - z.start) / 2));
        w = lerp(w, z.width, m * m);
      }
    }
    return clamp(w, 15, 42);
  }

  frameAt(s: number): RiverFrame {
    const cs = clamp(s, 0, this.length);
    const f = cs / 2;
    const i = Math.min(this.frames.length - 2, Math.floor(f));
    const t = f - i;
    const a = this.frames[i];
    const b = this.frames[i + 1] ?? a;
    return {
      s: cs,
      p: { x: lerp(a.p.x, b.p.x, t), y: lerp(a.p.y, b.p.y, t) },
      tangent: { x: lerp(a.tangent.x, b.tangent.x, t), y: lerp(a.tangent.y, b.tangent.y, t) },
      normal: { x: lerp(a.normal.x, b.normal.x, t), y: lerp(a.normal.y, b.normal.y, t) },
      width: lerp(a.width, b.width, t),
      curvature: lerp(a.curvature, b.curvature, t),
    };
  }

  project(p: Vec2): { frame: RiverFrame; lateral: number; s: number } {
    let best = this.frames[0];
    let bestD = Infinity;
    // The river is sampled densely enough that a full scan is cheap for 60 nodes.
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const d = (p.x - f.p.x) ** 2 + (p.y - f.p.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    const dx = p.x - best.p.x;
    const dy = p.y - best.p.y;
    const along = dx * best.tangent.x + dy * best.tangent.y;
    const lateral = dx * best.normal.x + dy * best.normal.y;
    const s = clamp(best.s + along, 0, this.length);
    return { frame: this.frameAt(s), lateral, s };
  }

  positionAt(s: number, lateral = 0): Vec2 {
    const f = this.frameAt(s);
    return { x: f.p.x + f.normal.x * lateral, y: f.p.y + f.normal.y * lateral };
  }
}
