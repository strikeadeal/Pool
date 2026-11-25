# Verification notes

**Short version:** everything below was checked in Node, in desktop Chromium emulating iPhone screens, and in WebKit (Safari's engine) in its Linux build. **None of it has run on an iPhone or in the iOS Simulator.**

- I had no Mac, so no Simulator.
- The WebKit runs use Playwright's WPE build (WebKit 26.6 on Linux). It's the same engine as Safari, but not iOS: there's no GPU (WebGL is drawn in software), no touch hardware, no iOS viewport and no home-screen app mode.

Treat every iOS-specific behaviour (standalone viewport, safe areas, haptics, audio session, ProMotion, storage durability) as **untested until you try it on your phone**.

## 1. Automated tests (Node 22, `npm test`): 45 pass

| Suite | What it proves |
|---|---|
| `physics.test.mjs` (15) | **Determinism:** bit-identical results whether the sim runs in one go or in chunks, plus a golden checksum of a full break. **Collisions and spin:** head-on stun transfer; cut shots following the 90° rule; **the guide line matching the simulated object-ball direction to < 0.005° over 40 cuts**; draw, follow and stun behaviour. **Cushions:** rebound angle and restitution; running versus reverse english; a rolling ball's rebound speed. **Pockets:** all 6 pockets at 3 speeds; jaw rejection; a rail roll past the side pocket. **Robustness:** 300 random shots ending with no ball off the cloth and no overlaps; every full-power break legal over 25 racks. |
| `rules.test.mjs` (20) | **Break:** legal and illegal breaks with the three options; scratch on the break; 8 on the break, with and without a scratch. **Open table:** group assignment, including the first ball to drop deciding; hitting the 8 first on an open table. **Fouls:** wrong ball first, no cushion, no hit, scratch; balls potted on a foul stay down. **Turns and the 8:** turn passing; winning on the 8; losing four ways (wrong pocket, uncalled, on a foul, early); a scratch on the 8 being only a foul. **Calling off:** the 8 in any pocket wins, early or on a foul still loses; calling defaults on, and a saved game without the field still calls. **Also:** ball-in-hand limits, practice mode, the VoiceOver table summary. |
| `storage.test.mjs` (5) | Versioned keys and revisions. A stale tab can't overwrite newer data. Older code never writes over a newer schema. Read-modify-write stats don't lose records across tabs. Corrupt data falls back. |
| `game.test.mjs` (5) | Six complete computer-vs-computer games, plus one with calling off, through the real physics and rules, with state invariants checked every shot. **Hard beats Easy in at least 70% of 10 games.** With ball in hand, Easy and Medium never miss everything or hit the wrong ball first (24 games). On the 8, the computer calls the pocket the 8 is heading for. |

## 2. Browser checks (Playwright 1.63): 31 pass in Chromium 158, 29 in WebKit 26.6

Commands: `node tools/e2e/verify.cjs chromium --shots` and `node tools/e2e/verify.cjs webkit`. Chromium runs headless with SwiftShader WebGL. WebKit runs every check except the two Chromium-only ones: frame cost, which needs Chromium's CPU throttle, and idle frames. It runs against the **production build served under `/pool/`** by a server that mimics GitHub Pages, including its 10-minute cache header.

| Check | Result |
|---|---|
| Layout, emulated safe areas, at SE (667×375), standard (852×393) and Pro Max (932×430), landscape. Controls are on screen, inside the safe area, and clear of the table; power is left of it, the roller right of it, spin top right. | 3/3. Ball sizes: 14.1–16.5 px |
| Assisted-aiming layout at standard and SE sizes, right- and left-handed. No overlaps. | 4/4 |
| **Every dialog fits** at standard (852×393 with iPhone insets) and SE size: its buttons are fully visible without scrolling and above the home indicator. Added after your phone showed the game-over buttons cut off; it fails on the old CSS. | 2/2 |
| **Portrait:** the rotate screen covers the game, no frames run (a shot in flight stops dead), and the shot finishes after turning back | pass |
| Aim drag gives the same result with 8, 16 or 64 touch events for the same path (the 60 Hz versus 120 Hz question) | 0.000° spread |
| Fine roller gives the same result at any event rate | exact |
| All 14 recorded sounds load and decode in the browser | 14/14 |
| A complete pass-and-play game through the UI with **Any pocket** chosen at setup, ending on the game-over screen | pass |
| A soft break is illegal, the incoming player gets the three WPA options, and re-racking hands the break over | pass |
| A complete game against the Hard computer | pass |
| **Restart** from the pause menu: the first tap only asks again; the second starts the same game from the break (same opponent level and 8-ball calling, even if Settings changed since) and isn't recorded in stats | pass |
| Close and reopen mid-game resumes the same table, turn and shot number | pass |
| **App killed mid-shot:** reopening shows exactly the result that shot would have produced | pass |
| **Offline:** relaunch with the network off loads from the service worker, and a shot can be played | pass |
| **Update mid-game:** the new version waits, with no reload and the "update ready" pill shown | pass |
| **Update at the menu:** applies and reloads, and the saved game continues unchanged | pass |
| **Update waiting at launch** applies before the menu shows, so no tap is lost to the reload. One found after the menu is up waits for the next launch. | pass (Chromium: see §2.1) |
| **Screen changes** (§2.1): at every screen change, a tap on the new screen's button the moment it appears works. In WebKit, no task over 50 ms after it appears, and the tap is handled within 100 ms. | WebKit: pass, longest 43 ms, slowest tap +31 ms. Chromium: no tap lost |
| **Update while the menu is in use:** the new version waits, and the sheet just opened stays open. Before the fix the page reloaded under the player and threw the tap away. | pass |
| **Fonts landing late** (every cold launch): no button on any screen moves when the web fonts replace the fallback, at standard, SE and 568×320. Before the fix, buttons moved by up to 198 px. | 3/3 |
| JS time per frame during a break with **4× CPU throttling** (SE-sized screen) | median 0.8 ms, 95th percentile 7.7 ms, worst 24.3 ms (one frame) |
| No animation frames while idle | 0 frames in 1.5 s |
| Console errors or uncaught exceptions across all of the above | none |

### 2.1 Taps after a screen change (WebKit, DECISIONS.md §13)

Measured in WebKit with the CPU slowed about 4×, at SE and standard (3×) sizes, with real mouse input. Every screen change in the game was covered:
- launch, with and without an update waiting;
- title → game and game over → Play again;
- restarting from the pause sheet, and quitting to the title;
- Continue;
- opening and closing every sheet;
- viewport size changes and rotation;
- assisted aiming and left-handed layouts.

For each, the tap lands the moment the new screen's button appears. The full before/after tables are in DECISIONS.md §13.5. In short:

<!-- VERIFY-SUMMARY -->

`verify.cjs` keeps this as a regression check (§7b), unthrottled. In WebKit it fails on a task over 50 ms after a button shows, on a tap handled more than 100 ms after its button appears, or on a lost tap. In Chromium it fails only on a lost tap: Chromium never showed the bug, and its headless software GL adds random 60–180 ms rendering tasks, in the old code too.

Two Chromium-only quirks:
- Its service worker occasionally (about 1 run in 10) wedges as a waiting update is told to take over. The app falls back to the "update ready" pill after 5 s.
- Because of that, the update-at-launch check retries once in Chromium and says so in its output. WebKit never needed it.

**Screenshots:** they're in [`docs/screenshots/`](docs/screenshots). There's a title and an in-game shot for each size (landscape), the game-over screen, and the portrait rotate screen.

**Other things I looked at by eye in screenshots:**
- the settings, help, setup, spin picker, pause, stats and game-over screens
- assisted aiming in both orientations
- the pocket-calling marker
- a frame-by-frame break sequence

**Limits of these numbers:**
- Chromium is not Safari. The frame timings include SwiftShader (software GL), so they say nothing about an iPhone GPU.
- The CPU throttle only approximates an older phone.
- Safe areas were emulated with a test URL parameter (`?insets=59,0,34,0&standalone=1`), because Chromium can't emulate the notch. That checks my layout maths, not iOS's real `env()` values.

## 3. Not verified: needs your iPhone

- Add to Home Screen: name, icon and launch image.
- **The standalone viewport:** full-screen with no band at any edge in landscape, on your iOS version. This is the bug that bit you last time. My fix is designed from bug reports, not observed on a device.
- **The iOS 26 bottom-band fix** (DECISIONS.md §9.1). Seen on your iPhone, fixed from WebKit bug 301108 reports; Chromium can't reproduce the short viewport, so only your phone can confirm it.
- Real `env(safe-area-inset-*)` values in landscape (the notch side and the home indicator).
- **The rotate screen:** that turning the phone upright mid-shot freezes the game and it carries on when turned back, and what happens with Portrait Orientation Lock on (the prompt should tell you to switch it off).
- **Touch feel** with real fingers: aim gain, roller gain, power travel and curve.
- **120 Hz ProMotion:** the maths is rate-independent and tested, but Safari's actual frame rate isn't.
- Performance on an SE-class GPU during the break.
- **Sound:** whether the recordings sound like real pool. I chose and cut them without being able to listen (DECISIONS.md §6); judge a break, a soft cut, a cushion bank, a pot and the rolling sound by ear. The rolling loop was replaced with a recording after you said the first one sounded wrong. Also the ringer switch (`audioSession = 'ambient'`), and audio resuming after a call.
- **Haptics:** the iOS 18 switch trick, possibly removed in iOS 26.5.
- WebGL context loss after long backgrounding.
- Whether iOS flushes `localStorage` before a force-quit right after a shot. If it doesn't, you'd lose that last shot and replay it, but the game won't be corrupted.
- VoiceOver reading the menus, HUD and announcements.
- The update flow against the real GitHub Pages CDN.
- **Buttons responding straight after a screen change** (DECISIONS.md §13). Measured in WebKit on Linux, not on a phone. These are untested on the iPhone:
  - painting the table in a worker (`OffscreenCanvas`, iOS 16.4 and later);
  - the texture copy on the phone's GPU;
  - the audio context created at launch, before the first tap.
- The repository name and URL case (README, "Before you deploy").

## 4. What to try first on the phone (10 minutes)

1. **Install and look.** Install from Safari and launch from the icon, holding the phone sideways. Check all four edges, turn the phone the other way round, then upright (you should get the rotate screen) and back.
   - If anything is cut off or there's a band, go to Settings, long-press the version label for 2 s, and screenshot the Diagnostics panel.
   - Then try "Viewport source": 100vh, innerHeight, Fixed. Tell me which one looks right.
2. **Break hard and watch.** Play a break against the computer. Watch for stutter and listen for the sounds (ringer switch on). Then start a game with **8-ball pocket: Any pocket** and check no pocket marker appears on the 8.
3. **Aim one long, thin cut.** Use drag, then the roller, then shoot at about 40%. If the controls feel off, see DECISIONS.md §10, or switch on "Record touches" in Diagnostics, play five shots, and send me the JSON from Share….
4. **Interrupt it.** Shoot, then immediately lock the phone. Unlock, and the shot should finish or show its result. Then shoot and swipe the app away. Reopen it, and the result should be there.
5. **Go offline.** Turn on Airplane Mode and launch from the icon.
6. **Test updates.** Push any small change to `main` and wait for the Action to finish.
   - Open the app, go to the menu, and you should see "Updated".
   - Then start a game, push again, and reopen. The update should wait until you leave the game.

### Taps after a screen change (5 minutes)

Each time, tap the new screen's button **as soon as it appears**. It should respond at once, never after a pause.
1. **Cold launch:** swipe the app away, open it from the icon, and tap **Play** the moment the menu shows.
2. **Into a game and back:** start a game and tap the menu button at once. Quit to the title and tap a menu item at once.
3. **Game over:** concede (pause → Concede), then tap **Play again** at once.
4. **Restart** from the pause sheet, then **Continue** from the title, tapping at once each time.
5. **Assisted aiming:** turn it on in Settings, start a game, tap at once, then quit and tap at once. This used to be the slowest case.
6. **Rotate** upright and back, then tap the menu button at once.
7. **Sound:** the first shot after launch should make its sound.
8. **After a deploy:** launch the app. It should open straight onto the new version, with no tap thrown away and no "update ready" pill.
9. **Update pending at game over:** push a change, finish a game, and tap **Play again** at once. It should start a new game; the update waits for the menu.
10. **Two deploys in quick succession:** push twice a minute apart, then launch. You should land on the second version.
11. **Offline:** in Airplane Mode, launch and tap at once.

If any tap needs a second try, note which step it was, and whether it was the first launch after installing or after a deploy.

## 5. Re-running

```sh
npm test                                         # unit tests, no dependencies
npm i -D playwright && npx playwright install chromium webkit
node tools/e2e/verify.cjs chromium --shots       # browser checks + screenshots
node tools/e2e/verify.cjs webkit                 # the same checks in WebKit (the frame-cost checks are Chromium-only)
node tools/e2e/latency.cjs webkit --throttle --size standard   # screen-change timings, CPU slowed 4× (Linux only)
```
