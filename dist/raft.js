// 竹排物理：一节一节用藤条连起来的长排，位置动力学（PBD）求解。
//  - 每节是带朝向的刚体，关节把相邻节的端点绑在一起
//  - 关节弯折角超过藤条允许范围会累积劳损，超限即断
//  - 吃水 > 水深 → 搁浅（大摩擦）；撞上礁石的那一节会被卡住
//  - 玩家在排头用篙撑，力太大也会把藤条逼断
import { v2, wrapAngle, clamp, len } from './math.js';
const WATER_DRAG = 2.6; // 水对排的拖曳系数
const GROUND_FRICTION = 0.82; // 搁浅时每步速度保留
const STUCK_DAMP = 0.05; // 卡住时每步速度保留
const SOLVER_ITERS = 6;
export class Raft {
    constructor(cfg) {
        this.sections = [];
        this.joints = [];
        this.cfg = cfg;
        this.mass = 60 + cfg.bamboosPerSection * 14;
        this.invM = 1 / this.mass;
        const I = this.mass * cfg.sectionLength * cfg.sectionLength / 12;
        this.invI = 1 / I;
        // 吃水：竹筒越多排越重，吃水越深
        this.draft = 0.28 + cfg.bamboosPerSection * 0.028;
        for (let i = 0; i < cfg.sectionCount; i++) {
            this.sections.push({
                pos: v2(), prevPos: v2(), angle: 0, prevAngle: 0,
                vel: v2(), angVel: 0,
                grounded: false, stuck: false, stuckLevel: 1, stuckTime: 0, stuckImmune: 0,
                condition: 1, depth: 1, s: 0,
            });
        }
        for (let i = 0; i < cfg.sectionCount - 1; i++) {
            this.joints.push({ broken: false, strain: 0 });
        }
    }
    /** 把排沿中心线起点顺流摆开 */
    place(flow, startS) {
        const geo = flow.geo;
        const n = geo.samples.length - 1;
        for (let i = 0; i < this.sections.length; i++) {
            const s = Math.max(0, startS - i * this.cfg.sectionLength);
            const smp = geo.samples[clamp(Math.round(s / geo.totalLength * n), 0, n)];
            const sec = this.sections[i];
            sec.pos.x = smp.pos.x;
            sec.pos.y = smp.pos.y;
            sec.prevPos.x = sec.pos.x;
            sec.prevPos.y = sec.pos.y;
            sec.angle = Math.atan2(smp.tangent.y, smp.tangent.x);
            sec.prevAngle = sec.angle;
            sec.s = s;
        }
    }
    /** 排头节 */
    get head() { return this.sections[0]; }
    /** 每节两端的世界坐标 */
    endPoints(sec, outFront, outBack) {
        const dx = Math.cos(sec.angle) * this.cfg.sectionLength / 2;
        const dy = Math.sin(sec.angle) * this.cfg.sectionLength / 2;
        outFront.x = sec.pos.x + dx;
        outFront.y = sec.pos.y + dy;
        outBack.x = sec.pos.x - dx;
        outBack.y = sec.pos.y - dy;
    }
    step(dt, flow, weather, pole, rockPts, events) {
        const cfg = this.cfg;
        const fs = { vel: v2(), depth: 0, s: 0, t: 0, inRiver: true };
        // --- 1. 积分外力 ---
        for (let i = 0; i < this.sections.length; i++) {
            const sec = this.sections[i];
            flow.sample(sec.pos, weather, fs);
            sec.depth = fs.depth;
            sec.s = fs.s;
            const wasGrounded = sec.grounded;
            sec.grounded = this.draft > fs.depth && fs.inRiver;
            if (sec.grounded && !wasGrounded) {
                events.groundedNow.push(i);
                sec.condition = Math.max(0.2, sec.condition - 0.04); // 搁浅擦底，轻伤
            }
            // 水拖曳：排被水带着走；搁浅时水推力减小
            const dragK = sec.grounded ? WATER_DRAG * 0.35 : WATER_DRAG;
            sec.vel.x += (fs.vel.x - sec.vel.x) * dragK * dt;
            sec.vel.y += (fs.vel.y - sec.vel.y) * dragK * dt;
            // 水流对长条的转向作用：让节的方向顺当地水流（简化：向流速方向缓慢对齐）
            const flowAng = Math.atan2(fs.vel.y, fs.vel.x);
            if (len(fs.vel) > 0.05) {
                const align = wrapAngle(flowAng - sec.angle);
                sec.angVel += align * 0.55 * dt;
            }
            // 篙力只作用在排头
            if (i === 0 && pole.active) {
                sec.vel.x += pole.force.x * this.invM * dt;
                sec.vel.y += pole.force.y * this.invM * dt;
                // 篙点在侧前方时产生转矩
                const rx = pole.point.x - sec.pos.x, ry = pole.point.y - sec.pos.y;
                const torque = (rx * pole.force.y - ry * pole.force.x) * this.invI * dt * 0.15;
                sec.angVel += torque;
            }
            // 状态阻尼
            if (sec.stuckImmune > 0)
                sec.stuckImmune -= dt;
            if (sec.stuck) {
                // 卡住：极大阻尼；涨水能浮起来，颠簸久了也能挣脱
                sec.stuckTime += dt;
                if (weather.levelMul > sec.stuckLevel * 1.08 || sec.stuckTime > 18) {
                    sec.stuck = false;
                    sec.stuckImmune = 4;
                    // 挣脱时顺势往下游攒一把，免得又压回同一块石头
                    sec.vel.x += fs.vel.x * 0.8;
                    sec.vel.y += fs.vel.y * 0.8;
                }
                else {
                    sec.vel.x *= STUCK_DAMP;
                    sec.vel.y *= STUCK_DAMP;
                    sec.angVel *= STUCK_DAMP;
                }
            }
            else {
                sec.stuckTime = 0;
                if (sec.grounded) {
                    sec.vel.x *= GROUND_FRICTION;
                    sec.vel.y *= GROUND_FRICTION;
                    sec.angVel *= GROUND_FRICTION;
                }
            }
            // 角阻尼
            sec.angVel *= 0.92;
            // 预测位置
            sec.prevPos.x = sec.pos.x;
            sec.prevPos.y = sec.pos.y;
            sec.prevAngle = sec.angle;
            sec.pos.x += sec.vel.x * dt;
            sec.pos.y += sec.vel.y * dt;
            sec.angle = wrapAngle(sec.angle + sec.angVel * dt);
        }
        // 藤条回弹：关节本身抗弯，把相邻节往顺直方向拉
        for (let j = 0; j < this.joints.length; j++) {
            const joint = this.joints[j];
            if (joint.broken)
                continue;
            const a = this.sections[j], b = this.sections[j + 1];
            const diff = wrapAngle(b.angle - a.angle);
            const torque = diff * 2.8 * dt;
            a.angVel += torque;
            b.angVel -= torque;
        }
        // 篙撑太猛，排头几个关节的藤条受累
        if (pole.active && pole.overstress > 0) {
            for (let j = 0; j < Math.min(3, this.joints.length); j++) {
                const joint = this.joints[j];
                if (!joint.broken)
                    joint.strain += pole.overstress * dt * (1 - j * 0.25) * 0.9;
            }
        }
        // --- 1.5 断裂判定（约束求解之前）：看动力学把关节掰到了什么程度 ---
        // 求解器会把弯折钳回藤条允许范围，所以必须在钳制之前量。
        for (let j = 0; j < this.joints.length; j++) {
            const joint = this.joints[j];
            if (joint.broken)
                continue;
            const a = this.sections[j], b = this.sections[j + 1];
            const diff = Math.abs(wrapAngle(b.angle - a.angle));
            if (diff > cfg.rattanBreakBend) {
                joint.broken = true; // 一下折死，直接崩断
                events.jointBroke.push(j);
                continue;
            }
            if (diff > cfg.rattanMaxBend) {
                // 被掰到允许范围之外：藤条开始受累，超得越多伤得越快
                joint.strain += (diff / cfg.rattanMaxBend - 1) * dt * 3.0;
            }
            else {
                joint.strain = Math.max(0, joint.strain - dt * 0.15); // 缓一缓能恢复
            }
            if (joint.strain > cfg.rattanStrainLimit) {
                joint.broken = true;
                events.jointBroke.push(j);
            }
        }
        // --- 2. 约束求解 ---
        const front = v2(), back = v2();
        for (let iter = 0; iter < SOLVER_ITERS; iter++) {
            // 关节：相邻节端点重合
            for (let j = 0; j < this.joints.length; j++) {
                const joint = this.joints[j];
                if (joint.broken)
                    continue;
                const a = this.sections[j], b = this.sections[j + 1];
                const hl = cfg.sectionLength / 2;
                const rax = -Math.cos(a.angle) * hl, ray = -Math.sin(a.angle) * hl;
                const rbx = Math.cos(b.angle) * hl, rby = Math.sin(b.angle) * hl;
                const p1x = a.pos.x + rax, p1y = a.pos.y + ray;
                const p2x = b.pos.x + rbx, p2y = b.pos.y + rby;
                const dx = p1x - p2x, dy = p1y - p2y;
                const C = Math.hypot(dx, dy);
                if (C < 1e-6)
                    continue;
                const nx = dx / C, ny = dy / C;
                const wA = this.invM + this.invI * (rax * ny - ray * nx) ** 2;
                const wB = this.invM + this.invI * (rbx * ny - rby * nx) ** 2;
                const lambda = C / (wA + wB);
                const corrX = nx * lambda, corrY = ny * lambda;
                a.pos.x -= corrX * this.invM;
                a.pos.y -= corrY * this.invM;
                b.pos.x += corrX * this.invM;
                b.pos.y += corrY * this.invM;
                a.angle = wrapAngle(a.angle - this.invI * (rax * corrY - ray * corrX));
                b.angle = wrapAngle(b.angle + this.invI * (rbx * corrY - rby * corrX));
            }
            // 岸线约束：不许上岸
            for (let i = 0; i < this.sections.length; i++) {
                const sec = this.sections[i];
                flow.sample(sec.pos, weather, fs);
                if (Math.abs(fs.t) > 0.97) {
                    const smp = flow.geo.samples[clamp(Math.round(fs.s / flow.geo.totalLength * (flow.geo.samples.length - 1)), 0, flow.geo.samples.length - 1)];
                    const push = (Math.abs(fs.t) - 0.97) * smp.halfWidth * 0.5 * Math.sign(fs.t);
                    sec.pos.x -= smp.normal.x * push;
                    sec.pos.y -= smp.normal.y * push;
                }
            }
            // 礁石碰撞：把节推出石头，并顺水流给一点滑移（水流会把排沿石面带开）
            for (let i = 0; i < this.sections.length; i++) {
                const sec = this.sections[i];
                this.endPoints(sec, front, back);
                for (const rk of rockPts) {
                    let touched = false;
                    let pushX = 0, pushY = 0;
                    for (const p of [sec.pos, front, back]) {
                        const dx = p.x - rk.pos.x, dy = p.y - rk.pos.y;
                        const d = Math.hypot(dx, dy);
                        const minD = rk.r + 0.7;
                        if (d < minD && d > 1e-6) {
                            const push = (minD - d);
                            pushX += (dx / d) * push;
                            pushY += (dy / d) * push;
                            touched = true;
                        }
                    }
                    if (touched) {
                        sec.pos.x += pushX * 0.8;
                        sec.pos.y += pushY * 0.8;
                        flow.sample(sec.pos, weather, fs);
                        const fl = Math.hypot(fs.vel.x, fs.vel.y);
                        if (fl > 0.05) {
                            const slide = Math.hypot(pushX, pushY) * 0.6;
                            sec.pos.x += (fs.vel.x / fl) * slide;
                            sec.pos.y += (fs.vel.y / fl) * slide;
                        }
                    }
                }
            }
            // 弯折限位放在最后：藤条能弯一点，但不能折死
            for (let j = 0; j < this.joints.length; j++) {
                const joint = this.joints[j];
                if (joint.broken)
                    continue;
                const a = this.sections[j], b = this.sections[j + 1];
                const diff = wrapAngle(b.angle - a.angle);
                if (Math.abs(diff) > cfg.rattanMaxBend) {
                    const excess = (Math.abs(diff) - cfg.rattanMaxBend) * Math.sign(diff);
                    a.angle = wrapAngle(a.angle + excess * 0.5);
                    b.angle = wrapAngle(b.angle - excess * 0.5);
                }
            }
        }
        // --- 3. 撞击 / 卡住 / 受损判定（用约束前的速度） ---
        for (let i = 0; i < this.sections.length; i++) {
            const sec = this.sections[i];
            const speed = len(sec.vel);
            this.endPoints(sec, front, back);
            for (const rk of rockPts) {
                for (const p of [sec.pos, front, back]) {
                    const d = Math.hypot(p.x - rk.pos.x, p.y - rk.pos.y);
                    if (d < rk.r + 0.9) {
                        if (!sec.stuck && sec.stuckImmune <= 0 && speed > 1.7) {
                            sec.stuck = true;
                            sec.stuckLevel = weather.levelMul;
                            events.stuckNow.push(i);
                        }
                        if (speed > 2.0) {
                            sec.condition = Math.max(0.1, sec.condition - 0.12);
                            events.damaged.push(i);
                        }
                    }
                }
            }
        }
        // --- 4. （断裂判定已移至约束求解前，见 1.5） ---
        // --- 5. 由位置更新速度 ---
        const invDt = 1 / dt;
        for (const sec of this.sections) {
            sec.vel.x = (sec.pos.x - sec.prevPos.x) * invDt;
            sec.vel.y = (sec.pos.y - sec.prevPos.y) * invDt;
            sec.angVel = wrapAngle(sec.angle - sec.prevAngle) * invDt;
        }
    }
    /** 与排头相连的连通块（用于结算：只有连着或漂到码头的节算运到） */
    connectedComponent(fromIndex) {
        const seen = new Set([fromIndex]);
        const queue = [fromIndex];
        while (queue.length) {
            const i = queue.pop();
            for (const j of [i - 1, i]) {
                if (j >= 0 && j < this.joints.length && !this.joints[j].broken) {
                    const nb = j === i ? i + 1 : j;
                    if (!seen.has(nb)) {
                        seen.add(nb);
                        queue.push(nb);
                    }
                }
            }
        }
        return seen;
    }
}
/** 由编组参数生成配置 */
export function makeRaftConfig(sections, bamboos, rattan) {
    const old = rattan === 'old';
    return {
        sectionCount: sections,
        sectionLength: 2.4,
        bamboosPerSection: bamboos,
        rattanMaxBend: old ? 0.52 : 0.36, // 老藤柔韧，新藤脆
        rattanBreakBend: old ? 0.95 : 0.7,
        rattanStrainLimit: old ? 1.6 : 1.0,
    };
}
//# sourceMappingURL=raft.js.map