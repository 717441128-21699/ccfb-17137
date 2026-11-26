// 水流场：按河道地形预计算流速与水深。
//  - 弯道外侧水急、内侧水缓（曲率 × 横向位置修正）
//  - 弯道内侧淤积变浅、外侧刷深
//  - 礁石下游生成回水（逆流）与旋涡
//  - 浅滩处水浅流急
// 天气通过倍率实时作用于查询，不重建网格。

import { RiverGeometry, RockDef } from './rivers.js';
import { Vec2, clamp, lerp, smoothstep } from './math.js';

export const NS = 512; // 沿程网格数
export const NT = 24;  // 横向网格数（覆盖 t ∈ [-1.15, 1.15]，略超出岸线）

export const T_MIN = -1.15;
export const T_MAX = 1.15;

export interface FlowSample {
  vel: Vec2;       // 世界坐标流速 m/s
  depth: number;   // 水深 m（含天气修正）
  s: number;       // 里程
  t: number;       // 横向 -1..1（超出表示在岸上）
  inRiver: boolean;
}

export interface WeatherState {
  speedMul: number;
  levelMul: number;
}

export class FlowField {
  readonly geo: RiverGeometry;
  // 网格数据（基准天气）
  private velX = new Float32Array(NS * NT);
  private velY = new Float32Array(NS * NT);
  private depth = new Float32Array(NS * NT);
  // 世界坐标 → (s,t) 查找用的均匀网格索引
  private cellSize = 8;
  private gridW = 0;
  private gridH = 0;
  private minX = 0;
  private minY = 0;
  private buckets: Int32Array = new Int32Array(0);
  private bucketStart: Int32Array = new Int32Array(0);
  private bucketCount: Int32Array = new Int32Array(0);

  constructor(geo: RiverGeometry) {
    this.geo = geo;
    this.compute();
    this.buildSpatialIndex();
  }

  /** 基准天气下的流速/水深网格 */
  private compute(): void {
    const { samples, totalLength } = this.geo;
    const def = this.geo.def;
    const n = samples.length - 1;

    // 每块石头的影响范围预先算好（沿程索引）
    interface RockCell { si: number; t: number; r: number; wakeLen: number; }
    const rocks: RockCell[] = def.rocks.map((r: RockDef) => {
      return { si: r.sNorm * (NS - 1), t: r.t, r: r.r, wakeLen: (r.r * 9) / totalLength * (NS - 1) };
    });

    for (let i = 0; i < NS; i++) {
      const sNorm = i / (NS - 1);
      const smp = samples[Math.round(sNorm * n)];
      const halfW = smp.halfWidth;
      const kappa = smp.curvature; // 有符号曲率
      for (let j = 0; j < NT; j++) {
        const t = T_MIN + (T_MAX - T_MIN) * (j / (NT - 1));
        const idx = i * NT + j;

        // --- 水深：基准 × 剖面 × 横向形态 ---
        // 河心深、岸边浅；弯道内侧（κ>0 时 t>0 一侧）淤积变浅，外侧刷深
        const bankFall = 1 - smoothstep(0.75, 1.05, Math.abs(t)) * 0.85;
        const bendDepth = clamp(1 - kappa * t * halfW * 0.55, 0.45, 1.6);
        let d = def.baseDepth * smp.depthScale * bankFall * bendDepth;

        // 浅滩
        for (const sh of def.shoals) {
          if (sNorm >= sh.s0 && sNorm <= sh.s1 && t >= sh.t0 && t <= sh.t1) {
            const edge = smoothstep(sh.s0, sh.s0 + 0.015, sNorm) * (1 - smoothstep(sh.s1 - 0.015, sh.s1, sNorm));
            d *= lerp(1, sh.depthFactor, edge);
          }
        }
        // 礁石露头处视为极浅（篙可以点在石头上）
        for (const rk of rocks) {
          const ds = (i - rk.si) / (NS - 1) * totalLength;
          const dt = (t - rk.t) * halfW;
          const dd = Math.hypot(ds, dt);
          if (dd < rk.r * 1.1) d = Math.min(d, 0.25);
        }
        this.depth[idx] = Math.max(0.02, d);

        // --- 流速 ---
        // 基准 × 水深连续性修正（浅处快一点）× 弯道外侧加速
        const continuity = clamp(Math.pow(def.baseDepth / Math.max(0.15, d), 0.35), 0.7, 1.7);
        const bendSpeed = clamp(1 - kappa * t * halfW * 0.85, 0.3, 1.9);
        const bankSlack = 1 - smoothstep(0.8, 1.1, Math.abs(t)) * 0.7;
        let speed = def.baseSpeed * continuity * bendSpeed * bankSlack;
        let dirX = smp.tangent.x, dirY = smp.tangent.y;

        // 弯道横向环流：外侧水有往内压的分量（螺旋流），简化成小横向速度
        const cross = -kappa * speed * halfW * 0.18 * (1 - Math.abs(t));
        dirX = smp.tangent.x; dirY = smp.tangent.y;
        let vx = dirX * speed + smp.normal.x * cross;
        let vy = dirY * speed + smp.normal.y * cross;

        // --- 礁石尾流：回水 + 旋涡 ---
        for (const rk of rocks) {
          const dsM = (i - rk.si) / (NS - 1) * totalLength; // 下游距离（米，沿程近似）
          const latM = (t - rk.t) * halfW;                  // 横向距离（米）
          if (dsM < -rk.r * 1.5 || dsM > rk.r * 10) continue;
          const wakeW = rk.r * (1.1 + Math.max(0, dsM) * 0.35); // 尾流喇叭口
          const latAbs = Math.abs(latM);
          if (latAbs > wakeW + rk.r) continue;
          const behind = smoothstep(-rk.r, rk.r * 0.5, dsM);
          const decay = 1 - smoothstep(rk.r * 2, rk.r * 9, dsM);
          const latFall = 1 - smoothstep(wakeW * 0.4, wakeW + rk.r * 0.5, latAbs);
          const wake = behind * decay * latFall;
          if (wake <= 0.001) continue;
          // 回流：紧贴石后逆流，向外渐弱
          const reverse = -0.55 * wake * (1 - smoothstep(rk.r * 3, rk.r * 8, dsM));
          vx += smp.tangent.x * speed * reverse;
          vy += smp.tangent.y * speed * reverse;
          // 旋涡：尾流两侧一对旋子，横向来回卷
          const side = latM >= 0 ? 1 : -1;
          const swirl = wake * 0.5 * Math.sin(dsM / (rk.r * 2.2));
          vx += smp.normal.x * swirl * side * speed * 0.4;
          vy += smp.normal.y * swirl * side * speed * 0.4;
        }

        this.velX[idx] = vx;
        this.velY[idx] = vy;
      }
    }
  }

  /** 中心线空间索引：均匀网格桶 */
  private buildSpatialIndex(): void {
    const pts = this.geo.samples;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.pos.x); maxX = Math.max(maxX, p.pos.x);
      minY = Math.min(minY, p.pos.y); maxY = Math.max(maxY, p.pos.y);
    }
    const pad = 40;
    this.minX = minX - pad; this.minY = minY - pad;
    this.gridW = Math.ceil((maxX - minX + 2 * pad) / this.cellSize);
    this.gridH = Math.ceil((maxY - minY + 2 * pad) / this.cellSize);
    const nCells = this.gridW * this.gridH;
    this.bucketCount = new Int32Array(nCells);
    const cellOf = (x: number, y: number) => {
      const cx = clamp(Math.floor((x - this.minX) / this.cellSize), 0, this.gridW - 1);
      const cy = clamp(Math.floor((y - this.minY) / this.cellSize), 0, this.gridH - 1);
      return cy * this.gridW + cx;
    };
    for (const p of pts) this.bucketCount[cellOf(p.pos.x, p.pos.y)]++;
    this.bucketStart = new Int32Array(nCells + 1);
    for (let i = 0; i < nCells; i++) this.bucketStart[i + 1] = this.bucketStart[i] + this.bucketCount[i];
    this.buckets = new Int32Array(pts.length);
    const fill = new Int32Array(nCells);
    for (let i = 0; i < pts.length; i++) {
      const c = cellOf(pts[i].pos.x, pts[i].pos.y);
      this.buckets[this.bucketStart[c] + fill[c]++] = i;
    }
  }

  /** 世界坐标 → 最近中心线里程与横向偏移 */
  worldToST(p: Vec2): { s: number; t: number; idx: number } {
    const cx = clamp(Math.floor((p.x - this.minX) / this.cellSize), 0, this.gridW - 1);
    const cy = clamp(Math.floor((p.y - this.minY) / this.cellSize), 0, this.gridH - 1);
    const pts = this.geo.samples;
    let best = -1, bestD = Infinity;
    // 逐步扩大搜索环
    for (let ring = 0; ring <= 6 && best < 0 || ring <= 1; ring++) {
      for (let yy = Math.max(0, cy - ring); yy <= Math.min(this.gridH - 1, cy + ring); yy++) {
        for (let xx = Math.max(0, cx - ring); xx <= Math.min(this.gridW - 1, cx + ring); xx++) {
          if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy)) !== ring) continue;
          const c = yy * this.gridW + xx;
          for (let k = this.bucketStart[c]; k < this.bucketStart[c + 1]; k++) {
            const i = this.buckets[k];
            const d = (pts[i].pos.x - p.x) ** 2 + (pts[i].pos.y - p.y) ** 2;
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
      if (best >= 0 && bestD < (this.cellSize * (ring + 1)) ** 2) break;
    }
    if (best < 0) { // 兜底：全扫（理论上到不了）
      for (let i = 0; i < pts.length; i++) {
        const d = (pts[i].pos.x - p.x) ** 2 + (pts[i].pos.y - p.y) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    // 在相邻两段上投影取更精确的 s,t
    let sBest = pts[best].s, tBest = 0;
    let bestSegD = Infinity;
    for (const i of [best - 1, best]) {
      if (i < 0 || i >= pts.length - 1) continue;
      const a = pts[i].pos, b = pts[i + 1].pos;
      const abx = b.x - a.x, aby = b.y - a.y;
      const len2 = abx * abx + aby * aby;
      if (len2 < 1e-9) continue;
      const u = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / len2, 0, 1);
      const px = a.x + abx * u, py = a.y + aby * u;
      const d = (p.x - px) ** 2 + (p.y - py) ** 2;
      if (d < bestSegD) {
        bestSegD = d;
        const smp = pts[i];
        const lat = (p.x - px) * smp.normal.x + (p.y - py) * smp.normal.y;
        sBest = smp.s + Math.sqrt(len2) * u;
        tBest = lat / smp.halfWidth;
      }
    }
    return { s: sBest, t: tBest, idx: best };
  }

  /** 查询某世界坐标的水流与水深（含天气修正） */
  sample(p: Vec2, weather: WeatherState, out: FlowSample): FlowSample {
    const st = this.worldToST(p);
    const fx = clamp(st.s / this.geo.totalLength, 0, 1) * (NS - 1);
    const fy = clamp((clamp(st.t, T_MIN, T_MAX) - T_MIN) / (T_MAX - T_MIN), 0, 1) * (NT - 1);
    const x0 = Math.min(NS - 2, Math.floor(fx)), y0 = Math.min(NT - 2, Math.floor(fy));
    const tx = fx - x0, ty = fy - y0;
    const i00 = x0 * NT + y0, i10 = i00 + NT, i01 = i00 + 1, i11 = i00 + NT + 1;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    out.vel.x = (this.velX[i00] * w00 + this.velX[i10] * w10 + this.velX[i01] * w01 + this.velX[i11] * w11) * weather.speedMul;
    out.vel.y = (this.velY[i00] * w00 + this.velY[i10] * w10 + this.velY[i01] * w01 + this.velY[i11] * w11) * weather.speedMul;
    out.depth = (this.depth[i00] * w00 + this.depth[i10] * w10 + this.depth[i01] * w01 + this.depth[i11] * w11) * weather.levelMul;
    out.s = st.s;
    out.t = st.t;
    out.inRiver = Math.abs(st.t) <= 1;
    return out;
  }

  /** 直接按 (s,t) 取基准网格数据（渲染器建纹理用） */
  rawCell(i: number, j: number): { vx: number; vy: number; depth: number } {
    const idx = clamp(i, 0, NS - 1) * NT + clamp(j, 0, NT - 1);
    return { vx: this.velX[idx], vy: this.velY[idx], depth: this.depth[idx] };
  }
}
