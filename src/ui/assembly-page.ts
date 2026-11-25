import { RAFT_PRESETS, STREAMS, WEATHERS, makeRaftConfig } from '../game/data';
import { WaterModel } from '../game/flow';
import { RaftSimulation } from '../game/raft';
import { GameRenderer } from '../render/renderer';
import type { SelectionState } from './state';

const LOAD_NAMES = ['轻便小排', '标准六竹', '重载货排'];
const LOAD_DESC = ['吃水浅、藤条软，适合枯水和新手', '六根毛竹一节，稳当且有载货', '八根毛竹加压舱货，运得多但易搁浅'];

export class AssemblyPage {
  private renderer: GameRenderer | null = null;
  private sim: RaftSimulation | null = null;
  private raf = 0;
  private destroyed = false;

  constructor(
    private root: HTMLElement,
    private selection: SelectionState,
    private onBack: () => void,
    private onStart: () => void,
  ) {}

  mount() {
    this.destroyed = false;
    const stream = STREAMS.find((s) => s.id === this.selection.streamId) ?? STREAMS[0];
    const weather = WEATHERS.find((w) => w.id === this.selection.weatherId) ?? WEATHERS[0];
    const config = makeRaftConfig(this.selection.presetIndex, this.selection.sectionCount);
    const totalBamboos = config.sections * config.bamboosPerSection;
    const approxLength = config.sections * 1.82;

    this.root.innerHTML = `
      <section class="screen assembly-screen">
        <aside class="side-panel assembly-panel">
          <header class="compact-header">
            <button class="text-button" id="backToMap">← 河道地图</button>
            <p class="eyebrow">第二步 · 竹排编组</p>
            <h1>一节一藤，编成大排</h1>
          </header>

          <div class="section-title"><span>装载编组</span><small>每节毛竹数/载货</small></div>
          <div class="preset-list">
            ${RAFT_PRESETS.map(
              (p, i) => `
              <button class="preset-card ${i === this.selection.presetIndex ? 'active' : ''}" data-preset="${i}">
                <div class="card-top"><strong>${LOAD_NAMES[i]}</strong><span>${p.bamboosPerSection} 竹/节</span></div>
                <p>${LOAD_DESC[i]}</p>
                <small>吃水 ${p.draft.toFixed(2)}m · 弯折上限 ${p.maxBendDeg}° · ${p.vineName}</small>
              </button>`,
            ).join('')}
          </div>

          <div class="section-title"><span>排节数量</span><small>三十节为展馆表演编组</small></div>
          <div class="segmented">
            ${[12, 20, 30]
              .map(
                (n) =>
                  `<button data-sections="${n}" class="${n === config.sections ? 'active' : ''}">${n} 节</button>`,
              )
              .join('')}
          </div>

          <div class="readout-grid">
            <div><span>毛竹总数</span><strong>${totalBamboos} 根</strong></div>
            <div><span>整排长度</span><strong>≈${approxLength.toFixed(0)} m</strong></div>
            <div><span>满载吃水</span><strong class="${config.draft > 0.55 ? 'warn-text' : ''}">${config.draft.toFixed(2)} m</strong></div>
            <div><span>藤条上限</span><strong>${config.maxBendDeg}° / 道</strong></div>
          </div>

          <div class="assembly-warning">
            <strong>${stream.name} · ${weather.name}</strong>
            <p>${
              weather.id === 'low' && config.draft >= 0.5
                ? '枯水天气加深浅滩，这个编组吃水偏深，建议减少装载或勤用“下水推排”。'
                : weather.id === 'flood'
                  ? '涨水后流速很快，建议使用弯折上限更大的藤条，提前入弯。'
                  : '长排过弯时要让每一节顺着水走，藤条转角超过上限会崩断。'
            }</p>
          </div>

          <button class="primary-button big" id="startGame">编组完成，下水放排 →</button>
        </aside>

        <main class="assembly-stage">
          <canvas id="assemblyCanvas" aria-label="竹排编组 WebGL2 预览"></canvas>
          <div class="assembly-caption">
            <h2>${config.sections} 节连贯竹排预览</h2>
            <p>节间藤条允许最大弯折 ${config.maxBendDeg}°；猛撑、撞石和后排挤压都会让弯折角迅速上升。</p>
          </div>
          <div class="section-chip-strip" aria-label="排节编号">
            ${Array.from({ length: config.sections }, (_, i) => `<span title="第${i + 1}节">${i + 1}</span>`).join('')}
          </div>
        </main>
      </section>
    `;

    const canvas = this.root.querySelector<HTMLCanvasElement>('#assemblyCanvas');
    if (canvas) {
      try {
        this.renderer = new GameRenderer(canvas);
        const water = new WaterModel(stream, weather);
        this.renderer.setWater(water);
        this.sim = new RaftSimulation(water, config, 92);
        const loop = () => {
          if (this.destroyed || !this.renderer || !this.sim) return;
          this.sim.update(1 / 120);
          this.renderer.renderAssembly(this.sim, performance.now() / 1000);
          this.raf = requestAnimationFrame(loop);
        };
        this.raf = requestAnimationFrame(loop);
      } catch (err) {
        const stage = this.root.querySelector('.assembly-stage');
        const div = document.createElement('div');
        div.className = 'webgl-error';
        div.textContent = `WebGL2 初始化失败：${err instanceof Error ? err.message : String(err)}`;
        stage?.appendChild(div);
      }
    }

    this.root.querySelector('#backToMap')?.addEventListener('click', () => this.onBack());
    this.root.querySelector('#startGame')?.addEventListener('click', () => this.onStart());
    this.root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) =>
      btn.addEventListener('click', () => {
        this.selection.presetIndex = Number(btn.dataset.preset);
        this.rebuild();
      }),
    );
    this.root.querySelectorAll<HTMLButtonElement>('[data-sections]').forEach((btn) =>
      btn.addEventListener('click', () => {
        this.selection.sectionCount = Number(btn.dataset.sections);
        this.rebuild();
      }),
    );
  }

  private rebuild() {
    this.destroy();
    this.mount();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.renderer?.dispose();
    this.renderer = null;
    this.sim = null;
  }
}
