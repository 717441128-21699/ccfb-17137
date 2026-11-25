import type { FlowSample, StreamDef, Vec2, WeatherDef } from './types';
import { RiverPath } from './river';
import { clamp, gaussian } from './math';

export class WaterModel {
  readonly path: RiverPath;
  constructor(
    readonly stream: StreamDef,
    readonly weather: WeatherDef,
  ) {
    this.path = new RiverPath(stream);
  }

  depthAt(s: number, lateral: number): number {
    const f = this.path.frameAt(s);
    const half = f.width * 0.5;
    const q = clamp(Math.abs(lateral) / Math.max(1, half - 0.5), 0, 1.25);
    let depth = this.stream.baseDepth * (1.02 - 0.62 * Math.pow(Math.min(q, 1), 1.75));
    depth += 0.16 * Math.sin(s * 0.045 + 1.7) + 0.08 * Math.sin(s * 0.13);

    // Outer bank is scoured deeper; the inside of a bend deposits sand.
    const bendDeep = -f.curvature * lateral * 8.5;
    depth += clamp(bendDeep, -0.75, 1.05);

    for (const sh of this.stream.shoals) {
      const ds = (s - sh.s) / (sh.length * 0.58);
      const dl = (lateral - sh.lateral) / (sh.width * 0.58);
      const influence = gaussian(Math.hypot(ds, dl), 0.72);
      if (influence > 0.015) depth = depth + (sh.depth - depth) * clamp(influence * 1.25, 0, 0.96);
    }

    for (const r of this.stream.rocks) {
      const ds = (s - r.s) / (r.radius * 2.2);
      const dl = (lateral - r.lateral) / (r.radius * 2.2);
      const influence = gaussian(Math.hypot(ds, dl), 0.8);
      depth -= influence * 0.55;
    }

    depth += this.weather.levelDelta;
    return Math.max(0.06, depth);
  }

  speedAt(s: number, lateral: number, depth?: number): { speed: number; outerFactor: number } {
    const f = this.path.frameAt(s);
    const half = f.width * 0.5;
    const q = clamp(Math.abs(lateral) / half, 0, 1);
    const centreChannel = 0.56 + 0.52 * (1 - Math.pow(q, 1.55));
    // Positive bendSignal is the scoured/outside bank.
    const bendSignal = clamp(-f.curvature * lateral * 4.2, -1, 1);
    const bendMul = 1 + 0.42 * bendSignal;
    const d = depth ?? this.depthAt(s, lateral);
    const shallowMul = clamp(0.62 + d / (this.stream.baseDepth + this.weather.levelDelta) * 0.38, 0.62, 1.08);
    const speed = this.stream.baseSpeed * this.weather.speedMul * centreChannel * bendMul * shallowMul;
    return { speed, outerFactor: bendSignal };
  }

  sampleSL(s: number, lateral: number, time = 0): FlowSample {
    const f = this.path.frameAt(s);
    const pos = { x: f.p.x + f.normal.x * lateral, y: f.p.y + f.normal.y * lateral };
    const depth = this.depthAt(s, lateral);
    const base = this.speedAt(s, lateral, depth);
    let long = base.speed;
    let side = 0;

    // Reverse flow and paired eddies immediately downstream of exposed rocks.
    this.stream.rocks.forEach((rock, ri) => {
      const rp = this.path.positionAt(rock.s, rock.lateral);
      const rf = this.path.frameAt(rock.s);
      const dx = pos.x - rp.x;
      const dy = pos.y - rp.y;
      const du = dx * rf.tangent.x + dy * rf.tangent.y;
      const dn = dx * rf.normal.x + dy * rf.normal.y;
      if (du < -rock.radius * 0.8 || du > rock.radius * 10.5) return;
      const longitudinal = (du - rock.radius * 2.3) / (rock.radius * 4.4);
      const lateralScale = dn / (rock.radius * 1.75);
      const wake = Math.exp(-longitudinal * longitudinal - lateralScale * lateralScale);
      if (wake < 0.025) return;
      long -= base.speed * 1.65 * wake;
      side -= Math.sign(dn || Math.sin(ri + 1)) * base.speed * 0.42 * wake;
      side += Math.sin(du * 1.65 - time * 2.4 + ri * 2.1) * base.speed * 0.28 * wake;
    });

    const velocity: Vec2 = {
      x: f.tangent.x * long + f.normal.x * side,
      y: f.tangent.y * long + f.normal.y * side,
    };
    return {
      velocity,
      downstream: f.tangent,
      normal: f.normal,
      position: pos,
      s,
      lateral,
      width: f.width,
      depth,
      speed: base.speed,
      outerFactor: base.outerFactor,
    };
  }

  sample(pos: Vec2, time = 0): FlowSample {
    const projected = this.path.project(pos);
    return this.sampleSL(projected.s, projected.lateral, time);
  }
}
