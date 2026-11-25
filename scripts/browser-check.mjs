import puppeteer from 'puppeteer-core';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4174/';
const errors = [];
const logs = [];

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--enable-webgl',
    ...(process.env.USE_HARDWARE_GPU ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    '--ignore-gpu-blocklist',
  ],
});

try {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    logs.push(`[${msg.type()}] ${text}`);
    if (msg.type() === 'error') errors.push(text);
  });
  page.on('pageerror', (err) => errors.push(err.stack ?? err.message));

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('#mapCanvas', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: 'node_modules/map.png' });

  const webgl2 = await page.evaluate(() => {
    const c = document.querySelector('#mapCanvas');
    return !!c?.getContext('webgl2');
  });
  if (!webgl2) throw new Error('WebGL2 context is unavailable');

  await page.click('[data-weather="flood"]');
  await new Promise((r) => setTimeout(r, 500));
  await page.click('#toAssembly');
  await page.waitForSelector('#assemblyCanvas', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: 'node_modules/assembly.png' });

  await page.click('#startGame');
  await page.waitForSelector('#startBtn', { timeout: 5000 });
  await page.click('#startBtn');
  await page.waitForSelector('#gameCanvas', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 500));

  // Aim, charge and release one pole, then hold push for a moment.
  await page.mouse.move(760, 520);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 650));
  await page.mouse.up();
  await page.keyboard.down('e');
  await new Promise((r) => setTimeout(r, 1200));
  await page.keyboard.up('e');

  const rafFps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        function tick() {
          frames++;
          if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
          else resolve(Math.round((frames * 1000) / (performance.now() - t0)));
        }
        requestAnimationFrame(tick);
      }),
  );

  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: 'node_modules/game.png' });
  const state = await page.evaluate(() => {
    const g = window.__raftGame;
    const sim = g?.sim;
    if (!sim) return null;
    let nan = 0;
    for (let i = 0; i < sim.nodeCount; i++) {
      if (!Number.isFinite(sim.x[i]) || !Number.isFinite(sim.y[i])) nan++;
    }
    return {
      phase: g.phase,
      headS: sim.headS,
      breaks: sim.breaks,
      rockHits: sim.rockHits,
      groundings: sim.groundings,
      delivered: sim.deliveredCount(),
      splashes: sim.splashes.length,
      nan,
      hudFps: document.querySelector('#fpsText')?.textContent,
    };
  });

  // Exercise settlement page directly.
  await page.evaluate(() => {
    const g = window.__raftGame;
    if (!g) throw new Error('game debug handle missing');
    g.finish();
  });
  await page.waitForSelector('.result-card', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: 'node_modules/result.png' });
  const resultText = await page.$eval('.result-card', (el) => el.textContent?.slice(0, 300));

  console.log(JSON.stringify({ webgl2, rafFps, state, resultText, errors }, null, 2));
  if (errors.length) {
    console.log(logs.slice(-30).join('\n'));
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
