export interface Vec2 {
  x: number;
  y: number;
}

export interface RockSpec {
  /** longitudinal position, metres from the upstream launch */
  s: number;
  /** offset from channel centreline; positive is left bank */
  lateral: number;
  radius: number;
  name?: string;
}

export interface ShoalSpec {
  s: number;
  lateral: number;
  length: number;
  width: number;
  depth: number;
  name?: string;
}

export interface StreamDef {
  id: string;
  name: string;
  tagline: string;
  difficulty: '平缓' | '曲折' | '凶险';
  length: number;
  baseWidth: number;
  baseDepth: number;
  baseSpeed: number;
  slope: string;
  story: string;
  tips: string[];
  control: Vec2[];
  widthWaves?: { start: number; end: number; width: number }[];
  rocks: RockSpec[];
  shoals: ShoalSpec[];
  dockFromEnd: number;
}

export interface WeatherDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  speedMul: number;
  levelDelta: number;
  rain: number;
  visibility: number;
}

export interface RaftConfig {
  /** number of connected floating sections; benchmark/default is 30 */
  sections: number;
  /** whole moso bamboos in each section */
  bamboosPerSection: number;
  /** cargo packages, adds draft and settlement value */
  cargo: number;
  /** nominal draft in metres */
  draft: number;
  /** maximum articulation angle in degrees before the vine snaps */
  maxBendDeg: number;
  /** vine spring strength */
  vineStiffness: number;
  vineName: string;
}

export interface FlowSample {
  velocity: Vec2;
  downstream: Vec2;
  normal: Vec2;
  position: Vec2;
  s: number;
  lateral: number;
  width: number;
  depth: number;
  speed: number;
  outerFactor: number;
}

export type GamePhase = 'ready' | 'running' | 'paused' | 'docking' | 'finished' | 'failed';

export interface SectionState {
  index: number;
  /** endpoint node indices: front, rear */
  a: number;
  b: number;
  angle: number;
  bend: number;
  hp: number;
  maxHp: number;
  grounded: number;
  stuckTimer: number;
  impact: number;
  delivered: boolean;
  lost: boolean;
}

export interface JointState {
  index: number;
  active: boolean;
  angle: number;
  stress: number;
  brokenAt?: string;
}

export interface GameEvent {
  id: number;
  time: number;
  kind: 'break' | 'rock' | 'ground' | 'reach' | 'info' | 'push' | 'pole-miss';
  text: string;
  section?: number;
  severity?: number;
}

export interface Settlement {
  streamName: string;
  weatherName: string;
  totalBamboos: number;
  arrivedBamboos: number;
  intactBamboos: number;
  cargoValue: number;
  timeSeconds: number;
  breaks: number;
  rockHits: number;
  groundings: number;
  score: number;
  stars: number;
  rank: string;
  summary: string;
}
