// Versioned, tab-safe persistence on localStorage.
// Every record: { schema, rev, app, at, data }.
// - Keys carry the schema version (baize.v1.*). A future schema writes baize.v2.* and migrates
//   once from v1, so an old tab still running v1 code can never overwrite v2 data.
// - rev increases on every write. A tab only writes if the stored rev is the one it last saw;
//   otherwise another tab/window moved on and this tab must adopt that state instead.
// - A tab whose code is older than the stored schema never writes.
export const SCHEMA = 1;
const PREFIX = 'baize.v1.';
let APP = 'dev';
export const setAppVersion = (v) => { APP = v; };

const mem = new Map();               // fallback when localStorage is unavailable (private mode, blocked)
const seen = new Map();              // name -> rev this tab last read or wrote

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function readRaw(name) {
  const ls = store();
  let txt = null;
  try { txt = ls ? ls.getItem(PREFIX + name) : mem.get(PREFIX + name) ?? null; } catch { txt = mem.get(PREFIX + name) ?? null; }
  if (txt == null) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

function writeRaw(name, rec) {
  const txt = JSON.stringify(rec);
  mem.set(PREFIX + name, txt);   // only read back if localStorage is missing or throwing
  const ls = store();
  try { if (ls) ls.setItem(PREFIX + name, txt); return true; } catch { return false; }
}

// Returns the data (or fallback) and remembers its rev.
export function load(name, fallback = null) {
  const rec = readRaw(name);
  if (!rec || typeof rec !== 'object' || !('data' in rec)) { seen.set(name, 0); return fallback; }
  seen.set(name, rec.rev || 0);
  return rec.data;
}

// Guarded write. Returns 'ok', 'conflict' (someone newer wrote; call load() and adopt it),
// or 'readonly' (stored data is from newer code; this tab must not write).
export function save(name, data) {
  const cur = readRaw(name);
  if (cur && cur.schema > SCHEMA) return 'readonly';
  const curRev = cur ? cur.rev || 0 : 0;
  if (curRev > (seen.get(name) ?? 0)) return 'conflict';
  const rev = curRev + 1;
  writeRaw(name, { schema: SCHEMA, rev, app: APP, at: Date.now(), data });
  seen.set(name, rev);
  return 'ok';
}

// Read-modify-write on the latest stored value (for additive data such as stats).
export function update(name, fn, fallback) {
  const cur = readRaw(name);
  if (cur && cur.schema > SCHEMA) return null;
  const data = fn(cur && 'data' in cur ? cur.data : structuredCloneSafe(fallback));
  const rev = (cur ? cur.rev || 0 : 0) + 1;
  writeRaw(name, { schema: SCHEMA, rev, app: APP, at: Date.now(), data });
  seen.set(name, rev);
  return data;
}

export function remove(name) {
  mem.delete(PREFIX + name);
  const ls = store();
  try { if (ls) ls.removeItem(PREFIX + name); } catch { /* ignore */ }
  seen.set(name, 0);
}

export const keyName = (name) => PREFIX + name;
const structuredCloneSafe = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// Ask the browser not to evict our data (Safari 17+, harmless elsewhere).
export function requestPersistence() {
  try { navigator.storage?.persist?.(); } catch { /* ignore */ }
}
