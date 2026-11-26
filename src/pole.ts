// 竹篙：玩家站在排头，把篙点在河底（或露出水面的礁石）借力。
// 篙长有限，水深超过篙长够不到底；撑得越猛力越大，
// 但超过安全力度会累坏排头几个关节的藤条。

import { Vec2, v2, sub, norm, len, clamp } from './math.js';
import { FlowField, FlowSample, WeatherState } from './flowfield.js';
import { PoleInput } from './raft.js';

export const POLE_LENGTH = 3.6;   // 篙长（米），水更深就点不到底
export const POLE_REACH = 7.0;    // 人站在排头能够着的范围
export const POLE_MAX_FORCE = 2600;
export const POLE_SAFE_FORCE = 1500; // 超过这个力度开始伤藤条

export class PoleController {
  state: 'idle' | 'planted' = 'idle';
  plantPoint: Vec2 = v2();
  private charge = 0;      // 按住越久撑得越猛
  private dir: Vec2 = v2();
  valid = false;
  invalidReason = '';

  /** 尝试把篙点在 target（世界坐标） */
  plant(headPos: Vec2, target: Vec2, flow: FlowField, weather: WeatherState): boolean {
    const d = len(sub(target, headPos));
    if (d > POLE_REACH) {
      this.valid = false;
      this.invalidReason = '太远了，够不着';
      return false;
    }
    const fs: FlowSample = { vel: v2(), depth: 0, s: 0, t: 0, inRiver: true };
    flow.sample(target, weather, fs);
    if (!fs.inRiver) {
      this.valid = false;
      this.invalidReason = '点到岸上了';
      return false;
    }
    if (fs.depth > POLE_LENGTH) {
      this.valid = false;
      this.invalidReason = '水太深，篙够不到底';
      return false;
    }
    this.plantPoint.x = target.x; this.plantPoint.y = target.y;
    this.dir = norm(sub(headPos, target)); // 从篙点指向排头：把排往离篙点方向推
    this.charge = 0;
    this.state = 'planted';
    this.valid = true;
    return true;
  }

  /** 按住期间每帧调用，返回当前篙力 */
  update(dt: number, headPos: Vec2, out: PoleInput): PoleInput {
    if (this.state !== 'planted') {
      out.active = false;
      return out;
    }
    // 排头被冲离篙点太远，篙就脱了
    if (len(sub(headPos, this.plantPoint)) > POLE_REACH * 1.25) {
      this.release();
      out.active = false;
      return out;
    }
    this.charge = clamp(this.charge + dt / 0.9, 0, 1);
    const force = POLE_MAX_FORCE * this.charge;
    out.active = true;
    out.force.x = this.dir.x * force;
    out.force.y = this.dir.y * force;
    out.point.x = this.plantPoint.x; out.point.y = this.plantPoint.y;
    out.overstress = clamp((force - POLE_SAFE_FORCE) / (POLE_MAX_FORCE - POLE_SAFE_FORCE), 0, 1);
    return out;
  }

  release(): void {
    this.state = 'idle';
    this.charge = 0;
  }
}
