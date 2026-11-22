// Local static server that mimics GitHub Pages: serves dist/ under a project subpath
// (default /pool/) with Pages' 10-minute cache header. Usage: node tools/serve.mjs [port] [base] [dir]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const port = +(process.argv[2] || process.env.PORT || 8080);
const base = (process.argv[3] || '/pool/').replace(/\/?$/, '/');
const dir = process.argv[4] || new URL('../dist', import.meta.url).pathname;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === base.slice(0, -1)) { res.writeHead(301, { Location: base }); return res.end(); }
  if (!url.pathname.startsWith(base)) { res.writeHead(404); return res.end('not found'); }
  let p = normalize(decodeURIComponent(url.pathname.slice(base.length)));
  if (p.startsWith('..')) { res.writeHead(400); return res.end(); }
  if (!p || p === '.' || p.endsWith('/')) p = join(p, 'index.html');
  try {
    const f = join(dir, p);
    if ((await stat(f)).isDirectory()) throw new Error('dir');
    const body = await readFile(f);
    res.writeHead(200, { 'Content-Type': types[extname(f)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(port, () => console.log(`Baize: http://localhost:${port}${base}`));
