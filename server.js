'use strict';
/**
 * Sync Room - a tiny private "listen together" server.
 * - Whoever runs this on their PC is the admin; everyone else who can reach it is a guest. No passwords.
 * - Streams songs from a folder on this PC (the admin can change it). Nothing is uploaded to any service.
 * - One shared playback state; every device schedules audio against a synced clock.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode-generator'); // local QR generation, no outside service

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------------------------------------------------------------- config
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch { /* first run */ }
  const defaults = { port: 3000, musicDir: 'music', maxUploadMB: 300, lyricsOnline: true };
  let changed = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (cfg[k] === undefined) { cfg[k] = v; changed = true; }
  }
  for (const old of ['password', 'adminPassword', 'secret', 'maxTracks']) { // settings from older versions
    if (old in cfg) { delete cfg[old]; changed = true; }
  }
  if (changed) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  return cfg;
}

const cfg = loadConfig();
let libRoot = path.resolve(ROOT, cfg.musicDir);
const MAX_TRACKS = 3000; // safety cap
const MAX_UPLOAD = Math.max(1, Number(cfg.maxUploadMB) || 300) * 1024 * 1024;
const LEAD_MS = 700; // how far in the future a play/seek takes effect, so everyone can schedule it

const AUDIO_EXT = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm',
};
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)', 'appdata']);

// ---------------------------------------------------------------- who is the admin
// The admin is whoever is sitting at the PC running this server: a request that comes from this very machine,
// is addressed to a name that machine owns, and was not relayed by a proxy or tunnel.
const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'tailscale-user-login'];

function ownAddresses() {
  const set = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) set.add(i.address.toLowerCase());
  return set;
}

function trustedHost(req) {
  const h = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || ownAddresses().has(h)) return true;
  const me = os.hostname().toLowerCase();
  return h === me || h === me + '.local';
}

function isHostRequest(req) {
  if (FORWARD_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  const ra = (req.socket.remoteAddress || '').toLowerCase().replace(/^::ffff:/, '');
  return ownAddresses().has(ra) && trustedHost(req); // trustedHost blocks DNS-rebinding tricks
}

const getRole = (req) => (isHostRequest(req) ? 'admin' : 'guest');

/** Browsers send Origin on cross-site requests; refuse anything not coming from our own page. */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

// ---------------------------------------------------------------- tracks
const durations = new Map(); // id -> seconds (exact, reported by clients after decoding)
const metaCache = new Map(); // id -> { sig, title, artist, album, duration, cover }
let tracks = [];
let trackSig = '';
let mmLib; // music-metadata (loaded on demand; ESM)

async function loadMM() {
  if (mmLib === undefined) {
    try { mmLib = await import('music-metadata'); } catch { mmLib = null; }
  }
  return mmLib;
}

function prettify(file) {
  const base = path.basename(file).replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = base.split(' - ');
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: base };
}

function scanFiles(root) {
  const out = [];
  let dirs = 0;
  (function walk(rel, depth) {
    if (depth > 8 || ++dirs > 4000) return;
    let ents;
    try { ents = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (out.length >= MAX_TRACKS) return;
      if (d.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name.toLowerCase())) walk(r, depth + 1); }
      else if (d.isFile() && AUDIO_EXT[path.extname(d.name).toLowerCase()]) out.push(r);
    }
  })('', 0);
  const dir = (r) => (r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '');
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return out.sort((a, b) => cmp(dir(a), dir(b)) || cmp(a, b));
}

/** Re-reads the music folder (and its subfolders). Returns true when the list changed. */
function refreshTracks() {
  let files = [];
  try {
    fs.mkdirSync(libRoot, { recursive: true });
    files = scanFiles(libRoot);
  } catch { /* folder unreadable: show an empty list */ }
  const next = files.map((rel) => {
    let size = 0;
    try { size = fs.statSync(path.join(libRoot, rel)).size; } catch { /* ignore */ }
    const m = metaCache.get(rel);
    const fallback = prettify(rel);
    const useMeta = m && m.sig === size;
    return {
      id: rel,
      folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
      title: (useMeta && m.title) || fallback.title,
      artist: (useMeta && m.artist) || fallback.artist,
      album: (useMeta && m.album) || '',
      cover: !!(useMeta && m.cover),
      size,
      duration: durations.get(rel) || (useMeta && m.duration) || null,
    };
  });
  const sig = JSON.stringify(next.map((t) => [t.id, t.size]));
  const changed = sig !== trackSig;
  trackSig = sig;
  if (changed) tracks = next;
  return changed;
}

// Read title / artist / cover info from the files' own tags, in the background.
let metaRunning = false;
async function fillMeta() {
  if (metaRunning) return;
  metaRunning = true;
  try {
    const lib = await loadMM();
    if (!lib) return;
    let dirty = false;
    let lastFlush = Date.now();
    for (const t of tracks.slice()) {
      const have = metaCache.get(t.id);
      if (have && have.sig === t.size) continue;
      const entry = { sig: t.size };
      try {
        const md = await lib.parseFile(path.join(libRoot, t.id), { skipPostHeaders: true });
        entry.title = md.common.title || '';
        entry.artist = md.common.artist || md.common.albumartist || '';
        entry.album = md.common.album || '';
        entry.duration = md.format.duration || null;
        entry.cover = !!(md.common.picture && md.common.picture.length);
      } catch { /* unreadable tags: keep the filename */ }
      metaCache.set(t.id, entry);
      const live = tracks.find((x) => x.id === t.id);
      if (live) {
        if (entry.title) live.title = entry.title;
        if (entry.artist) live.artist = entry.artist;
        live.album = entry.album || '';
        live.cover = !!entry.cover;
        if (!live.duration && entry.duration) live.duration = entry.duration;
      }
      dirty = true;
      if (Date.now() - lastFlush > 1500) { broadcast({ type: 'tracks', tracks }); dirty = false; lastFlush = Date.now(); }
    }
    if (dirty) broadcast({ type: 'tracks', tracks });
  } finally { metaRunning = false; }
}

// ---------------------------------------------------------------- lyrics
// Order: a .lrc file next to the song, lyrics inside the file's tags, then (if the admin allows) lrclib.net.
// Results are cached on disk, so each song is looked up at most once. Friends' devices never contact anyone.
const LYRICS_CACHE = path.join(ROOT, 'lyrics-cache.json');
let lyricsCache = {};
try { lyricsCache = JSON.parse(fs.readFileSync(LYRICS_CACHE, 'utf8')); } catch { /* none yet */ }
const lyricsInflight = new Map();
const DAY = 86400000;

function parseLrc(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim();
    for (const s of stamps) out.push([Number(s[1]) * 60 + Number(s[2]) + (s[3] ? Number('0.' + s[3]) : 0), words]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function asLyrics(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const synced = /\[\d{1,3}:\d{2}/.test(t) ? parseLrc(t) : [];
  if (synced.length) return { synced, plain: null };
  return { synced: null, plain: t.replace(/\r\n/g, '\n') };
}

function sidecarLyrics(track) {
  const base = path.join(libRoot, track.id).replace(/\.[^.\\/]+$/, '');
  try { const r = asLyrics(fs.readFileSync(base + '.lrc', 'utf8')); return r && r.synced ? r : null; } catch { return null; }
}

async function lrclibLookup(track) {
  const headers = { 'User-Agent': 'SyncRoom/1.0 (private listening room)' };
  const get = async (endpoint, params) => {
    const r = await fetch(`https://lrclib.net/api/${endpoint}?${new URLSearchParams(params)}`, { headers, signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  const dur = track.duration ? Math.round(track.duration) : 0;
  const strip = (s) => String(s || '').replace(/\s*[(\[][^)\]]*(feat|ft\.|with|remaster|live|version|from)[^)\]]*[)\]]/gi, '').trim();
  const primary = String(track.artist || '').split(/,|&|;|\/|\sfeat\.?\s|\sft\.?\s/i)[0].trim();
  const pick = (r) => {
    const synced = r && !r.instrumental && r.syncedLyrics ? parseLrc(r.syncedLyrics) : [];
    return synced.length ? { synced, plain: null } : null; // plain, untimed lyrics are not used
  };

  if (track.artist && track.title && dur) {
    const exact = pick(await get('get', { artist_name: track.artist, track_name: track.title, album_name: track.album || '', duration: dur }));
    if (exact) return exact;
  }
  const params = { track_name: strip(track.title) };
  if (primary) params.artist_name = primary;
  const list = await get('search', params);
  if (Array.isArray(list)) {
    const close = list.filter((r) => !dur || !r.duration || Math.abs(r.duration - dur) <= 4);
    const best = close.find((r) => r.syncedLyrics);
    return pick(best);
  }
  return null;
}

async function resolveLyrics(track) {
  const key = `${track.id}|${track.size}`;
  const c = lyricsCache[key];
  if (c && (c.source === 'none' || c.synced)) {
    const none = c.source === 'none';
    if (!none || (Date.now() - c.t < 14 * DAY && (c.online || !settings.lyricsOnline))) return c;
  }
  let found = sidecarLyrics(track);
  let source = found ? 'lrc file' : '';
  let online = false;
  if (!found && settings.lyricsOnline) {
    online = true;
    try { found = await lrclibLookup(track); if (found) source = 'lrclib.net'; }
    catch { return { source: 'none', synced: null, plain: null, offline: true }; } // network trouble: do not cache
  }
  const result = found ? { source, ...found, t: Date.now() } : { source: 'none', synced: null, plain: null, online, t: Date.now() };
  lyricsCache[key] = result;
  try { fs.writeFileSync(LYRICS_CACHE, JSON.stringify(lyricsCache)); } catch { /* cache is optional */ }
  return result;
}

function getLyrics(track) {
  const key = `${track.id}|${track.size}`;
  if (!lyricsInflight.has(key)) lyricsInflight.set(key, resolveLyrics(track).finally(() => lyricsInflight.delete(key)));
  return lyricsInflight.get(key);
}

// ---------------------------------------------------------------- playback state
const state = { trackId: null, scope: null, playing: false, anchorTime: 0, anchorPos: 0, shuffle: false, repeat: 'all', version: 0 };
// One switch: who may control playback AND upload songs. The admin can change it.
// lyricsOnline: whether this PC may look up lyrics on lrclib.net (sends only title/artist/album/length).
const settings = { access: 'everyone', lyricsOnline: cfg.lyricsOnline !== false };

/** Save one setting into config.json without touching anything else (e.g. a temporary PORT override). */
function saveConfigKey(key, value) {
  try {
    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch { /* start fresh */ }
    onDisk[key] = value;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2));
  } catch { /* read-only folder: the choice just won't survive a restart */ }
}
const CONTROL_MSGS = new Set(['play', 'pause', 'seek', 'select', 'next', 'prev', 'shuffle', 'repeat']);
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);

const trackIndex = (id) => tracks.findIndex((t) => t.id === id);
const durationOf = (id) => {
  const t = tracks.find((x) => x.id === id);
  return durations.get(id) || (t && t.duration) || Infinity;
};
/** The list "next/previous" walks: one folder if the song was started from a folder, otherwise everything. */
const queue = () => (state.scope === null ? tracks : tracks.filter((t) => t.folder === state.scope));

function currentPos(t = Date.now()) {
  if (!state.playing) return state.anchorPos;
  return state.anchorPos + Math.max(0, t - state.anchorTime) / 1000;
}

function startTrack(id, pos = 0, play = true) {
  state.trackId = id;
  state.anchorPos = pos;
  state.playing = play;
  state.anchorTime = Date.now() + (play ? LEAD_MS : 0);
  state.version++;
}

function stopAtStart() {
  state.trackId = tracks.length ? tracks[0].id : null;
  state.scope = null;
  state.anchorPos = 0;
  state.playing = false;
  state.anchorTime = Date.now();
  state.version++;
}

function resetPlayback() {
  state.trackId = null;
  state.scope = null;
  state.playing = false;
  state.anchorPos = 0;
  state.anchorTime = Date.now();
  state.version++;
}

function nextId(auto) {
  const q = queue();
  if (!q.length) return null;
  const i = q.findIndex((t) => t.id === state.trackId);
  if (state.shuffle && q.length > 1) {
    let j;
    do { j = Math.floor(Math.random() * q.length); } while (j === i);
    return q[j].id;
  }
  if (i < 0) return q[0].id;
  if (i + 1 < q.length) return q[i + 1].id;
  return state.repeat === 'all' || !auto ? q[0].id : null;
}

function prevId() {
  const q = queue();
  if (!q.length) return null;
  const i = q.findIndex((t) => t.id === state.trackId);
  return q[(i <= 0 ? q.length : i) - 1].id;
}

function handleMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.type !== 'string') return;

  if (CONTROL_MSGS.has(m.type) && ws.role !== 'admin' && settings.access !== 'everyone') {
    ws.send(JSON.stringify({ type: 'denied', reason: 'Only the admin can control playback right now' }));
    return;
  }

  switch (m.type) {
    case 'name': {
      const n = cleanName(m.name);
      if (!n) return;
      ws.name = n;
      broadcastUsers();
      return;
    }

    case 'settings': {
      if (ws.role !== 'admin') return;
      if (['admin', 'everyone'].includes(m.access)) settings.access = m.access;
      if (typeof m.lyricsOnline === 'boolean' && m.lyricsOnline !== settings.lyricsOnline) {
        settings.lyricsOnline = m.lyricsOnline;
        cfg.lyricsOnline = m.lyricsOnline;
        saveConfigKey('lyricsOnline', m.lyricsOnline);
      }
      broadcast({ type: 'settings', settings });
      return;
    }

    case 'ping':
      if (typeof m.t0 === 'number') ws.send(JSON.stringify({ type: 'pong', t0: m.t0, ts: Date.now() }));
      return;

    case 'play':
      if (!state.trackId) {
        if (!tracks.length) return;
        state.trackId = tracks[0].id;
        state.scope = null;
        state.anchorPos = 0;
      }
      if (state.playing) return;
      state.playing = true;
      state.anchorTime = Date.now() + LEAD_MS;
      state.version++;
      break;

    case 'pause':
      if (!state.playing) return;
      state.anchorPos = currentPos();
      state.playing = false;
      state.anchorTime = Date.now();
      state.version++;
      break;

    case 'seek': {
      const pos = Number(m.pos);
      if (!state.trackId || !Number.isFinite(pos)) return;
      state.anchorPos = Math.min(Math.max(0, pos), Math.max(0, durationOf(state.trackId) - 0.2));
      state.anchorTime = Date.now() + (state.playing ? LEAD_MS : 0);
      state.version++;
      break;
    }

    case 'select': {
      const t = tracks[trackIndex(m.id)];
      if (!t) return;
      state.scope = typeof m.scope === 'string' && m.scope === t.folder ? m.scope : null;
      startTrack(m.id, 0, true);
      break;
    }

    case 'next': {
      const id = nextId(false);
      if (!id) return;
      startTrack(id, 0, true);
      break;
    }

    case 'prev': {
      if (!state.trackId) return;
      if (currentPos() > 3) startTrack(state.trackId, 0, state.playing);
      else startTrack(prevId(), 0, true);
      break;
    }

    case 'shuffle':
      state.shuffle = !!m.on; // no playback change, so the version stays the same
      break;

    case 'repeat':
      if (!['off', 'all', 'one'].includes(m.mode)) return;
      state.repeat = m.mode;
      break;

    case 'ended': {
      // Every device reports the end of the track; only the first report for this version counts.
      if (m.id !== state.trackId || m.version !== state.version || !state.playing) return;
      if (state.repeat === 'one') startTrack(state.trackId, 0, true);
      else {
        const id = nextId(true);
        if (id) startTrack(id, 0, true);
        else stopAtStart();
      }
      break;
    }

    case 'duration': {
      const d = Number(m.duration);
      if (trackIndex(m.id) < 0 || !(d > 0 && d < 36000)) return;
      if (Math.abs((durations.get(m.id) || 0) - d) > 0.01) {
        durations.set(m.id, d);
        const t = tracks[trackIndex(m.id)];
        if (t) t.duration = d;
        broadcast({ type: 'tracks', tracks });
      }
      return;
    }

    default:
      return;
  }
  broadcast({ type: 'state', state });
}

// ---------------------------------------------------------------- http
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const sendJson = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const isHttps = (req) => !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

/** The address friends should open: how this request reached us, unless that is localhost, then the Wi-Fi/LAN address. */
function shareUrl(req) {
  const host = req.headers.host || '';
  if (host && !/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(host)) return `${isHttps(req) ? 'https' : 'http'}://${host}`;
  const ips = lanAddresses();
  const lan = ips.find((a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) || ips[0] || 'localhost';
  return `http://${lan}:${cfg.port}`;
}

/** Streams the raw request body straight into the music folder (no multipart parsing). */
function handleUpload(req, res, url) {
  const raw = path.basename(url.searchParams.get('name') || '');
  const ext = path.extname(raw).toLowerCase();
  if (!AUDIO_EXT[ext]) return sendJson(res, 400, { error: 'Unsupported file type' });
  if (tracks.length >= MAX_TRACKS) return sendJson(res, 409, { error: 'Library is full' });
  const declared = Number(req.headers['content-length']);
  if (!declared || declared > MAX_UPLOAD) return sendJson(res, 413, { error: `File too large (limit ${Math.round(MAX_UPLOAD / 1048576)} MB)` });

  let name = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  const stem = name.slice(0, name.length - ext.length) || 'track';
  name = stem + ext;
  for (let n = 2; fs.existsSync(path.join(libRoot, name)); n++) name = `${stem} (${n})${ext}`;

  const tmp = path.join(libRoot, `.upload-${crypto.randomBytes(6).toString('hex')}`);
  const out = fs.createWriteStream(tmp);
  let size = 0;
  let failed = false;
  const fail = (code, msg) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.unlink(tmp, () => {});
    if (!res.headersSent) sendJson(res, code, { error: msg });
    req.destroy();
  };
  req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) fail(413, 'File too large'); });
  req.on('error', () => fail(400, 'Upload interrupted'));
  req.on('aborted', () => fail(400, 'Upload interrupted'));
  out.on('error', () => fail(500, 'Could not save the file'));
  out.on('finish', () => {
    if (failed) return;
    fs.rename(tmp, path.join(libRoot, name), (err) => {
      if (err) { fs.unlink(tmp, () => {}); return sendJson(res, 500, { error: 'Could not save the file' }); }
      rescan();
      sendJson(res, 200, { ok: true, name });
    });
  });
  req.pipe(out);
}

// Folder browser for the admin (only ever reachable from the host PC itself).
function listDir(p) {
  if (!p) {
    const entries = [];
    if (process.platform === 'win32') {
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':\\';
        try { if (fs.existsSync(d)) entries.push({ name: d, path: d }); } catch { /* skip */ }
      }
    } else entries.push({ name: '/', path: '/' });
    const shortcuts = [];
    const home = os.homedir();
    for (const n of ['Music', 'Downloads', 'Documents', 'Desktop']) {
      const sp = path.join(home, n);
      try { if (fs.statSync(sp).isDirectory()) shortcuts.push({ name: n, path: sp }); } catch { /* missing */ }
    }
    if (process.platform !== 'win32') {
      shortcuts.push({ name: 'Home', path: home });
      try { if (fs.statSync('/Volumes').isDirectory()) shortcuts.push({ name: 'External drives (/Volumes)', path: '/Volumes' }); } catch { /* not macOS */ }
    }
    shortcuts.push({ name: 'Sync Room music folder', path: path.resolve(ROOT, 'music') });
    return { path: '', parent: null, entries, shortcuts, audio: 0 };
  }
  const dir = path.resolve(p);
  const ents = fs.readdirSync(dir, { withFileTypes: true });
  const entries = ents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$'))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, 500);
  const audio = ents.filter((d) => d.isFile() && AUDIO_EXT[path.extname(d.name).toLowerCase()]).length;
  const parent = path.dirname(dir) === dir ? '' : path.dirname(dir);
  return { path: dir, parent, entries, shortcuts: [], audio };
}

function setLibrary(dir) {
  cfg.musicDir = dir;
  saveConfigKey('musicDir', dir);
  libRoot = dir;
  durations.clear();
  metaCache.clear();
  trackSig = '';
  tracks = [];
  refreshTracks();
  resetPlayback();
  broadcast({ type: 'tracks', tracks, libName: libName() });
  broadcast({ type: 'state', state });
  fillMeta();
}
const libName = () => path.basename(libRoot) || libRoot;

function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  try { p = decodeURIComponent(p); } catch { return send(res, 400, 'Bad request'); }
  const file = path.join(PUBLIC_DIR, path.normalize(p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': STATIC_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function serveAudio(req, res, id) {
  const track = tracks.find((t) => t.id === id);
  if (!track) return send(res, 404, 'Not found');
  const file = path.join(libRoot, track.id);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const size = st.size;
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': AUDIO_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === '' && m[2] === '')) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
      if (start > end || start >= size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

async function serveCover(res, id) {
  const t = tracks.find((x) => x.id === id);
  const lib = await loadMM();
  if (!t || !t.cover || !lib) return send(res, 404, 'Not found');
  try {
    const md = await lib.parseFile(path.join(libRoot, t.id), { skipPostHeaders: true });
    const pic = md.common.picture && md.common.picture[0];
    if (!pic) return send(res, 404, 'Not found');
    const type = /^image\/(jpeg|png|webp|gif)$/.test(pic.format) ? pic.format : 'application/octet-stream';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': pic.data.length, 'Cache-Control': 'private, max-age=86400' });
    res.end(Buffer.from(pic.data));
  } catch { send(res, 404, 'Not found'); }
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
  const { pathname } = url;
  const role = getRole(req);

  if (req.method === 'POST' && !sameOrigin(req)) return sendJson(res, 403, { error: 'Forbidden' });

  if (pathname === '/api/share' && req.method === 'GET') return sendJson(res, 200, { url: shareUrl(req) });

  if (pathname === '/api/qr.svg' && req.method === 'GET') {
    const qr = qrcode(0, 'M');
    qr.addData(shareUrl(req));
    qr.make();
    return send(res, 200, qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
  }

  if (pathname === '/api/cover' && req.method === 'GET') return serveCover(res, url.searchParams.get('id') || '');

  if (pathname === '/api/lyrics' && req.method === 'GET') {
    const t = tracks.find((x) => x.id === (url.searchParams.get('id') || ''));
    if (!t) return sendJson(res, 404, { error: 'Track not found' });
    const r = await getLyrics(t);
    return sendJson(res, 200, { source: r.source, synced: r.synced || null, plain: r.plain || null, offline: !!r.offline });
  }

  if (pathname === '/api/upload' && req.method === 'POST') {
    if (role !== 'admin' && settings.access !== 'everyone') return sendJson(res, 403, { error: 'Only the admin can upload right now' });
    return handleUpload(req, res, url);
  }

  if (pathname === '/api/delete' && req.method === 'POST') {
    if (role !== 'admin') return sendJson(res, 403, { error: 'Admin only' });
    let id = '';
    try { id = String(JSON.parse(await readBody(req)).id || ''); } catch { /* bad body */ }
    const t = tracks.find((x) => x.id === id);
    if (!t) return sendJson(res, 404, { error: 'Track not found' });
    try { fs.unlinkSync(path.join(libRoot, t.id)); } catch { return sendJson(res, 500, { error: 'Could not delete the file' }); }
    durations.delete(id);
    metaCache.delete(id);
    rescan();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/fs' && req.method === 'GET') {
    if (role !== 'admin') return sendJson(res, 403, { error: 'Only the host PC can browse folders' });
    try { return sendJson(res, 200, listDir(url.searchParams.get('path') || '')); }
    catch { return sendJson(res, 400, { error: 'Cannot open that folder' }); }
  }

  if (pathname === '/api/folder' && req.method === 'POST') {
    if (role !== 'admin') return sendJson(res, 403, { error: 'Only the host PC can change the folder' });
    let p = '';
    try { p = String(JSON.parse(await readBody(req)).path || ''); } catch { /* bad body */ }
    if (!p || !path.isAbsolute(p)) return sendJson(res, 400, { error: 'Pick a folder' });
    const dir = path.resolve(p);
    try { if (!fs.statSync(dir).isDirectory()) throw new Error('not a folder'); fs.readdirSync(dir); }
    catch { return sendJson(res, 400, { error: 'Cannot open that folder' }); }
    setLibrary(dir);
    return sendJson(res, 200, { ok: true, path: dir, name: libName(), count: tracks.length });
  }

  if (pathname.startsWith('/audio/') && (req.method === 'GET' || req.method === 'HEAD')) {
    let id;
    try { id = decodeURIComponent(pathname.slice('/audio/'.length)); } catch { return send(res, 400, 'Bad request'); }
    return serveAudio(req, res, id);
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  return send(res, 405, 'Method not allowed');
});

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
const userList = () => [...wss.clients].map((c) => ({ id: c.id, name: c.name, admin: c.role === 'admin' }));
const broadcastUsers = () => broadcast({ type: 'users', users: userList() });

server.on('upgrade', (req, socket, head) => {
  const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return reject(400, 'Bad Request'); }
  if (pathname !== '/ws') return reject(404, 'Not Found');
  if (!sameOrigin(req)) return reject(403, 'Forbidden');
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  ws.id = crypto.randomBytes(4).toString('hex');
  ws.role = getRole(req);
  ws.name = (ws.role === 'admin' ? 'host-' : 'guest-') + ws.id.slice(0, 3);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => handleMessage(ws, data.toString()));
  ws.on('close', broadcastUsers);
  ws.on('error', () => {});
  ws.send(JSON.stringify({
    type: 'hello', tracks, state, settings, libName: libName(),
    libPath: ws.role === 'admin' ? libRoot : null, // only the host sees the real path
    you: { id: ws.id, role: ws.role, name: ws.name }, maxUploadMB: Math.round(MAX_UPLOAD / 1048576),
  }));
  broadcastUsers();
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

// Pick up files added to / removed from the music folder.
function rescan() {
  if (!refreshTracks()) return;
  if (state.trackId && trackIndex(state.trackId) < 0) resetPlayback();
  broadcast({ type: 'tracks', tracks });
  broadcast({ type: 'state', state });
  fillMeta();
}
setInterval(rescan, 8000).unref();

// ---------------------------------------------------------------- start
refreshTracks();
fillMeta();
server.listen(cfg.port, '0.0.0.0', () => {
  console.log('\n  Sync Room is running. You are the admin on this PC; friends on your Wi-Fi are guests.\n');
  console.log(`  This PC:   http://localhost:${cfg.port}   <- open this one (admin)`);
  for (const a of lanAddresses()) console.log(`  Wi-Fi/LAN: http://${a}:${cfg.port}   <- friends use this, or scan the QR code in the app`);
  console.log(`\n  Music:     ${libRoot}`);
  console.log(`  Tracks:    ${tracks.length} found`);
  if (!tracks.length) console.log('  -> Pick a folder with audio in the app, or drop files into the music folder.');
  console.log('');
});

process.on('SIGINT', () => process.exit(0));


