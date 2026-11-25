import { formatTime } from '../game/settlement';
import type { Settlement } from '../game/types';

export class ResultPage {
  constructor(
    private root: HTMLElement,
    private settlement: Settlement,
    private onRetry: () => void,
    private onAssembly: () => void,
    private onMap: () => void,
  ) {}

  mount() {
    const r = this.settlement;
    this.root.innerHTML = `
      <section class="screen result-screen">
        <div class="result-card">
          <p class="eyebrow">下游码头 · 验收结算</p>
          <h1>${r.streamName} <span>${r.weatherName}</span></h1>
          <div class="stars" aria-label="${r.stars} 星评价">
            ${[1, 2, 3].map((i) => `<span class="${i <= r.stars ? 'on' : ''}">★</span>`).join('')}
          </div>
          <div class="rank">${r.rank}</div>
          <div class="score-ring" style="--score:${r.score}">
            <strong>${r.score}</strong><span>结算分</span>
          </div>
          <p class="summary">${r.summary}</p>

          <div class="result-grid">
            <div class="result-stat bamboo">
              <span>运到毛竹</span>
              <strong>${r.arrivedBamboos}<small> / ${r.totalBamboos} 根</small></strong>
              <em>完好可用约 ${r.intactBamboos} 根</em>
            </div>
            <div class="result-stat">
              <span>用时</span>
              <strong>${formatTime(r.timeSeconds)}</strong>
              <em>${r.timeSeconds < 180 ? '水程利落' : '稳妥抵岸'}</em>
            </div>
            <div class="result-stat">
              <span>藤条崩断</span>
              <strong class="${r.breaks ? 'danger-text' : ''}">${r.breaks} 道</strong>
              <em>${r.breaks ? '有排节失散/延误' : '连接完好'}</em>
            </div>
            <div class="result-stat">
              <span>撞石 / 搁浅</span>
              <strong>${r.rockHits} / ${r.groundings}</strong>
              <em>撞石次数 / 擦浅次数</em>
            </div>
            <div class="result-stat cargo">
              <span>货物结算</span>
              <strong>¥${r.cargoValue}</strong>
              <em>按运到与完好程度</em>
            </div>
            <div class="result-stat">
              <span>完好率</span>
              <strong>${r.arrivedBamboos ? Math.round((r.intactBamboos / r.arrivedBamboos) * 100) : 0}%</strong>
              <em>到排毛竹可用比例</em>
            </div>
          </div>

          <div class="result-actions">
            <button class="primary-button big" id="retryBtn">再放一次</button>
            <button class="secondary-button" id="assemblyBtn">调整编组</button>
            <button class="text-button" id="mapBtn">返回河道地图</button>
          </div>
        </div>
      </section>
    `;
    this.root.querySelector('#retryBtn')?.addEventListener('click', () => this.onRetry());
    this.root.querySelector('#assemblyBtn')?.addEventListener('click', () => this.onAssembly());
    this.root.querySelector('#mapBtn')?.addEventListener('click', () => this.onMap());
  }

  destroy() {
    this.root.innerHTML = '';
  }
}
