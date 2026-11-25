import { STREAMS, WEATHERS, makeRaftConfig } from '../src/game/data';
import { WaterModel } from '../src/game/flow';
import { RaftSimulation } from '../src/game/raft';
import { clamp } from '../src/game/math';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error('❌', message);
    process.exitCode = 1;
    throw new Error(message);
  }
}

function finiteSim(sim: RaftSimulation) {
  for (let i = 0; i < sim.nodeCount; i++) {
    assert(Number.isFinite(sim.x[i]) && Number.isFinite(sim.y[i]), 'simulation produced non-finite coordinates');
  }
}

// 1. Outside of a bend must flow faster than the inside.
for (const stream of STREAMS) {
  const water = new WaterModel(stream, WEATHERS[0]);
  let checked = false;
  for (let s = 30; s < water.path.length - 30; s += 8) {
    const f = water.path.frameAt(s);
    if (Math.abs(f.curvature) < 0.006) continue;
    const lat = Math.min(6, f.width * 0.28);
    const outerLat = -Math.sign(f.curvature) * lat;
    const innerLat = Math.sign(f.curvature) * lat;
    const outer = water.sampleSL(s, outerLat).speed;
    const inner = water.sampleSL(s, innerLat).speed;
    assert(outer > inner * 1.08, `${stream.name} bend outer speed should exceed inner (${outer.toFixed(2)} <= ${inner.toFixed(2)})`);
    checked = true;
    break;
  }
  assert(checked, `${stream.name} should contain a measurable bend`);
}
console.log('✅ 弯道外侧流速 > 内侧流速');

// 2. Grounding rule: draft greater than local depth marks a section grounded.
{
  const stream = STREAMS[0];
  const weather = WEATHERS.find((w) => w.id === 'low')!;
  const water = new WaterModel(stream, weather);
  const shoal = stream.shoals.find((sh) => Math.abs(sh.lateral) < 1) ?? stream.shoals[0];
  const depth = water.depthAt(shoal.s, shoal.lateral);
  const config = makeRaftConfig(2, 30);
  assert(config.draft > depth, `heavy draft ${config.draft} should exceed shoal depth ${depth}`);
  const sim = new RaftSimulation(water, config, shoal.s + 0.8);
  for (let f = 0; f < 120; f++) sim.update(1 / 60);
  assert(sim.sections.some((s) => s.grounded > 0.02), 'shoal should ground at least one section');
  console.log(`✅ 浅滩搁浅判定正常（吃水 ${config.draft}m > 水深 ${depth.toFixed(2)}m）`);
}

// 3. Extreme poling can exceed the articulation limit and snap a vine.
{
  const water = new WaterModel(STREAMS[1], WEATHERS[0]);
  const config = makeRaftConfig(1, 30);
  const sim = new RaftSimulation(water, config, 180);
  let snapped = false;
  for (let frame = 0; frame < 60 * 12; frame++) {
    sim.update(1 / 60);
    if (frame % 28 === 0) {
      const h = sim.headCenter();
      const side = frame % 56 === 0 ? 7.2 : -7.2;
      sim.releasePole({ x: h.x + side, y: h.y - 1.5 }, 1);
    }
    if (sim.breaks > 0) {
      snapped = true;
      break;
    }
  }
  assert(snapped, 'full-power alternating poles should eventually snap an over-bent vine');
  console.log(`✅ 猛撑导致弯折超限并断藤（${sim.breaks} 道）`);
}

// 4. Current carries the raft downstream on every authored stream.
for (const [streamId, weatherId] of [
  ['cuizhu', 'spring'],
  ['jiuqu', 'drizzle'],
  ['longyin', 'flood'],
] as const) {
  const stream = STREAMS.find((s) => s.id === streamId)!;
  const weather = WEATHERS.find((w) => w.id === weatherId)!;
  const water = new WaterModel(stream, weather);
  const sim = new RaftSimulation(water, makeRaftConfig(1, 30), 88);
  const startS = sim.headS;
  for (let frame = 0; frame < 60 * 12; frame++) {
    sim.update(1 / 60);
    finiteSim(sim);
  }
  assert(sim.headS > startS + 24, `${stream.name} current should carry the raft downstream`);
  console.log(`✅ ${stream.name}/${weather.name} 水流推进正常：${startS.toFixed(0)}m → ${sim.headS.toFixed(0)}m`);
}

// 5. CPU budget for 30 sections. Rendering is instanced; physics is tiny.
{
  const water = new WaterModel(STREAMS[1], WEATHERS[2]);
  const sim = new RaftSimulation(water, makeRaftConfig(1, 30), 120);
  for (let i = 0; i < 120; i++) sim.update(1 / 60);
  const n = 3000;
  const start = performance.now();
  for (let i = 0; i < n; i++) sim.update(1 / 60);
  const msPerFrame = (performance.now() - start) / n;
  console.log(`✅ 30 节物理平均 ${msPerFrame.toFixed(3)} ms/帧（远低于 16.7ms 预算）`);
  assert(msPerFrame < 3, 'physics should stay below 3ms/frame in Node');
}

console.log('\n全部核心模拟检查通过。');
