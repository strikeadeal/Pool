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
  return {
    w, h, insets, standalone, landscape, source,
    raw: { innerW: iw, innerH: ih, fixedW: Math.round(fr.width), fixedH: Math.round(fr.height), vh100: vhH, visualH: Math.round(vvH),
      clientH: document.documentElement.clientHeight, screenW: screen.width, screenH: screen.height, dpr: window.devicePixelRatio,
      safe: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft },
  };
}

// Compute where everything goes. All values CSS px. Landscape only (portrait shows a rotate
// prompt, see main.js): power down one side, the fine-aim roller (or the assisted panel) down
// the other, menu and spin in the top corners, player plates centred, table in between.
export function computeLayout(m, { leftHanded = false, assist = false } = {}) {
  const { w, h, insets } = m;
  const pad = 8, btn = 44, hudH = 44, powerW = 44, sideW = assist ? 176 : 44;
  const l = Math.max(insets.l, 4), r = Math.max(insets.r, 4);
  const lay = { w, h, insets };
  const hudY = Math.max(insets.t, 4) + 2;
  lay.spin = { x: w - r - pad - btn, y: hudY, w: btn, h: btn };
  lay.hud = { x: l + pad, y: hudY, w: lay.spin.x - pad - (l + pad), h: hudH };
  const top = hudY + hudH + pad, bottom = h - Math.max(insets.b, 6) - pad;
  const leftCol = { x: l + pad, y: top, h: bottom - top };
  const rightX = (cw) => w - r - pad - cw;
  const powerX = leftHanded ? rightX(powerW) : leftCol.x;
  const sideX = leftHanded ? leftCol.x : rightX(sideW);
  lay.power = { x: powerX, y: top, w: powerW, h: bottom - top };
  if (assist) { lay.assist = { x: sideX, y: top, w: sideW, h: Math.min(bottom - top, 236) }; lay.roller = null; }
  else { lay.roller = { x: sideX, y: top, w: sideW, h: bottom - top }; lay.assist = null; }
  const x0 = leftCol.x + (leftHanded ? sideW : powerW) + pad, x1 = rightX(leftHanded ? powerW : sideW) - pad;
  const region = { x: x0, y: top, w: x1 - x0, h: bottom - top };
  const tw = L + 2 * RAIL, th = W + 2 * RAIL;  // world size of table incl. rails
  const s = Math.min(region.w / tw, region.h / th);
  lay.s = s;
  lay.cx = region.x + region.w / 2;
  lay.cy = region.y + region.h / 2;
  // ex/ey: screen directions of world +x / +y (rotation only, no mirror, so english reads right).
  lay.ex = [1, 0];
  lay.ey = [0, -1];
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
