// Build: copy src/ to dist/, stamp a content-derived version, and write the service worker's
// precache list with SRI hashes. Any change to any shipped file changes sw.js, so installed
// copies always notice an update. No dependencies.
import { createHash } from 'node:crypto';
import { cpSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const src = join(root, 'src'), dist = process.env.BAIZE_DIST || join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
cpSync(src, dist, { recursive: true });

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
// iOS fetches startup images itself at install time, so they are not precached.
const shipped = walk(dist).filter((f) => !f.endsWith('sw.js') && !f.includes(`${sep}splash${sep}`)).sort();
const rel = (f) => relative(dist, f).split(sep).join('/');
const sha = (buf, enc) => createHash('sha256').update(buf).digest(enc);

// Version from the source content (before stamping it in), plus an optional suffix for tests.
const version = sha(shipped.map((f) => rel(f) + ':' + sha(readFileSync(f), 'hex')).join('\n'), 'hex').slice(0, 10) + (process.env.BAIZE_VERSION_SUFFIX || '');
const mainJs = join(dist, 'js', 'main.js');
const before = readFileSync(mainJs, 'utf8');
const stamped = before.replace("const VERSION = '__VERSION__';", `const VERSION = '${version}';`);
if (stamped === before) throw new Error('version marker missing in main.js');
writeFileSync(mainJs, stamped);

const assets = shipped.map((f) => {
  const buf = readFileSync(f);
  return { url: rel(f), v: sha(buf, 'hex').slice(0, 12), sri: 'sha256-' + sha(buf, 'base64') };
});
const sw = readFileSync(join(dist, 'sw.js'), 'utf8')
  .replace("const VERSION = '__VERSION__';", `const VERSION = '${version}';`)
  .replace('const ASSETS = __ASSETS__;', `const ASSETS = ${JSON.stringify(assets)};`);
if (sw.includes('__ASSETS__') || sw.includes("'__VERSION__'")) throw new Error('sw.js markers not replaced');
writeFileSync(join(dist, 'sw.js'), sw);
const bytes = assets.reduce((n, a) => n + statSync(join(dist, a.url)).size, 0);
console.log(`built ${version}: ${assets.length} files, ${(bytes / 1024).toFixed(0)} KB precached -> ${relative(root, dist) || dist}`);
