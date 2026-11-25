import { STREAMS, WEATHERS, makeRaftConfig } from '../src/game/data';
import { WaterModel } from '../src/game/flow';
import { RaftSimulation } from '../src/game/raft';
import { clamp } from '../src/game/math';

for (const stream of STREAMS) {
  const water = new WaterModel(stream, WEATHERS[0]);
  const sim = new RaftSimulation(water, makeRaftConfig(1, 30), 88);
  let lastPole = -10;
  for (let frame = 0; frame < 60 * 360; frame++) {
    const t = frame / 60;
    sim.pushHeld = sim.sections.some((s) => s.grounded > 0.08 || s.stuckTimer > 0.05);
    if (t - lastPole > 0.65) {
      const h = sim.headCenter();
      const pr = water.path.project(h);
      let desired = 0;
      for (const r of stream.rocks) {
        const ds = r.s - pr.s;
        if (ds > -58 && ds < 72) {
          const safe = -Math.sign(r.lateral || 1) * 7.2;
          const urgency = clamp(1 - Math.abs(ds - 12) / 70, 0.25, 1);
          desired += safe * urgency;
        }
      }
      desired = clamp(desired, -pr.frame.width * 0.5 + 4, pr.frame.width * 0.5 - 4);
      const err = pr.lateral - desired;
      const side = clamp(err * 1.25, -5.8, 5.8);
      const earlyStuck = sim.sections.slice(0, 8).some((s) => s.stuckTimer > 0.05);
      const long = earlyStuck ? 4.2 : -3.1;
      sim.releasePole(
        { x: h.x + pr.frame.tangent.x * long + pr.frame.normal.x * side, y: h.y + pr.frame.tangent.y * long + pr.frame.normal.y * side },
        earlyStuck ? 0.9 : clamp(0.42 + Math.abs(err) * 0.035, 0.42, 0.68),
      );
      lastPole = t;
    }
    sim.update(1 / 60);
    if (sim.headS >= water.path.dockS && sim.deliveredCount() >= 25) break;
  }
  console.log(stream.id, 'head', sim.headS.toFixed(0), 'dock', water.path.dockS.toFixed(0), 'delivered', sim.deliveredCount(), 'breaks', sim.breaks, 'hits', sim.rockHits, 'grounds', sim.groundings);
}
