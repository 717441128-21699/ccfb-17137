import type {
  GameEvent,
  JointState,
  RaftConfig,
  SectionState,
  Vec2,
} from './types';
import { WaterModel } from './flow';
import { clamp, DEG, normalize } from './math';

interface DistanceConstraint {
  a: number;
  b: number;
  rest: number;
  stiffness: number;
  kind: 'section' | 'vine' | 'bend';
  joint?: number;
}

export interface Splash {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

export interface PolePlan {
  origin: Vec2;
  target: Vec2;
  valid: boolean;
  depth: number;
  reach: number;
}

const SECTION_LENGTH = 1.55;
const VINE_GAP = 0.24;
const POLE_REACH = 6.2;
const POLE_MAX_DEPTH = 5.4;
const FIXED_STEP = 1 / 60;

export class RaftSimulation {
  readonly water: WaterModel;
  readonly config: RaftConfig;
  readonly nodeCount: number;
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  readonly sections: SectionState[] = [];
  readonly joints: JointState[] = [];
  readonly constraints: DistanceConstraint[] = [];
  readonly splashes: Splash[] = [];
  readonly events: GameEvent[] = [];

  time = 0;
  headS = 0;
  headSpeed = 0;
  maxObservedFps = 60;
  breaks = 0;
  rockHits = 0;
  groundings = 0;
  totalDamage = 0;
  private eventSeq = 1;
  private accumulator = 0;
  private hitCooldown: Float64Array;
  private contactNX: Float64Array;
  private contactNY: Float64Array;
  private wasGrounded: boolean[] = [];

  aim: Vec2 = { x: 0, y: 0 };
  chargeHeld = false;
  charge = 0;
  pushHeld = false;
  poleCooldown = 0;
  poleAnim = 0;
  lastPole: PolePlan | null = null;
  polePower = 0;

  constructor(water: WaterModel, config: RaftConfig, startS = 82) {
    this.water = water;
    this.config = config;
    this.nodeCount = config.sections * 2;
    this.x = new Float64Array(this.nodeCount);
    this.y = new Float64Array(this.nodeCount);
    this.vx = new Float64Array(this.nodeCount);
    this.vy = new Float64Array(this.nodeCount);
    this.hitCooldown = new Float64Array(config.sections);
    this.contactNX = new Float64Array(config.sections);
    this.contactNY = new Float64Array(config.sections);

    const spacing = SECTION_LENGTH + VINE_GAP;
    for (let i = 0; i < config.sections; i++) {
      const frontS = startS - i * spacing;
      const rearS = frontS - SECTION_LENGTH;
      const front = water.path.positionAt(frontS, 0);
      const rear = water.path.positionAt(rearS, 0);
      const a = i * 2;
      const b = a + 1;
      this.x[a] = front.x;
      this.y[a] = front.y;
      this.x[b] = rear.x;
      this.y[b] = rear.y;

      const flow = water.sampleSL((frontS + rearS) / 2, 0, 0).velocity;
      this.vx[a] = flow.x * 0.8;
      this.vy[a] = flow.y * 0.8;
      this.vx[b] = flow.x * 0.8;
      this.vy[b] = flow.y * 0.8;

      this.sections.push({
        index: i,
        a,
        b,
        angle: 0,
        bend: 0,
        hp: 100,
        maxHp: 100,
        grounded: 0,
        stuckTimer: 0,
        impact: 0,
        delivered: false,
        lost: false,
      });
      this.wasGrounded.push(false);

      this.constraints.push({ a, b, rest: SECTION_LENGTH, stiffness: 1, kind: 'section' });
      if (i < config.sections - 1) {
        const nextFront = (i + 1) * 2;
        this.constraints.push({
          a: b,
          b: nextFront,
          rest: VINE_GAP,
          stiffness: 0.82,
          kind: 'vine',
          joint: i,
        });
        this.constraints.push({
          a,
          b: nextFront + 1,
          rest: SECTION_LENGTH * 2 + VINE_GAP,
          stiffness: config.vineStiffness,
          kind: 'bend',
          joint: i,
        });
        this.joints.push({ index: i, active: true, angle: 0, stress: 0 });
      }
    }
    this.updateGeometry();
    this.aim = { ...this.headCenter() };
  }

  drainEvents(): GameEvent[] {
    const out = this.events.splice(0, this.events.length);
    return out;
  }

  private emit(kind: GameEvent['kind'], text: string, section?: number, severity?: number) {
    this.events.push({ id: this.eventSeq++, time: this.time, kind, text, section, severity });
    if (this.events.length > 30) this.events.shift();
  }

  headCenter(): Vec2 {
    const a = 0;
    const b = 1;
    return { x: (this.x[a] + this.x[b]) * 0.5, y: (this.y[a] + this.y[b]) * 0.5 };
  }

  sectionCenter(i: number): Vec2 {
    const s = this.sections[i];
    return { x: (this.x[s.a] + this.x[s.b]) * 0.5, y: (this.y[s.a] + this.y[s.b]) * 0.5 };
  }

  halfWidth(): number {
    return 0.62 + this.config.bamboosPerSection * 0.055;
  }

  planPole(target: Vec2): PolePlan {
    const origin = this.headCenter();
    let dx = target.x - origin.x;
    let dy = target.y - origin.y;
    let d = Math.hypot(dx, dy);
    const reach = POLE_REACH;
    if (d > reach && d > 1e-6) {
      dx = (dx / d) * reach;
      dy = (dy / d) * reach;
      d = reach;
    }
    const q = { x: origin.x + dx, y: origin.y + dy };
    const sample = this.water.sample(q, this.time);
    return { origin, target: q, valid: sample.depth <= POLE_MAX_DEPTH && d > 0.4, depth: sample.depth, reach };
  }

  pressCharge(target?: Vec2) {
    if (this.poleCooldown > 0) return;
    this.chargeHeld = true;
    if (target) this.aim = target;
  }

  releasePole(target?: Vec2, powerOverride?: number): boolean {
    if (target) this.aim = target;
    const power = clamp(powerOverride ?? this.charge, 0.12, 1);
    this.chargeHeld = false;
    this.charge = 0;
    if (this.poleCooldown > 0.05) return false;

    const plan = this.planPole(this.aim);
    this.lastPole = plan;
    this.polePower = power;
    this.poleAnim = 1;
    this.poleCooldown = 0.52;

    if (!plan.valid) {
      this.emit('pole-miss', plan.depth > POLE_MAX_DEPTH ? '这里水太深，竹篙点不到河底！' : '篙点太近，使不上劲。');
      this.addSplash(plan.target.x, plan.target.y, 4, '#d8f6ff');
      return false;
    }

    const dir = normalize({ x: plan.origin.x - plan.target.x, y: plan.origin.y - plan.target.y });
    const impulse = 2.2 + power * 7.4;
    // Front node receives more load, so a side plant also turns the head section.
    this.vx[0] += dir.x * impulse * 0.72;
    this.vy[0] += dir.y * impulse * 0.72;
    this.vx[1] += dir.x * impulse * 0.34;
    this.vy[1] += dir.y * impulse * 0.34;
    this.addSplash(plan.target.x, plan.target.y, 5 + power * 8, '#e8fbff');
    if (power > 0.88) {
      this.emit('info', '这一篙撑得太猛，藤条发出刺耳的绷紧声！', 0, power);
    }
    return true;
  }

  setPush(held: boolean) {
    this.pushHeld = held;
  }

  update(frameDt: number) {
    const dt = Math.min(frameDt, 0.05);
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < 4) {
      this.step(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    if (steps === 4) this.accumulator = 0;
  }

  private step(dt: number) {
    this.time += dt;
    this.poleCooldown = Math.max(0, this.poleCooldown - dt);
    this.poleAnim = Math.max(0, this.poleAnim - dt * 2.8);
    if (this.chargeHeld && this.poleCooldown <= 0) this.charge = clamp(this.charge + dt / 0.82, 0, 1);

    for (let i = 0; i < this.sections.length; i++) {
      const s = this.sections[i];
      s.stuckTimer = Math.max(0, s.stuckTimer - dt);
      s.impact = Math.max(0, s.impact - dt * 2.4);
      this.hitCooldown[i] = Math.max(0, this.hitCooldown[i] - dt);
      const c = this.sectionCenter(i);
      const sample = this.water.sample(c, this.time);
      s.grounded = Math.max(0, this.config.draft - sample.depth);
      if (s.grounded > 0.08 && !this.wasGrounded[i]) {
        this.groundings++;
        if (i < 8 || this.groundings <= 3) {
          this.emit('ground', `第 ${i + 1} 节擦到浅滩，吃水 ${this.config.draft.toFixed(2)}m / 水深 ${sample.depth.toFixed(2)}m`, i);
        }
      }
      this.wasGrounded[i] = s.grounded > 0.08;
    }

    for (let n = 0; n < this.nodeCount; n++) {
      const secIndex = Math.floor(n / 2);
      const sec = this.sections[secIndex];
      const flow = this.water.sample({ x: this.x[n], y: this.y[n] }, this.time).velocity;
      const blend = 1 - Math.exp(-1.85 * dt);
      this.vx[n] += (flow.x - this.vx[n]) * blend;
      this.vy[n] += (flow.y - this.vy[n]) * blend;

      if (sec.stuckTimer > 0) {
        const d = Math.exp(-(this.pushHeld ? 3.2 : 7.2) * dt);
        this.vx[n] *= d;
        this.vy[n] *= d;
      }

      if (sec.grounded > 0.02) {
        const g = clamp(sec.grounded / 0.42, 0, 1);
        const pushing = this.pushHeld;
        const rate = pushing ? 1.8 + 3.2 * g : 3.5 + 15 * g;
        const d = Math.exp(-rate * dt);
        this.vx[n] *= d;
        this.vy[n] *= d;

        if (pushing) {
          const c = this.sectionCenter(secIndex);
          const pr = this.water.path.project(c);
          const towardCentre = pr.lateral > 0 ? -1 : 1;
          const dir = normalize({
            x: pr.frame.tangent.x * 1.15 + pr.frame.normal.x * 0.75 * towardCentre,
            y: pr.frame.tangent.y * 1.15 + pr.frame.normal.y * 0.75 * towardCentre,
          });
          this.vx[n] += dir.x * 8.5 * dt;
          this.vy[n] += dir.y * 8.5 * dt;
        }
      }

      if (this.pushHeld && sec.stuckTimer > 0.05) {
        const nx = this.contactNX[secIndex];
        const ny = this.contactNY[secIndex];
        const nl = Math.hypot(nx, ny);
        if (nl > 0.1) {
          // Crew shoulder the rattan and lever the caught section off the rock.
          this.vx[n] += (nx / nl) * 11.5 * dt;
          this.vy[n] += (ny / nl) * 11.5 * dt;
        }
      }

      // Soft safety speed cap.
      const sp = Math.hypot(this.vx[n], this.vy[n]);
      const maxSpeed = 13;
      if (sp > maxSpeed) {
        this.vx[n] *= maxSpeed / sp;
        this.vy[n] *= maxSpeed / sp;
      }

      this.x[n] += this.vx[n] * dt;
      this.y[n] += this.vy[n] * dt;
    }

    const iterations = 12;
    for (let it = 0; it < iterations; it++) {
      this.solveDistances();
      this.solveBanks();
      this.solveEndBarrier();
      this.solveRocks(it === 0);
    }

    this.updateGeometry();
    this.checkBreaks();
    this.updateDelivery();
    this.updateSplashes(dt);

    const head = this.headCenter();
    const hs = this.water.path.project(head);
    this.headS = hs.s;
    this.headSpeed = Math.hypot((this.vx[0] + this.vx[1]) * 0.5, (this.vy[0] + this.vy[1]) * 0.5);
  }

  private solveDistances() {
    for (const c of this.constraints) {
      if ((c.kind === 'vine' || c.kind === 'bend') && c.joint !== undefined && !this.joints[c.joint].active) continue;
      const dx = this.x[c.b] - this.x[c.a];
      const dy = this.y[c.b] - this.y[c.a];
      const d = Math.hypot(dx, dy) || 1e-6;
      const diff = ((d - c.rest) / d) * c.stiffness;
      const ox = dx * diff * 0.5;
      const oy = dy * diff * 0.5;
      this.x[c.a] += ox;
      this.y[c.a] += oy;
      this.x[c.b] -= ox;
      this.y[c.b] -= oy;
    }
  }

  private solveBanks() {
    for (let i = 0; i < this.sections.length; i++) {
      const sec = this.sections[i];
      const hw = this.halfWidth() * 0.35; // endpoint constraint; segment capsule adds rock width
      for (const n of [sec.a, sec.b]) {
        const pr = this.water.path.project({ x: this.x[n], y: this.y[n] });
        const limit = pr.frame.width * 0.5 - hw;
        if (Math.abs(pr.lateral) > limit) {
          const sign = Math.sign(pr.lateral);
          const target = this.water.path.positionAt(pr.s, sign * limit);
          const pushX = target.x - this.x[n];
          const pushY = target.y - this.y[n];
          this.x[n] += pushX * 0.7;
          this.y[n] += pushY * 0.7;
          const vn = this.vx[n] * pr.frame.normal.x * sign + this.vy[n] * pr.frame.normal.y * sign;
          if (vn > 0) {
            this.vx[n] -= pr.frame.normal.x * sign * vn * 1.25;
            this.vy[n] -= pr.frame.normal.y * sign * vn * 1.25;
          }
        }
      }
    }
  }

  private solveEndBarrier() {
    const limit = this.water.path.length - 4;
    for (let n = 0; n < this.nodeCount; n++) {
      const pr = this.water.path.project({ x: this.x[n], y: this.y[n] });
      if (pr.s > limit) {
        const target = this.water.path.positionAt(limit, pr.lateral);
        this.x[n] += (target.x - this.x[n]) * 0.65;
        this.y[n] += (target.y - this.y[n]) * 0.65;
        const vn = this.vx[n] * pr.frame.tangent.x + this.vy[n] * pr.frame.tangent.y;
        if (vn > 0) {
          this.vx[n] -= pr.frame.tangent.x * vn * 1.2;
          this.vy[n] -= pr.frame.tangent.y * vn * 1.2;
        }
      }
    }
  }

  private solveRocks(velocityResponse: boolean) {
    const hw = this.halfWidth();
    for (const sec of this.sections) {
      const ax = this.x[sec.a];
      const ay = this.y[sec.a];
      const bx = this.x[sec.b];
      const by = this.y[sec.b];
      const abx = bx - ax;
      const aby = by - ay;
      const len2 = abx * abx + aby * aby || 1e-6;

      for (const rock of this.water.stream.rocks) {
        const rp = this.water.path.positionAt(rock.s, rock.lateral);
        let t = ((rp.x - ax) * abx + (rp.y - ay) * aby) / len2;
        t = clamp(t, 0, 1);
        const qx = ax + abx * t;
        const qy = ay + aby * t;
        let dx = qx - rp.x;
        let dy = qy - rp.y;
        let d = Math.hypot(dx, dy);
        const minD = rock.radius + hw * 0.82;
        if (d >= minD) continue;

        let nx: number;
        let ny: number;
        if (d > 1e-5) {
          nx = dx / d;
          ny = dy / d;
        } else {
          const f = this.water.path.frameAt(rock.s);
          nx = f.normal.x;
          ny = f.normal.y;
          d = 0;
        }
        const pen = minD - d;
        const wa = 1 - t;
        const wb = t;
        const contactMass = Math.max(0.25, wa * wa + wb * wb);
        const posLambda = pen / contactMass;
        this.x[sec.a] += nx * posLambda * wa;
        this.y[sec.a] += ny * posLambda * wa;
        this.x[sec.b] += nx * posLambda * wb;
        this.y[sec.b] += ny * posLambda * wb;
        this.contactNX[sec.index] = nx;
        this.contactNY[sec.index] = ny;

        if (velocityResponse) {
          const cvx = this.vx[sec.a] * wa + this.vx[sec.b] * wb;
          const cvy = this.vy[sec.a] * wa + this.vy[sec.b] * wb;
          const vn = cvx * nx + cvy * ny;
          if (vn < 0.05) {
            const tx = -ny;
            const ty = nx;
            const vt = cvx * tx + cvy * ty;
            const impact = Math.max(0, -vn);
            const restitution = 0.12;
            const grip = impact > 0.8 ? 0.16 : 0.42;
            const newVn = -vn * restitution;
            const newVt = vt * grip;
            const nvx = nx * newVn + tx * newVt;
            const nvy = ny * newVn + ty * newVt;
            const deltaX = nvx - cvx;
            const deltaY = nvy - cvy;
            const impulseLambda = 1 / contactMass;
            this.vx[sec.a] += deltaX * wa * impulseLambda;
            this.vy[sec.a] += deltaY * wa * impulseLambda;
            this.vx[sec.b] += deltaX * wb * impulseLambda;
            this.vy[sec.b] += deltaY * wb * impulseLambda;

            if (impact > 0.55) {
              sec.stuckTimer = Math.max(sec.stuckTimer, clamp(0.28 + impact * 0.16, 0.35, 1.15));
            }
            if (impact > 0.75 && this.hitCooldown[sec.index] <= 0) {
              this.hitCooldown[sec.index] = 0.85;
              const damage = Math.min(34, 3.5 + impact * 4.8);
              sec.hp = Math.max(0, sec.hp - damage);
              this.totalDamage += damage;
              sec.impact = 1;
              this.rockHits++;
              this.spawnRockSplash(qx, qy, impact);
              this.emit(
                'rock',
                `第 ${sec.index + 1} 节撞上${rock.name ?? '礁石'}！${impact > 3.2 ? '后排藤条被挤得猛弯。' : '这一节被卡住了。'}`,
                sec.index,
                impact,
              );
            }
          }
        }
      }
    }
  }

  private updateGeometry() {
    for (let i = 0; i < this.sections.length; i++) {
      const sec = this.sections[i];
      const dx = this.x[sec.b] - this.x[sec.a];
      const dy = this.y[sec.b] - this.y[sec.a];
      sec.angle = Math.atan2(dy, dx);
      if (i < this.joints.length) {
        let delta = this.sections[i + 1].angle - sec.angle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        sec.bend = delta / DEG;
        const joint = this.joints[i];
        joint.angle = Math.abs(sec.bend);
        joint.stress = clamp(joint.angle / this.config.maxBendDeg, 0, 1.4);
      }
    }
  }

  private checkBreaks() {
    const limit = this.config.maxBendDeg;
    for (const joint of this.joints) {
      if (!joint.active) continue;
      if (joint.angle > limit) {
        joint.active = false;
        this.breaks++;
        const at = this.sectionCenter(joint.index);
        this.addSplash(at.x, at.y, 14, '#b8844a');
        this.emit(
          'break',
          `第 ${joint.index + 1} 道藤条弯折到 ${joint.angle.toFixed(1)}°，超过 ${limit}° 上限，崩断了！`,
          joint.index,
          joint.angle,
        );
      }
    }
  }

  private updateDelivery() {
    for (const sec of this.sections) {
      if (sec.delivered) continue;
      const rear = { x: this.x[sec.b], y: this.y[sec.b] };
      const pr = this.water.path.project(rear);
      if (pr.s >= this.water.path.dockS) sec.delivered = true;
    }
  }

  private spawnRockSplash(x: number, y: number, impact: number) {
    const count = Math.floor(clamp(6 + impact * 4, 8, 26));
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + impact;
      const sp = 1.2 + ((i * 17 + Math.floor(impact * 10)) % 10) * 0.22 + impact * 0.25;
      this.splashes.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.55 + (i % 5) * 0.08,
        maxLife: 0.95,
        size: 0.18 + (i % 4) * 0.08,
        color: i % 3 === 0 ? '#ffffff' : '#bfefff',
      });
    }
    if (this.splashes.length > 420) this.splashes.splice(0, this.splashes.length - 420);
  }

  addSplash(x: number, y: number, count: number, color = '#dff8ff') {
    for (let i = 0; i < count; i++) {
      const a = (i / Math.max(1, count)) * Math.PI * 2;
      const sp = 0.5 + (i % 5) * 0.22;
      this.splashes.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.45 + (i % 4) * 0.08,
        maxLife: 0.75,
        size: 0.12 + (i % 3) * 0.07,
        color,
      });
    }
  }

  private updateSplashes(dt: number) {
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const p = this.splashes[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.splashes.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.exp(-2.2 * dt);
      p.vy *= Math.exp(-2.2 * dt);
    }
  }

  deliveredCount(): number {
    return this.sections.filter((s) => s.delivered).length;
  }

  averageHp(): number {
    return this.sections.reduce((a, s) => a + s.hp, 0) / this.sections.length;
  }
}
