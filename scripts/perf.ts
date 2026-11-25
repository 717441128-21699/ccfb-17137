import { STREAMS, WEATHERS, makeRaftConfig } from '../src/game/data';
import { WaterModel } from '../src/game/flow';
import { RaftSimulation } from '../src/game/raft';

const water = new WaterModel(STREAMS[1], WEATHERS[2]);
const sim = new RaftSimulation(water, makeRaftConfig(1, 30), 120);
for (let i = 0; i < 120; i++) sim.update(1 / 60);
const n = 6000;
const start = performance.now();
for (let i = 0; i < n; i++) sim.update(1 / 60);
const elapsed = performance.now() - start;
console.log(JSON.stringify({ frames: n, totalMs: +elapsed.toFixed(1), msPerFrame: +(elapsed / n).toFixed(4) }));
