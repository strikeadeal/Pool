// End-to-end verification in real Chromium (and WebKit if installed) against the production
// build served under a subpath. Needs Playwright: `npm i -D playwright` (not needed to build).
// Usage: npm run build && node tools/e2e/verify.cjs [chromium|webkit] [--shots]
const { chromium, webkit } = require('playwright');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const BASE = '/pool/';
const PORT = 8090;
const URL = `http://localhost:${PORT}${BASE}`;
const engine = process.argv[2] === 'webkit' ? webkit : chromium;
const engineName = process.argv[2] === 'webkit' ? 'webkit' : 'chromium';
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const results = [];
const errors = [];
const ok = (name, pass, info = '') => { results.push({ name, pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

function build(suffix = '') {
  execSync('node tools/build.mjs', { cwd: ROOT, env: { ...process.env, BAIZE_VERSION_SUFFIX: suffix }, stdio: 'pipe' });
}
function serve() {
  const p = spawn(process.execPath, ['tools/serve.mjs', String(PORT), BASE], { cwd: ROOT, stdio: 'ignore' });
  return new Promise((r) => setTimeout(() => r(p), 400));
}
const launchArgs = engineName === 'chromium' ? { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {};

async function newPage(browser, { w = 393, h = 852, dpr = 2, insets = '', ctx = null } = {}) {
  const context = ctx || await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: true, isMobile: engineName === 'chromium' });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${w}x${h}] console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${w}x${h}] pageerror: ${e.message}`));
  return { context, page, url: URL + (insets ? `?insets=${insets}&standalone=1` : '') };
}
const B = (page, fn, arg) => page.evaluate(fn, arg);

// Take the current player's turn using the computer's brain, through the real shoot path.
async function aiTurn(page, level = 3, ff = 4) {
  await page.evaluate(async ({ level, ff }) => {
    const Bz = window.__baize;
    const { decideSync } = await import('./js/ai.js');
    const g = Bz.game;
    const d = decideSync(g, level, (g.shotNo * 7919 + 13) >>> 0);
    if (d.place) Bz.app.tryPlaceCue(d.place[0], d.place[1]);
    if (d.called != null) Bz.game.called = d.called;
    Bz.setAim(Math.atan2(d.shot.dy, d.shot.dx));
    Bz.shoot(0, d);
    if (Bz.pb) Bz.pb.speed = ff;
  }, { level, ff });
}
async function waitIdle(page, timeout = 60000) {
  await page.waitForFunction(() => { const b = window.__baize; return b && !b.pb && !b.cpu; }, null, { timeout });
}
// Drive a game to the end. Human turns use the AI hook; computer turns play themselves.
async function playToEnd(page, maxTurns = 300) {
  for (let i = 0; i < maxTurns; i++) {
    const st = await B(page, () => {
      const b = window.__baize, g = b.game;
      if (!g) return 'none';
      if (g.phase === 'over') return 'over';
      if (b.overlay === 'decision') return 'decision';
      if (b.pb || b.cpu) return 'busy';
      return b.app.inputEnabled() ? 'human' : 'wait';
    });
    if (st === 'over') return true;
    if (st === 'decision') { await page.click('#dec-opts button'); continue; }
    if (st === 'human') { await aiTurn(page); await waitIdle(page); continue; }
    if (st === 'busy') { await B(page, () => { if (window.__baize.pb) window.__baize.pb.speed = 4; }); }
    await page.waitForTimeout(150);
  }
  return false;
}

(async () => {
  build();
  let server = await serve();
  const browser = await engine.launch(launchArgs);
  try {
    // ---------- 1. screenshots at three phone sizes, both orientations ----------
    const devices = [
      ['se', 375, 667, 2, '20,0,0,0', '0,0,0,0'],
      ['standard', 393, 852, 3, '59,0,34,0', '0,59,21,59'],
      ['promax', 430, 932, 3, '59,0,34,0', '0,59,21,59'],
    ];
    if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
    for (const [name, w, h, dpr, ip, il] of devices) {
      for (const [orient, vw, vh, ins] of [['portrait', w, h, ip], ['landscape', h, w, il]]) {
        const { page, context, url } = await newPage(browser, { w: vw, h: vh, dpr, insets: ins });
        await page.goto(url);
        await page.waitForTimeout(700);
        if (SHOTS) await page.screenshot({ path: `${OUT}/${name}-${orient}-title.jpg`, quality: 82, type: 'jpeg' });
        await page.click('[data-go="setup-cpu"]');
        await page.click('#setup-start');
        await page.waitForTimeout(300);
        await aiTurn(page); await waitIdle(page);
        await page.waitForFunction(() => window.__baize.app.inputEnabled() || window.__baize.game.phase !== 'play', null, { timeout: 60000 }).catch(() => {});
        await waitIdle(page);
        await page.waitForTimeout(2600);
        const lay = await B(page, () => window.__baize.lay);
        // nothing may sit outside the screen or overlap the table
        const rects = await B(page, () => ['hud', 'power', 'roller', 'spin-btn'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, r.left, r.top, r.right, r.bottom]; }));
        const inside = rects.every(([, l, t, r, b]) => l >= 0 && t >= 0 && r <= vw + 0.5 && b <= vh + 0.5);
        const tb = lay.table;
        const clearOfTable = rects.filter(([id]) => id !== 'hud').every(([, l, t, r, b]) => r <= tb.x + 1 || l >= tb.x + tb.w - 1 || b <= tb.y + 1 || t >= tb.y + tb.h - 1);
        const [it, ir, ib, il2] = ins.split(',').map(Number);
        const safe = rects.every(([, l, t, r, b]) => t >= it - 0.5 && b <= vh - ib + 0.5 && l >= il2 - 0.5 && r <= vw - ir + 0.5);
        ok(`layout ${name} ${orient}: controls on screen, inside safe area, clear of the table`, inside && clearOfTable && safe, `ball ${lay.ballPx.toFixed(1)}px, table ${Math.round(tb.w)}×${Math.round(tb.h)}`);
        if (SHOTS) await page.screenshot({ path: `${OUT}/${name}-${orient}-game.jpg`, quality: 82, type: 'jpeg' });
        await context.close();
      }
    }

    // ---------- 1b. assisted aiming and left-handed layouts ----------
    for (const [orient, vw, vh, ins] of [['portrait', 393, 852, '59,0,34,0'], ['landscape', 852, 393, '0,59,21,59']]) {
      for (const left of [false, true]) {
        const { page, context, url } = await newPage(browser, { w: vw, h: vh, dpr: 1 });
        await page.goto(`${URL}?insets=${ins}&standalone=1`);
        await page.evaluate((left) => localStorage.setItem('baize.v1.settings', JSON.stringify({ schema: 1, rev: 1, data: { assist: true, left, tutorial: 3 } })), left);
        await page.reload(); await page.waitForTimeout(300);
        await page.click('[data-go="setup-pvp"]'); await page.click('#setup-start'); await page.waitForTimeout(300);
        const r = await B(page, () => {
          const box = (id) => { const e = document.getElementById(id); if (!e || e.offsetParent === null) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
          const t = window.__baize.lay.table;
          return { assist: box('assist'), power: box('power'), spin: box('spin-btn'), roller: box('roller'), table: { l: t.x, t: t.y, r: t.x + t.w, b: t.y + t.h }, ball: window.__baize.lay.ballPx };
        });
        const ov = (a, b) => a && b && a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
        const inside = (a, b) => a.l >= b.l - 0.5 && a.r <= b.r + 0.5 && a.t >= b.t - 0.5 && a.b <= b.b + 0.5;
        const good = r.assist && !ov(r.assist, r.power) && !ov(r.assist, r.table) && !ov(r.power, r.table) && inside(r.spin, r.assist) && (!r.roller || (!ov(r.roller, r.assist) && !ov(r.roller, r.table)));
        ok(`assisted aiming ${orient}${left ? ' left-handed' : ''}: panel, power and table don't overlap`, good, `ball ${r.ball.toFixed(1)}px`);
        await context.close();
      }
    }

    // ---------- 2. aim and power are position-based: same path at 60 Hz vs 120 Hz event density ----------
    {
      const { page, context, url } = await newPage(browser);
      await page.goto(url); await page.waitForTimeout(500);
      await page.click('[data-go="practice"]'); await page.waitForTimeout(400);
      const lay = await B(page, () => window.__baize.lay);
      const drag = async (steps) => {
        await B(page, () => window.__baize.setAim(Math.PI / 2));
        await page.mouse.move(lay.cx + 90, lay.cy + 100); await page.mouse.down();
        for (let i = 1; i <= steps; i++) await page.mouse.move(lay.cx + 90 - (60 * i) / steps, lay.cy + 100 - (140 * i) / steps);
        await page.mouse.up();
        return B(page, () => window.__baize.app.aim);
      };
      const a60 = await drag(8), a120 = await drag(16), a240 = await drag(64);
      const spread = Math.max(Math.abs(a60 - a120), Math.abs(a120 - a240)) * 180 / Math.PI;
      ok('aim drag: result independent of event rate (8/16/64 events)', spread < 0.3, `spread ${spread.toFixed(3)}°`);
      // fine roller: 100 px at any rate = 100 * fineAimDegPerPt
      const r = lay.roller;
      const fine = async (steps) => {
        await B(page, () => window.__baize.setAim(0));
        await page.mouse.move(r.x + 20, r.y + r.h / 2); await page.mouse.down();
        for (let i = 1; i <= steps; i++) await page.mouse.move(r.x + 20 + (100 * i) / steps, r.y + r.h / 2);
        await page.mouse.up();
        return B(page, () => window.__baize.app.aim * 180 / Math.PI);
      };
      const f1 = await fine(5), f2 = await fine(50);
      ok('fine roller: 100 px gives the same aim change at any event rate', Math.abs(f1 - f2) < 1e-9 && Math.abs(Math.abs(f1) - 1.2) < 1e-6, `${f1.toFixed(4)}° vs ${f2.toFixed(4)}°`);
      await context.close();
    }

    // ---------- 3. complete pass-and-play game through the UI ----------
    {
      const { page, context, url } = await newPage(browser);
      await page.goto(url); await page.waitForTimeout(500);
      await page.click('[data-go="setup-pvp"]');
      await page.fill('#name-0', 'Alex'); await page.fill('#name-1', 'Sam');
      await page.click('#setup-start');
      const t0 = Date.now();
      const done = await playToEnd(page);
      const over = await B(page, () => ({ phase: window.__baize.game?.phase, reason: window.__baize.game?.winReason, shots: window.__baize.game?.shotNo }));
      await page.waitForSelector('#over:not([hidden])', { timeout: 5000 }).catch(() => {});
      const shown = await page.isVisible('#over');
      ok('complete pass-and-play game reaches a winner with the game-over screen', done && over.phase === 'over' && shown, `${over.shots} shots, ${((Date.now() - t0) / 1000).toFixed(0)} s: ${over.reason}`);
      if (SHOTS) await page.screenshot({ path: `${OUT}/standard-portrait-gameover.jpg`, quality: 82, type: 'jpeg' });
      await context.close();
    }

    // ---------- 3b. illegal break: the incoming player gets the WPA choice ----------
    {
      const { page, context, url } = await newPage(browser);
      await page.goto(url); await page.waitForTimeout(400);
      await page.click('[data-go="setup-pvp"]'); await page.click('#setup-start'); await page.waitForTimeout(300);
      await page.evaluate(() => {
        const Bz = window.__baize, b = Bz.game.balls;
        Bz.setAim(Math.atan2(0.495 - b.y[0], 1.485 - b.x[0]));
        Bz.shoot(0.18);   // far too soft to send four balls to a cushion
        if (Bz.pb) Bz.pb.speed = 4;
      });
      await waitIdle(page);
      await page.waitForSelector('#decision:not([hidden])', { timeout: 5000 }).catch(() => {});
      const opts = await page.$$eval('#dec-opts button', (b) => b.map((x) => x.textContent));
      await page.click('#dec-opts button:nth-child(2)').catch(() => {});
      await page.waitForTimeout(300);
      const after = await B(page, () => ({ phase: window.__baize.game.phase, turn: window.__baize.game.turn, rack: window.__baize.game.rackNo }));
      ok('illegal break offers the three WPA options; re-rack hands the break over', opts.length === 3 && after.phase === 'break' && after.turn === 1 && after.rack === 2, opts.join(' / '));
      await context.close();
    }

    // ---------- 4. complete game against the computer ----------
    {
      const { page, context, url } = await newPage(browser);
      await page.goto(url); await page.waitForTimeout(500);
      await page.click('[data-go="setup-cpu"]');
      await page.click('[data-level="3"]');
      await page.click('#setup-start');
      const done = await playToEnd(page);
      const over = await B(page, () => window.__baize.game?.winReason);
      ok('complete game against the computer (Hard)', done, over);
      await context.close();
    }

    // ---------- 5. resume after closing, and recovery of a shot in flight ----------
    {
      const { page, context, url } = await newPage(browser);
      await page.goto(url); await page.waitForTimeout(500);
      await page.click('[data-go="setup-pvp"]'); await page.click('#setup-start');
      for (let i = 0; i < 3; i++) { await playOne(page); }
      const before = await B(page, () => JSON.stringify(window.__baize.game.balls) + window.__baize.game.turn + window.__baize.game.shotNo);
      await page.reload(); await page.waitForTimeout(800);
      const after = await B(page, () => JSON.stringify(window.__baize.game.balls) + window.__baize.game.turn + window.__baize.game.shotNo);
      const scr = await B(page, () => window.__baize.screen);
      ok('closing and reopening resumes the same game on the table', before === after && scr === 'game');
      // shot in flight: shoot, then kill the page immediately
      const expected = await page.evaluate(async () => {
        const Bz = window.__baize;
        const { decideSync } = await import('./js/ai.js');
        const { simulate } = await import('./js/physics.js');
        const { judge } = await import('./js/rules.js');
        const g = Bz.game;
        const d = decideSync(g, 3, 99);
        if (d.place) Bz.app.tryPlaceCue(d.place[0], d.place[1]);
        Bz.game.called = d.called;
        const pre = JSON.parse(JSON.stringify(Bz.game));
        const sim = simulate(pre.balls, d.shot, { record: false });
        const exp = judge(pre, sim.outcome(), sim.finalBalls()).state;
        Bz.shoot(0, d);
        return JSON.stringify(exp.balls) + exp.turn + exp.shotNo;
      });
      await page.reload(); await page.waitForTimeout(800);
      const got = await B(page, () => JSON.stringify(window.__baize.game.balls) + window.__baize.game.turn + window.__baize.game.shotNo);
      ok('app killed mid-shot: reopening shows the exact result of that shot', got === expected);
      await context.close();
    }

    // ---------- 6. offline launch and update flow (service worker) ----------
    {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, hasTouch: true });
      const { page } = await newPage(browser, { ctx: context });
      await page.goto(URL);
      await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 20000 });
      const v1 = await B(page, () => window.__baize.version);
      await context.setOffline(true);
      await page.reload(); await page.waitForTimeout(800);
      const offlineOk = await B(page, () => !!window.__baize && document.getElementById('title').hidden === false);
      await page.click('[data-go="practice"]'); await page.waitForTimeout(300);
      await aiTurn(page, 3); await waitIdle(page);
      ok('offline: app launches from the service worker cache and plays', offlineOk, `version ${v1}`);
      await context.setOffline(false);
      // mid-game update: must not interrupt
      await page.click('#menu-btn'); await page.click('#p-quit'); await page.waitForTimeout(200);
      await page.click('[data-go="setup-pvp"]'); await page.click('#setup-start'); await page.waitForTimeout(300);
      await playOne(page);
      const gameBefore = await B(page, () => JSON.stringify(window.__baize.game.balls) + window.__baize.game.shotNo);
      build('u2');
      await B(page, () => window.__swReg.update());
      await page.waitForSelector('#update-pill:not([hidden])', { timeout: 20000 });
      const stillV1 = await B(page, () => window.__baize.version);
      ok('update arriving mid-game waits (no reload, pill shown)', stillV1 === v1);
      // returning to the menu applies it and reloads
      await page.click('#menu-btn');
      await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.click('#p-quit')]);
      await page.waitForTimeout(800);
      const v2 = await B(page, () => window.__baize.version);
      await page.click('#t-continue'); await page.waitForTimeout(400);
      const gameAfter = await B(page, () => JSON.stringify(window.__baize.game.balls) + window.__baize.game.shotNo);
      ok('update applies at the menu; the saved game continues after it', v2 !== v1 && v2.endsWith('u2') && gameBefore === gameAfter, `${v1} → ${v2}`);
      // update at launch applies straight away (no input yet)
      build('u3');
      await page.reload(); await page.waitForTimeout(500);
      await page.waitForFunction(() => window.__baize.version.endsWith('u3'), null, { timeout: 20000 }).catch(() => {});
      const v3 = await B(page, () => window.__baize.version);
      ok('update found at launch installs before play starts', v3.endsWith('u3'), v3);
      await context.close();
    }

    // ---------- 7. frame cost during a break (JS time per frame, 4x CPU throttle) ----------
    if (engineName === 'chromium') {
      const { page, context, url } = await newPage(browser, { w: 375, h: 667, dpr: 2 });
      await page.goto(url); await page.waitForTimeout(500);
      const cdp = await context.newCDPSession(page);
      await page.click('[data-go="setup-pvp"]'); await page.click('#setup-start'); await page.waitForTimeout(300);
      await B(page, () => window.__baize.frameMs.splice(0));
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await aiTurn(page, 3, 1);
      await waitIdle(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const ms = await B(page, () => window.__baize.frameMs.slice());
      ms.sort((a, b) => a - b);
      const p50 = ms[ms.length >> 1], p95 = ms[Math.floor(ms.length * 0.95)], max = ms[ms.length - 1];
      ok('break at 4x CPU throttle: JS per frame (median/p95/max) within a 16 ms budget at p95', p95 < 16, `${ms.length} frames, ${p50.toFixed(1)} / ${p95.toFixed(1)} / ${max.toFixed(1)} ms (includes SwiftShader GL calls)`);
      const idle = await B(page, async () => { const n = window.__baize.frameMs.length; await new Promise((r) => setTimeout(r, 1500)); return window.__baize.frameMs.length - n; });
      ok('no animation loop while nothing moves', idle <= 1, `${idle} frames in 1.5 s idle`);
      await context.close();
    }
  } finally {
    await browser.close();
    server.kill();
    build();   // leave dist/ as a clean build
  }
  ok('no console errors or uncaught exceptions', errors.length === 0, errors.slice(0, 5).join(' | '));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed on ${engineName}`);
  process.exit(failed.length ? 1 : 0);
})();

async function playOne(page) {
  await page.waitForFunction(() => window.__baize.app.inputEnabled() || window.__baize.overlay === 'decision', null, { timeout: 30000 });
  if (await page.isVisible('#decision')) { await page.click('#dec-opts button'); return; }
  await aiTurn(page);
  await waitIdle(page);
}
