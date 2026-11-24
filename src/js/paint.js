// Worker: paints the table and room (textures.js paintScene) off the main thread, and with the first one the ball digits
// and the cue, then hands them back as raw pixels, the table one strip per message, so the main thread uploads it in
// small pieces between taps (Renderer.paintBg). The table goes as RGB (it's opaque; the WebGL canvas has no alpha).
import { paintScene, paintDigits, paintCue } from './textures.js';

const rgba = (c, y = 0, h = c.height) => c.getContext('2d').getImageData(0, y, c.width, h).data;
const send = (m) => postMessage(m, [m.px]);

onmessage = ({ data: { id, lay, dpr, noise, rows, extras } }) => {
  if (extras) for (const [kind, c] of [['digits', paintDigits()], ['cue', paintCue()]]) send({ kind, w: c.width, h: c.height, px: rgba(c).buffer });
  const c = paintScene(lay, dpr, noise);
  for (let y = 0; y < c.height; y += rows) {
    const h = Math.min(rows, c.height - y), src = rgba(c, y, h), px = new Uint8Array(c.width * h * 3);
    for (let i = 0, j = 0; i < src.length; i += 4, j += 3) { px[j] = src[i]; px[j + 1] = src[i + 1]; px[j + 2] = src[i + 2]; }
    send({ kind: 'strip', id, y, w: c.width, h, px: px.buffer, last: y + h >= c.height });
  }
};
