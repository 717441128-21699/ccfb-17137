// 界面装配：河道地图页 → 竹排编组页 → 放排操作页 → 码头结算页。
import { RIVERS } from './rivers.js';
import { makeRaftConfig } from './raft.js';
import { GameRun } from './game.js';
import { Renderer } from './render.js';
import { WeatherTimeline } from './weather.js';
import { POLE_SAFE_FORCE, POLE_MAX_FORCE } from './pole.js';
import { clamp } from './math.js';
const $ = (sel) => document.querySelector(sel);
// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
const canvas = $('#view');
const renderer = new Renderer(canvas);
let currentRiver = RIVERS[0];
let run = null;
let rafId = 0;
let cam = { x: 0, y: 0 };
let viewHalfH = 26;
let lastTime = 0;
let acc = 0;
let fps = 60;
const FIXED_DT = 1 / 60;
// 编组参数
const setup = { sections: 20, bamboos: 8, rattan: 'old' };
function showScreen(id) {
    for (const el of document.querySelectorAll('.screen'))
        el.classList.remove('active');
    const panel = document.getElementById(id); // 放排页没有覆盖层，只有画布+HUD
    if (panel)
        panel.classList.add('active');
    canvas.style.visibility = id === 'screen-run' ? 'visible' : 'hidden';
    $('#hud').classList.toggle('active', id === 'screen-run');
}
// ---------------------------------------------------------------------------
// 页一：河道地图
// ---------------------------------------------------------------------------
function buildMapPage() {
    const list = $('#river-list');
    list.innerHTML = '';
    for (const r of RIVERS) {
        const tl = new WeatherTimeline(r.weatherSeed, r.difficulty);
        const fc = tl.forecast().map(f => `<span class="wx" title="${f.name}">${f.icon}</span>`).join('');
        const stars = '★'.repeat(r.difficulty) + '☆'.repeat(5 - r.difficulty);
        const card = document.createElement('div');
        card.className = 'river-card';
        card.innerHTML = `
      <div class="river-head"><b>${r.name}</b><span class="stars">${stars}</span></div>
      <div class="river-sub">${r.subtitle}</div>
      <p>${r.description}</p>
      <div class="river-meta">
        <span>礁石 ${r.rocks.length} 处</span><span>浅滩 ${r.shoals.length} 处</span>
        <span>每节工钱 ${r.rewardBase} 文</span><span class="forecast">天气 ${fc}</span>
      </div>`;
        card.onclick = () => { currentRiver = r; openAssembly(); };
        list.appendChild(card);
    }
}
// ---------------------------------------------------------------------------
// 页二：竹排编组
// ---------------------------------------------------------------------------
function openAssembly() {
    $('#asm-river-name').textContent = currentRiver.name;
    updateAssembly();
    showScreen('screen-assembly');
}
function updateAssembly() {
    $('#asm-sections-val').textContent = `${setup.sections} 节`;
    $('#asm-bamboos-val').textContent = `${setup.bamboos} 筒`;
    const cfg = makeRaftConfig(setup.sections, setup.bamboos, setup.rattan);
    const draft = 0.28 + setup.bamboos * 0.028;
    const totalLen = (setup.sections * cfg.sectionLength).toFixed(0);
    $('#asm-stats').innerHTML = `
    <div><b>${totalLen} 米</b><span>排总长</span></div>
    <div><b>${draft.toFixed(2)} 米</b><span>吃水</span></div>
    <div><b>${(cfg.rattanMaxBend * 180 / Math.PI).toFixed(0)}°</b><span>藤条允许弯折</span></div>
    <div><b>${setup.sections * currentRiver.rewardBase} 文</b><span>满排满货运到工钱</span></div>`;
    const warn = [];
    if (draft > 0.5)
        warn.push('吃水偏深，过浅滩要当心搁浅');
    if (setup.sections >= 26)
        warn.push('排太长，过弯时排尾甩得厉害，藤条吃力');
    if (setup.rattan === 'new')
        warn.push('新藤脆，弯折余量小，撑篙别太猛');
    $('#asm-warn').innerHTML = warn.map(w => `<li>${w}</li>`).join('');
}
function bindAssembly() {
    $('#asm-sections').oninput = (e) => {
        setup.sections = +e.target.value;
        updateAssembly();
    };
    $('#asm-bamboos').oninput = (e) => {
        setup.bamboos = +e.target.value;
        updateAssembly();
    };
    for (const btn of document.querySelectorAll('.rattan-btn')) {
        btn.onclick = () => {
            setup.rattan = btn.dataset.v;
            for (const b of document.querySelectorAll('.rattan-btn'))
                b.classList.remove('sel');
            btn.classList.add('sel');
            updateAssembly();
        };
    }
    $('#asm-start').onclick = () => startRun();
    $('#asm-back').onclick = () => showScreen('screen-map');
}
// ---------------------------------------------------------------------------
// 页三：放排操作
// ---------------------------------------------------------------------------
function resize() {
    canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
    canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
}
window.addEventListener('resize', resize);
function startRun() {
    const cfg = makeRaftConfig(setup.sections, setup.bamboos, setup.rattan);
    run = new GameRun(currentRiver, cfg);
    renderer.setRiver(run.flow.geo, run.flow, run.rocksWorld);
    cam.x = run.raft.head.pos.x;
    cam.y = run.raft.head.pos.y;
    viewHalfH = 26;
    run.onEvent = (kind, idx) => {
        const msgs = {
            break: `第 ${idx + 1} 处藤条断了！排散了！`,
            ground: `第 ${idx + 1} 节搁浅了，等涨水或用篙撑`,
            stuck: `第 ${idx + 1} 节卡在石头上了！`,
            damage: `第 ${idx + 1} 节撞伤了`,
        };
        toast(msgs[kind], kind === 'break' ? 'bad' : 'warn');
    };
    showScreen('screen-run');
    resize();
    lastTime = performance.now();
    acc = 0;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
}
function screenToWorld(px, py) {
    const rect = canvas.getBoundingClientRect();
    const nx = ((px - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((py - rect.top) / rect.height) * 2;
    const aspect = canvas.width / canvas.height;
    return { x: cam.x + nx * viewHalfH * aspect, y: cam.y + ny * viewHalfH };
}
function bindRunInput() {
    canvas.addEventListener('pointerdown', (e) => {
        if (!run || run.phase === 'done')
            return;
        const w = screenToWorld(e.clientX, e.clientY);
        if (!run.pole.plant(run.raft.head.pos, w, run.flow, run.weather)) {
            toast(run.pole.invalidReason, 'warn');
        }
        canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', () => run?.pole.release());
    canvas.addEventListener('pointercancel', () => run?.pole.release());
    canvas.addEventListener('wheel', (e) => {
        viewHalfH = clamp(viewHalfH * (e.deltaY > 0 ? 1.12 : 0.9), 14, 60);
        e.preventDefault();
    }, { passive: false });
    $('#btn-quit').onclick = () => { if (run) {
        run.phase = 'done';
        settle();
    } };
}
let toastTimer = 0;
function toast(msg, kind = 'info') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { el.className = ''; }, 2200);
}
function loop(now) {
    if (!run)
        return;
    const frameStart = performance.now();
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    dt = Math.min(dt, 0.1);
    fps = fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
    // 固定步长物理
    acc += dt;
    let steps = 0;
    while (acc >= FIXED_DT && steps < 5) {
        run.step(FIXED_DT);
        acc -= FIXED_DT;
        steps++;
    }
    // 相机跟随排头
    const head = run.raft.head;
    cam.x += (head.pos.x - cam.x) * 0.08;
    cam.y += (head.pos.y - cam.y) * 0.08;
    renderer.render(cam, viewHalfH, run.raft, run.pole, { levelMul: run.weather.levelMul, rain: run.weather.rain }, now / 1000, run.dockPos, run.dockAngle);
    updateHud();
    if (run.phase === 'done') {
        settle();
        return;
    }
    rafId = requestAnimationFrame(loop);
    void frameStart;
}
function updateHud() {
    if (!run)
        return;
    const head = run.raft.head;
    const speed = Math.hypot(head.vel.x, head.vel.y);
    $('#hud-wx').textContent = `${run.weather.icon} ${run.weather.name}`;
    $('#hud-speed').textContent = `${speed.toFixed(1)} m/s`;
    $('#hud-depth').textContent = `水深 ${head.depth.toFixed(2)}m / 吃水 ${run.raft.draft.toFixed(2)}m`;
    const prog = clamp(head.s / run.dockS, 0, 1);
    $('#hud-progress-fill').style.width = `${(prog * 100).toFixed(1)}%`;
    // 藤条状态：最差的 5 个关节
    const joints = run.raft.joints
        .map((j, i) => ({ i, strain: j.broken ? 1 : j.strain / run.raft.cfg.rattanStrainLimit, broken: j.broken }))
        .sort((a, b) => b.strain - a.strain).slice(0, 6);
    $('#hud-joints').innerHTML = joints.map(j => `<span class="joint ${j.broken ? 'broken' : j.strain > 0.6 ? 'hot' : ''}" title="关节 ${j.i + 1}"></span>`).join('');
    // 篙力表
    const forceRatio = run.poleInput.active
        ? Math.hypot(run.poleInput.force.x, run.poleInput.force.y) / POLE_MAX_FORCE : 0;
    $('#hud-pole-fill').style.width = `${forceRatio * 100}%`;
    $('#hud-pole-fill').style.background =
        forceRatio * POLE_MAX_FORCE > POLE_SAFE_FORCE ? '#e05038' : '#7ec850';
    $('#hud-phase').textContent = run.phase === 'landing' ? `靠岸中… ${Math.ceil(run.landingTimer)}s` : '';
    if (run.poleInput.active && run.poleInput.overstress > 0.4) {
        $('#hud-pole-warn').textContent = '篙太猛了，藤条吃不消！';
    }
    else
        $('#hud-pole-warn').textContent = '';
}
// ---------------------------------------------------------------------------
// 页四：码头结算
// ---------------------------------------------------------------------------
function settle() {
    if (!run)
        return;
    const r = run.result(currentRiver);
    cancelAnimationFrame(rafId);
    $('#settle-title').textContent = `${currentRiver.name} · 到港结算`;
    $('#settle-rows').innerHTML = `
    <div><span>运到竹子</span><b>${r.delivered} / ${r.total} 节</b></div>
    <div><span>平均完好度</span><b>${(r.avgCondition * 100).toFixed(0)}%</b></div>
    <div><span>散失在半路</span><b>${r.lost} 节</b></div>
    <div><span>断藤</span><b>${r.stats.jointsBroken} 处</b></div>
    <div><span>搁浅 / 卡石</span><b>${r.stats.groundings} 次 / ${r.stats.stucks} 次</b></div>
    <div><span>用时</span><b>${r.timeSec.toFixed(0)} 秒</b></div>
    <div class="total"><span>工钱</span><b>${r.score} 文（满额 ${r.maxScore}）</b></div>`;
    $('#settle-rating').textContent = `老排工点评：${r.rating}`;
    showScreen('screen-settle');
    run = null;
}
function bindSettle() {
    $('#btn-again').onclick = () => openAssembly();
    $('#btn-map').onclick = () => { buildMapPage(); showScreen('screen-map'); };
}
// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
buildMapPage();
bindAssembly();
bindRunInput();
bindSettle();
// ---------------------------------------------------------------------------
// 展馆待机演示模式：?demo 或 ?demo=luoyan 自动开排、自动撑篙
// ---------------------------------------------------------------------------
function autopilot() {
    if (!run || run.phase === 'done')
        return;
    const h = run.raft.head;
    const spd = Math.hypot(h.vel.x, h.vel.y);
    if (run.pole.state === 'idle' && spd < 1.0) {
        const fs = { vel: { x: 0, y: 0 }, depth: 0, s: 0, t: 0, inRiver: true };
        run.flow.sample(h.pos, run.weather, fs);
        const fl = Math.hypot(fs.vel.x, fs.vel.y) || 1;
        const target = { x: h.pos.x - fs.vel.x / fl * 3, y: h.pos.y - fs.vel.y / fl * 3 };
        run.pole.plant(h.pos, target, run.flow, run.weather);
        setTimeout(() => run?.pole.release(), 600);
    }
}
const demoMatch = location.search.match(/demo(?:=([a-z]+))?/);
if (demoMatch) {
    const r = RIVERS.find(r => r.id === demoMatch[1]);
    if (r)
        currentRiver = r;
    startRun();
    // ?freeze=秒：加载后同步快进，便于截图/检查某一时刻的画面
    const freeze = location.search.match(/freeze=([\d.]+)/);
    const g = run;
    if (freeze && g) {
        const n = Math.min(600 * 60, Math.round(parseFloat(freeze[1]) * 60));
        for (let i = 0; i < n; i++)
            g.step(FIXED_DT);
        cam.x = g.raft.head.pos.x;
        cam.y = g.raft.head.pos.y; // 快进后把相机直接放到排头
    }
    setInterval(autopilot, 500);
}
else {
    showScreen('screen-map');
}
//# sourceMappingURL=main.js.map