import { STREAMS, WEATHERS, makeRaftConfig } from '../game/data';
import { WaterModel } from '../game/flow';
import { RaftSimulation } from '../game/raft';
import { buildSettlement, formatTime } from '../game/settlement';
import { GameRenderer } from '../render/renderer';
import { clamp } from '../game/math';
import type { Settlement } from '../game/types';
import type { SelectionState } from './state';

type Phase = 'ready' | 'running' | 'paused' | 'docking' | 'finished';

export class GamePage {
  private renderer: GameRenderer | null = null;
  private water: WaterModel | null = null;
  private sim: RaftSimulation | null = null;
  private raf = 0;
  private last = 0;
  private elapsed = 0;
  private hudAccum = 0;
  private phase: Phase = 'ready';
  private dockLeft = 0;
  private kbdSide = 0;
  private spaceHeld = false;
  private pointerDown = false;
  private ac = new AbortController();
  private jointFills: HTMLElement[] = [];

  constructor(
    private root: HTMLElement,
    private selection: SelectionState,
    private onFinish: (settlement: Settlement) => void,
    private onQuit: () => void,
  ) {}

  mount() {
    this.phase = 'ready';
    this.elapsed = 0;
    this.dockLeft = 0;
    const stream = STREAMS.find((s) => s.id === this.selection.streamId) ?? STREAMS[1];
    const weather = WEATHERS.find((w) => w.id === this.selection.weatherId) ?? WEATHERS[0];
    const config = makeRaftConfig(this.selection.presetIndex, this.selection.sectionCount);

    this.root.innerHTML = `
      <section class="screen game-screen">
        <canvas id="gameCanvas" aria-label="放排操作 WebGL2 画面"></canvas>
        <div class="rain-layer" style="opacity:${weather.rain * 0.34}"></div>
        <div class="vignette"></div>

        <header class="hud-top">
          <div class="hud-brand">
            <strong>${stream.name}</strong>
            <span>${weather.name}</span>
          </div>
          <div class="hud-timer">
            <span id="timeText">0:00</span>
            <small id="fpsText">-- FPS</small>
          </div>
          <div class="hud-actions">
            <button id="pauseBtn" class="hud-button" aria-label="暂停">⏸</button>
            <button id="quitBtn" class="hud-button" aria-label="返回地图">✕</button>
          </div>
        </header>

        <div class="progress-wrap">
          <div class="progress-label"><span>上游起点</span><span id="progressText">0%</span><span>下游码头</span></div>
          <div class="progress-track"><div id="progressFill" class="progress-fill"></div><div id="progressRaft" class="progress-raft">排</div></div>
          <div class="delivered-pill">已到节数 <strong id="deliveredText">0/${config.sections}</strong></div>
        </div>

        <aside class="hud-vitals">
          <div class="vital-row"><span>排速</span><strong id="speedText">0.0 m/s</strong></div>
          <div class="vital-row"><span>排头吃水</span><strong id="depthText">${config.draft.toFixed(2)} / -- m</strong></div>
          <div class="vital-row"><span>竹排完好</span><strong id="hpText">100%</strong></div>
          <div class="meter"><div id="hpFill" class="meter-fill hp"></div></div>
          <div class="status-line" id="statusLine">解开缆绳，准备放排。</div>
          <div class="charge-wrap"><span>撑篙蓄力</span><div class="charge-track"><div id="chargeFill"></div></div></div>
        </aside>

        <aside class="joint-panel">
          <div class="joint-title">藤条弯折 <small id="breakText">0 断</small></div>
          <div class="joint-bars" id="jointBars">
            ${Array.from({ length: Math.max(0, config.sections - 1) }, (_, i) => `<div class="joint-bar"><i data-joint="${i}"></i></div>`).join('')}
          </div>
          <div class="joint-legend"><span>绿安全</span><span>黄接近</span><span>红将断</span></div>
        </aside>

        <div class="event-stack" id="eventStack" aria-live="polite"></div>

        <div class="controls-bar">
          <button id="pushBtn" class="control-button push-button">🪵<span>下水推排</span><kbd>E</kbd></button>
          <div class="control-hint">
            <strong>移动鼠标/手指选择河底篙点</strong>
            <span>按住左键或 <kbd>Space</kbd> 蓄力，松开撑篙；<kbd>A</kbd><kbd>D</kbd> 调左右篙点；<kbd>E</kbd> 推排</span>
          </div>
          <button id="poleBtn" class="control-button pole-button">🎋<span>按住撑篙</span><kbd>Space</kbd></button>
        </div>

        <div class="dock-panel hidden" id="dockPanel">
          <strong>排头已到码头水域</strong>
          <p>等待后段竹节靠岸：<b id="dockTimer">28</b>s，也可以立即结算。</p>
          <button class="primary-button" id="settleNow">立即按已到竹子结算</button>
        </div>

        <div class="overlay" id="readyOverlay">
          <div class="overlay-card">
            <p class="eyebrow">${stream.name} · ${weather.name}</p>
            <h2>看水、顺弯、慎撑篙</h2>
            <p>${stream.story}</p>
            <div class="instruction-grid">
              <div><b>外急内缓</b><span>弯道外侧流速更快，但长排会切弯，提前摆正。</span></div>
              <div><b>石后回水</b><span>礁石下方反向水纹会把排尾吸回去。</span></div>
              <div><b>浅滩搁浅</b><span>当 ${config.draft.toFixed(2)}m 吃水大于水深时，按住 E 下水推排。</span></div>
              <div><b>藤条上限 ${config.maxBendDeg}°</b><span>弯折超过上限的那一道会断开；撑太猛容易折排。</span></div>
            </div>
            <button class="primary-button big" id="startBtn">解开缆绳，开始放排</button>
          </div>
        </div>

        <div class="overlay hidden" id="pauseOverlay">
          <div class="overlay-card narrow">
            <h2>暂停看水</h2>
            <p>水流和竹排都已停住。</p>
            <button class="primary-button big" id="resumeBtn">继续放排</button>
            <button class="secondary-button" id="restartBtn">重新放这一溪</button>
            <button class="text-button" id="pauseQuitBtn">返回河道地图</button>
          </div>
        </div>

      </section>
    `;

    const canvas = this.root.querySelector<HTMLCanvasElement>('#gameCanvas')!;
    try {
      this.renderer = new GameRenderer(canvas);
      this.water = new WaterModel(stream, weather);
      this.renderer.setWater(this.water);
      this.sim = new RaftSimulation(this.water, config, 88);
      this.jointFills = Array.from(this.root.querySelectorAll<HTMLElement>('.joint-bar i'));
    } catch (err) {
      const stage = this.root.querySelector('.game-screen');
      const div = document.createElement('div');
      div.className = 'webgl-error';
      div.textContent = `WebGL2 初始化失败：${err instanceof Error ? err.message : String(err)}`;
      stage?.appendChild(div);
      return;
    }

    this.bindUi(canvas);
    (window as unknown as { __raftGame?: GamePage }).__raftGame = this;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.renderer || !this.sim) return;
      const dt = Math.min((now - this.last) / 1000, 0.05);
      this.last = now;
      const active = this.phase === 'running' || this.phase === 'docking';
      if (active) {
        this.elapsed += dt;
        this.sim.update(dt);
        if (this.phase === 'running' && this.sim.headS >= this.water!.path.dockS - 2) this.enterDocking();
        if (this.phase === 'docking') {
          this.dockLeft -= dt;
          if (this.sim.deliveredCount() >= this.sim.config.sections) this.dockLeft = Math.min(this.dockLeft, 1.2);
          if (this.dockLeft <= 0) this.finish();
        }
      }
      if (this.spaceHeld && this.phase !== 'paused') this.updateAutoAim();
      this.renderer.renderGame(this.sim, dt, now / 1000);
      this.drainEvents();
      this.hudAccum += dt;
      if (this.hudAccum > 0.08) {
        this.updateHud();
        this.hudAccum = 0;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private bindUi(canvas: HTMLCanvasElement) {
    const signal = this.ac.signal;
    const $ = <T extends Element>(sel: string) => this.root.querySelector<T>(sel);

    $('#startBtn')?.addEventListener('click', () => this.start(), { signal });
    $('#pauseBtn')?.addEventListener('click', () => this.togglePause(), { signal });
    $('#resumeBtn')?.addEventListener('click', () => this.togglePause(false), { signal });
    $('#restartBtn')?.addEventListener('click', () => this.restart(), { signal });
    $('#quitBtn')?.addEventListener('click', () => this.onQuit(), { signal });
    $('#pauseQuitBtn')?.addEventListener('click', () => this.onQuit(), { signal });
    $('#settleNow')?.addEventListener('click', () => this.finish(), { signal });

    canvas.addEventListener(
      'pointermove',
      (e) => {
        if (!this.renderer || !this.sim) return;
        this.sim.aim = this.renderer.screenToWorld(e.clientX, e.clientY);
      },
      { signal },
    );
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.renderer || !this.sim || (this.phase !== 'running' && this.phase !== 'docking')) return;
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        const p = this.renderer.screenToWorld(e.clientX, e.clientY);
        this.sim.aim = p;
        this.sim.pressCharge(p);
        this.pointerDown = true;
      },
      { signal },
    );
    const up = (e: PointerEvent) => {
      if (!this.sim || !this.pointerDown) return;
      const p = this.renderer?.screenToWorld(e.clientX, e.clientY) ?? this.sim.aim;
      this.sim.releasePole(p);
      this.pointerDown = false;
    };
    canvas.addEventListener('pointerup', up, { signal });
    canvas.addEventListener('pointercancel', () => this.cancelCharge(), { signal });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

    const pushBtn = $('#pushBtn');
    const pushOn = (e: Event) => {
      e.preventDefault();
      this.sim?.setPush(true);
      pushBtn?.classList.add('active');
    };
    const pushOff = () => {
      this.sim?.setPush(false);
      pushBtn?.classList.remove('active');
    };
    pushBtn?.addEventListener('pointerdown', pushOn, { signal });
    pushBtn?.addEventListener('pointerup', pushOff, { signal });
    pushBtn?.addEventListener('pointercancel', pushOff, { signal });
    pushBtn?.addEventListener('pointerleave', pushOff, { signal });

    const poleBtn = $('#poleBtn');
    poleBtn?.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        if (!this.sim || (this.phase !== 'running' && this.phase !== 'docking')) return;
        this.updateAutoAim();
        this.sim.pressCharge();
        poleBtn.classList.add('active');
      },
      { signal },
    );
    const poleUp = () => {
      if (this.sim?.chargeHeld) this.sim.releasePole();
      poleBtn?.classList.remove('active');
    };
    poleBtn?.addEventListener('pointerup', poleUp, { signal });
    poleBtn?.addEventListener('pointercancel', () => {
      this.cancelCharge();
      poleBtn.classList.remove('active');
    }, { signal });
    poleBtn?.addEventListener('pointerleave', poleUp, { signal });

    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Space') {
          e.preventDefault();
          if (this.phase === 'ready') return this.start();
          if (this.phase === 'paused') return this.togglePause(false);
          if (!e.repeat && this.sim && (this.phase === 'running' || this.phase === 'docking')) {
            this.updateAutoAim();
            this.sim.pressCharge();
            this.spaceHeld = true;
          }
        } else if (e.code === 'KeyE') {
          if (!e.repeat) this.sim?.setPush(true);
          $('#pushBtn')?.classList.add('active');
        } else if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
          this.kbdSide = clamp(this.kbdSide - 0.85, -6.5, 6.5);
          this.updateAutoAim();
        } else if (e.code === 'KeyD' || e.code === 'ArrowRight') {
          this.kbdSide = clamp(this.kbdSide + 0.85, -6.5, 6.5);
          this.updateAutoAim();
        } else if (e.code === 'KeyP' || e.code === 'Escape') {
          this.togglePause();
        } else if (e.code === 'Enter' && this.phase === 'ready') {
          this.start();
        }
      },
      { signal },
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (e.code === 'Space') {
          e.preventDefault();
          if (this.spaceHeld && this.sim) this.sim.releasePole();
          this.spaceHeld = false;
        } else if (e.code === 'KeyE') {
          this.sim?.setPush(false);
          $('#pushBtn')?.classList.remove('active');
        }
      },
      { signal },
    );
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden && (this.phase === 'running' || this.phase === 'docking')) this.togglePause(true);
      },
      { signal },
    );
    window.addEventListener(
      'blur',
      () => {
        this.cancelCharge();
        this.sim?.setPush(false);
        this.spaceHeld = false;
        $('#pushBtn')?.classList.remove('active');
      },
      { signal },
    );
  }

  private updateAutoAim() {
    if (!this.sim || !this.water) return;
    const head = this.sim.headCenter();
    const pr = this.water.path.project(head);
    // Behind the head gives a forward reaction; side offset selects steering side.
    const long = -3.4;
    const side = this.kbdSide;
    this.sim.aim = {
      x: head.x + pr.frame.tangent.x * long + pr.frame.normal.x * side,
      y: head.y + pr.frame.tangent.y * long + pr.frame.normal.y * side,
    };
  }

  private cancelCharge() {
    if (this.sim) {
      this.sim.chargeHeld = false;
      this.sim.charge = 0;
      this.sim.pushHeld = false;
    }
    this.spaceHeld = false;
    this.pointerDown = false;
  }

  private start() {
    if (this.phase !== 'ready') return;
    this.phase = 'running';
    this.root.querySelector('#readyOverlay')?.classList.add('hidden');
  }

  private togglePause(force?: boolean) {
    if (this.phase === 'finished' || this.phase === 'ready') return;
    const shouldPause = force ?? this.phase !== 'paused';
    if (shouldPause) {
      this.phase = 'paused';
      this.cancelCharge();
      this.root.querySelector('#pauseOverlay')?.classList.remove('hidden');
    } else {
      this.phase = this.dockLeft > 0 ? 'docking' : 'running';
      this.root.querySelector('#pauseOverlay')?.classList.add('hidden');
      this.last = performance.now();
    }
  }

  private enterDocking() {
    this.phase = 'docking';
    this.dockLeft = 28;
    this.root.querySelector('#dockPanel')?.classList.remove('hidden');
    this.toast('reach', '排头到达码头水域！等待后段靠岸，或立即结算。');
  }

  private restart() {
    this.destroy();
    this.ac = new AbortController();
    this.mount();
  }

  private finish() {
    if (!this.sim || !this.water || this.phase === 'finished') return;
    this.phase = 'finished';
    const stream = STREAMS.find((s) => s.id === this.selection.streamId) ?? STREAMS[1];
    const weather = WEATHERS.find((w) => w.id === this.selection.weatherId) ?? WEATHERS[0];
    const settlement = buildSettlement(this.sim, this.elapsed, stream, weather);
    this.onFinish(settlement);
  }

  private toast(kind: string, text: string) {
    const stack = this.root.querySelector<HTMLElement>('#eventStack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = text;
    stack.appendChild(el);
    while (stack.children.length > 5) stack.firstElementChild?.remove();
    window.setTimeout(() => {
      el.classList.add('hide');
      window.setTimeout(() => el.remove(), 450);
    }, 4200);
  }

  private drainEvents() {
    if (!this.sim) return;
    for (const ev of this.sim.drainEvents()) this.toast(ev.kind, ev.text);
  }

  private updateHud() {
    if (!this.sim || !this.water) return;
    const sim = this.sim;
    const $ = <T extends Element>(sel: string) => this.root.querySelector<T>(sel);
    $('#timeText')!.textContent = formatTime(this.elapsed);
    $('#fpsText')!.textContent = `${this.renderer?.fps ?? 60} FPS`;
    const progress = clamp((sim.headS / this.water.path.dockS) * 100, 0, 100);
    const fill = $('#progressFill') as HTMLElement | null;
    const raftMarker = $('#progressRaft') as HTMLElement | null;
    if (fill) fill.style.width = `${progress}%`;
    if (raftMarker) raftMarker.style.left = `${progress}%`;
    const pt = $('#progressText');
    if (pt) pt.textContent = `${Math.round(progress)}%`;
    const dt = $('#deliveredText');
    if (dt) dt.textContent = `${sim.deliveredCount()}/${sim.config.sections}`;
    const sp = $('#speedText');
    if (sp) sp.textContent = `${sim.headSpeed.toFixed(1)} m/s`;
    const head = sim.headCenter();
    const flow = this.water.sample(head, sim.time);
    const depth = $('#depthText');
    if (depth) {
      depth.textContent = `${sim.config.draft.toFixed(2)} / ${flow.depth.toFixed(2)} m`;
      depth.className = sim.config.draft > flow.depth ? 'danger-text' : '';
    }
    const hp = Math.round(sim.averageHp());
    const hpText = $('#hpText');
    if (hpText) hpText.textContent = `${hp}%`;
    const hpFill = $('#hpFill') as HTMLElement | null;
    if (hpFill) {
      hpFill.style.width = `${hp}%`;
      hpFill.className = `meter-fill hp ${hp < 45 ? 'bad' : hp < 70 ? 'warn' : ''}`;
    }
    const charge = $('#chargeFill') as HTMLElement | null;
    if (charge) {
      charge.style.width = `${Math.round(sim.charge * 100)}%`;
      charge.style.background = sim.charge > 0.86 ? '#e8482f' : sim.charge > 0.55 ? '#f4c542' : '#65d68b';
    }
    const breakText = $('#breakText');
    if (breakText) breakText.textContent = `${sim.breaks} 断`;
    const dockTimer = $('#dockTimer');
    if (dockTimer) dockTimer.textContent = `${Math.max(0, Math.ceil(this.dockLeft))}`;

    let grounded = 0;
    let stuck = 0;
    for (const s of sim.sections) {
      if (s.grounded > 0.05) grounded++;
      if (s.stuckTimer > 0.05) stuck++;
    }
    const status = $('#statusLine');
    if (status) {
      if (sim.breaks > 0) status.textContent = `已有 ${sim.breaks} 道藤条崩断，失散排节要尽快收拢。`;
      else if (stuck > 0) status.textContent = `第 ${sim.sections.find((s) => s.stuckTimer > 0.05)!.index + 1} 节撞石被卡，后排正在挤压！`;
      else if (grounded > 0) status.textContent = `${grounded} 节擦浅/搁浅：吃水大于水深，按住 E 或“下水推排”。`;
      else if (sim.charge > 0.86) status.textContent = '蓄力已满！再不放篙，猛撑可能拉断藤条。';
      else status.textContent = '顺着水舌走，入弯前提前摆正长排。';
      status.className = `status-line ${grounded || stuck || sim.breaks ? 'alert' : ''}`;
    }

    for (let i = 0; i < this.jointFills.length; i++) {
      const joint = sim.joints[i];
      const el = this.jointFills[i];
      if (!joint || !el) continue;
      const stress = joint.active ? clamp(joint.stress, 0, 1.15) : 1;
      el.style.height = `${Math.min(100, stress * 100)}%`;
      el.dataset.state = !joint.active ? 'broken' : stress > 0.86 ? 'danger' : stress > 0.62 ? 'warn' : 'ok';
      el.title = joint.active ? `第${i + 1}道：${joint.angle.toFixed(1)}° / ${sim.config.maxBendDeg}°` : `第${i + 1}道已断`;
    }
  }

  destroy() {
    this.phase = 'finished';
    cancelAnimationFrame(this.raf);
    this.ac.abort();
    this.renderer?.dispose();
    this.renderer = null;
    this.sim = null;
    const w = window as unknown as { __raftGame?: GamePage };
    if (w.__raftGame === this) delete w.__raftGame;
  }
}
