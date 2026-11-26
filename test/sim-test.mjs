// 无头仿真测试：node test/sim-test.mjs（先 npm run build）
import { RIVERS, buildRiverGeometry } from '../dist/rivers.js';
import { FlowField } from '../dist/flowfield.js';
import { Raft, makeRaftConfig } from '../dist/raft.js';
import { GameRun } from '../dist/game.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

const WX = { speedMul: 1, levelMul: 1 };

// ---------- 1. 弯道外侧流速 > 内侧 ----------
console.log('弯道流速分布：');
{
  const geo = buildRiverGeometry(RIVERS[1]); // 响水峡，弯多
  const flow = new FlowField(geo);
  // 找曲率最大的采样点
  let kMax = 0, kIdx = 0;
  geo.samples.forEach((s, i) => { if (Math.abs(s.curvature) > Math.abs(kMax)) { kMax = s.curvature; kIdx = i; } });
  const smp = geo.samples[kIdx];
  check('找到明显弯道', Math.abs(kMax) > 0.004, `κ=${kMax.toFixed(4)}`);
  // 外侧 = 曲率反侧（κ>0 左转，外侧在 t<0）
  const outerT = kMax > 0 ? -0.7 : 0.7;
  const innerT = -outerT;
  const mk = (t) => ({
    x: smp.pos.x + smp.normal.x * t * smp.halfWidth,
    y: smp.pos.y + smp.normal.y * t * smp.halfWidth,
  });
  const sOut = { vel: { x: 0, y: 0 }, depth: 0, s: 0, t: 0, inRiver: true };
  const sIn = { vel: { x: 0, y: 0 }, depth: 0, s: 0, t: 0, inRiver: true };
  flow.sample(mk(outerT), WX, sOut);
  flow.sample(mk(innerT), WX, sIn);
  const vOut = Math.hypot(sOut.vel.x, sOut.vel.y);
  const vIn = Math.hypot(sIn.vel.x, sIn.vel.y);
  console.log(`  弯道 κ=${kMax.toFixed(4)} 外侧 ${vOut.toFixed(2)} m/s vs 内侧 ${vIn.toFixed(2)} m/s`);
  check('外侧流速大于内侧', vOut > vIn * 1.15, `${vOut} vs ${vIn}`);
}

// ---------- 2. 石头后面有回水 ----------
console.log('礁石回水：');
{
  const geo = buildRiverGeometry(RIVERS[0]);
  const flow = new FlowField(geo);
  const rk = RIVERS[0].rocks[1];
  const n = geo.samples.length - 1;
  const smp = geo.samples[Math.round(rk.sNorm * n)];
  // 石头下游 3 米处
  const behind = geo.samples[Math.min(n, Math.round(rk.sNorm * n) + Math.round(3 / geo.step))];
  const p = {
    x: behind.pos.x + behind.normal.x * rk.t * behind.halfWidth,
    y: behind.pos.y + behind.normal.y * rk.t * behind.halfWidth,
  };
  const fs = { vel: { x: 0, y: 0 }, depth: 0, s: 0, t: 0, inRiver: true };
  flow.sample(p, WX, fs);
  const downstream = fs.vel.x * behind.tangent.x + fs.vel.y * behind.tangent.y;
  console.log(`  石后 3m 顺流分量 ${downstream.toFixed(2)} m/s（基准 ${RIVERS[0].baseSpeed}）`);
  check('石后流速显著减弱或逆流', downstream < RIVERS[0].baseSpeed * 0.6);
}

// ---------- 3. 搁浅：吃水 > 水深 ----------
console.log('搁浅判定：');
{
  const cfg = makeRaftConfig(12, 12, 'old'); // 吃水 0.28+12*0.028=0.616m
  const run = new GameRun(RIVERS[0], cfg);
  check('吃水计算正确', Math.abs(run.raft.draft - 0.616) < 1e-6, `draft=${run.raft.draft}`);
  // 把排头放到浅滩中央（青竹溪第一个浅滩 depthFactor 0.45，水深≈1.5*0.45≈0.6 内缘更浅）
  const geo = run.flow.geo;
  const sh = RIVERS[0].shoals[0];
  const sNorm = (sh.s0 + sh.s1) / 2;
  const n = geo.samples.length - 1;
  const smp = geo.samples[Math.round(sNorm * n)];
  const tMid = (sh.t0 + sh.t1) / 2;
  const sec = run.raft.sections[0];
  sec.pos.x = smp.pos.x + smp.normal.x * tMid * smp.halfWidth;
  sec.pos.y = smp.pos.y + smp.normal.y * tMid * smp.halfWidth;
  const fs = { vel: { x: 0, y: 0 }, depth: 0, s: 0, t: 0, inRiver: true };
  run.flow.sample(sec.pos, run.weather, fs);
  console.log(`  浅滩水深 ${fs.depth.toFixed(2)}m，吃水 ${run.raft.draft.toFixed(2)}m`);
  check('浅滩水深小于吃水', fs.depth < run.raft.draft);
  const events = { jointBroke: [], groundedNow: [], stuckNow: [], damaged: [] };
  run.raft.step(1 / 60, run.flow, run.weather, run.poleInput, run.rocksWorld, events);
  check('该节被判定搁浅', run.raft.sections[0].grounded);
}

// ---------- 4. 藤条弯折超限会断 ----------
console.log('藤条断裂：');
{
  const cfg = makeRaftConfig(10, 8, 'new'); // 新藤：maxBend 0.36, breakBend 0.7
  const run = new GameRun(RIVERS[0], cfg);
  // 直接把第 3、4 节掰成超过断裂角
  run.raft.sections[3].angle = 0;
  run.raft.sections[4].angle = 1.2; // > 0.7 rad
  const events = { jointBroke: [], groundedNow: [], stuckNow: [], damaged: [] };
  run.raft.step(1 / 60, run.flow, run.weather, run.poleInput, run.rocksWorld, events);
  check('超限弯折导致断藤', events.jointBroke.includes(3), `broke=[${events.jointBroke}]`);
}

// ---------- 5. 30 节排性能：60 帧 ----------
console.log('30 节排性能：');
{
  for (const river of RIVERS) {
    const cfg = makeRaftConfig(30, 10, 'old');
    const run = new GameRun(river, cfg);
    const steps = 3600; // 模拟 60 秒
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < steps; i++) run.step(1 / 60);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const perStep = ms / steps;
    console.log(`  ${river.name}: ${steps} 步共 ${ms.toFixed(0)}ms，每步 ${perStep.toFixed(3)}ms`);
    check(`${river.name} 每步远低于 16.6ms 帧预算`, perStep < 2, `${perStep.toFixed(3)}ms`);
    // 数值稳定
    let nan = false;
    for (const s of run.raft.sections) {
      if (!Number.isFinite(s.pos.x) || !Number.isFinite(s.pos.y) || !Number.isFinite(s.angle)) nan = true;
    }
    check(`${river.name} 60 秒后数值无 NaN`, !nan);
  }
}

// ---------- 6. 整趟能跑到码头（模拟玩家：走不动了就撑篙） ----------
console.log('整趟放排（自动撑篙）：');
{
  const cfg = makeRaftConfig(15, 7, 'old');
  const run = new GameRun(RIVERS[0], cfg);
  const fs = { vel: { x: 0, y: 0 }, depth: 0, s: 0, t: 0, inRiver: true };
  let guard = 0;
  let poleHold = 0;
  while (run.phase !== 'done' && guard < 60 * 600) {
    const h = run.raft.head;
    const spd = Math.hypot(h.vel.x, h.vel.y);
    if (poleHold > 0) {
      poleHold -= 1 / 60;
      if (poleHold <= 0) run.pole.release();
    } else if (spd < 0.9) {
      // 走不动了：把篙点在排头上游 3 米的水底，往下游撑
      run.flow.sample(h.pos, run.weather, fs);
      const fl = Math.hypot(fs.vel.x, fs.vel.y) || 1;
      const target = { x: h.pos.x - fs.vel.x / fl * 3, y: h.pos.y - fs.vel.y / fl * 3 };
      if (run.pole.plant(h.pos, target, run.flow, run.weather)) poleHold = 0.6;
    }
    run.step(1 / 60);
    guard++;
  }
  const r = run.result(RIVERS[0]);
  console.log(`  ${(guard / 60).toFixed(0)}s 后结束：运到 ${r.delivered}/${r.total}，断藤 ${r.stats.jointsBroken}，卡石 ${r.stats.stucks}，搁浅 ${r.stats.groundings}`);
  check('竹排最终到达码头', run.raft.head.s >= run.dockS - 1, `head.s=${run.raft.head.s.toFixed(0)} dock=${run.dockS.toFixed(0)}`);
  check('大部分竹子运到', r.delivered >= r.total * 0.7, `${r.delivered}/${r.total}`);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
