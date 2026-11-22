// Every value that shapes how the controls feel lives here. Nothing else in the code
// hard-codes a feel number. All mappings are positional (finger position -> value), so
// they behave identically at 60 Hz and 120 Hz. Units: pt = CSS pixel, deg = degrees.
// See DECISIONS.md §10 for which to try first and in which direction.
export const FEEL = {
  // ---- Aiming by dragging on the table ----
  // The cue turns by the change in the finger's angle around the cue ball (relative,
  // never jumps). Near the cue ball, angles are computed as if the finger were at least
  // this far away, so tiny movements there don't swing the aim. Raise if aiming near
  // the cue ball feels twitchy; lower if you have to drag far to turn the cue.
  aimMinRadiusPt: 60,
  // Extra gain on table drags (1 = the cue follows the finger's angle exactly).
  aimDragGain: 1.0,

  // A touch shorter and smaller than this is a tap: the cue points straight at the spot.
  // Lower these if drags are being mistaken for taps (the aim jumps).
  tapMaxMs: 180,
  tapMaxMovePt: 8,

  // ---- Fine aim roller ----
  // Degrees of aim per point dragged along the roller. 0.012 -> a 3 cm drag is about 1.5 deg.
  // Raise if corrections feel sluggish; lower if you can't land thin cuts.
  fineAimDegPerPt: 0.012,
  // Haptic tick every N degrees of fine aim (where haptics exist).
  fineTickDeg: 0.25,

  // ---- Power slider ----
  // Pull distance for 100% power. Clamped to 90% of the slider's on-screen length so it
  // is always reachable. Lower if full power is a stretch; raise for finer soft shots.
  powerTravelPt: 280,
  // Ball speed = maxBallSpeed * power^powerCurve. >1 gives finer control of soft shots.
  // Raise toward 2.0 if soft shots run too far; lower toward 1.3 if mid power feels weak.
  powerCurve: 1.6,
  // Cue ball speed at 100% power, m/s. Real amateur breaks are 7-9 m/s.
  maxBallSpeed: 8.5,
  // Releasing below this power cancels the shot instead of playing it.
  powerCancel: 0.03,

  // ---- Spin ----
  // Furthest the tip can be from centre, as a fraction of ball radius (0.5 = miscue limit).
  // Lower toward 0.4 if spin effects feel too strong.
  spinMax: 0.5,
  // How far (pt) the finger moves in the spin picker per unit of spin offset.
  spinPickerRadiusPt: 110,

  // ---- Ball in hand ----
  // A touch within this many ball radii of the cue ball grabs it (when it's movable).
  grabRadiusBalls: 2.6,

  // ---- Playback ----
  // Tap during a shot to watch it at this speed.
  fastForward: 3,
};
