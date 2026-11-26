// 河道定义与几何：中心线样条、宽度/水深剖面、礁石、浅滩。
// 三条山溪为虚构地形：青竹溪（入门）、响水峡（中等）、落雁滩（险）。
import { v2, sub, norm, perp, len, mulberry32, clamp, lerp } from './math.js';
/** Catmull-Rom 样条插值 */
function catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return {
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    };
}
function profileAt(profile, sNorm) {
    if (sNorm <= profile[0][0])
        return profile[0][1];
    for (let i = 1; i < profile.length; i++) {
        if (sNorm <= profile[i][0]) {
            const [s0, v0] = profile[i - 1];
            const [s1, v1] = profile[i];
            return lerp(v0, v1, (sNorm - s0) / Math.max(1e-6, s1 - s0));
        }
    }
    return profile[profile.length - 1][1];
}
export function buildRiverGeometry(def, step = 2) {
    const cps = def.controlPoints;
    // 先过采样样条
    const dense = [];
    const SEG = 48;
    for (let i = 0; i < cps.length - 1; i++) {
        const p0 = cps[Math.max(0, i - 1)], p1 = cps[i], p2 = cps[i + 1], p3 = cps[Math.min(cps.length - 1, i + 2)];
        for (let j = 0; j < SEG; j++)
            dense.push(catmullRom(p0, p1, p2, p3, j / SEG));
    }
    dense.push(cps[cps.length - 1]);
    // 计算累计长度并等距重采样
    const cum = [0];
    for (let i = 1; i < dense.length; i++)
        cum.push(cum[i - 1] + len(sub(dense[i], dense[i - 1])));
    const totalLength = cum[cum.length - 1];
    const n = Math.max(64, Math.round(totalLength / step));
    const actualStep = totalLength / n;
    const samples = [];
    let cursor = 0;
    const posAt = (s) => {
        while (cursor < cum.length - 2 && cum[cursor + 1] < s)
            cursor++;
        const t = (s - cum[cursor]) / Math.max(1e-6, cum[cursor + 1] - cum[cursor]);
        return { x: lerp(dense[cursor].x, dense[cursor + 1].x, t), y: lerp(dense[cursor].y, dense[cursor + 1].y, t) };
    };
    for (let i = 0; i <= n; i++) {
        const s = i * actualStep;
        const pos = posAt(s);
        samples.push({ pos, tangent: v2(1, 0), normal: v2(0, 1), curvature: 0, halfWidth: 10, depthScale: 1, s });
    }
    // 切线 / 法线
    for (let i = 0; i <= n; i++) {
        const a = samples[Math.max(0, i - 1)].pos, b = samples[Math.min(n, i + 1)].pos;
        const tg = norm(sub(b, a));
        samples[i].tangent = tg;
        samples[i].normal = perp(tg);
    }
    // 曲率（用相邻切线夹角 / 弧长），并做一点平滑
    const kRaw = new Array(n + 1).fill(0);
    for (let i = 1; i < n; i++) {
        const t0 = samples[i - 1].tangent, t1 = samples[i + 1].tangent;
        const cross = t0.x * t1.y - t0.y * t1.x;
        const dotp = t0.x * t1.x + t0.y * t1.y;
        kRaw[i] = Math.atan2(cross, dotp) / (2 * actualStep);
    }
    for (let pass = 0; pass < 3; pass++) {
        for (let i = 1; i < n; i++)
            kRaw[i] = (kRaw[i - 1] + 2 * kRaw[i] + kRaw[i + 1]) / 4;
    }
    for (let i = 0; i <= n; i++) {
        const sNorm = i / n;
        samples[i].curvature = kRaw[i];
        samples[i].halfWidth = profileAt(def.widthProfile, sNorm);
        samples[i].depthScale = profileAt(def.depthProfile, sNorm);
    }
    return { def, samples, step: actualStep, totalLength };
}
// ---------------------------------------------------------------------------
// 三条虚构山溪
// ---------------------------------------------------------------------------
/** 河道整体缩放（控制单趟时长在展馆可接受的几分钟内） */
const sc = (pts, k) => pts.map(p => v2(p.x * k, p.y * k));
function makeRocks(seed, list) {
    // 加一点确定性抖动，避免石头排在死板的位置上
    const rnd = mulberry32(seed);
    return list.map(([s, t, r]) => ({
        sNorm: clamp(s + (rnd() - 0.5) * 0.004, 0.02, 0.98),
        t: clamp(t + (rnd() - 0.5) * 0.06, -0.9, 0.9),
        r,
    }));
}
export const RIVERS = [
    {
        id: 'qingzhu',
        name: '青竹溪',
        subtitle: '山前缓水 · 入门河道',
        description: '溪面开阔，弯道平缓，只有零星几块卧牛石。老排工说，新手先在这条溪上学会「看水」。',
        difficulty: 1,
        controlPoints: sc([
            v2(0, 0), v2(120, 30), v2(260, 10), v2(380, 70), v2(520, 60),
            v2(640, -10), v2(780, -30), v2(900, 40), v2(1040, 50), v2(1180, 0), v2(1300, 10),
        ], 0.75),
        baseSpeed: 2.4,
        baseDepth: 1.5,
        widthProfile: [[0, 14], [0.3, 16], [0.55, 12], [0.8, 15], [1, 18]],
        depthProfile: [[0, 1], [0.5, 1.1], [0.75, 0.85], [1, 1.2]],
        rocks: makeRocks(11, [
            [0.22, 0.3, 1.6], [0.38, -0.4, 1.9], [0.52, 0.1, 1.4],
            [0.66, 0.45, 2.1], [0.83, -0.2, 1.7],
        ]),
        shoals: [
            { s0: 0.44, s1: 0.5, t0: -1, t1: 0.2, depthFactor: 0.33 },
            { s0: 0.7, s1: 0.76, t0: 0.1, t1: 1, depthFactor: 0.36 },
        ],
        weatherSeed: 101,
        rewardBase: 8,
    },
    {
        id: 'xiangshui',
        name: '响水峡',
        subtitle: '峡深流急 · 连环弯道',
        description: '两山夹一溪，水声如响鼓。弯道一个接一个，外侧立崖下水急，内侧回水浅，最是考验排头的眼力。',
        difficulty: 3,
        controlPoints: sc([
            v2(0, 0), v2(100, 60), v2(180, -20), v2(280, -80), v2(360, 0),
            v2(460, 80), v2(560, 10), v2(640, -70), v2(760, -60), v2(840, 30),
            v2(940, 70), v2(1060, -10), v2(1180, -40), v2(1300, 20), v2(1420, 0),
        ], 0.75),
        baseSpeed: 3.0,
        baseDepth: 1.7,
        widthProfile: [[0, 12], [0.2, 9], [0.45, 11], [0.6, 8], [0.8, 10], [1, 14]],
        depthProfile: [[0, 1], [0.3, 1.25], [0.5, 0.9], [0.7, 1.2], [0.88, 0.8], [1, 1.1]],
        rocks: makeRocks(23, [
            [0.12, -0.3, 1.5], [0.2, 0.35, 1.8], [0.3, 0, 1.3], [0.36, -0.45, 2.0],
            [0.47, 0.25, 1.6], [0.55, -0.15, 1.4], [0.63, 0.4, 1.9], [0.72, -0.35, 1.5],
            [0.8, 0.05, 2.2], [0.88, -0.4, 1.6], [0.94, 0.3, 1.8],
        ]),
        shoals: [
            { s0: 0.26, s1: 0.31, t0: -1, t1: 0.35, depthFactor: 0.32 },
            { s0: 0.58, s1: 0.64, t0: -0.2, t1: 1, depthFactor: 0.34 },
            { s0: 0.84, s1: 0.89, t0: -1, t1: 0.1, depthFactor: 0.4 },
        ],
        weatherSeed: 202,
        rewardBase: 12,
    },
    {
        id: 'luoyan',
        name: '落雁滩',
        subtitle: '滩险石恶 · 老排工才敢走',
        description: '「落雁滩，十排九翻」。急弯夹着乱石滩，水小时处处搁浅，水大时排尾甩得像鞭子。走一趟，工钱翻倍。',
        difficulty: 5,
        controlPoints: sc([
            v2(0, 0), v2(90, 80), v2(150, -30), v2(240, -90), v2(300, 10),
            v2(370, 90), v2(450, -10), v2(510, -90), v2(610, -70), v2(660, 40),
            v2(740, 100), v2(830, 20), v2(890, -60), v2(990, -80), v2(1060, 10),
            v2(1150, 60), v2(1260, -20), v2(1380, -50), v2(1500, 10),
        ], 0.75),
        baseSpeed: 3.4,
        baseDepth: 1.6,
        widthProfile: [[0, 11], [0.15, 8], [0.35, 10], [0.5, 7.5], [0.68, 9], [0.85, 8], [1, 13]],
        depthProfile: [[0, 1], [0.2, 1.3], [0.4, 0.85], [0.55, 1.25], [0.72, 0.8], [0.9, 1.15], [1, 1]],
        rocks: makeRocks(37, [
            [0.07, 0.2, 1.5], [0.13, -0.35, 1.8], [0.19, 0.4, 1.4], [0.24, -0.1, 2.0],
            [0.3, 0.35, 1.6], [0.35, -0.4, 1.7], [0.41, 0.05, 1.5], [0.46, -0.3, 2.1],
            [0.52, 0.4, 1.6], [0.57, -0.15, 1.4], [0.62, 0.25, 1.9], [0.67, -0.45, 1.6],
            [0.73, 0.1, 2.2], [0.78, 0.45, 1.5], [0.83, -0.25, 1.8], [0.88, 0.3, 1.5],
            [0.93, -0.4, 1.9], [0.96, 0.15, 1.4],
        ]),
        shoals: [
            { s0: 0.16, s1: 0.21, t0: -1, t1: 0.3, depthFactor: 0.3 },
            { s0: 0.38, s1: 0.44, t0: -0.1, t1: 1, depthFactor: 0.28 },
            { s0: 0.6, s1: 0.66, t0: -1, t1: 0.2, depthFactor: 0.32 },
            { s0: 0.8, s1: 0.85, t0: 0, t1: 1, depthFactor: 0.34 },
        ],
        weatherSeed: 303,
        rewardBase: 20,
    },
];
//# sourceMappingURL=rivers.js.map