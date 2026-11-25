// End-to-end verification in real Chromium (and WebKit if installed) against the production
// build served under a subpath. Needs Playwright: `npm i -D playwright` (not needed to build).
// Usage: npm run build && node tools/e2e/verify.cjs [chromium|webkit] [--shots]
const { chromium, webkit } = require('playwright');
const { Bench, runAll, runUpdates, serve: serveLatency } = require('./latency.cjs');
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
let offlineNow = false;
const errors = [], pendingErrors = [];   // pendingErrors: possibly teardown, judged at the end
const ok = (name, pass, info = '') => { results.push({ name, pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

function build(suffix = '') {
  execSync('node tools/build.mjs', { cwd: ROOT, env: { ...process.env, BAIZE_VERSION_SUFFIX: suffix }, stdio: 'pipe' });
}
function serve() {
  const p = spawn(process.execPath, ['tools/serve.mjs', String(PORT), BASE], { cwd: ROOT, stdio: 'ignore' });
  return new Promise((r) => setTimeout(() => r(p), 400));
}
const launchArgs = engineName === 'chromium' ? { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {};

async function newPage(browser, { w = 852, h = 393, dpr = 2, insets = '', ctx = null } = {}) {
  const context = ctx || await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, hasTouch: true, isMobile: engineName === 'chromium' });
  const page = await context.newPage();
  // A reload while the table worker is still loading its modules (the update reload at launch does that) cancels the
  // load, and WebKit logs it as a failed module load. Those two messages within 1.5 s of a navigation are teardown, not
  // a fault; anywhere else they count.
  const navs = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(Date.now()); });
  const teardown = (text) => /Cannot load .*\/js\/[a-z]+\.js due to access control checks|Importing a module script failed/.test(text);
  const report = (text) => {
    const at = Date.now(), e = { text: `[${w}x${h}] ${text}`, at, navs };
    if (teardown(text)) pendingErrors.push(e);
    else if (!(offlineNow && /Failed to load resource/.test(text))) errors.push(e.text);   // offline: network loads fail, as they should
  };
  page.on('console', (m) => { if (m.type() === 'error') report(`console: ${m.text()}`); });
  page.on('pageerror', (e) => report(`pageerror: ${e.message}`));
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
    // ---------- 1. screenshots at three phone sizes (landscape only) ----------
    const devices = [
      ['se', 667, 375, 2, '0,0,0,0'],
      ['standard', 852, 393, 3, '0,59,21,59'],
      ['promax', 932, 430, 3, '0,59,21,59'],
    ];
    if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
    for (const [name, vw, vh, dpr, ins] of devices) {
      {
        const orient = 'landscape';
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
        const at = Object.fromEntries(rects.map(([id, l, t, r, b]) => [id, { l, t, r, b }]));
        const placed = at.power.r <= tb.x + 1 && at.roller.l >= tb.x + tb.w - 1 && at['spin-btn'].b <= tb.y + 1 && at['spin-btn'].l >= tb.x + tb.w - 1;
        ok(`layout ${name} ${orient}: controls on screen, inside safe area, clear of the table; power left, roller right, spin top right`, inside && clearOfTable && safe && placed, `ball ${lay.ballPx.toFixed(1)}px, table ${Math.round(tb.w)}×${Math.round(tb.h)}`);
        if (SHOTS) await page.screenshot({ path: `${OUT}/${name}-${orient}-game.jpg`, quality: 82, type: 'jpeg' });
        await context.close();
      }
    }

    // ---------- 1a. every dialog fits: its buttons are visible without scrolling, above the home indicator ----------
    for (const [name, vw, vh, ins] of [['standard', 852, 393, '0,59,21,59'], ['SE', 667, 375, '0,0,0,0']]) {
      const { page, context, url } = await newPage(browser, { w: vw, h: vh, dpr: 2, insets: ins });
      await page.goto(url); await page.waitForTimeout(400);
      await page.click('[data-go="setup-cpu"]'); await page.click('#setup-start'); await page.waitForTimeout(400);
      const sab = Number(ins.split(',')[2]);
      const bad = await B(page, ({ vh, sab }) => {
        const out = [];
        document.getElementById('over-h').textContent = 'Computer wins';
        document.getElementById('over-p').textContent = 'Computer potted the 8 in the called pocket.';
        document.getElementById('over-stats').innerHTML = ['You: balls potted', 'You: best run', 'Computer: balls potted', 'Computer: best run'].map((t, i) => `<dt>${t}</dt><dd>${i + 2}</dd>`).join('');
        for (const s of document.querySelectorAll('section.sheet')) {
          s.hidden = false;
          const c = s.querySelector('.card').getBoundingClientRect();
          for (const btn of s.querySelectorAll('.actions button, #pause .menu button:not([hidden])')) {
            const r = btn.getBoundingClientRect();
            if (r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5 || r.bottom > vh - sab + 0.5) out.push(`${s.id}: ${btn.textContent.trim()}`);
          }
          if (s.id !== 'over') s.hidden = true;
        }
        return out;
      }, { vh, sab });
      ok(`dialogs fit at ${name} landscape: every dialog's buttons visible, above the home indicator`, bad.length === 0, bad.join(', '));
      if (SHOTS && name === 'standard') await page.screenshot({ path: `${OUT}/standard-landscape-gameover.jpg`, quality: 82, type: 'jpeg' });
      await context.close();
    }

    // ---------- 1b. assisted aiming and left-handed layouts ----------
    for (const [orient, vw, vh, ins] of [['standard', 852, 393, '0,59,21,59'], ['SE', 667, 375, '0,0,0,0']]) {
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
        const good = r.assist && !ov(r.assist, r.power) && !ov(r.assist, r.table) && !ov(r.power, r.table) && ![r.assist, r.power, r.table].some((x) => ov(r.spin, x)) && !r.roller;
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
        await page.mouse.move(r.x + r.w / 2, r.y + 40); await page.mouse.down();
        for (let i = 1; i <= steps; i++) await page.mouse.move(r.x + r.w / 2, r.y + 40 + (100 * i) / steps);
        await page.mouse.up();
        return B(page, () => window.__baize.app.aim * 180 / Math.PI);
      };
      const f1 = await fine(5), f2 = await fine(50);
      ok('fine roller: 100 px gives the same aim change at any event rate', Math.abs(f1 - f2) < 1e-9 && Math.abs(Math.abs(f1) - 1.2) < 1e-6, `${f1.toFixed(4)}° vs ${f2.toFixed(4)}°`);
      await context.close();
    }

    // ---------- 2b. portrait: rotate prompt, game frozen mid-shot, carries on after turning back ----------
    {
      const { page, context, url } = await newPage(browser);
      await page.goto(url); await page.waitForTimeout(400);
      await page.click('[data-go="setup-pvp"]'); await page.click('#setup-start'); await page.waitForTimeout(300);
      await B(page, () => window.__baize.shoot(1));
      await page.waitForTimeout(200);
      await page.setViewportSize({ width: 393, height: 852 });
      await page.waitForTimeout(800);
      const shown = await page.isVisible('#rotate');
      const frozen = await B(page, async () => { const Bz = window.__baize, n = Bz.frameMs.length, t = Bz.pb?.t; await new Promise((r) => setTimeout(r, 1000)); return { frames: Bz.frameMs.length - n, pb: !!Bz.pb, same: Bz.pb?.t === t }; });
      if (SHOTS) await page.screenshot({ path: `${OUT}/standard-portrait-rotate.jpg`, quality: 82, type: 'jpeg' });
      await page.setViewportSize({ width: 852, height: 393 });
      await waitIdle(page);
      const after = await B(page, () => ({ hidden: !document.getElementById('rotate').checkVisibility(), shot: window.__baize.game.shotNo }));
      ok('portrait: rotate prompt covers the game, which freezes mid-shot and finishes after turning back', shown && frozen.frames === 0 && frozen.pb && frozen.same && after.hidden && after.shot >= 1, `${frozen.frames} frames while upright`);
      await context.close();
    }

    // ---------- 3. complete pass-and-play game through the UI ----------
    {
      const { page, context, url } = await newPage(browser);
      await page.goto(url); await page.waitForTimeout(500);
      await page.click('[data-go="setup-pvp"]');
      await page.fill('#name-0', 'Alex'); await page.fill('#name-1', 'Sam');
      await page.click('#call-seg [data-v="any"]');
      await page.click('#setup-start');
      const sounds = await page.evaluate(async () => (await import('./js/feedback.js')).soundsReady);
      ok('all 14 recorded sounds load and decode in the browser', sounds === 14, `${sounds} decoded`);
      const t0 = Date.now();
      const done = await playToEnd(page);
      const over = await B(page, () => ({ phase: window.__baize.game?.phase, reason: window.__baize.game?.winReason, shots: window.__baize.game?.shotNo, call: window.__baize.game?.callEight }));
      await page.waitForSelector('#over:not([hidden])', { timeout: 5000 }).catch(() => {});
      const shown = await page.isVisible('#over');
      ok('complete pass-and-play game ("Any pocket" for the 8) reaches a winner with the game-over screen', done && over.phase === 'over' && shown && over.call === false, `${over.shots} shots, ${((Date.now() - t0) / 1000).toFixed(0)} s: ${over.reason}`);
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

    // ---------- 4a. restart from the pause menu ----------
    {
      const { page, context, url } = await newPage(browser);
      await page.goto(url); await page.waitForTimeout(500);
      await page.click('[data-go="setup-cpu"]'); await page.click('[data-level="1"]');
      await page.click('#call-seg [data-v="any"]'); await page.click('#setup-start');
      for (let i = 0; i < 2; i++) await playOne(page);
      // Setup now says Hard and calling on: Restart must copy the game being restarted, not setup.
      await B(page, () => { window.__baize.settings.level = 3; window.__baize.settings.eight = 'call'; });
      const played = await B(page, () => JSON.parse(localStorage.getItem('baize.v1.stats') || '{}').data?.played ?? 0);
      const shotsBefore = await B(page, () => window.__baize.game.shotNo);
      await page.click('#menu-btn'); await page.waitForTimeout(200);
      await page.click('#p-restart');
      const armed = await B(page, () => [document.getElementById('p-restart').textContent, window.__baize.game.shotNo, window.__baize.overlay]);
      await page.click('#p-restart'); await page.waitForTimeout(300);
      const g = await B(page, () => { const b = window.__baize, g = b.game; return { phase: g.phase, shotNo: g.shotNo, turn: g.turn, level: g.players[1].cpu, call: g.callEight, overlay: b.overlay, on: [...g.balls.on].every(Boolean) }; });
      const playedAfter = await B(page, () => JSON.parse(localStorage.getItem('baize.v1.stats') || '{}').data?.played ?? 0);
      ok('restart: first tap asks again; second starts the same game from the break, unrecorded',
        armed[0] === 'Tap again to restart' && armed[1] === shotsBefore && armed[2] === 'pause' && shotsBefore > 0 &&
        g.phase === 'break' && g.shotNo === 0 && g.turn === 0 && g.on && g.level === 1 && g.call === false && g.overlay === null && playedAfter === played,
        `level ${g.level}, calling ${g.call}, games recorded ${played} → ${playedAfter}`);
      await page.click('#menu-btn'); await page.waitForTimeout(200);
      const prac = await B(page, () => document.getElementById('p-restart').textContent);
      await context.close();
      if (prac !== 'Restart game') ok('restart: button resets when the menu reopens', false, prac);
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
      const context = await browser.newContext({ viewport: { width: 852, height: 393 }, deviceScaleFactor: 2, hasTouch: true });
      const { page } = await newPage(browser, { ctx: context });
      await page.goto(URL);
      await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 20000 });
      const v1 = await B(page, () => window.__baize.version);
      await context.setOffline(true); offlineNow = true;
      // Playwright's WebKit reports an internal error for an offline reload even though the page loads; what counts is the page
      await page.reload().catch(() => {}); await page.waitForTimeout(800);
      const offlineOk = await B(page, () => !!window.__baize && document.getElementById('title').hidden === false);
      await page.click('[data-go="practice"]'); await page.waitForTimeout(300);
      await aiTurn(page, 3); await waitIdle(page);
      ok('offline: app launches from the service worker cache and plays', offlineOk, `version ${v1}`);
      await context.setOffline(false); await page.waitForTimeout(300); offlineNow = false;
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
      // an update landing while someone is using the menu must not reload under them (it used to throw away their tap)
      await page.click('#menu-btn'); await page.click('#p-quit'); await page.waitForTimeout(200);
      build('u2b');
      await page.click('[data-go="setup-cpu"]');
      let menuState;
      try {
        await B(page, () => window.__swReg.update());
        await page.waitForFunction(() => window.__swReg.waiting, null, { timeout: 20000 });
        await page.waitForTimeout(600);
        menuState = await B(page, () => `${window.__baize.version} ${window.__baize.overlay}`);
      } catch { menuState = 'the page reloaded under the open sheet'; await page.waitForTimeout(1500); }
      ok('update arriving while the menu is in use waits (the sheet just opened stays open)', menuState === `${v2} setup`, menuState);
      if (menuState.endsWith('setup')) await page.click('#setup [data-back]');
      // At launch, the version waiting (u2b) applies before the menu shows. One found after the menu is up (u3) waits:
      // a reload then would land on whatever the player is tapping. It applies at the next launch.
      await page.reload(); await page.waitForTimeout(1500);
      await page.waitForFunction(() => window.__baize && !document.getElementById('app').classList.contains('booting'), null, { timeout: 20000 }).catch(() => {});
      const atLaunch = await B(page, () => `${window.__baize.version} pill:${!document.getElementById('update-pill').hidden}`).catch(() => '?');
      build('u3');
      await B(page, () => window.__swReg.update()).catch(() => {});
      await page.waitForFunction(() => window.__swReg?.waiting, null, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(600);
      const shown = await B(page, () => `${window.__baize.version} pill:${!document.getElementById('update-pill').hidden}`).catch(() => '?');
      await page.reload(); await page.waitForTimeout(1500);
      await page.waitForFunction(() => window.__baize && !document.getElementById('app').classList.contains('booting'), null, { timeout: 20000 }).catch(() => {});
      const next = await B(page, () => window.__baize.version).catch(() => '?');
      const u2b = v2.replace(/u2$/, 'u2b');
      ok('update waiting at launch applies before the menu shows; one found once it shows waits for the next launch',
        atLaunch === `${u2b} pill:false` && shown === `${u2b} pill:true` && next.endsWith('u3'), `${atLaunch} → ${shown} → ${next}`);
      await context.close();
    }

    // ---------- 7. frame cost during a break (JS time per frame, 4x CPU throttle) ----------
    if (engineName === 'chromium') {
      const { page, context, url } = await newPage(browser, { w: 667, h: 375, dpr: 2 });
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

    // ---------- 7b. screen changes never block input: tap the new screen's button the moment it shows ----------
    // Every screen change in tools/e2e/latency.cjs, unthrottled. Fails if a change runs a main-thread task over 50 ms
    // (after the launch screen shows, for launches), if a tap on the new button isn't handled within 100 ms of it
    // appearing, or if a tap is lost, including to an update reload. Before the fix, the assisted-aiming switch ran
    // a 0.3 s repaint and taps were lost to update reloads at launch, game over and the menu.
    {
      const srv = await serveLatency();
      const bench = new Bench(browser, engineName, { throttle: false, size: 'se' });
      try { await runAll(bench); await runUpdates(bench); } finally { srv.kill(); build(); }
      const bad = bench.rows.filter((r) => !r.ok || r.err || (r.longest != null && ((r.launch ? r.after : r.longest) > 50 || r.handled > 100)));
      const worst = bench.rows.filter((r) => r.longest != null);
      ok(`screen changes: a tap on the new screen's button works at once (${bench.rows.length} changes)`, !bad.length,
        bad.length ? bad.map((r) => `${r.name}: ${r.err || (!r.ok ? 'tap lost' : `task ${r.longest} ms, tap handled +${r.handled} ms`)}`).join('; ')
          : `longest task ${Math.max(...worst.map((r) => (r.launch ? r.after : r.longest)))} ms, slowest tap +${Math.max(...worst.map((r) => r.handled))} ms`);
    }

    // ---------- 8. web fonts arriving after the first paint (every cold launch) must not move any button ----------
    {
      const boxes = async (fonts, w, h) => {
        const context = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: engineName === 'chromium', serviceWorkers: 'block' });
        const page = await context.newPage();   // not newPage(): the blocked font requests would count as console errors
        if (!fonts) await page.route('**/*.woff2', (r) => r.abort());
        await page.goto(URL); await page.waitForTimeout(600);
        const out = [];
        const snap = async (s) => { await B(page, () => document.fonts.ready); out.push(...await B(page, (s) => [...document.querySelectorAll(s + ' button')].filter((e) => !e.closest('[hidden]'))
          .map((e) => { const r = e.getBoundingClientRect(); return [`${s} ${e.id || e.textContent.trim()}`, r.x, r.y, r.width, r.height]; }), s)); };
        await snap('#title');
        for (const [go, s] of [['setup-cpu', '#setup'], ['setup-pvp', '#setup'], ['help', '#help'], ['settings', '#settings'], ['stats', '#stats']]) {
          await page.click(`[data-go="${go}"]`); await snap(s); await page.click(`${s} [data-back]`);
        }
        await page.click('[data-go="practice"]'); await page.waitForTimeout(300); await snap('#hud'); await snap('#controls');
        await page.click('#menu-btn'); await snap('#pause'); await page.click('#p-resume');
        await page.click('#spin-btn'); await snap('#spin');
        const faces = await B(page, () => [...document.fonts].filter((f) => f.status === 'loaded').length);
        await context.close(); return { out, faces };
      };
      for (const [name, w, h] of [['standard', 852, 393], ['SE', 667, 375], ['SE 1st gen', 568, 320]]) {
        const a = await boxes(true, w, h), f = await boxes(false, w, h);
        const moved = a.out.map((x, i) => [x[0], Math.max(...[1, 2, 3, 4].map((k) => Math.abs(x[k] - (f.out[i]?.[k] ?? 1e9))))]).filter(([, d]) => d > 2);
        ok(`fonts landing late move no button, ${name}`, a.faces > 0 && f.faces === 0 && a.out.length === f.out.length && !moved.length,
          moved.length ? moved.map(([n, d]) => `${n} ${Math.round(d)}px`).join(', ') : `${a.out.length} buttons, ${a.faces} faces vs fallback`);
      }
    }
  } finally {
    await browser.close();
    server.kill();
    build();   // leave dist/ as a clean build
  }
  for (const e of pendingErrors) if (!e.navs.some((t) => Math.abs(t - e.at) < 1500)) errors.push(e.text);
  ok('no console errors or uncaught exceptions', errors.length === 0, errors.slice(0, 5).join(' | ') || `${pendingErrors.length} module loads cancelled by a reload`);
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
