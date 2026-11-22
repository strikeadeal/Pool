// Regenerate PNG icons and iOS startup images from src/icons/icon.svg.
// Needs Playwright (npm i -D playwright) — only for changing the artwork, not for building.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = new URL('../src/', import.meta.url).pathname;
const svg = readFileSync(root + 'icons/icon.svg', 'utf8');
const browser = await chromium.launch();
const shot = async (w, h, html, out) => {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:#070a0b">${html}</body></html>`);
  await page.screenshot({ path: out });
  await page.close();
};
const icon = (size, pad = 0) => `<div style="width:${size}px;height:${size}px;background:#0c585d;display:grid;place-items:center">
  <div style="width:${size * (1 - pad)}px;height:${size * (1 - pad)}px">${svg.replace('<svg ', `<svg width="${size * (1 - pad)}" height="${size * (1 - pad)}" `)}</div></div>`;
await shot(180, 180, icon(180), root + 'icons/apple-touch-icon.png');
await shot(192, 192, icon(192), root + 'icons/icon-192.png');
await shot(512, 512, icon(512), root + 'icons/icon-512.png');


// Startup images: dark room with the cue ball, one per iPhone screen size and orientation.
const devices = [[320, 568, 2], [375, 667, 2], [414, 736, 3], [375, 812, 3], [414, 896, 2], [414, 896, 3], [390, 844, 3],
  [428, 926, 3], [393, 852, 3], [430, 932, 3], [402, 874, 3], [440, 956, 3], [420, 912, 3]];
mkdirSync(root + 'icons/splash', { recursive: true });
const links = [];
const ball = svg.replace(/<rect[^>]*\/>/, '').replace(/<circle cx="1040"[^>]*\/>/g, '');
for (const [w, h, d] of devices) {
  for (const orient of ['portrait', 'landscape']) {
    const [pw, ph] = orient === 'portrait' ? [w * d, h * d] : [h * d, w * d];
    const size = Math.min(pw, ph) * 0.42;
    const name = `${w}x${h}@${d}-${orient}.png`;
    await shot(pw, ph, `<div style="width:${pw}px;height:${ph}px;display:grid;place-items:center;background:#070a0b">
      ${ball.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div>`, root + 'icons/splash/' + name);
    links.push(`<link rel="apple-touch-startup-image" media="screen and (device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${d}) and (orientation: ${orient})" href="icons/splash/${name}">`);
  }
}
await browser.close();
const idx = root + 'index.html';
const html = readFileSync(idx, 'utf8').replace(/<!-- startup-images -->[\s\S]*<!-- \/startup-images -->/, `<!-- startup-images -->\n${links.join('\n')}\n<!-- /startup-images -->`);
writeFileSync(idx, html);
console.log('icons and', links.length, 'startup images written');
