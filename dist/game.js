// 一趟放排的运行控制：物理步进、事件统计、到港结算。
// 不依赖 DOM，可在 Node 里无头跑（帧率与正确性测试）。
import { buildRiverGeometry } from './rivers.js';
import { FlowField } from './flowfield.js';
import { Raft } from './raft.js';
import { WeatherTimeline } from './weather.js';
import { PoleController } from './pole.js';
import { v2 } from './math.js';
export class GameRun {
    constructor(def, cfg) {
        this.pole = new PoleController();
        this.rocksWorld = [];
        this.time = 0;
        this.phase = 'running';
        this.stats = { jointsBroken: 0, groundings: 0, stucks: 0, damageEvents: 0 };
        this.dockPos = v2();
        this.dockAngle = 0;
        this.landingTimer = 0;
        this.poleInput = { active: false, force: v2(), point: v2(), overstress: 0 };
        this.events = { jointBroke: [], groundedNow: [], stuckNow: [], damaged: [] };
        /** UI 订阅：断藤、搁浅、卡石时提示 */
        this.onEvent = null;
        const geo = buildRiverGeometry(def);
        this.flow = new FlowField(geo);
        this.raft = new Raft(cfg);
        this.weatherTl = new WeatherTimeline(def.weatherSeed, def.difficulty);
        this.weather = this.weatherTl.current(0);
        this.dockS = geo.totalLength * 0.965;
        // 码头在下游末端
        const n = geo.samples.length - 1;
        const smp = geo.samples[n];
        this.dockPos = { x: smp.pos.x, y: smp.pos.y };
        this.dockAngle = Math.atan2(smp.tangent.y, smp.tangent.x);
        // 礁石世界坐标
        for (const rk of def.rocks) {
            const i = Math.round(rk.sNorm * n);
            const s2 = geo.samples[i];
            this.rocksWorld.push({
                pos: {
                    x: s2.pos.x + s2.normal.x * rk.t * s2.halfWidth,
                    y: s2.pos.y + s2.normal.y * rk.t * s2.halfWidth,
                },
                r: rk.r,
            });
        }
        // 排头起点要给整排留出长度，避免排尾被钳到源头重叠
        const startS = geo.totalLength * 0.02 + cfg.sectionCount * cfg.sectionLength + 6;
        this.raft.place(this.flow, startS);
    }
    step(dt) {
        if (this.phase === 'done')
            return;
        this.time += dt;
        this.weather = this.weatherTl.current(dt);
        this.pole.update(dt, this.raft.head.pos, this.poleInput);
        this.events.jointBroke.length = 0;
        this.events.groundedNow.length = 0;
        this.events.stuckNow.length = 0;
        this.events.damaged.length = 0;
        this.raft.step(dt, this.flow, this.weather, this.poleInput, this.rocksWorld, this.events);
        if (this.events.jointBroke.length) {
            this.stats.jointsBroken += this.events.jointBroke.length;
            for (const j of this.events.jointBroke)
                this.onEvent?.('break', j);
        }
        for (const i of this.events.groundedNow) {
            this.stats.groundings++;
            this.onEvent?.('ground', i);
        }
        for (const i of this.events.stuckNow) {
            this.stats.stucks++;
            this.onEvent?.('stuck', i);
        }
        for (const i of this.events.damaged) {
            this.stats.damageEvents++;
            this.onEvent?.('damage', i);
        }
        // 到港判定
        if (this.phase === 'running' && this.raft.head.s >= this.dockS) {
            this.phase = 'landing';
            this.landingTimer = 40; // 给排尾 40 秒靠岸
        }
        else if (this.phase === 'landing') {
            this.landingTimer -= dt;
            const comp = this.raft.connectedComponent(0);
            let allIn = true;
            for (const i of comp) {
                if (this.raft.sections[i].s < this.dockS) {
                    allIn = false;
                    break;
                }
            }
            if (allIn || this.landingTimer <= 0)
                this.phase = 'done';
        }
    }
    /** 结算：按运到的竹子数量和完好程度 */
    result(def) {
        const dockLine = this.dockS - 2;
        let delivered = 0, condSum = 0;
        for (const sec of this.raft.sections) {
            if (sec.s >= dockLine) {
                delivered++;
                condSum += sec.condition;
            }
        }
        const total = this.raft.sections.length;
        const avgCondition = delivered > 0 ? condSum / delivered : 0;
        const score = Math.round(delivered * def.rewardBase * (0.4 + 0.6 * avgCondition));
        const maxScore = total * def.rewardBase;
        const ratio = maxScore > 0 ? score / maxScore : 0;
        const rating = ratio >= 0.95 ? '老排古佬（满分传奇）' :
            ratio >= 0.8 ? '一把好手' :
                ratio >= 0.6 ? '出师了' :
                    ratio >= 0.4 ? '还得多看水' : '排都喂了鱼';
        return {
            delivered, total, avgCondition,
            lost: total - delivered,
            stats: this.stats,
            score, maxScore, rating,
            timeSec: this.time,
        };
    }
}
//# sourceMappingURL=game.js.map