# Verification notes

**Short version:** everything below was checked in Node and in desktop Chromium emulating iPhone screens. **None of it has run on an iPhone, in the iOS Simulator, or in WebKit.**

- I had no Mac, so no Simulator.
- This environment's rules don't allow installing Playwright's WebKit build. `tools/e2e/verify.cjs webkit` will run the same checks in WebKit on a machine that has it.

Treat every iOS-specific behaviour (standalone viewport, safe areas, haptics, audio session, ProMotion, storage durability) as **untested until you try it on your phone**.

## 1. Automated tests (Node 22, `npm test`): 40 pass

| Suite | What it proves |
|---|---|
| `physics.test.mjs` (15) | **Determinism:** bit-identical results whether the sim runs in one go or in chunks, plus a golden checksum of a full break. **Collisions and spin:** head-on stun transfer; cut shots following the 90° rule; **the guide line matching the simulated object-ball direction to < 0.005° over 40 cuts**; draw, follow and stun behaviour. **Cushions:** rebound angle and restitution; running versus reverse english; a rolling ball's rebound speed. **Pockets:** all 6 pockets at 3 speeds; jaw rejection; a rail roll past the side pocket. **Robustness:** 300 random shots ending with no ball off the cloth and no overlaps; every full-power break legal over 25 racks. |
| `rules.test.mjs` (18) | **Break:** legal and illegal breaks with the three options; scratch on the break; 8 on the break, with and without a scratch. **Open table:** group assignment, including the first ball to drop deciding; hitting the 8 first on an open table. **Fouls:** wrong ball first, no cushion, no hit, scratch; balls potted on a foul stay down. **Turns and the 8:** turn passing; winning on the 8; losing four ways (wrong pocket, uncalled, on a foul, early); a scratch on the 8 being only a foul. **Also:** ball-in-hand limits, practice mode, the VoiceOver table summary. |
| `storage.test.mjs` (5) | Versioned keys and revisions. A stale tab can't overwrite newer data. Older code never writes over a newer schema. Read-modify-write stats don't lose records across tabs. Corrupt data falls back. |
| `game.test.mjs` (2) | Six complete computer-vs-computer games through the real physics and rules, with state invariants checked every shot. **Hard beats Easy in at least 70% of 10 games.** |

## 2. Browser checks (Chromium 153 headless, SwiftShader WebGL, Playwright 1.63): 24 pass

Command: `node tools/e2e/verify.cjs chromium --shots`. It runs against the **production build served under `/pool/`** by a server that mimics GitHub Pages, including its 10-minute cache header.

| Check | Result |
|---|---|
| Layout, emulated safe areas, at SE (375×667), standard (393×852) and Pro Max (430×932), portrait and landscape. Controls are on screen, inside the safe area, and clear of the table. | 6/6. Ball sizes: 13.3–17.1 px |
| Assisted-aiming layout, portrait and landscape, right- and left-handed. No overlaps. | 4/4 |
| Aim drag gives the same result with 8, 16 or 64 touch events for the same path (the 60 Hz versus 120 Hz question) | 0.000° spread |
| Fine roller gives the same result at any event rate | exact |
| A complete pass-and-play game through the UI, ending on the game-over screen | pass |
| A soft break is illegal, the incoming player gets the three WPA options, and re-racking hands the break over | pass |
| A complete game against the Hard computer | pass |
| Close and reopen mid-game resumes the same table, turn and shot number | pass |
| **App killed mid-shot:** reopening shows exactly the result that shot would have produced | pass |
| **Offline:** relaunch with the network off loads from the service worker, and a shot can be played | pass |
| **Update mid-game:** the new version waits, with no reload and the "update ready" pill shown | pass |
| **Update at the menu:** applies and reloads, and the saved game continues unchanged | pass |
| **Update found at launch** (before any input) installs immediately | pass |
| JS time per frame during a break with **4× CPU throttling** (SE-sized screen) | median 0.8 ms, 95th percentile 7.1 ms, worst 23.5 ms (one frame) |
| No animation frames while idle | 0 frames in 1.5 s |
| Console errors or uncaught exceptions across all of the above | none |

**Screenshots:** they're in [`docs/screenshots/`](docs/screenshots). There's a title and an in-game shot for each size and orientation, plus the game-over screen.

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
- **The standalone viewport:** full-screen with no band at the top or bottom, in portrait and landscape, on your iOS version. This is the bug that bit you last time. My fix is designed from bug reports, not observed on a device.
- Real `env(safe-area-inset-*)` values, and whether my iOS 26.1 zero-top-inset heuristic ever kicks in.
- **Touch feel** with real fingers: aim gain, roller gain, power travel and curve.
- **120 Hz ProMotion:** the maths is rate-independent and tested, but Safari's actual frame rate isn't.
- Performance on an SE-class GPU during the break.
- **Sound:** the synthesised sounds, the ringer switch (`audioSession = 'ambient'`), and audio resuming after a call.
- **Haptics:** the iOS 18 switch trick, possibly removed in iOS 26.5.
- WebGL context loss after long backgrounding.
- Whether iOS flushes `localStorage` before a force-quit right after a shot. If it doesn't, you'd lose that last shot and replay it, but the game won't be corrupted.
- VoiceOver reading the menus, HUD and announcements.
- The update flow against the real GitHub Pages CDN.
- The repository name and URL case (README, "Before you deploy").

## 4. What to try first on the phone (10 minutes)

1. **Install and look.** Install from Safari and launch from the icon. Look at the very top and bottom in portrait, rotate to landscape, rotate back.
   - If anything is cut off or there's a band, go to Settings, long-press the version label for 2 s, and screenshot the Diagnostics panel.
   - Then try "Viewport source": 100vh, innerHeight, Fixed. Tell me which one looks right.
2. **Break hard and watch.** Play a break against the computer. Watch for stutter and listen for the sounds (ringer switch on).
3. **Aim one long, thin cut.** Use drag, then the roller, then shoot at about 40%. If the controls feel off, see DECISIONS.md §10, or switch on "Record touches" in Diagnostics, play five shots, and send me the JSON from Share….
4. **Interrupt it.** Shoot, then immediately lock the phone. Unlock, and the shot should finish or show its result. Then shoot and swipe the app away. Reopen it, and the result should be there.
5. **Go offline.** Turn on Airplane Mode and launch from the icon.
6. **Test updates.** Push any small change to `main` and wait for the Action to finish.
   - Open the app, go to the menu, and you should see "Updated".
   - Then start a game, push again, and reopen. The update should wait until you leave the game.

## 5. Re-running

```sh
npm test                                         # unit tests, no dependencies
npm i -D playwright && npx playwright install chromium webkit
node tools/e2e/verify.cjs chromium --shots       # browser checks + screenshots
node tools/e2e/verify.cjs webkit                 # the same checks in WebKit (the frame-cost check is Chromium-only)
```
