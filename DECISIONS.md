# Decision log

Each entry: what I chose, what I considered, why. Written before the code and kept current as it was built.

## 0. Identity

- **Name: Baize.** Baize is the cloth on a pool table. It's short, fits under an icon, and isn't used by the reference game. Considered: Felt, Chalk, Corner Pocket.
- **Look:** a late-night club table. Petrol-teal cloth (not the bright green of the reference), dark walnut rails, ivory diamond sights, black leather pockets, and two warm lamps baked into the lighting. The UI is dark panels with one brass accent colour.
- **Icon:** a cream cue ball on teal cloth with a brass pocket arc. It isn't an 8-ball, which keeps it clear of the reference game's logo.
- **No monetisation imitation:** there are no coins, shop, XP, levels, unlocks or ads. Stats are records only.

## 1. Stack and deployment

- **Plain JavaScript ES modules with WebGL 1 and hand-written shaders. No framework and no runtime dependencies.**
  - Considered three.js. It's around 600 KB for features I don't need. A top-down table needs about 6 shader programs.
  - Considered Canvas 2D. It can't draw rolling balls with a correct number decal cheaply, and full-canvas 2D redraws were the exact stutter source from the last project.
  - WebGL keeps per-frame CPU work proportional to the number of balls, not screen area.
- **Zero npm dependencies.** Tests use `node --test`, the build is a ~100-line Node script and the dev server is ~40 lines. The repo needs nothing installed beyond Node 20+.
- **Build step exists only to make updates safe.** `tools/build.mjs` copies `src/` to `dist/` and computes a SHA-256 for every asset. It writes the file list and a content-derived version into `sw.js`.
  - Any change to any file changes `sw.js`, so installed copies always see the update.
  - Hand-bumping a version string was rejected: forgetting to bump it once means installed copies never update.
- **Deploy:** a GitHub Actions workflow runs the tests, builds and deploys `dist/` to Pages on every push to `main`.
  - One-time setting: Settings → Pages → Source: **GitHub Actions**.
- **Subpath:** every URL is relative (`./`). That covers the manifest `start_url`/`scope`/`id`, service worker registration and scope, and module imports.
  - The game works at `/pool/`, `/Pool/` or a domain root without changes. This matters because the repo is actually named `Pool`, and GitHub Pages paths are case-sensitive, so the live URL is likely `/Pool/`. See README.

## 2. Rules

The base is the **WPA World Standardised Rules for 8-ball** (2025 edition, verified via search). Deviations below are deliberate and listed so they read as choices, not bugs.

| Situation | Baize | WPA | Why deviate |
|---|---|---|---|
| Rack | Standard triangle, 8 in the centre, one solid and one stripe in the back corners. The rest come from a seeded shuffle. | Same | |
| Break | Ball in hand behind the head string. A legal break pots a ball or drives at least 4 object balls to a cushion. | Same | |
| Illegal break | Incoming player chooses: play from here, re-rack and break, or re-rack and the other player re-breaks | Same | |
| Scratch on break | Foul. Table open, potted balls stay down, incoming player gets **ball in hand anywhere**. | Ball in hand behind the head string, can't shoot back into the kitchen | One rule for every foul. "Ball in hand" always means anywhere, which is easier to explain on a phone (CSI/BCAPL do the same). |
| 8 potted on break | Breaker chooses: re-spot the 8 and continue, or re-break | Same | |
| 8 potted on break + scratch | Incoming player chooses: re-spot the 8 with ball in hand, or re-rack and break | Similar | |
| Groups | The table is open after the break. Groups are set by the **first object ball legally potted** after the break. | Set by the called ball | No per-shot calling (see next row) |
| Calling | **Only the 8 is called.** The game pre-selects the pocket the guide line points at, and a tap on a pocket changes it. | Call shot (obvious balls exempt) | Calling every ball on a phone is slow and error-prone. Calling only the 8 is the convention every mobile pool game uses. |
| Open table, 8 hit first | Foul | Same | |
| Legal shot | First contact is with your group (any non-8 on an open table, the 8 once your group is clear). Then a ball is potted or any ball touches a cushion. | Same | |
| Foul penalty | Opponent gets ball in hand anywhere. Object balls potted on a foul stay down. | Same | |
| Turn continues | Legal shot that pots at least one of your own balls (any non-8 on an open table) | Same, by called ball | |
| Loss | 8 potted before your group is clear (including on the same shot as your last ball), 8 in an uncalled pocket, or 8 potted on a foul | Same | |
| **Calling optional** | Setup offers **8-ball pocket: Call it / Any pocket**, for both computer and pass-and-play games. Default is Call it; the last choice is remembered. With Any pocket, the 8 in any pocket wins, but early or on a foul still loses. | Always called | Players asked for it; many casual tables don't call the 8. Games saved before the option keep calling. The computer needs no change: it judges candidate shots through the same rules code. |
| Scratch while on the 8 (8 not potted) | Foul only, not a loss | Same | |
| Three fouls | Not a rule | Not in WPA 8-ball | |
| Jump/massé, push-out, re-spotted balls, touching balls | Not applicable. The cue is always level, so no jumps. | | Scope |

**Foul explanation:** the banner states the rule in plain words ("Foul: you hit a stripe first", "Foul: no ball hit a cushion after contact", "Scratch: the cue ball was potted") and says who has ball in hand. The ball that was wrongly hit first gets a ring. The same text goes to the VoiceOver live region.

## 3. Physics

- **Simulate the whole shot ahead of time, then play it back.** On release the shot is simulated with a fixed step of `1/480 s`. Keyframes are recorded at 240 Hz and the renderer interpolates them at whatever rate the display runs (60 or 120 Hz).
  - Considered real-time stepping in the frame loop. It's frame-rate coupled, the outcome is unknown until the balls stop, and an interruption mid-shot leaves a half-simulated state.
  - Simulating ahead gives the final state immediately. It's saved before the animation is half over.
- **Deterministic by construction.** The sim uses only `+ − × ÷ √`, which IEEE 754 makes bit-identical across engines. There's no `Math.sin/cos/exp/pow` (those can differ between Safari versions) and no `Math.random`.
  - The shot is stored as a unit direction vector, a speed and a spin offset.
  - Rack variation comes from a seeded PRNG stored in the game state.
  - A test runs the same shot twice and compares every byte. Another compares against a recorded checksum, so accidental changes to the physics fail CI.
- **Exact contact times (continuous collision detection).** Within each step the sim finds the earliest ball–ball or ball–cushion time of impact, advances to it, resolves it and repeats.
  - Overlap-based detection was rejected. At break speed it would give up to 8 mm of penetration, which skews contact normals by degrees. That's unacceptable when a long thin cut needs ±0.02° of aim.
- **Ball on cloth:** standard sliding, rolling and spinning phases.
  - Sliding friction `μs = 0.2` makes the slip decay linearly. Rolling resistance is `μr = 0.013` and vertical-axis spin decays at `μsp = 0.044`.
  - `μr` was tuned with the cushion restitution against break statistics: 60 seeded racks per setting, aiming for about one ball potted on a hard break and every hard break legal.
  - Draw, follow and stun come out naturally, as does the cue ball's curved path after contact.
- **Ball–ball:** equal masses, restitution 0.95, frictionless (no throw).
  - **Clusters and the break use a soft-contact model.** Instant pairwise impulses through a touching rack act like a Newton's cradle: the energy runs down one line of balls.
    - On the first prototype, 41 of 60 full-power breaks were illegal, with fewer than 4 balls reaching a cushion.
    - When a ball hits a ball that is touching a third one, the sim switches to Hertzian springs (`F = k·d^1.5`) integrated at about 2 µs substeps, with restitution applied through load/unload hysteresis.
    - It switches back once no two balls are in contact. It is still deterministic, using only `+ − × ÷ √`.
    - Result: 60 of 60 breaks legal at every power tested.
  - Throw is real, but it would make the guide line lie by 1–3° on cut shots with no way for a player to learn it. A truthful guide line matters more than that last bit of realism.
- **Cushions:** restitution `0.84 − 0.018·v` (minimum 0.70), falling with impact speed.
  - Side spin interacts with the cushion through a friction impulse, so running english widens the rebound angle and reverse english narrows it.
  - The nose height is above the ball's centre, so most top/back spin is removed at impact. Without this, a rolling ball comes off a cushion at about 30% of its speed instead of about 60%.
- **Pockets are real geometry, not "close enough" circles.** Each pocket has two rounded jaw points and two angled facings: 142° for corners and 104° for sides, per the WPA spec.
  - Mouths are 117 mm for corners and 130 mm for sides, about 2.05 and 2.27 ball widths on a 7 ft (1.98 × 0.99 m) table.
  - A ball drops once its centre passes a drop line behind the mouth: 0.6 R deep for corners, 0.4 R for sides. The pocket hole is drawn so its edge sits exactly on that line, so what you see matches what the physics does.
  - Balls can rattle in the jaws, bounce off points, or stop hanging on the lip. A ball rolling along the rail past a side pocket doesn't fall in.
  - Measured acceptance for a slow ball straight down the pocket's line is about 70 mm for a corner and 84 mm for a side, slightly more generous than the bare mouth-minus-ball figure. This is deliberate for a phone.
- **Cue:** the cue is level and strikes up to 0.5 R off centre. A 0.4 R top hit gives natural roll exactly.
  - There's no squirt or swerve, so the aim line to first contact is exact. Spin shows its effect after contact and off cushions.
- **Tests** (15, in `test/physics.test.mjs`) cover:
  - head-on and cut collisions (angle, energy, the 90° rule)
  - the guide line matching the simulated object-ball direction to within 0.005° for 40 cuts
  - cushion rebound angle and speed, and the effect of english
  - stun, draw and follow distances
  - pocketing at each pocket at several speeds
  - jaw rejection, and the rail roll past a side pocket
  - no tunnelling at maximum speed, and balls always staying on the table across random shots
  - determinism

## 4. Controls (two thumbs, landscape)

- **Aim by dragging anywhere on the table.** The drag is relative and angular: the cue turns by the finger's exact change in angle around the cue ball, so it never jumps on touch-down.
  - Exact angle differences add up the same however the movement is sampled. A test drags the same path with 8, 16 and 64 events and gets the same aim to 0.000°.
  - My first version summed small cross-product steps instead. It drifted 1.7° depending on the event rate, which is exactly the 60 Hz versus 120 Hz trap.
  - Within 60 pt of the cue ball the turn is damped, so small movements there don't swing the aim wildly.
  - **A quick tap** (under about 180 ms and 8 pt) points the cue straight at the tapped spot, for coarse aiming and first-timers.
- **Fine aim:** a ribbed roller down the right edge (left edge for left-handed play). It turns aim by about 0.012° per point dragged, so a 3 cm drag is about 1.5°. This gives the ±0.02° precision long cuts need.
  - The roller shows a moving rib texture and a haptic tick every 0.25°.
- **Power:** a vertical pull-back slider down the left edge, mirrored for left-handed play. A cue drawn inside it slides down as you pull.
  - Touch anywhere on it and pull down. Power is the distance pulled divided by a fixed travel (280 pt, clamped to the slider length), so it feels the same on every phone.
  - Release to shoot. Slide back to the top to cancel.
  - Ball speed is `8.5 m/s × p^1.6`, which gives fine control at the soft end where positional play happens. The cue on the table draws back as you pull, and a % readout follows your thumb.
- **Spin:** a small cue-ball button shows the current tip position. Tap it to open a large spin picker, then drag the tip mark. The mark is clamped to the miscue limit, and a "Centre" button resets it. Spin resets after every shot.
- **Ball in hand:** drag starting on or near the cue ball moves it, and drag elsewhere aims. Placement can't overlap a ball, and a ring plus a hand icon show that it's movable.
- **Aiming help:** the aim line runs to the first contact, with a ghost ball there.
  - Short projected lines show the object ball and cue ball directions. Long, short or no projections are a setting; short is the default.
  - Guides never show where the cue ball goes after spin. That keeps the skill gap: a novice can pot, but only a skilled player gets position.
- **Frame-rate independence:** every control maps finger *position* to a value, never per-frame deltas, and there's no frame-based smoothing. That makes behaviour identical at 60 Hz and 120 Hz.
- **All feel values live in one commented object:** `src/js/feel.js`.
- **Hidden touch recorder:** in Settings, long-press the version label for 2 s to open Diagnostics, then switch on "Record touches".
  - It records every pointer event (time, position, control, pressure, radius), every shot (aim, power, spin), the device's viewport measurements and the current feel values.
  - Export with **Share…** (iOS share sheet, a JSON file) or **Copy**. The buffer is capped at 50k events.

## 5. Camera and layout

- **Top-down orthographic view, landscape only** (changed after the first phone test, at your request).
  - iPhone Safari ignores the manifest `orientation` and has no `screen.orientation.lock()` (checked Nov 2026), so a home-screen app can't force landscape. Portrait shows a "turn your phone sideways" screen instead, and the game freezes (the frame loop stops, so shot playback and the computer pause) until the phone turns back.
  - **Known cost:** with Portrait Orientation Lock on, the phone never rotates. The prompt tells the player to switch the lock off. Drawing the game rotated in portrait would avoid that, but every touch mapping, the safe areas and the keyboard would need rotating too.
  - The manifest says `landscape` anyway, for Android and desktop installs.
- **Arrangement** follows the common mobile-pool convention you pointed me at: menu top left, player plates (name plus seven ball slots) meeting in the middle around a table-status button, spin top right, power down the left edge, fine-aim roller down the right edge, the table centred between them, and turn messages as a toast along the bottom of the table. Left-handed swaps the two side columns.
  - Only the arrangement is shared. The art (teal cloth, walnut rails, brass accents, the cue, no avatars or badges) stays Baize's own; copying the reference's look would recreate that game, which the brief ruled out.
- **Dialogs** (game over, pause, spin, settings) keep their buttons pinned to the bottom of the card, and on short screens the cards are compacted and the spin picker goes two-column. A phone showed the game-over buttons cut off by the home-indicator margin; a browser check now covers every dialog.
- **Table size:** the 7 ft bar-box size. It's limited by screen height, not width. Measured ball diameters: SE 14.1 pt, iPhone 15 size 14.7 pt, Pro Max 16.5 pt.

  Precision comes from angular drag and the roller, not from tapping balls.
- **Assisted aiming** replaces the roller column with a wider button panel, so the table shrinks a little (12.6 pt balls on an iPhone 15 size).

## 6. Visuals, sound, haptics

- **Rendering:**
  - **Table:** the background and table (wood grain, cloth noise, lamp falloff, pockets, diamonds) are painted once per resize with Canvas 2D into a texture.
  - **Balls:** each ball is a quad. The fragment shader computes the sphere normal, rotates it by the ball's orientation and shades the stripe band, number disc and glyph analytically, with two lamp highlights and a cloth-coloured rim reflection. There's no texture stretching, and numbers stay crisp at every size.
  - **Extras:** shadows are soft sprites. Potted balls sink and fade.
- **Sound:** recorded, not synthesised. Players said the original synthesised sounds didn't sound like pool.
  - **Source:** 14 clips (4 ball clicks, 3 cushion thuds, 3 cue strikes, 3 pocket drops, 1 rolling loop) cut from six CC0 Freesound recordings. CC0 means no licence terms to carry. Sources and cut points are in `tools/sounds.mjs` and the README's Sound credits.
  - **Chosen without listening.** I can't hear audio, so I chose by description, ratings and downloads, then checked each cut with ffmpeg: onset at 1 ms, spectral centroid (clicks and cues 1.3–2.6 kHz, cushions 0.3–0.5 kHz, pockets ~0.5 kHz with a rattle tail) and spectrum images. The cushion clips are low, isolated thuds from a cue-and-ball session; that they are cushion hits is my inference from their spectrum and timing, not a label in the recording.
  - **WAV, mono 16-bit, 32 kHz** (310 KB in all). MP3 and AAC add encoder padding of about 25 ms before each hit, which would put the click out of step with the collision.
  - **Variation:** each hit picks a random clip (never the same one twice running) with ±4% pitch, so a break doesn't sound like a machine gun. Volume and a low-pass filter both follow impact speed: soft contacts are quieter and duller, as real ones are. Each hit is panned by the ball's position across the table (up to ±0.6).
  - **Rolling:** a recorded 1.5 s loop whose level and pitch follow the balls' total speed. The first version used synthesised noise, which players said sounded wrong.
    - Source: a hard bowls ball rolling on a wooden table (Freesound 708103). Bowls balls are hard composite like pool balls. I found no clean CC0 recording of a ball on cloth: the one snooker recording with under-table mics also carries commentary, crowd and mains hum.
    - The loop is the steadiest 1.8 s (level within ±2 dB), with the last 0.3 s crossfaded into the start. The seam's sample step is a fifth of the largest step inside the clip, so it shouldn't click.
    - Played through a 1 kHz low-pass, because wood is brighter than cloth. Turned down 6 dB (peak gain 0.14) after phone feedback that it was too loud.
  - **Fallback:** if a clip fails to load or decode, that sound falls back to the old synthesised version, so sound never just disappears. The clips are precached like every other file, so they work offline.
  - Voice-limited to 16 during the break, with a 12 ms de-duplication window.
  - Uses `navigator.audioSession.type = 'ambient'` where it exists, so the ringer switch mutes the game and the player's music keeps playing.
- **Haptics:** iOS Safari has no Vibration API. On iOS 18+ a hidden `<input type="checkbox" switch>` produces a system haptic when it toggles, so it's used for the strike, roller ticks and 100% power.
  - This only works from a user gesture, so collisions can't buzz. It's best-effort and has an off switch. One third-party source says Apple closed it in iOS 26.5. I haven't verified that, and if true, iPhones on 26.5 or later get no haptics.
- **Launch screen:** iOS doesn't build a splash screen from the manifest. The app ships `apple-touch-startup-image` PNGs (the cue ball on the room colour) for 13 iPhone screen sizes in both orientations, so launch isn't a white flash.
  - They're generated by `tools/icons.mjs` and aren't precached, because iOS copies them at install.

## 7. Modes

- **Pass and play (2 players):** player names are editable. A handover banner names who's up, so the phone can be passed without anyone accidentally shooting.
- **vs Computer** at Easy, Medium and Hard, with an aim error (σ) of 1.1°, 0.45° and 0.16°. The AI searches candidate shots: for each target ball and pocket it works out the ghost-ball aim, checks the path is clear, simulates with the real physics and scores the result for a pot, no foul and the next shot. Difficulty sets the aim error and the size of the search. It also handles breaks, ball in hand placement, calling the 8 and safeties.
  - Considered skipping the AI. It doubles as the full-game test harness, since AI-vs-AI games exercise the rules end to end in CI, and it gives a solo player a reason to open the app.
  - **Measured over 12 AI-vs-AI games per level:**

    | Level | Shots per game | Foul rate |
    |---|---|---|
    | Hard vs Hard | 14 | 5% |
    | Medium vs Medium | 20 | 10% |
    | Easy vs Easy | 38 | 13% |

    A test requires Hard to beat Easy in at least 70% of games.
  - It decides in a median of 4–18 ms and at most about 230 ms on a desktop CPU. It is time-sliced, so the UI never blocks.
- **Practice:** free table, no rules, ball in hand at any time, re-rack button.
- **Stats:** games played and won per mode and AI level, best run (balls in one visit), and balls potted.
- **Not built:** trick shots, online play, other games (9-ball and so on), cue collections. See "Next".

## 8. Performance budget (target: 60 fps on an iPhone SE 2nd gen during the break)

- **Per frame while balls move:** about 40 draw calls. The table texture is one quad, which is GPU fill only with no CPU raster. Balls and shadows are 2 quads each. CPU work is keyframe interpolation and uniform uploads, under 1.5 ms.
- **No DOM writes per frame.** The power fill uses `transform` only. The HUD updates only on events (pot, turn change). There are no CSS filters or `backdrop-filter` anywhere.
- **No animation loop when nothing moves.** `requestAnimationFrame` runs only during playback, cue animation, active touch and UI transitions.
- **Shot simulation** is time-sliced, at most 6 ms per frame, one 2 ms step at a time, which keeps it far ahead of playback. A full break simulates in about 5–10 ms in Node on a desktop CPU.
- **Measured** in Chromium with a 4× CPU slowdown, SwiftShader software GL and an SE-sized screen, during a break:
  - JS per frame was 0.8 ms median and 7.1 ms at the 95th percentile, with one 23 ms worst frame.
  - With the loop idle, it drew 0 frames in 1.5 s.
  - This is desktop emulation, not an iPhone (see VERIFICATION.md).
- **Bundle:** under 250 KB uncompressed and under 20 requests on first load, all precached.

## 9. The five lessons

1. **Installed-app viewport**
   - The layout size comes from JavaScript, not CSS units. In standalone mode the app takes the largest of `100vh` (probe element), the `position:fixed; inset:0` rect and `innerHeight`, capped at the screen size for the current orientation. That covers the reported short-viewport bug.
   - In a Safari tab it uses the fixed rect. Safe-area insets are read from a probe element using `env()`.
   - It re-measures on `resize`, `orientationchange` and `visualViewport.resize`, plus 150 ms and 600 ms after rotation.
   - `body` is `position: fixed` with `overflow: visible`. The app can then be taller than the reported viewport without clipping, and the page still can't scroll.
   - `html`/`body` and an oversized backdrop are painted in the game's background colour, so any band iOS leaves can never show as a white or black strip.
   - **Seen on a real iPhone (iOS 26):** the layout was sized correctly, but WebKit stopped drawing everything, fixed elements included, one status-bar height (59 pt) above the bottom, leaving a black band that cut off the spin and power controls. This is WebKit bug 301108: an installed app with `viewport-fit=cover` and a black-translucent status bar gets a short viewport while the document is shorter than the screen.
     - Fix: in standalone, `html { min-height: min(100lvh, calc(100% + env(safe-area-inset-top))) }`. The document becomes screen-tall, so iOS gives the full viewport. The `min()` cap means it can never scroll, and it does nothing when the top inset is 0 (landscape, Safari tab).
     - The `standalone` class is set from JavaScript (`navigator.standalone`), because `display-mode` is reported as unreliable on iOS.
   - Diagnostics shows every raw measurement, and there's a hidden "Viewport source" override (Auto / 100vh / innerHeight), so a phone can be fixed without a new build.
2. **Touch feel**
   - All feel values are in `feel.js`.
   - Positional mapping means 60 Hz and 120 Hz behave the same.
   - There's the hidden recorder with share export.
   - The tuning advice is in section 10.
3. **Smooth animation**
   - WebGL with a static table texture, no CSS filters, no per-frame DOM and no layout thrash.
   - The scene isn't rebuilt at key moments: textures are made at start-up and on resize only, and the WebGL context is reused.
   - The render loop sleeps when idle, and the sim is time-sliced.
4. **Saved data**
   - Keys are versioned (`baize.v1.game`, `baize.v1.stats`, `baize.v1.settings`).
   - Every record carries `{schema, rev, appVersion, savedAt}`.
   - A tab refuses to write if the stored `rev` is newer than the last one it read (another tab or window moved on). It reloads that state instead.
   - A tab whose code is older than the stored `schema` never writes.
   - A future schema change writes to a new key and migrates once from the old one, so an old tab still running can't overwrite newer data.
   - The game is saved at every state change, including the moment a shot is taken, and again on `pagehide`/`visibilitychange`.
   - Safari and the installed app have separate storage. This is documented, and there's no sync without a backend.
   - `navigator.storage.persist()` is requested.
5. **Interruptions**
   - When you shoot, the pre-shot state plus the shot (direction, speed, spin) is saved *before* anything moves. When the sim finishes, normally within a few hundred ms, the post-shot state replaces it.
   - If the app is killed in between, the next launch re-simulates the saved shot. The sim is deterministic, so it reaches the exact result the player would have seen.
   - Backgrounding pauses playback and the clock. Resuming continues the animation from where it was.
   - The WebGL context-loss and restore events rebuild textures, and the AudioContext is resumed on the next touch.

## 10. If the controls feel off: what to adjust first (`src/js/feel.js`)

1. **`fineAimDegPerPt`** (0.012): raise it if the roller feels sluggish for normal corrections, lower it if you can't land thin cuts.
2. **`powerTravelPt`** (280): lower it if full power is hard to reach with your thumb, raise it for finer soft-shot control.
3. **`powerCurve`** (1.6): raise it toward 2.0 if soft shots go too far, lower it toward 1.3 if mid power feels weak.
4. **`aimMinRadiusPt`** (60): raise it if aiming near the cue ball is twitchy.
5. **`tapMaxMs` / `tapMaxMovePt`** (180 ms / 8 pt): lower them if drags get mistaken for taps and the aim jumps.
6. **`maxBallSpeed`** (8.5 m/s): lower it if the break and power shots feel uncontrollable.
7. **`spinMax`** (0.5 R): lower it toward 0.4 if spin effects feel too strong.

If none of these fix it, record a session (section 4) and send the JSON.

## 11. Accessibility

- **Reduced motion:** follows `prefers-reduced-motion` and can be overridden in Settings. Banners appear without sliding, the cue stroke is shortened, and there's no camera motion (the game has none). Ball motion is the game itself, so it stays, but "Instant shots" can skip the playback.
- **Contrast:** HUD text is at least 7:1 on its panels. Groups are shown as numbered ball icons plus the words "Solids"/"Stripes", never colour alone.
- **VoiceOver:** all menus are real buttons with labels. A polite live region announces turns, pots, fouls, ball in hand, groups and the result. A "Table status" button reads the remaining balls per player.
- **Playing without precise dragging:** "Assisted aiming" adds three things:
  - a list to pick a target ball and pocket, which sets the exact ghost-ball aim
  - stepper buttons for fine aim
  - power presets with a Shoot button.
  This makes the game playable by switch control and, in principle, by VoiceOver.
- **What I couldn't make accessible:** a blind player can't judge the cue ball's path off cushions or plan position play, because the guide is visual. The assisted list makes straight pots possible, not full play.

## 12. What I'd build next / deliberately left out

See the end of README.md.
