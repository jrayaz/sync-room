(() => {
  'use strict';

  const clientNow = () => performance.timeOrigin + performance.now();
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } },
  };

  const el = {};
  for (const id of ['gate', 'gateTitle', 'gateSub', 'gateBar', 'gateBtn', 'gateStats',
    'picker', 'pickUp', 'pickPath', 'pickGo', 'pickList', 'pickInfo', 'pickCancel', 'pickUse',
    'app', 'status', 'statusText', 'tOffset', 'tRtt', 'tOl', 'qrBtn', 'qrOpen', 'inviteUrl', 'qrModal', 'qrClose', 'sideToggle', 'sidebar', 'backdrop',
    'roleBadge', 'nameInput', 'qrImg', 'qrUrl', 'usersList', 'usersMore', 'usersMoreText', 'usersCount', 'trimMinus', 'trimPlus', 'trimVal', 'resync',
    'heroCover', 'heroState', 'heroTitle', 'heroArtist', 'permAccess', 'accessTitle', 'accessSub',
    'count', 'folderBtn', 'uploadBtn', 'fileInput', 'upState', 'tabSongs', 'tabFolders', 'search', 'crumb', 'crumbName',
    'folders', 'tracks', 'empty', 'emptyTitle', 'emptyHint', 'emptyPick', 'dropzone',
    'npCover', 'npTitle', 'npArtist', 'btnShuffle', 'btnPrev', 'btnPlay', 'playUse', 'btnNext', 'btnRepeat', 'repeatUse',
    'lyrics', 'lyTitle', 'lyArtist', 'lySource', 'lyMinus', 'lyPlus', 'lyOff', 'lyClose', 'lyBody', 'btnLyrics', 'permLyrics',
    'player', 'sheetClose', 'nowOpen', 'seek', 'tCur', 'tDur', 'vol', 'toast']) el[id] = document.getElementById(id);

  // ------------------------------------------------------------ state
  let tracks = [];
  let libName = 'Music';
  let libPath = null; // only the host PC is told the real path
  let state = null;
  let settings = { access: 'everyone' };
  let role = 'guest';
  let me = { id: '', name: '' };
  let users = [];
  let ws = null;
  let reconnectDelay = 500;
  let reconnectTimer = null;
  let pingTimer = null;
  let filter = '';
  let tab = store.get('sr_tab', 'songs') === 'folders' ? 'folders' : 'songs';
  let openFolder = null; // inside a folder in the Folders tab
  let shareLink = location.origin;

  // clock sync: offset = serverTime - clientTime
  let offset = 0;
  let clockReady = false;
  let started = false; // true once the user tapped "Start" (browsers need that gesture before sound)
  let samples = [];
  const READY_SAMPLES = 10;
  const BURST = 16;

  // audio
  let ctx = null;
  let gain = null;
  let source = null;
  let srcInfo = null;
  let applyToken = 0;
  let appliedVersion = -1;
  let lastResched = 0;
  const MAX_CACHED = 2; // decoded audio is large, so keep only the current and next track
  const buffers = new Map();
  const loading = new Map();
  const loadingIds = new Set();

  let trimMs = Number(store.get('sr_trim', 0)) || 0;
  let volume = Math.min(1, Math.max(0, Number(store.get('sr_vol', 1))));
  let dragging = false;

  const serverNow = () => clientNow() + offset;
  const isAdmin = () => role === 'admin';
  const canControl = () => isAdmin() || settings.access === 'everyone';
  const canUpload = canControl;

  // ------------------------------------------------------------ helpers
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  const send = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const trackById = (id) => tracks.find((t) => t.id === id);
  const outLatency = () => (ctx && (ctx.outputLatency || ctx.baseLatency)) || 0;
  const totalLat = () => outLatency() + trimMs / 1000;
  const setP = (node, frac) => node.style.setProperty('--p', `${(frac * 100).toFixed(2)}%`);
  function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  const folderLabel = (f) => (f === '' ? libName : f.slice(f.lastIndexOf('/') + 1));
  const queueOf = () => (!state || state.scope === null || state.scope === undefined ? tracks : tracks.filter((t) => t.folder === state.scope));

  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3500);
  }

  const ADJ = ['quiet', 'bright', 'happy', 'swift', 'lucky', 'calm', 'brave', 'gentle', 'cosmic', 'sunny'];
  const ANI = ['koala', 'otter', 'falcon', 'panda', 'tiger', 'heron', 'lynx', 'dolphin', 'fox', 'owl'];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  let myName = store.get('sr_name', '') || `${pick(ADJ)}-${pick(ANI)}`;
  store.set('sr_name', myName);
  el.nameInput.value = myName;

  /** Gradient fallback plus the song's real cover art when it has one. */
  function setCover(node, t, seed) {
    node.style.setProperty('--h', String(hue(seed)));
    const key = t && t.cover ? `${t.id}|${t.size}` : '';
    if (node.dataset.cv === key) return;
    node.dataset.cv = key;
    const old = node.querySelector('img');
    if (old) old.remove();
    if (!key) return;
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = `/api/cover?id=${encodeURIComponent(t.id)}&v=${t.size}`;
    img.addEventListener('error', () => img.remove());
    node.prepend(img);
  }

  // ------------------------------------------------------------ boot
  function closeDrawers() {
    el.sidebar.classList.remove('open');
    el.backdrop.hidden = true;
  }

  async function loadShare() {
    try {
      const j = await (await fetch('/api/share')).json();
      if (j.url) {
        shareLink = j.url;
        const short = j.url.replace(/^https?:\/\//, '');
        el.qrUrl.textContent = short;
        el.inviteUrl.textContent = short;
      }
    } catch { /* QR is optional */ }
  }

  // QR code: a small icon opens the enlarged version
  function openQr() {
    if (!el.qrImg.getAttribute('src')) el.qrImg.src = '/api/qr.svg';
    el.qrModal.hidden = false;
    closeDrawers();
  }
  el.qrBtn.addEventListener('click', openQr);
  el.qrOpen.addEventListener('click', openQr);
  el.qrClose.addEventListener('click', () => { el.qrModal.hidden = true; });
  el.qrModal.addEventListener('click', (e) => { if (e.target === el.qrModal) el.qrModal.hidden = true; });

  function startApp() {
    el.app.hidden = false;
    started = false;
    showGate('calibrating');
    connect();
    loadShare();
  }

  // ------------------------------------------------------------ gate (calibration + start tap)
  function showGate(mode) {
    el.gate.hidden = false;
    if (mode === 'resume') {
      el.gateTitle.textContent = 'Audio paused by the browser';
      el.gateSub.textContent = 'Tap once to rejoin the music.';
      el.gateBtn.textContent = 'Rejoin';
      el.gateBtn.disabled = !clockReady;
    } else if (!clockReady) {
      el.gateTitle.textContent = 'Calibrating';
      el.gateSub.textContent = "Synchronising this device's clock with the room...";
      el.gateBtn.textContent = 'Please wait';
      el.gateBtn.disabled = true;
    } else {
      el.gateTitle.textContent = 'In sync';
      el.gateSub.textContent = 'This device is locked to the room clock. Your browser needs one tap before it can play sound.';
      el.gateBtn.textContent = 'Start listening';
      el.gateBtn.disabled = false;
    }
  }

  function updateGate() {
    el.gateBar.style.width = `${Math.min(100, (samples.length / READY_SAMPLES) * 100)}%`;
    const best = bestSample();
    el.gateStats.textContent = best ? `RTT ${best.rtt.toFixed(1)} ms   Offset ${Math.round(offset)} ms` : '';
    if (!el.gate.hidden && !started) showGate('calibrating');
  }

  el.gateBtn.addEventListener('click', async () => {
    ensureCtx();
    try { if (ctx) await ctx.resume(); } catch { /* ignore */ }
    if (ctx && ctx.state === 'running') {
      started = true;
      el.gate.hidden = true;
      applyState();
    }
  });

  // ------------------------------------------------------------ websocket + clock sync
  function ping() { send({ type: 'ping', t0: clientNow() }); }

  function burstPings() {
    let n = 0;
    const b = setInterval(() => { ping(); if (++n >= BURST) clearInterval(b); }, 60);
  }

  function connect() {
    clearTimeout(reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    setStatus('syncing', 'Connecting');

    ws.onopen = () => {
      reconnectDelay = 500;
      samples = [];
      clockReady = false;
      send({ type: 'name', name: myName });
      burstPings();
      clearInterval(pingTimer);
      pingTimer = setInterval(ping, 3000);
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      setStatus('offline', 'Reconnecting');
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
    };
    ws.onerror = () => {};
  }

  function setStatus(s, text) {
    el.status.dataset.s = s;
    el.statusText.textContent = text;
  }

  function bestSample() {
    return samples.length ? samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)) : null;
  }

  function onPong(m) {
    const t1 = clientNow();
    const rtt = t1 - m.t0;
    if (rtt < 0) return;
    // the server stamped its reply roughly halfway through the round trip
    samples.push({ rtt, off: m.ts + rtt / 2 - t1 });
    if (samples.length > 40) samples.shift();
    // trust only the fastest round trips (least network jitter), take the median of their offsets
    const keep = Math.max(3, Math.ceil(samples.length * 0.25));
    const best = samples.slice().sort((a, b) => a.rtt - b.rtt).slice(0, keep);
    const offs = best.map((s) => s.off).sort((a, b) => a - b);
    offset = offs[Math.floor(offs.length / 2)];
    el.tOffset.textContent = `${offset.toFixed(1)}ms`;
    el.tRtt.textContent = `${best[0].rtt.toFixed(1)}ms`;
    if (!clockReady && samples.length >= READY_SAMPLES) {
      clockReady = true;
      setStatus('ok', 'In sync');
      if (started) applyState();
    }
    updateGate();
  }

  el.resync.addEventListener('click', () => {
    samples = [];
    clockReady = false;
    setStatus('syncing', 'Re-syncing');
    burstPings();
  });

  function onMessage(m) {
    switch (m.type) {
      case 'pong': return onPong(m);
      case 'hello':
        tracks = m.tracks || [];
        libName = m.libName || libName;
        libPath = m.libPath || null;
        settings = m.settings || settings;
        me = m.you || me;
        role = me.role || role;
        renderAccess();
        renderTracks();
        setState(m.state);
        return;
      case 'tracks':
        tracks = m.tracks || [];
        if (m.libName) { libName = m.libName; openFolder = null; }
        if (openFolder !== null && !tracks.some((t) => t.folder === openFolder)) openFolder = null;
        renderTracks();
        renderNow();
        return;
      case 'state': return setState(m.state);
      case 'users': users = m.users || []; renderUsers(); return;
      case 'settings': {
        const lyChanged = !!m.settings.lyricsOnline !== !!settings.lyricsOnline;
        settings = m.settings;
        renderAccess();
        renderTracks();
        if (lyChanged) { lyCache.clear(); lyFor = null; if (lyricsOpen) loadLyrics(); }
        return;
      }
      case 'denied': toast(m.reason || 'Not allowed'); return;
      default:
    }
  }

  function setState(s) {
    state = s;
    renderControls();
    renderTracks();
    renderNow();
    if (s.version !== appliedVersion) {
      appliedVersion = s.version;
      applyState();
    }
  }

  // ------------------------------------------------------------ audio engine
  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { toast('This browser has no Web Audio support'); return null; }
    ctx = new AC({ latencyHint: 'interactive' });
    gain = ctx.createGain();
    gain.gain.value = volume;
    gain.connect(ctx.destination);
    ctx.onstatechange = () => {
      if (!started) return;
      if (ctx.state === 'running') { el.gate.hidden = true; applyState(); }
      else if (state && state.playing) showGate('resume');
    };
    return ctx;
  }

  function stopSource() {
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch { /* not started */ }
    try { source.disconnect(); } catch { /* ignore */ }
    source = null;
    srcInfo = null;
  }

  function touchBuffer(id) {
    const b = buffers.get(id);
    if (b) { buffers.delete(id); buffers.set(id, b); }
    return b;
  }

  function evict() {
    while (buffers.size > MAX_CACHED) {
      const oldest = [...buffers.keys()].find((k) => k !== (state && state.trackId));
      if (oldest === undefined) break;
      buffers.delete(oldest);
    }
  }

  function ensureBuffer(id) {
    const cached = touchBuffer(id);
    if (cached) return Promise.resolve(cached);
    if (loading.has(id)) return loading.get(id);
    const p = (async () => {
      loadingIds.add(id); renderTracks();
      try {
        const res = await fetch('/audio/' + encodeURIComponent(id));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        buffers.set(id, buf);
        evict();
        send({ type: 'duration', id, duration: buf.duration });
        return buf;
      } finally {
        loadingIds.delete(id); loading.delete(id); renderTracks();
      }
    })();
    loading.set(id, p);
    return p;
  }

  async function applyState() {
    const token = ++applyToken;
    stopSource();
    if (!state || !state.trackId || !state.playing || !clockReady || !started) return;
    if (!ctx || ctx.state !== 'running') { showGate('resume'); return; }
    let buf;
    try {
      buf = await ensureBuffer(state.trackId);
    } catch (e) {
      if (token === applyToken) toast(`Could not load that track (${e.message})`);
      return;
    }
    if (token !== applyToken) return; // a newer state arrived while loading
    schedule(buf);
    prefetchNext();
  }

  /** Start the buffer so it is audible at the position the server clock says it should be. */
  function schedule(buf) {
    stopSource();
    const d = (serverNow() - state.anchorTime) / 1000 + totalLat();
    let when = 0;
    let pos;
    if (d < 0) { when = -d; pos = state.anchorPos; } else { pos = state.anchorPos + d; }

    if (pos >= buf.duration - 0.05) { send({ type: 'ended', id: state.trackId, version: state.version }); return; }

    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(gain);
    const startAt = ctx.currentTime + when;
    node.start(startAt, pos);
    node.onended = () => {
      if (source !== node) return;
      send({ type: 'ended', id: state.trackId, version: state.version });
    };
    source = node;
    srcInfo = { when: startAt, offset: pos };
  }

  function prefetchNext() {
    const q = queueOf();
    if (!state || state.shuffle || q.length < 2) return;
    const i = q.findIndex((t) => t.id === state.trackId);
    const nxt = q[(i + 1) % q.length];
    if (nxt && nxt.id !== state.trackId) ensureBuffer(nxt.id).catch(() => {});
  }

  // Keep devices locked together: if this device has wandered, re-aim it.
  setInterval(() => {
    if (!source || !srcInfo || !state || !state.playing || !ctx || ctx.state !== 'running') return;
    if (ctx.currentTime < srcInfo.when + 0.5) return;
    const audioPos = srcInfo.offset + (ctx.currentTime - srcInfo.when);
    const wanted = state.anchorPos + (serverNow() - state.anchorTime) / 1000 + totalLat();
    if (Math.abs(audioPos - wanted) > 0.025 && performance.now() - lastResched > 3000) {
      lastResched = performance.now();
      applyState();
    }
  }, 1000);

  // ------------------------------------------------------------ rendering
  function currentDuration() {
    if (!state || !state.trackId) return 0;
    const t = trackById(state.trackId);
    const b = buffers.get(state.trackId);
    return (b && b.duration) || (t && t.duration) || 0;
  }

  function uiPos() {
    if (!state || !state.trackId) return 0;
    if (!state.playing) return state.anchorPos;
    return state.anchorPos + Math.max(0, (serverNow() - state.anchorTime) / 1000);
  }

  function renderControls() {
    const playing = !!(state && state.playing);
    el.playUse.setAttribute('href', playing ? '#i-pause' : '#i-play');
    el.btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    el.btnPlay.disabled = !tracks.length;
    el.btnShuffle.setAttribute('aria-pressed', String(!!(state && state.shuffle)));
    el.btnShuffle.title = state && state.shuffle ? 'Shuffle: on' : 'Shuffle: off';
    const rep = (state && state.repeat) || 'all';
    el.btnRepeat.setAttribute('aria-pressed', String(rep !== 'off'));
    el.repeatUse.setAttribute('href', rep === 'one' ? '#i-repeat1' : '#i-repeat');
    el.btnRepeat.setAttribute('aria-label', `Repeat: ${rep}`);
  }

  function renderNow() {
    const t = state && state.trackId ? trackById(state.trackId) : null;
    el.npTitle.textContent = t ? t.title : 'Nothing playing';
    el.npArtist.textContent = t ? t.artist : '';
    document.title = t && state.playing ? `${t.title} - Sync Room` : 'Sync Room';
    el.seek.disabled = !t || !currentDuration() || !canControl();

    const seed = t ? t.title : 'idle';
    setCover(el.heroCover, t, seed);
    setCover(el.npCover, t, seed);
    el.heroTitle.textContent = t ? t.title : 'Nothing playing';
    el.heroArtist.textContent = t ? ([t.artist, t.album].filter(Boolean).join(' · ') || 'Unknown artist')
      : (tracks.length ? 'Pick a song to start the room.' : 'Add some songs to get started.');
    el.heroState.textContent = !t ? 'Ready' : state.playing ? 'Now playing for everyone' : 'Paused';
    if (lyricsOpen) loadLyrics();
  }

  function renderAccess() {
    el.roleBadge.textContent = isAdmin() ? 'Admin' : 'Guest';
    el.roleBadge.classList.toggle('admin', isAdmin());
    el.folderBtn.hidden = !isAdmin();

    const all = settings.access === 'everyone';
    el.accessTitle.textContent = all ? 'Everyone can control' : 'Admin controls the room';
    el.accessSub.textContent = (all ? 'Anyone here can play, skip and upload songs.' : 'Only the admin can play, skip and upload songs.')
      + (isAdmin() ? '' : ' Only the admin can change this.');
    el.permAccess.closest('.access').classList.toggle('open-all', all);
    el.permAccess.classList.toggle('locked', !isAdmin());
    for (const b of el.permAccess.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.v === settings.access);
      b.disabled = !isAdmin();
    }
    for (const b of el.permLyrics.querySelectorAll('button')) {
      b.classList.toggle('on', (b.dataset.v === 'on') === !!settings.lyricsOnline);
      b.disabled = !isAdmin();
    }
    el.permLyrics.classList.toggle('locked', !isAdmin());
    el.btnLyrics.hidden = !settings.lyricsOnline; // lookup off: no lyrics button
    if (!settings.lyricsOnline && lyricsOpen) setLyricsOpen(false);
    el.uploadBtn.hidden = !canUpload();
    renderControls();
    renderNow();
    renderUsers();
  }

  const USER_LIMIT = 5;
  let usersExpanded = false;
  function renderUsers() {
    el.usersCount.textContent = String(users.length);
    el.usersList.textContent = '';
    const sorted = users.slice().sort((a, b) => Number(b.admin) - Number(a.admin) || a.name.localeCompare(b.name));
    // show 5 people (admin first); the rest sit behind 'Show all'. You always see yourself.
    let visible = sorted;
    if (!usersExpanded && sorted.length > USER_LIMIT) {
      visible = sorted.slice(0, USER_LIMIT);
      const mine = sorted.find((u) => u.id === me.id);
      if (mine && !visible.includes(mine)) visible[USER_LIMIT - 1] = mine;
    }
    el.usersMore.hidden = sorted.length <= USER_LIMIT;
    el.usersMore.setAttribute('aria-expanded', String(usersExpanded));
    el.usersMoreText.textContent = usersExpanded ? 'Show less' : `Show all ${sorted.length}`;
    for (const u of visible) {
      const li = document.createElement('li');
      if (u.id === me.id) li.className = 'me';
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = (u.name[0] || '?').toUpperCase();
      if (u.admin) {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        c.setAttribute('class', 'icon');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '#i-crown');
        c.append(use);
        av.append(c);
      }
      const nm = document.createElement('span');
      nm.className = 'uname';
      nm.textContent = u.name;
      li.append(av, nm);
      if (u.id === me.id) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'You';
        li.append(tag);
      }
      el.usersList.append(li);
    }
  }

  el.usersMore.addEventListener('click', () => { usersExpanded = !usersExpanded; renderUsers(); });

  // Library rendering is coalesced: many state/duration/tag updates can arrive in a burst.
  let renderQueued = false;
  function renderTracks() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; drawLibrary(); });
  }

  function drawLibrary() {
    const q = filter.trim().toLowerCase();
    const inFolders = tab === 'folders';
    el.tabSongs.setAttribute('aria-selected', String(!inFolders));
    el.tabFolders.setAttribute('aria-selected', String(inFolders));
    el.count.textContent = `${libName} · ${tracks.length} song${tracks.length === 1 ? '' : 's'}`;

    const showFolderList = inFolders && openFolder === null;
    el.crumb.hidden = !(inFolders && openFolder !== null);
    if (!el.crumb.hidden) el.crumbName.textContent = folderLabel(openFolder);
    el.folders.hidden = !showFolderList;
    el.tracks.hidden = showFolderList;
    el.folders.textContent = '';
    el.tracks.textContent = '';

    let shown = 0;
    if (showFolderList) {
      const groups = new Map();
      for (const t of tracks) { if (!groups.has(t.folder)) groups.set(t.folder, []); groups.get(t.folder).push(t); }
      for (const [f, list] of groups) {
        if (q && !folderLabel(f).toLowerCase().includes(q)) continue;
        shown++;
        el.folders.append(folderRow(f, list));
      }
    } else {
      const scope = inFolders ? openFolder : null;
      for (const t of tracks) {
        if (inFolders && t.folder !== openFolder) continue;
        if (q && !`${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)) continue;
        shown++;
        el.tracks.append(trackRow(t, scope));
      }
    }

    el.empty.hidden = shown > 0;
    if (!shown) {
      el.emptyTitle.textContent = tracks.length ? 'No matches' : 'No songs here yet';
      el.emptyHint.textContent = tracks.length ? 'Try a different search.'
        : isAdmin() ? 'Choose the folder on this PC that holds your music, or upload songs.'
          : 'Waiting for the host to add songs.';
      el.emptyPick.hidden = !(isAdmin() && !tracks.length);
    } else el.emptyPick.hidden = true;
  }

  function folderRow(f, list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'folder';
    const cover = document.createElement('span');
    cover.className = 'cover';
    cover.style.setProperty('--h', String(hue(f || libName)));
    cover.innerHTML = '<svg class="icon"><use href="#i-folder"/></svg>';
    const meta = document.createElement('span');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = folderLabel(f);
    const sub = document.createElement('div');
    sub.className = 'artist';
    sub.textContent = `${list.length} song${list.length === 1 ? '' : 's'}${f.includes('/') ? ' · ' + f : ''}`;
    meta.append(title, sub);
    const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chev.setAttribute('class', 'icon chev');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-chevron');
    chev.append(use);
    b.append(cover, meta, chev);
    b.addEventListener('click', () => { openFolder = f; el.search.value = ''; filter = ''; renderTracks(); });
    li.append(b);
    return li;
  }

  function trackRow(t, scope) {
    const li = document.createElement('li');
    li.dataset.id = t.id;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    const active = state && state.trackId === t.id;
    if (active) row.classList.add('active');
    if (active && state.playing) row.classList.add('playing');

    const cover = document.createElement('span');
    cover.className = 'cover';
    setCover(cover, t, t.title);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-music');
    icon.append(use);
    cover.append(icon);
    const eq = document.createElement('span');
    eq.className = 'eq';
    eq.innerHTML = '<b></b><b></b><b></b>';
    cover.append(eq);

    const meta = document.createElement('span');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = t.title;
    const artist = document.createElement('div');
    artist.className = 'artist';
    artist.textContent = [t.artist, t.album].filter(Boolean).join(' · ') || ' ';
    meta.append(title, artist);

    const dur = document.createElement('span');
    dur.className = 'dur';
    if (loadingIds.has(t.id)) {
      const sp = document.createElement('i');
      sp.className = 'spin';
      dur.append(sp);
    }
    dur.append(document.createTextNode(t.duration ? fmt(t.duration) : ''));

    row.append(cover, meta, dur);
    row.addEventListener('click', () => { gesture(); send({ type: 'select', id: t.id, scope }); });
    li.append(row);

    if (isAdmin()) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn del';
      del.setAttribute('aria-label', `Delete ${t.title}`);
      del.innerHTML = '<svg class="icon"><use href="#i-x"/></svg>';
      del.addEventListener('click', () => deleteTrack(t));
      li.append(del);
    }
    return li;
  }

  async function deleteTrack(t) {
    if (!window.confirm(`Delete "${t.title}" from this PC? This removes the file.`)) return;
    try {
      const r = await fetch('/api/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id }),
      });
      if (!r.ok) toast((await r.json().catch(() => ({}))).error || 'Could not delete');
    } catch { toast('Cannot reach the server'); }
  }

  function frame() {
    const dur = currentDuration();
    const pos = Math.min(uiPos(), dur || Infinity);
    if (!dragging) {
      el.tCur.textContent = fmt(pos);
      const frac = dur ? pos / dur : 0;
      el.seek.value = String(Math.round(frac * 1000));
      setP(el.seek, frac);
    }
    el.tDur.textContent = dur ? fmt(dur) : '0:00';
    el.tOl.textContent = ctx ? `${Math.round(outLatency() * 1000)}ms` : '-';
    updateLyricsLine();
    requestAnimationFrame(frame);
  }

  // tabs, folders, search
  function setTab(next) {
    tab = next;
    openFolder = null;
    store.set('sr_tab', next);
    renderTracks();
  }
  el.tabSongs.addEventListener('click', () => setTab('songs'));
  el.tabFolders.addEventListener('click', () => setTab('folders'));
  el.crumb.addEventListener('click', () => { openFolder = null; renderTracks(); });
  el.search.addEventListener('input', () => { filter = el.search.value; renderTracks(); });

  // ------------------------------------------------------------ full "Now playing" screen (phones)
  const phoneLayout = window.matchMedia('(max-width: 1020px)');
  function setSheet(open, fromPop) {
    const isOpen = el.player.classList.contains('expanded');
    if (open && !phoneLayout.matches) return;
    if (open === isOpen) return;
    el.player.classList.toggle('expanded', open);
    if (open) history.pushState({ sheet: 1 }, ''); // the Android back button closes the screen
    else if (!fromPop && history.state && history.state.sheet) history.back();
  }
  window.addEventListener('popstate', () => setSheet(false, true));
  phoneLayout.addEventListener('change', () => { if (!phoneLayout.matches) setSheet(false); });
  el.nowOpen.addEventListener('click', (e) => {
    const expanded = el.player.classList.contains('expanded');
    if (phoneLayout.matches && !expanded) { setSheet(true); return; } // phone mini bar: open the full player
    if (expanded && !e.target.closest('.now-text')) return;
    if (expanded) setSheet(false);
    revealCurrent();
  });
  el.sheetClose.addEventListener('click', () => setSheet(false));
  let sheetTouchY = null;
  el.player.addEventListener('touchstart', (e) => {
    sheetTouchY = el.player.classList.contains('expanded') && !e.target.closest('input') ? e.touches[0].clientY : null;
  }, { passive: true });
  el.player.addEventListener('touchend', (e) => {
    if (sheetTouchY === null) return;
    if (e.changedTouches[0].clientY - sheetTouchY > 90) setSheet(false); // swipe down to close
    sheetTouchY = null;
  }, { passive: true });

  // Clicking the now-playing song shows it in the Songs list.
  function revealCurrent() {
    const t = state && state.trackId ? trackById(state.trackId) : null;
    if (!t) return;
    if (lyricsOpen) setLyricsOpen(false);
    closeDrawers();
    tab = 'songs';
    openFolder = null;
    filter = '';
    el.search.value = '';
    store.set('sr_tab', 'songs');
    drawLibrary();
    const li = [...el.tracks.children].find((n) => n.dataset.id === t.id);
    if (!li) return;
    li.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const row = li.querySelector('.row');
    row.classList.remove('flash');
    void row.offsetWidth; // restart the animation
    row.classList.add('flash');
  }
  document.querySelector('.hero').addEventListener('click', revealCurrent);
  // ------------------------------------------------------------ lyrics
  let lyricsOpen = false;
  let lyFor = null;        // track id whose lyrics are on screen
  let lyLines = [];        // [{ t, node }] for synced lyrics
  let lyIdx = -1;
  let lyPauseScroll = 0;   // don't auto-scroll while the user is scrolling by hand
  let lyOffset = Number(store.get('sr_lyoff', 0)) || 0; // seconds; + shows lines earlier, - later
  const lyCache = new Map();

  function setLyOffset(v) {
    lyOffset = Math.max(-5, Math.min(5, Math.round(v * 100) / 100));
    el.lyOff.textContent = `${lyOffset > 0 ? '+' : ''}${lyOffset.toFixed(2)} s`;
    store.set('sr_lyoff', lyOffset);
  }

  function lyMessage(text, hint) {
    el.lyBody.className = 'lyrics-body is-msg';
    el.lyBody.textContent = '';
    const p = document.createElement('p');
    p.className = 'ly-msg';
    p.textContent = text;
    el.lyBody.append(p);
    if (hint) { const h = document.createElement('p'); h.className = 'ly-msg hint'; h.textContent = hint; el.lyBody.append(h); }
    lyLines = [];
    lyIdx = -1;
  }

  function renderLyrics(res) {
    el.lySource.textContent = res.source && res.source !== 'none' ? `via ${res.source}` : '';
    lyLines = [];
    lyIdx = -1;
    if (res.synced && res.synced.length) {
      el.lyBody.className = 'lyrics-body';
      el.lyBody.textContent = '';
      for (const [t, text] of res.synced) {
        const d = document.createElement('div');
        d.className = 'ly-line';
        d.textContent = text || '...';
        d.addEventListener('click', () => { if (canControl()) send({ type: 'seek', pos: Math.max(0, t - lyOffset) }); });
        el.lyBody.append(d);
        lyLines.push({ t, node: d });
      }
      el.lyBody.scrollTop = 0;
    } else if (res.offline) {
      lyMessage('Could not reach the lyrics service.', "The host PC needs internet for lyrics lookup. It'll try again next time.");
    } else if (settings.lyricsOnline) {
      lyMessage('No lyrics found for this song.', 'Put a .lrc file with the same name next to the song to show your own.');
    } else {
      lyMessage('No lyrics on this PC for this song.', 'Online lookup is off. Ask the admin to turn it on, or add a .lrc file next to the song.');
    }
  }

  async function loadLyrics() {
    const t = state && state.trackId ? trackById(state.trackId) : null;
    el.lyTitle.textContent = t ? t.title : 'Lyrics';
    el.lyArtist.textContent = t ? t.artist : '';
    if (!t) { lyFor = null; lyMessage('Play a song to see its lyrics.'); el.lySource.textContent = ''; return; }
    if (lyFor === t.id) return;
    lyFor = t.id;
    if (lyCache.has(t.id)) { renderLyrics(lyCache.get(t.id)); return; }
    lyMessage('Looking for lyrics...');
    el.lySource.textContent = '';
    try {
      const res = await (await fetch('/api/lyrics?id=' + encodeURIComponent(t.id))).json();
      if (!res.offline) lyCache.set(t.id, res);
      if (lyFor === t.id) renderLyrics(res);
    } catch { if (lyFor === t.id) renderLyrics({ offline: true }); }
  }

  function setLyricsOpen(open) {
    lyricsOpen = open;
    el.lyrics.hidden = !open;
    el.btnLyrics.setAttribute('aria-pressed', String(open));
    if (open) { closeDrawers(); lyFor = null; loadLyrics(); }
  }

  function updateLyricsLine() {
    if (!lyricsOpen || !lyLines.length) return;
    const pos = uiPos() + lyOffset;
    let lo = 0;
    let hi = lyLines.length - 1;
    let idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (lyLines[mid].t <= pos) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx === lyIdx) return;
    lyIdx = idx;
    lyLines.forEach((l, i) => { l.node.classList.toggle('on', i === idx); l.node.classList.toggle('past', i < idx); });
    if (idx >= 0 && performance.now() > lyPauseScroll) {
      const n = lyLines[idx].node;
      el.lyBody.scrollTo({ top: n.offsetTop - el.lyBody.clientHeight / 2 + n.clientHeight / 2, behavior: 'smooth' });
    }
  }

  el.btnLyrics.addEventListener('click', () => { setSheet(false); setLyricsOpen(!lyricsOpen); });
  el.lyClose.addEventListener('click', () => setLyricsOpen(false));
  el.lyMinus.addEventListener('click', () => setLyOffset(lyOffset - 0.25));
  el.lyPlus.addEventListener('click', () => setLyOffset(lyOffset + 0.25));
  for (const ev of ['wheel', 'touchmove']) el.lyBody.addEventListener(ev, () => { lyPauseScroll = performance.now() + 4000; }, { passive: true });
  setLyOffset(lyOffset);

  el.permLyrics.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !isAdmin()) return;
    send({ type: 'settings', lyricsOnline: b.dataset.v === 'on' });
  });

  // ------------------------------------------------------------ folder picker (host PC only)
  let pickCur = '';
  let pickParent = null;

  async function pickLoad(p) {
    try {
      const r = await fetch('/api/fs?path=' + encodeURIComponent(p));
      const j = await r.json();
      if (!r.ok) { toast(j.error || 'Cannot open that folder'); return; }
      pickCur = j.path;
      pickParent = j.parent;
      el.pickPath.value = j.path;
      el.pickUp.disabled = j.parent === null;
      el.pickUse.disabled = !j.path;
      el.pickInfo.textContent = j.path ? `${j.audio} audio file${j.audio === 1 ? '' : 's'} directly in this folder (subfolders are included too)` : 'Pick a drive or a shortcut, or paste a folder path above.';
      el.pickList.textContent = '';
      for (const e of [...j.shortcuts, ...j.entries]) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = '<svg class="icon"><use href="#i-folder"/></svg>';
        const name = document.createElement('span');
        name.textContent = e.name;
        b.append(name);
        if (j.shortcuts.includes(e)) { const s = document.createElement('span'); s.className = 'sub'; s.textContent = 'shortcut'; b.append(s); }
        b.addEventListener('click', () => pickLoad(e.path));
        li.append(b);
        el.pickList.append(li);
      }
      if (!el.pickList.children.length) {
        const li = document.createElement('li');
        li.className = 'hint';
        li.style.padding = '12px';
        li.textContent = 'No subfolders here.';
        el.pickList.append(li);
      }
    } catch { toast('Cannot reach the server'); }
  }

  function openPicker() {
    el.picker.hidden = false;
    pickLoad(libPath || '');
  }
  el.folderBtn.addEventListener('click', openPicker);
  el.emptyPick.addEventListener('click', openPicker);
  // paste or type a path (also accepts Windows "Copy as path" with quotes)
  const goToTypedPath = () => pickLoad(el.pickPath.value.trim().replace(/^["']+|["']+$/g, ''));
  el.pickGo.addEventListener('click', goToTypedPath);
  el.pickPath.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goToTypedPath(); } });
  el.pickCancel.addEventListener('click', () => { el.picker.hidden = true; });
  el.pickUp.addEventListener('click', () => { if (pickParent !== null) pickLoad(pickParent); });
  el.pickUse.addEventListener('click', async () => {
    if (!pickCur) return;
    el.pickUse.disabled = true;
    try {
      const r = await fetch('/api/folder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: pickCur }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(j.error || 'Could not use that folder'); el.pickUse.disabled = false; return; }
      libPath = j.path;
      el.picker.hidden = true;
      openFolder = null;
      toast(`Loaded ${j.count} song${j.count === 1 ? '' : 's'} from ${j.name}`);
    } catch { toast('Cannot reach the server'); el.pickUse.disabled = false; }
  });

  // ------------------------------------------------------------ upload
  let uploading = false;
  async function uploadFiles(files) {
    if (uploading) { toast('An upload is already running'); return; }
    if (!canUpload()) { toast('Only the admin can upload right now'); return; }
    const list = [...files].filter((f) => /\.(mp3|m4a|aac|wav|ogg|opus|flac|webm)$/i.test(f.name));
    if (!list.length) { toast('No supported audio files selected'); return; }
    uploading = true;
    let done = 0;
    for (const f of list) {
      el.upState.hidden = false;
      el.upState.textContent = `Uploading ${done + 1}/${list.length}: ${f.name} (0%)`;
      try {
        await new Promise((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open('POST', '/api/upload?name=' + encodeURIComponent(f.name));
          x.upload.onprogress = (ev) => {
            if (ev.lengthComputable) el.upState.textContent = `Uploading ${done + 1}/${list.length}: ${f.name} (${Math.round((ev.loaded / ev.total) * 100)}%)`;
          };
          x.onload = () => {
            if (x.status === 200) return resolve();
            let msg = 'Upload failed';
            try { msg = JSON.parse(x.responseText).error || msg; } catch { /* keep default */ }
            reject(new Error(msg));
          };
          x.onerror = () => reject(new Error('Cannot reach the server'));
          x.send(f);
        });
        done++;
      } catch (e) {
        toast(`${f.name}: ${e.message}`);
        break;
      }
    }
    uploading = false;
    el.upState.hidden = true;
    if (done) toast(`${done} song${done > 1 ? 's' : ''} added to ${libName}`);
  }

  el.fileInput.addEventListener('change', () => { uploadFiles(el.fileInput.files); el.fileInput.value = ''; });
  let dragDepth = 0;
  el.dropzone.addEventListener('dragenter', (e) => { if (!canUpload()) return; e.preventDefault(); dragDepth++; el.dropzone.classList.add('drag'); });
  el.dropzone.addEventListener('dragover', (e) => { if (canUpload()) e.preventDefault(); });
  el.dropzone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; el.dropzone.classList.remove('drag'); } });
  el.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.dropzone.classList.remove('drag');
    if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  // ------------------------------------------------------------ controls
  function gesture() {
    ensureCtx();
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  el.btnPlay.addEventListener('click', () => { gesture(); send({ type: state && state.playing ? 'pause' : 'play' }); });
  el.btnNext.addEventListener('click', () => { gesture(); send({ type: 'next' }); });
  el.btnPrev.addEventListener('click', () => { gesture(); send({ type: 'prev' }); });
  el.btnShuffle.addEventListener('click', () => {
    const on = !(state && state.shuffle);
    send({ type: 'shuffle', on });
    if (canControl()) toast(on ? 'Shuffle on' : 'Shuffle off');
  });
  el.btnRepeat.addEventListener('click', () => {
    const order = ['off', 'all', 'one'];
    const cur = (state && state.repeat) || 'all';
    const mode = order[(order.indexOf(cur) + 1) % order.length];
    send({ type: 'repeat', mode });
    if (canControl()) toast(mode === 'one' ? 'Repeat this song' : mode === 'all' ? 'Repeat all' : 'Repeat off');
  });

  el.seek.addEventListener('input', () => {
    dragging = true;
    const frac = Number(el.seek.value) / 1000;
    el.tCur.textContent = fmt(frac * currentDuration());
    setP(el.seek, frac);
  });
  el.seek.addEventListener('change', () => {
    dragging = false;
    const dur = currentDuration();
    if (dur) send({ type: 'seek', pos: (Number(el.seek.value) / 1000) * dur });
  });

  function setVolume(v) {
    volume = v;
    if (gain) gain.gain.value = v;
    setP(el.vol, v);
    store.set('sr_vol', v);
  }
  el.vol.value = String(Math.round(volume * 100));
  setVolume(volume);
  el.vol.addEventListener('input', () => setVolume(Number(el.vol.value) / 100));

  function setTrim(ms) {
    trimMs = Math.max(-500, Math.min(500, ms));
    el.trimVal.textContent = `${trimMs > 0 ? '+' : ''}${trimMs} ms`;
    store.set('sr_trim', trimMs);
  }
  let trimTimer = null;
  const nudge = (delta) => {
    setTrim(trimMs + delta);
    clearTimeout(trimTimer);
    trimTimer = setTimeout(() => { if (state && state.playing) applyState(); }, 250);
  };
  el.trimMinus.addEventListener('click', () => nudge(-5));
  el.trimPlus.addEventListener('click', () => nudge(5));
  setTrim(trimMs);

  // the one access switch (admin only)
  el.permAccess.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !isAdmin()) return;
    send({ type: 'settings', access: b.dataset.v });
  });

  el.nameInput.addEventListener('change', () => {
    const n = el.nameInput.value.replace(/[<>]/g, '').trim().slice(0, 24);
    if (!n) { el.nameInput.value = myName; return; }
    myName = n;
    store.set('sr_name', n);
    send({ type: 'name', name: n });
  });

  el.qrUrl.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(shareLink); toast('Link copied'); }
    catch { toast(shareLink); }
  });

  // sidebar drawer on small screens
  el.sideToggle.addEventListener('click', () => {
    const open = !el.sidebar.classList.contains('open');
    el.sidebar.classList.toggle('open', open);
    el.backdrop.hidden = !open;
  });
  el.backdrop.addEventListener('click', closeDrawers);

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === '/' && !typing) { e.preventDefault(); el.search.focus(); return; }
    if (e.key === 'Escape') {
      if (el.player.classList.contains('expanded')) { setSheet(false); return; }
      if (!el.qrModal.hidden) { el.qrModal.hidden = true; return; }
      if (lyricsOpen && e.target !== el.search) { setLyricsOpen(false); return; }
      if (!el.picker.hidden) { el.picker.hidden = true; return; }
      if (e.target === el.search) { el.search.value = ''; filter = ''; renderTracks(); el.search.blur(); }
      return;
    }
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); el.btnPlay.click(); }
    else if (e.key === 'n' || e.key === 'N') el.btnNext.click();
    else if (e.key === 'p' || e.key === 'P') el.btnPrev.click();
    else if ((e.key === 'l' || e.key === 'L') && !el.btnLyrics.hidden) el.btnLyrics.click();
  });

  // phones sometimes suspend audio when the screen locks; offer a one-tap rejoin
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && started && ctx && state && state.playing && ctx.state !== 'running') showGate('resume');
  });

  renderControls();
  requestAnimationFrame(frame);
  startApp();
})();







