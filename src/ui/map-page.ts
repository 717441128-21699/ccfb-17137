import { STREAMS, WEATHERS } from '../game/data';
import { WaterModel } from '../game/flow';
import { GameRenderer } from '../render/renderer';
import type { SelectionState } from './state';

export class MapPage {
  private renderer: GameRenderer | null = null;
  private water: WaterModel | null = null;
  private raf = 0;
  private destroyed = false;
  private canvas: HTMLCanvasElement | null = null;

  constructor(
    private root: HTMLElement,
    private selection: SelectionState,
    private onChange: () => void,
    private onNext: () => void,
  ) {}

  mount() {
    this.destroyed = false;
    const stream = STREAMS.find((s) => s.id === this.selection.streamId) ?? STREAMS[0];
    const weather = WEATHERS.find((w) => w.id === this.selection.weatherId) ?? WEATHERS[0];
    this.root.innerHTML = `
      <section class="screen map-screen">
        <aside class="side-panel map-panel">
          <header class="brand">
            <div class="brand-seal">竹排</div>
            <div>
              <p class="eyebrow">竹乡展馆 · 互动展项</p>
              <h1>竹溪放排</h1>
            </div>
          </header>
          <p class="lead">先看河道地形：弯有内外，石后有回水，滩前看吃水。选一条山溪和天气，再去编组竹排。</p>

          <div class="section-title"><span>河道地图</span><small>三条山溪</small></div>
          <div class="card-list stream-list">
            ${STREAMS.map(
              (s) => `
              <button class="select-card stream-card ${s.id === stream.id ? 'active' : ''}" data-stream="${s.id}">
                <div class="card-top">
                  <strong>${s.name}</strong>
                  <span class="difficulty diff-${s.difficulty}">${s.difficulty}</span>
                </div>
                <p>${s.tagline}</p>
                <div class="meta-row"><span>流长 ${Math.round(s.length)}m</span><span>比降 ${s.slope}</span><span>${s.rocks.length} 处礁石</span></div>
              </button>`,
            ).join('')}
          </div>

          <div class="section-title"><span>天气水情</span><small>影响流速与水深</small></div>
          <div class="weather-grid">
            ${WEATHERS.map(
              (w) => `
              <button class="weather-card ${w.id === weather.id ? 'active' : ''}" data-weather="${w.id}">
                <span class="weather-icon">${w.icon}</span>
                <strong>${w.name}</strong>
                <small>流速 ×${w.speedMul.toFixed(2)} · 水位 ${w.levelDelta >= 0 ? '+' : ''}${w.levelDelta.toFixed(2)}m</small>
              </button>`,
            ).join('')}
          </div>

          <div class="stream-detail">
            <h2>${stream.name} · ${weather.name}</h2>
            <p>${stream.story}</p>
            <ul>${stream.tips.map((tip) => `<li>${tip}</li>`).join('')}</ul>
          </div>

          <button class="primary-button big" id="toAssembly">下一步：竹排编组 →</button>
        </aside>

        <main class="map-stage">
          <canvas id="mapCanvas" aria-label="河道 WebGL2 地图"></canvas>
          <div class="map-overlay-top">
            <div class="map-title-card">
              <h2>${stream.name}地形水势图</h2>
              <p>绿点为放排起点，金环为下游码头；蓝白光带表示流动水纹。</p>
            </div>
            <div class="legend">
              <span><i class="lg-deep"></i>深槽/外弯急流</span>
              <span><i class="lg-shallow"></i>浅滩</span>
              <span><i class="lg-rock"></i>礁石/回水</span>
              <span><i class="lg-dock"></i>码头</span>
            </div>
          </div>
          <div class="map-scale-note">WebGL2 河道 · 地形/流速/回水均由 TypeScript 采样计算</div>
        </main>
      </section>
    `;

    this.canvas = this.root.querySelector<HTMLCanvasElement>('#mapCanvas');
    if (this.canvas) {
      try {
        this.renderer = new GameRenderer(this.canvas);
        this.water = new WaterModel(stream, weather);
        this.renderer.setWater(this.water);
        const loop = () => {
          if (this.destroyed || !this.renderer) return;
          this.renderer.renderMap(performance.now() / 1000);
          this.raf = requestAnimationFrame(loop);
        };
        this.raf = requestAnimationFrame(loop);
      } catch (err) {
        this.showWebGLError(err);
      }
    }

    this.root.querySelectorAll<HTMLButtonElement>('[data-stream]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selection.streamId = btn.dataset.stream!;
        this.onChange();
        this.rebuild();
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-weather]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selection.weatherId = btn.dataset.weather!;
        this.onChange();
        this.rebuild();
      });
    });
    this.root.querySelector('#toAssembly')?.addEventListener('click', () => this.onNext());
  }

  private rebuild() {
    this.destroy();
    this.mount();
  }

  private showWebGLError(err: unknown) {
    const stage = this.root.querySelector('.map-stage');
    if (stage) {
      const div = document.createElement('div');
      div.className = 'webgl-error';
      div.textContent = `WebGL2 初始化失败：${err instanceof Error ? err.message : String(err)}。请使用新版 Edge/Chrome 并开启硬件加速。`;
      stage.appendChild(div);
    }
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.renderer?.dispose();
    this.renderer = null;
  }
}
