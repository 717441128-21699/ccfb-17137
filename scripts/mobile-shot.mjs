import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:4174/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#mapCanvas');
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: 'node_modules/mobile-map.png' });
  await page.click('#toAssembly');
  await page.waitForSelector('#assemblyCanvas');
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: 'node_modules/mobile-assembly.png' });
  await page.click('#startGame');
  await page.waitForSelector('#startBtn');
  await page.click('#startBtn');
  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot({ path: 'node_modules/mobile-game.png' });
  console.log(errors.length ? errors.join('\n') : 'mobile smoke ok');
} finally {
  await browser.close();
}
