// 天气：一趟放排途中会变天。下雨涨水——流速变快、水深抬高，
// 搁浅的排能浮起来，但水急也更容易撞石。
import { mulberry32, lerp, clamp } from './math.js';
const PHASE_TABLE = {
    '晴': { icon: '☀', speedMul: 1.0, levelMul: 1.0, rain: 0 },
    '阴': { icon: '⛅', speedMul: 1.05, levelMul: 1.05, rain: 0 },
    '小雨': { icon: '🌦', speedMul: 1.18, levelMul: 1.22, rain: 0.4 },
    '大雨': { icon: '🌧', speedMul: 1.42, levelMul: 1.55, rain: 0.75 },
    '暴雨': { icon: '⛈', speedMul: 1.7, levelMul: 1.95, rain: 1 },
};
export class WeatherTimeline {
    constructor(seed, roughness) {
        this.phases = [];
        this.elapsed = 0;
        const rnd = mulberry32(seed);
        // 开头总是好天，中段按难度安排风雨
        this.phases.push({ name: '晴', ...PHASE_TABLE['晴'], duration: 25 + rnd() * 15 });
        let t = 0;
        const total = 240; // 一趟约 4 分钟的天气剧本
        while (t < total) {
            const roll = rnd();
            let name = '阴';
            if (roll < 0.3)
                name = '晴';
            else if (roll < 0.55)
                name = '阴';
            else if (roll < 0.75)
                name = '小雨';
            else if (roll < 0.93)
                name = '大雨';
            else
                name = roughness >= 3 ? '暴雨' : '大雨';
            const dur = 18 + rnd() * 25;
            this.phases.push({ name, ...PHASE_TABLE[name], duration: dur });
            t += dur;
        }
    }
    /** 预报（地图页展示） */
    forecast() {
        return this.phases.slice(0, 5).map(p => ({ name: p.name, icon: p.icon }));
    }
    /** 当前天气（阶段间 8 秒平滑过渡） */
    current(dt) {
        this.elapsed += dt;
        let t = this.elapsed;
        for (let i = 0; i < this.phases.length; i++) {
            const p = this.phases[i];
            if (t < p.duration) {
                const next = this.phases[Math.min(i + 1, this.phases.length - 1)];
                const blend = clamp((t - (p.duration - 8)) / 8, 0, 1); // 末尾 8 秒过渡
                return {
                    name: blend > 0.5 ? next.name : p.name,
                    icon: blend > 0.5 ? next.icon : p.icon,
                    speedMul: lerp(p.speedMul, next.speedMul, blend),
                    levelMul: lerp(p.levelMul, next.levelMul, blend),
                    rain: lerp(p.rain, next.rain, blend),
                };
            }
            t -= p.duration;
        }
        const last = this.phases[this.phases.length - 1];
        return { name: last.name, icon: last.icon, speedMul: last.speedMul, levelMul: last.levelMul, rain: last.rain };
    }
}
//# sourceMappingURL=weather.js.map