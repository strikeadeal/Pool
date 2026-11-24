// Worker: paints the table and room (textures.js paintScene) off the main thread, then hands the picture back cut into
// strips, so the main thread uploads it in small pieces between taps (Renderer.paintBg).
import { paintScene } from './textures.js';

onmessage = async ({ data: { id, lay, dpr, noise, rows } }) => {
  const c = paintScene(lay, dpr, noise);
  const strips = [];
  for (let y = 0; y < c.height; y += rows) strips.push(await createImageBitmap(c, 0, y, c.width, Math.min(rows, c.height - y)));
  postMessage({ id, strips }, strips);
};
