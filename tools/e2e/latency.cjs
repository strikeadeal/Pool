// Screen-change responsiveness: for every screen change, how long the main thread is blocked and how long a tap on
// a button takes to respond once that button is on screen. Real input through Playwright, WebKit by default.
// Usage: node tools/e2e/latency.cjs [webkit|chromium] [--throttle[=main]] [--size se|standard] [--json out.json]
//   --throttle       Linux only, WebKit: the whole web content process (main thread, canvas raster, WebGL, workers)
//                    shares one core with three busy loops, 4.2x slower (measured), like a phone 4x slower than this one.
//   --throttle=main  only its main thread is slowed; its other threads run free on the other cores. That's what
//                    Chromium's CDP 4x CPU throttle does, and Chromium uses CDP for either option. It understates work the
//                    main thread waits on in another thread (WebKit rasterises canvases on helper threads).
// WebKit has no Long Tasks API, so a 4 ms timer loop stands in for it: a gap between ticks of more than 50 ms is a
// task (script, style, layout or paint) that held the main thread for that long, and input waited behind it.
const { chromium, webkit } = require('playwright');
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 8091;
const URL = `http://localhost:${PORT}/pool/`;
const SIZES = { se: [667, 375, 2, '0,0,0,0'], standard: [852, 393, 3, '0,59,21,59'] };

// Installed before any app script: the main-thread gap monitor and a record of every tap.
function monitor(watchSel) {
  const L = (window.__lat = { gaps: [], taps: [], watch: null });
  let last = performance.now();
  const tick = () => { const n = performance.now(); if (n - last > 20) L.gaps.push([last, n - last]); last = n; setTimeout(tick, 4); };
  setTimeout(tick, 4);
  document.addEventListener('click', (e) => {
    const t = { id: e.target.closest('button')?.id || e.target.closest('button')?.dataset.go || '', at: performance.now() };
    L.taps.push(t);
    // The next rendering update after the handlers has run on the main thread (rAF, then style, layout and paint,
    // then this timer). Compositing happens off the main thread and isn't counted: headless WPE composites in software.
    requestAnimationFrame(() => setTimeout(() => { t.frame = performance.now(); }, 0));
  }, true);
  // When the watched button first shows: checked every frame, so this is the frame it's painted in.
  L.watchFor = (sel) => {
    L.watch = { sel, at: null, box: null };
    const w = L.watch;
    const look = () => {
      if (L.watch !== w) return;
      const el = document.querySelector(sel);
      const booting = document.getElementById('app')?.classList.contains('booting') ?? true;
      if (el && !booting && el.checkVisibility({ visibilityProperty: true })) {
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2, top = document.elementFromPoint(x, y);
        // shown = visible and on top: under the rotate prompt, say, it isn't shown yet
        if (r.width > 0 && top && el.contains(top)) { w.at = performance.now(); w.box = [x, y]; return; }
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  };
  if (watchSel) L.watchFor(watchSel);   // a launch: watch from the first frame
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
function blocking(gaps, from, to) {
  const g = gaps.filter(([at, ms]) => at + ms > from && at < to).map(([, ms]) => ms);
  return { longest: g.length ? Math.max(...g) : 0, tbt: sum(g.map((ms) => Math.max(0, ms - 50))), over50: g.filter((ms) => ms > 50).length };
}

class Bench {
  constructor(browser, engineName, { throttle, size }) { Object.assign(this, { browser, engineName, throttle, size }); this.rows = []; }

  async page({ settings, sw = false, ctx = null, watch = null } = {}) {
    const [w, h, dpr, ins] = SIZES[this.size];
    const context = ctx || await this.browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: true,
      isMobile: this.engineName === 'chromium', serviceWorkers: sw ? 'allow' : 'block' });
    await context.addInitScript(monitor, watch);
    if (settings) await context.addInitScript((s) => { if (!localStorage.getItem('baize.v1.settings')) localStorage.setItem('baize.v1.settings', JSON.stringify({ schema: 1, rev: 1, data: s })); }, settings);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    page.url0 = `${URL}?insets=${ins}&standalone=1`;
    await this.slow(context, page);
    return { context, page };
  }

  async slow(context, page) {
    if (!this.throttle) return;
    if (this.engineName === 'chromium') { const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); return; }
    pinWebProcesses();
  }

  // Run `trigger` (the tap that changes the screen), then tap `target` the moment it shows. Records the main-thread
  // blocking from the trigger to 1.5 s after the target appeared, and the time from appearing to the tap's result
  // being painted. `check` confirms the tap did what that button does.
  async change(name, ...a) {
    try { return await this.change1(name, ...a); }
    catch (e) { const row = { name, ok: false, err: e.message.split('\n')[0] }; this.rows.push(row); console.log(`MISS  ${name.padEnd(44)} ${row.err}`); return row; }
  }
  async change1(name, page, trigger, target, check, { window: win = 1500, nav = false } = {}) {
    let t0 = 0;   // a launch counts from navigation start
    if (!nav) { await page.evaluate((sel) => window.__lat.watchFor(sel), target); t0 = await page.evaluate(() => performance.now()); }
    await trigger();
    const handle = await page.waitForFunction(() => window.__lat.watch.at != null && window.__lat.watch, null, { timeout: 30000, polling: 5 });
    const { at, box } = await handle.jsonValue();
    await tap(page, box);
    await page.waitForFunction((at) => window.__lat.taps.some((t) => t.at > at && t.frame), at, { timeout: 30000, polling: 10 });
    const ok = await check();
    await page.waitForTimeout(win);
    const r = await page.evaluate(({ t0, at, win }) => {
      const L = window.__lat, t = L.taps.find((x) => x.at > at);
      return { gaps: L.gaps.slice(), t0, at, tapAt: t.at, frame: t.frame, end: at + win };
    }, { t0, at, win });
    const b = blocking(r.gaps, r.t0, r.end);
    const row = { name, longest: Math.round(b.longest), tbt: Math.round(b.tbt), over50: b.over50, response: Math.round(r.frame - r.at), handled: Math.round(r.tapAt - r.at), ok,
      after: Math.round(blocking(r.gaps, r.at, r.end).longest), launch: nav, shown: nav ? Math.round(r.at) : undefined };
    this.rows.push(row);
    console.log(`${ok ? '    ' : 'MISS'}  ${name.padEnd(44)} longest ${String(row.longest).padStart(5)} ms  TBT ${String(row.tbt).padStart(5)} ms  visible→tap painted ${String(row.response).padStart(5)} ms (click handled at +${row.handled})${nav ? `; menu shown at ${row.shown} ms, longest after ${row.after} ms` : ''}`);
    return row;
  }
}

async function tap(page, [x, y]) { await page.mouse.click(x, y); }
const visible = (page, sel) => page.evaluate((s) => !!document.querySelector(s)?.checkVisibility(), sel);
const overlay = (page) => page.evaluate(() => window.__baize.overlay);
const screen = (page) => page.evaluate(() => window.__baize.screen);
async function click(page, sel) { const box = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel); await tap(page, box); }
async function settle(page, ms = 1200) { await page.waitForTimeout(ms); }

// Main thread (its thread id is the process id) on CPU 0 with the busy loops; every other thread on CPUs 1-3. A shell
// loop re-applies it every 250 ms (new threads, a worker say, inherit the affinity of the thread that starts them);
// it's a separate process so the pinning never stalls Playwright's input.
let OTHER = '0';   // where the web process's other threads go: '0' (whole process throttled) or '1-3' (main thread only)
const PIN_ONCE = () => `for p in $(pgrep -x WPEWebProcess); do for t in $(ls /proc/$p/task 2>/dev/null); do
  if [ "$t" = "$p" ]; then taskset -p -c 0 $t; else taskset -p -c ${OTHER} $t; fi; done; done >/dev/null 2>&1; true`;
function pinWebProcesses() { try { execSync(PIN_ONCE(), { shell: '/bin/sh' }); } catch { /* not Linux */ } }
let hogs = [];
function startHogs(mainOnly) {
  OTHER = mainOnly ? '1-3' : '0';
  for (let i = 0; i < 3; i++) hogs.push(spawn('taskset', ['-c', '0', 'sh', '-c', 'while :; do :; done'], { stdio: 'ignore' }));
  hogs.push(spawn('sh', ['-c', `while :; do ${PIN_ONCE()}; sleep 0.25; done`], { stdio: 'ignore' }));
}
function stopHogs() { for (const h of hogs) h.kill('SIGKILL'); hogs = []; }

// Every screen change in the brief. Returns the rows.
async function runAll(bench) {
  const B = bench;
  // ---- cold launch: tap the first menu button as soon as it shows ----
  {
    const { page, context } = await B.page({ watch: '[data-go="setup-cpu"]' });
    await B.change('cold launch → title', page, () => page.goto(page.url0), '[data-go="setup-cpu"]', async () => (await overlay(page)) === 'setup', { window: 2500, nav: true });
    await context.close();
  }
  // ---- the game: title → game → pause, restart, game over, play again, quit, continue ----
  {
    const { page, context } = await B.page({ settings: { tutorial: 3 } });
    await page.goto(page.url0); await settle(page);
    await click(page, '[data-go="setup-cpu"]'); await settle(page, 300);
    await B.change('title → game (Rack ’em)', page, () => click(page, '#setup-start'), '#menu-btn', async () => (await overlay(page)) === 'pause');
    await B.change('pause sheet closes (Resume)', page, () => click(page, '#p-resume'), '#spin-btn', async () => (await overlay(page)) === 'spin');
    await B.change('spin sheet closes (Done)', page, () => click(page, '#spin-done'), '#menu-btn', async () => (await overlay(page)) === 'pause');
    await click(page, '#p-restart'); await settle(page, 200);
    await B.change('restart from the pause sheet', page, () => click(page, '#p-restart'), '#menu-btn', async () => (await overlay(page)) === 'pause');
    await B.change('pause → settings sheet', page, () => click(page, '#pause [data-go="settings"]'), '#settings [data-back]', async () => (await overlay(page)) === 'pause');
    await B.change('pause → how to play sheet', page, () => click(page, '#pause [data-go="help"]'), '#help [data-back]', async () => (await overlay(page)) === 'pause');
    await B.change('concede → game-over sheet', page, () => click(page, '#p-forfeit'), '#o-again', async () => (await screen(page)) === 'game' && (await overlay(page)) === null);
    // that tap was "Play again"
    B.rows[B.rows.length - 1].name = 'game over sheet → Play again'; console.log('      (row above: the game-over sheet appearing, then Play again tapped)');
    await B.change('Play again → game', page, () => Promise.resolve(), '#menu-btn', async () => (await overlay(page)) === 'pause');
    await B.change('quit to the title', page, () => click(page, '#p-quit'), '#t-continue', async () => (await screen(page)) === 'game');
    await click(page, '#menu-btn'); await settle(page, 300); await click(page, '#p-quit'); await settle(page);
    await B.change('Continue → game', page, () => click(page, '#t-continue'), '#menu-btn', async () => (await overlay(page)) === 'pause');
    await click(page, '#p-quit'); await settle(page);
    // title sheets: open, then close
    for (const go of ['setup-cpu', 'setup-pvp', 'help', 'stats', 'settings']) {
      const sheet = go.startsWith('setup') ? 'setup' : go;
      await B.change(`title → ${go} sheet`, page, () => click(page, `[data-go="${go}"]`), `#${sheet} [data-back]`, async () => (await overlay(page)) === null);
    }
    // the viewport changing size, as iOS does when it settles after launch or rotation (DECISIONS.md §9.1), then a tap
    const [w, h] = SIZES[B.size];
    await B.change('viewport resizes on the title', page, () => page.setViewportSize({ width: w, height: h - 24 }), '[data-go="setup-cpu"]', async () => (await overlay(page)) === 'setup');
    await click(page, '#setup [data-back]'); await settle(page, 300);
    await click(page, '#t-continue'); await settle(page);
    await B.change('viewport resizes mid-game', page, () => page.setViewportSize({ width: w, height: h }), '#menu-btn', async () => (await overlay(page)) === 'pause');
    await click(page, '#p-resume'); await settle(page);
    // rotate: portrait, then back to landscape, then tap the menu at once
    await page.setViewportSize({ width: h, height: w }); await settle(page);
    await B.change('rotate back to landscape', page, () => page.setViewportSize({ width: w, height: h }), '#menu-btn', async () => (await overlay(page)) === 'pause');
    await context.close();
  }
  // ---- assisted aiming and left-handed: the game screen has its own layout ----
  for (const [label, s] of [['assisted aiming', { assist: true, tutorial: 3 }], ['left-handed', { left: true, tutorial: 3 }]]) {
    const { page, context } = await B.page({ settings: s });
    await page.goto(page.url0); await settle(page);
    await click(page, '[data-go="setup-pvp"]'); await settle(page, 300);
    await B.change(`title → game (${label})`, page, () => click(page, '#setup-start'), '#menu-btn', async () => (await overlay(page)) === 'pause');
    await B.change(`quit to the title (${label})`, page, () => click(page, '#p-quit'), '#t-continue', async () => (await screen(page)) === 'game');
    await context.close();
  }
  return B.rows;
}

// An update waiting while the player taps, at the three moments the app has reloaded for one: launch, the game-over
// sheet, and quitting to the menu. A person taps a button about 150 ms after it appears at the quickest; the tap must
// do what it says, not vanish in a reload. Timed from Node, since the page itself may be replaced.
async function runUpdates(bench) {
  const B = bench, rows = [];
  const [w, h, dpr] = SIZES[B.size];
  const ctx = await B.browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: true });
  const { page, context } = await B.page({ sw: true, ctx });
  let loads = 0; page.on('load', () => loads++);
  await page.goto(page.url0);
  await page.waitForFunction(() => navigator.serviceWorker.controller && window.__baize && !document.getElementById('app').classList.contains('booting'), null, { timeout: 20000 });
  await settle(page, 4500);   // past launch: the previous version treated the first 4 s as launch and reloaded then
  const pending = async (v) => { build(v); await page.evaluate(() => window.__swReg.update()); await page.waitForFunction(() => window.__swReg?.waiting, null, { timeout: 20000 }); };
  const tapWhenShown = async (sel) => {
    const t0 = Date.now();
    let box = null;
    while (!box && Date.now() - t0 < 15000) {
      box = await page.evaluate((s) => { const e = document.querySelector(s), a = document.getElementById('app'); if (!e || !a || a.classList.contains('booting') || !e.checkVisibility({ visibilityProperty: true })) return null; const r = e.getBoundingClientRect(); return r.width ? [r.x + r.width / 2, r.y + r.height / 2] : null; }, sel).catch(() => null);
      if (!box) await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 150));
    if (box) await page.mouse.click(...box).catch(() => {});   // never shown: recorded as a lost tap
    await page.waitForTimeout(3000);
  };
  const record = async (name, okFn, l0) => {
    const ok = await okFn().catch(() => false), reloads = loads - l0, v = await page.evaluate(() => window.__baize.version).catch(() => '?');
    rows.push({ name, ok, reloads, version: v }); B.rows.push({ name, ok, reloads });
    console.log(`${ok ? '    ' : 'MISS'}  ${name.padEnd(44)} tap 150 ms after the button showed ${ok ? 'worked' : 'was lost'}; ${reloads} reload(s); now ${v}`);
  };
  // 1. launch with a downloaded update waiting
  await pending('u1');
  let l0 = loads;
  await page.goto('about:blank'); l0 = loads;
  await page.goto(page.url0).catch(() => {});
  await tapWhenShown('[data-go="setup-cpu"]');
  await record('update waiting at launch → tap the menu', async () => (await overlay(page)) === 'setup', l0 + 1);
  await click(page, '#setup [data-back]'); await settle(page, 300);
  // 1b. a deploy while the app was closed: the update is found, downloaded and ready during the launch itself
  await page.goto('about:blank'); build('u1b'); l0 = loads;
  await page.goto(page.url0).catch(() => {});
  await tapWhenShown('[data-go="setup-cpu"]');
  await record('update found during launch → tap the menu', async () => (await overlay(page)) === 'setup', l0 + 1);
  await click(page, '#setup [data-back]'); await settle(page, 300);
  // 2. game over with an update waiting
  await click(page, '[data-go="setup-pvp"]'); await settle(page, 300); await click(page, '#setup-start'); await settle(page, 600);
  await pending('u2');
  l0 = loads;
  await click(page, '#menu-btn'); await settle(page, 300); await click(page, '#p-forfeit');
  await tapWhenShown('#o-again');
  await record('update waiting at game over → Play again', async () => (await screen(page)) === 'game' && (await page.evaluate(() => window.__baize.game?.phase)) !== 'over' && (await overlay(page)) === null, l0);
  // 3. quitting to the menu with an update waiting
  await pending('u3');
  l0 = loads;
  await click(page, '#menu-btn'); await settle(page, 300); await click(page, '#p-quit');
  await tapWhenShown('[data-go="setup-cpu"]');
  await record('update waiting, quit to menu → tap the menu', async () => (await overlay(page)) === 'setup', l0);
  await context.close();
  build();
  return rows;
}

function build(suffix = '') { execSync('node tools/build.mjs', { cwd: ROOT, env: { ...process.env, BAIZE_VERSION_SUFFIX: suffix }, stdio: 'pipe' }); }
// Fails if the port is taken: a server left over from another run (or another tree) would be measured instead.
function serve() {
  const p = spawn(process.execPath, ['tools/serve.mjs', String(PORT), '/pool/'], { cwd: ROOT, stdio: 'ignore' });
  return new Promise((res, rej) => { p.on('exit', () => rej(new Error(`port ${PORT} is in use`))); setTimeout(() => res(p), 400); });
}

module.exports = { Bench, runAll, runUpdates, build, serve, startHogs, stopHogs, URL };

if (require.main === module) (async () => {
  const engineName = process.argv[2] === 'chromium' ? 'chromium' : 'webkit';
  const throttle = process.argv.some((a) => a.startsWith('--throttle'));
  const mainOnly = process.argv.includes('--throttle=main');
  const size = process.argv.includes('--size') ? process.argv[process.argv.indexOf('--size') + 1] : 'se';
  const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
  build();
  const server = await serve();
  const browser = await (engineName === 'chromium' ? chromium : webkit).launch(engineName === 'chromium' ? { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {});
  if (throttle && engineName === 'webkit') startHogs(mainOnly);
  console.log(`${engineName} ${browser.version()}, ${size} ${SIZES[size].slice(0, 3).join('×')}, ${throttle ? `4x CPU throttle (${mainOnly ? 'main thread' : 'whole process'})` : 'no throttle'}`);
  const bench = new Bench(browser, engineName, { throttle, size });
  try { await runAll(bench); await runUpdates(bench); }
  finally { stopHogs(); await browser.close(); server.kill(); build(); }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ engine: engineName, version: browser.version(), size, throttle: throttle && (mainOnly ? 'main' : 'process'), rows: bench.rows }, null, 1));
  const worst = bench.rows.filter((r) => r.longest != null);
  console.log(`\nworst: longest task ${Math.max(...worst.map((r) => r.longest))} ms, worst visible→tap painted ${Math.max(...worst.map((r) => r.response))} ms, ${bench.rows.filter((r) => !r.ok).length} taps missed`);
})();
