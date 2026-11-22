// Viewport measurement and screen layout.
//
// iOS home-screen apps have reported a viewport shorter than the screen (a dead band at the
// bottom) and safe-area insets that disagree with it. So the app size comes from JavaScript:
// in standalone mode we take the largest of three independent measurements (100vh probe,
// a position:fixed inset:0 probe, innerHeight), capped at the physical screen for the current
// orientation. In a normal Safari tab the fixed probe (the visible area) is used.
// Diagnostics shows every raw value, and a hidden override can force one source.
import { L, W } from './physics.js';

export const RAIL = 0.1;               // cushion + wood beyond the cushion nose, metres
export const CUSHION = 0.04;

export function isStandalone() {
  try {
    return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
  } catch { return false; }
}

export function measure(source = 'auto') {
  const safe = document.getElementById('probe-safe');
  const vh = document.getElementById('probe-vh');
  const fr = safe.getBoundingClientRect();
  const cs = getComputedStyle(safe);
  const insets = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  // Test hooks for desktop emulation (Chromium can't emulate the notch): ?insets=t,r,b,l&standalone=1
  const q = new URLSearchParams(location.search);
  if (q.has('insets')) { const [t, r, b, l] = q.get('insets').split(',').map(Number); Object.assign(insets, { t, r, b, l }); }
  const standalone = q.has('standalone') ? q.get('standalone') === '1' : isStandalone();
  document.documentElement.classList.toggle('standalone', standalone);  // iOS 26 bottom-band fix, app.css
  const iw = window.innerWidth, ih = window.innerHeight;
  const vvH = window.visualViewport ? window.visualViewport.height : ih;
  const vhH = vh.offsetHeight;
  const sMin = Math.min(screen.width, screen.height), sMax = Math.max(screen.width, screen.height);
  const landscape = (fr.width || iw) > (fr.height || ih);
  const scrW = landscape ? sMax : sMin, scrH = landscape ? sMin : sMax;
  let w, h;
  if (source === 'vh') { w = fr.width || iw; h = vhH; }
  else if (source === 'inner') { w = iw; h = ih; }
  else if (source === 'fixed') { w = fr.width; h = fr.height; }
  else if (standalone) {
    w = Math.min(Math.max(fr.width, iw), scrW);
    h = Math.min(Math.max(fr.height, vhH, ih), scrH);
  } else { w = fr.width || iw; h = fr.height || ih; }
  w = Math.round(w); h = Math.round(h);
  // iOS 26.1+ has been seen to report env(safe-area-inset-top) = 0 while the page draws under
  // the status bar. If we're full-screen in portrait on a notched phone with a zero top inset,
  // keep the HUD clear of the status bar / Dynamic Island anyway.
  let heuristic = '';
  if (standalone && !landscape && h >= scrH - 1 && insets.t < 20) {
    insets.t = scrH >= 812 ? 50 : 20; heuristic = 'top-inset';
  }
  return {
    w, h, insets, standalone, landscape, source, heuristic,
    raw: { innerW: iw, innerH: ih, fixedW: Math.round(fr.width), fixedH: Math.round(fr.height), vh100: vhH, visualH: Math.round(vvH),
      clientH: document.documentElement.clientHeight, screenW: screen.width, screenH: screen.height, dpr: window.devicePixelRatio,
      safe: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft },
  };
}

// Compute where everything goes. All values CSS px.
export function computeLayout(m, { leftHanded = false, assist = false } = {}) {
  const { w, h, insets } = m;
  const portrait = h >= w;
  const pad = 8;
  const lay = { w, h, portrait, insets };
  const tableW = L + 2 * RAIL, tableH = W + 2 * RAIL;  // world size of table incl. rails
  let region;
  if (portrait) {
    const hudH = 46, deckH = assist ? 172 : 64, powerW = 50;
    lay.hud = { x: insets.l + pad, y: insets.t + 6, w: w - insets.l - insets.r - 2 * pad, h: hudH };
    const top = lay.hud.y + hudH + pad;
    const deckY = h - insets.b - pad - deckH;
    const powerX = leftHanded ? insets.l + pad : w - insets.r - pad - powerW;
    lay.power = { x: powerX, y: top, w: powerW, h: deckY + deckH - top };
    const deckX0 = leftHanded ? powerX + powerW + pad : insets.l + pad;
    const deckX1 = leftHanded ? w - insets.r - pad : powerX - pad;
    lay.deck = { x: deckX0, y: deckY, w: deckX1 - deckX0, h: deckH };
    if (assist) {
      // Assisted aiming: nudge buttons replace the roller; spin sits in the panel's first row.
      lay.assist = { x: deckX0, y: deckY, w: deckX1 - deckX0, h: deckH };
      lay.spin = { x: deckX1 - 10 - 44, y: deckY + 10, w: 44, h: 44 };
      lay.roller = null;
    } else {
      const spin = 56;
      const sy = deckY + (deckH - spin) / 2;
      lay.spin = { x: leftHanded ? deckX1 - spin : deckX0, y: sy, w: spin, h: spin };
      const rx0 = leftHanded ? deckX0 : deckX0 + spin + pad, rx1 = leftHanded ? deckX1 - spin - pad : deckX1;
      lay.roller = { x: rx0, y: sy + 4, w: rx1 - rx0, h: spin - 8, vertical: false };
      lay.assist = null;
    }
    region = leftHanded
      ? { x: powerX + powerW + pad, y: top, w: w - insets.r - pad - (powerX + powerW + pad), h: deckY - pad - top }
      : { x: insets.l + pad, y: top, w: powerX - pad - (insets.l + pad), h: deckY - pad - top };
  } else {
    // Landscape: one control column on the dominant-hand side (power + roller, or power +
    // the assisted panel), so it stays playable with one thumb.
    const hudH = 40, panelW = assist ? 176 : 44, colW = 50 + pad + panelW;
    const l = Math.max(insets.l, 4), r = Math.max(insets.r, 4);
    lay.hud = { x: l + pad, y: Math.max(insets.t, 4) + 2, w: w - l - r - 2 * pad, h: hudH };
    const top = lay.hud.y + hudH + pad, bottom = h - Math.max(insets.b, 6) - pad;
    const colX = leftHanded ? l + pad : w - r - pad - colW;
    const powerX = leftHanded ? colX : colX + colW - 50;
    const sideX = leftHanded ? colX + 50 + pad : colX;
    lay.power = { x: powerX, y: top, w: 50, h: bottom - top };
    if (assist) {
      lay.assist = { x: sideX, y: top, w: panelW, h: Math.min(bottom - top, 236), narrow: true };
      lay.spin = { x: sideX + panelW - 54, y: top + 10, w: 44, h: 44 };
      lay.roller = null;
    } else {
      lay.spin = { x: sideX, y: top, w: 44, h: 44 };
      lay.roller = { x: sideX, y: top + 44 + pad, w: 44, h: bottom - top - 44 - pad, vertical: true };
      lay.assist = null;
    }
    lay.deck = null;
    const rx0 = leftHanded ? colX + colW + pad : l + pad;
    const rx1 = leftHanded ? w - r - pad : colX - pad;
    region = { x: rx0, y: top, w: rx1 - rx0, h: bottom - top };
  }
  // Table orientation: long axis along the longer side of the region.
  const vertical = portrait;
  const tw = vertical ? tableH : tableW, th = vertical ? tableW : tableH;
  const s = Math.min(region.w / tw, region.h / th);
  lay.s = s;
  lay.cx = region.x + region.w / 2;
  lay.cy = region.y + region.h / 2;
  // ex/ey: screen directions of world +x / +y. Rotation only (no mirror), so spin and
  // english read correctly on screen. Portrait puts the head string at the bottom (thumb end).
  lay.ex = vertical ? [0, -1] : [1, 0];
  lay.ey = vertical ? [-1, 0] : [0, -1];
  lay.table = { x: lay.cx - (tw * s) / 2, y: lay.cy - (th * s) / 2, w: tw * s, h: th * s };
  lay.region = region;
  lay.ballPx = 2 * 0.028575 * s;
  return lay;
}

export function toWorld(lay, sx, sy) {
  const dx = (sx - lay.cx) / lay.s, dy = (sy - lay.cy) / lay.s;
  return [L / 2 + dx * lay.ex[0] + dy * lay.ex[1], W / 2 + dx * lay.ey[0] + dy * lay.ey[1]];
}

export function toScreen(lay, x, y) {
  const dx = (x - L / 2) * lay.s, dy = (y - W / 2) * lay.s;
  return [lay.cx + dx * lay.ex[0] + dy * lay.ey[0], lay.cy + dx * lay.ex[1] + dy * lay.ey[1]];
}
