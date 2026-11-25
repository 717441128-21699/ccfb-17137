import type { Settlement, StreamDef, WeatherDef } from './types';
import type { RaftSimulation } from './raft';
import { clamp } from './math';

export function buildSettlement(
  sim: RaftSimulation,
  elapsed: number,
  stream: StreamDef,
  weather: WeatherDef,
): Settlement {
  const totalSections = sim.config.sections;
  const deliveredSections = sim.sections.filter((s) => s.delivered);
  const arrivedSections = deliveredSections.length;
  const totalBamboos = totalSections * sim.config.bamboosPerSection;
  const arrivedBamboos = arrivedSections * sim.config.bamboosPerSection;
  const intactBamboos = Math.round(
    deliveredSections.reduce((sum, s) => sum + sim.config.bamboosPerSection * (s.hp / 100), 0),
  );
  const intactRate = arrivedBamboos > 0 ? intactBamboos / arrivedBamboos : 0;
  const intactTotalRate = intactBamboos / totalBamboos;
  const deliveryRate = arrivedSections / totalSections;
  const timeRate = clamp(1 - Math.max(0, elapsed - 150) / 300, 0.25, 1);

  const score = Math.round(
    60 * deliveryRate +
      25 * intactTotalRate +
      8 * timeRate * deliveryRate +
      7 * deliveryRate -
      sim.breaks * 1.5,
  );
  const safeScore = clamp(Math.max(0, score), 0, 100);
  const stars = safeScore >= 85 ? 3 : safeScore >= 60 ? 2 : safeScore >= 30 ? 1 : 0;
  const rank =
    stars === 3 ? '金牌排工' : stars === 2 ? '靠谱把式' : stars === 1 ? '初学放排' : '险些翻排';

  let summary: string;
  if (deliveryRate === 1 && intactRate > 0.86) {
    summary = '整排竹子齐齐到码头，藤条弯折拿捏得准，老排工也会点头。';
  } else if (sim.breaks > 2) {
    summary = '断藤多、散排长，到了码头还要沿江寻回失散竹节。';
  } else if (sim.groundings > 5) {
    summary = '浅滩上推了好几回排，竹子磕损不少，但总算运到了码头。';
  } else if (deliveryRate < 0.7) {
    summary = '后段竹排没能及时靠岸，运到的竹子少了许多。';
  } else {
    summary = '竹子基本运到，水势判断还可以更细：外弯借速、回水绕行。';
  }

  return {
    streamName: stream.name,
    weatherName: weather.name,
    totalBamboos,
    arrivedBamboos,
    intactBamboos,
    cargoValue: Math.round(sim.config.cargo * 120 * deliveryRate * (0.6 + 0.4 * intactRate)),
    timeSeconds: elapsed,
    breaks: sim.breaks,
    rockHits: sim.rockHits,
    groundings: sim.groundings,
    score: safeScore,
    stars,
    rank,
    summary,
  };
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
