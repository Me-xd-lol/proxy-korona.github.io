/* ==========================================================================
   Korona Proxy — core app logic
   Proxy list management, GitHub source sync, latency checks.
   Platform bridges (Electron / Capacitor) override window.koronaBridge
   to provide real TCP ping and system-wide connect.
   ========================================================================== */

'use strict';

/* ------------------------------------------------------------------ *
 * Constants & state
 * ------------------------------------------------------------------ */

const LS = {
  proxies: 'korona.proxies.v1',
  sources: 'korona.sources.v1',
  settings: 'korona.settings.v1',
  conn: 'korona.conn.v1',
};

const MAX_ROWS = 400;        // render cap for the visible list
const GEO_CHUNK = 100;       // ip-api batch size
const GEO_COOLDOWN = 4300;   // free tier: ~15 req/min

const bridge = window.koronaBridge || null;

const defaultSettings = {
  pingTimeout: 3000,
  concurrency: 12,
  autoRefreshHours: 12,
  geoLookup: true,   // countries come with the honest ping anyway; batch lookup fills the rest
};

const defaultSources = [
  { id: 'speedx-http',   name: 'TheSpeedX · HTTP',   url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',      proto: 'http',   enabled: true,  builtin: true, lastSync: 0, count: 0 },
  { id: 'speedx-socks4', name: 'TheSpeedX · SOCKS4', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',    proto: 'socks4', enabled: false, builtin: true, lastSync: 0, count: 0 },
  { id: 'speedx-socks5', name: 'TheSpeedX · SOCKS5', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',    proto: 'socks5', enabled: false, builtin: true, lastSync: 0, count: 0 },
  { id: 'monosans-http', name: 'monosans · HTTP',    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', proto: 'http',   enabled: true,  builtin: true, lastSync: 0, count: 0 },
  { id: 'monosans-socks5', name: 'monosans · SOCKS5', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', proto: 'socks5', enabled: false, builtin: true, lastSync: 0, count: 0 },
  { id: 'proxifly-all',  name: 'proxifly · All',     url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt', proto: 'auto', enabled: false, builtin: true, lastSync: 0, count: 0 },
];

let state = {
  proxies: [],            // { id, host, port, protocol, source, addedAt, latency, alive, lastChecked, fav, country }
  sources: [],
  settings: { ...defaultSettings },
  view: 'proxies',
  selectedId: null,
  conn: { status: 'idle', id: null },   // idle | connecting | connected
  filter: { q: '', proto: 'all', status: 'all', sort: 'latency' },
  pinging: false,
  pingAbort: false,
};

let geoWarned = false;

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function saveSources() { localStorage.setItem(LS.sources, JSON.stringify(state.sources)); }
function saveSettings() { localStorage.setItem(LS.settings, JSON.stringify(state.settings)); }
function saveConn() { localStorage.setItem(LS.conn, JSON.stringify(state.conn)); }

let storageWarned = false;

/** Compact storage: array of [host, port, proto, source, addedAt, latency, alive,
 *  lastChecked, fav, country, providers] — ~4x smaller than full JSON objects,
 *  so large multi-provider lists stay well under the localStorage quota. */
function saveProxies() {
  try {
    const packed = state.proxies.map(p => [
      p.host, p.port, p.protocol, p.source || 'manual',
      p.addedAt, p.latency == null ? '' : p.latency,
      p.alive == null ? '' : p.alive ? 1 : 0,
      p.lastChecked || 0, p.fav ? 1 : 0, p.country || '',
      (p.providers || []).join(','),
    ]);
    localStorage.setItem(LS.proxies, JSON.stringify(packed));
  } catch (e) {
    if (!storageWarned) {
      storageWarned = true;
      toast('Local storage is full — recent changes may not survive a restart. Try removing some sources or clearing dead proxies.', 'err', 6000);
    }
  }
}

function loadState() {
  // Load proxies: new compact array format, or legacy full-object format
  const raw = loadJSON(LS.proxies, []);
  if (Array.isArray(raw) && raw.length && Array.isArray(raw[0])) {
    state.proxies = raw.map(a => {
      const [host, port, protocol, source, addedAt, latency, alive, lastChecked, fav, country, providers] = a;
      return {
        id: `${protocol}|${host}|${port}`,
        host, port, protocol, source: source || 'manual',
        addedAt: addedAt || Date.now(),
        latency: latency === '' ? null : +latency,
        alive: alive === '' ? null : alive === 1,
        lastChecked: lastChecked || 0,
        fav: fav === 1,
        country: country || '',
        providers: providers ? providers.split(',') : [source || 'manual'],
      };
    });
  } else {
    state.proxies = raw;
  }
  state.sources = loadJSON(LS.sources, null) || defaultSources.map(s => ({ ...s }));
  state.settings = { ...defaultSettings, ...loadJSON(LS.settings, {}) };
  state.conn = loadJSON(LS.conn, { status: 'idle', id: null });
  // Selected proxy: fall back to first valid one
  if (state.conn.id && !state.proxies.some(p => p.id === state.conn.id)) state.conn.id = null;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind = 'warn', ms = 3200) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}

function fmtPing(ms) {
  if (ms == null) return '—';
  return ms + ' ms';
}

/* ------------------------------------------------------------------ *
 * Parsing & importing
 * ------------------------------------------------------------------ */

/* validHost / validPort / parseLine / parseAll live in parse.js — shared with the website */

function makeProxy(p, source) {
  const id = `${p.protocol}|${p.host}|${p.port}`;
  return {
    id, host: p.host, port: p.port, protocol: p.protocol,
    source: source || 'manual',
    addedAt: Date.now(),
    latency: null, alive: null, lastChecked: 0,
    fav: false, country: '',
  };
}

/** Merge proxies into state; returns { added, merged }.
 *  A proxy remembers EVERY source that provides it (providers[]), so
 *  overlapping lists from different providers still count for each. */
function mergeProxies(items, source) {
  const index = new Map(state.proxies.map(p => [p.id, p]));
  let added = 0, merged = 0;
  for (const item of items) {
    const existing = index.get(item.id);
    if (existing) {
      merged++;
      if (!existing.providers) existing.providers = [existing.source || 'manual'];
      if (source && !existing.providers.includes(source)) existing.providers.push(source);
      if (existing.source === 'manual' && source && source !== 'manual') existing.source = source;
    } else {
      const p = makeProxy(item, source);
      p.providers = [source || 'manual'];
      index.set(p.id, p);
      state.proxies.push(p);
      added++;
    }
  }
  if (added) saveProxies();
  return { added, merged };
}

/** Remove a source's contribution: proxies provided ONLY by it are deleted,
 *  shared ones just drop it from their providers list. */
function purgeSourceProxies(srcId) {
  const activeId = state.conn.status === 'connected' ? state.conn.id : null;
  const keep = [];
  let removed = 0;
  for (const p of state.proxies) {
    if (!p.providers) p.providers = [p.source || 'manual'];
    const i = p.providers.indexOf(srcId);
    if (i === -1 || p.id === activeId) { keep.push(p); continue; }
    p.providers.splice(i, 1);
    if (p.providers.length) keep.push(p);
    else removed++;
  }
  state.proxies = keep;
  saveProxies();
  render();
  updateStats();
  return removed;
}

/* ------------------------------------------------------------------ *
 * Latency checks
 * ------------------------------------------------------------------ */

/** Browser-side ping: opaque fetch to the proxy port, timed. Estimate only. */
function webPing(proxy, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort(); resolve(null); }, timeoutMs);
    fetch(`http://${proxy.host}:${proxy.port}/`, {
      mode: 'no-cors',
      cache: 'no-store',
      redirect: 'manual',
      signal: ctrl.signal,
    }).then(() => {
      clearTimeout(timer);
      resolve(Math.round(performance.now() - t0));
    }).catch(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function pingProxy(proxy) {
  const started = Date.now();
  let ms = null;
  let works = null;      // from the bridge's real handshake check
  let country = null;
  try {
    if (bridge && typeof bridge.ping === 'function') {
      const r = await bridge.ping(proxy, state.settings.pingTimeout);
      if (typeof r === 'number') {
        ms = r;                       // legacy bridge: raw TCP only
      } else if (r && typeof r === 'object') {
        ms = r.ms;
        works = r.alive === true;     // proxy actually relays traffic
        if (r.country) country = r.country;
      }
    } else {
      ms = await webPing(proxy, state.settings.pingTimeout);
    }
  } catch { ms = null; }
  proxy.latency = ms;
  proxy.alive = works != null ? works : (ms != null && ms > 0);
  if (country) proxy.country = country;
  proxy.lastChecked = started;
  return proxy;
}

/** Simple worker pool */
async function runPool(items, worker, concurrency, shouldStop) {
  let i = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < items.length) {
      if (shouldStop && shouldStop()) return;
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

async function pingAll() {
  if (state.pinging) { state.pingAbort = true; return; }
  const targets = filteredProxies();
  if (!targets.length) { toast('Nothing to ping — list is empty.', 'warn'); return; }

  state.pinging = true;
  state.pingAbort = false;
  const btn = $('pingAllBtn'), label = $('pingAllLabel');
  let done = 0;

  await runPool(targets, async (p) => {
    p._pinging = true;
    updateRow(p);
    await pingProxy(p);
    p._pinging = false;
    done++;
    if (done % 5 === 0 || done === targets.length) {
      label.textContent = `${done}/${targets.length}`;
      updateRow(p);
      updateStats();
    }
  }, state.settings.concurrency, () => state.pingAbort);

  state.pinging = false;
  label.textContent = 'Ping all';
  saveProxies();
  render();
  updateStats();
  if (state.pingAbort) toast('Ping run stopped.', 'warn');
  else {
    const alive = targets.filter(p => p.alive).length;
    toast(`Checked ${targets.length} proxies — ${alive} alive.`, 'ok');
  }
}

/* ------------------------------------------------------------------ *
 * Geo lookup (ip-api.com batch, free tier, desktop/localhost only)
 * ------------------------------------------------------------------ */

async function geoLookup() {
  if (!state.settings.geoLookup) return;
  const unknown = state.proxies.filter(p => !p.country && IPV4_RE.test(p.host)).slice(0, GEO_CHUNK);
  if (!unknown.length) return;

  // ip-api free tier is HTTP-only — impossible from an HTTPS page (mixed content).
  if (location.protocol === 'https:') {
    if (!geoWarned) {
      geoWarned = true;
      toast('Country lookup unavailable on HTTPS pages — use the desktop app.', 'warn');
    }
    return;
  }

  try {
    const res = await fetch('http://ip-api.com/batch?fields=status,countryCode,query', {
      method: 'POST',
      body: JSON.stringify(unknown.map(p => p.host)),
    });
    const data = await res.json();
    if (!Array.isArray(data)) return;
    const byIp = new Map(data.map(d => [d.query, d.status === 'success' ? d.countryCode : '']));
    for (const p of unknown) {
      const cc = byIp.get(p.host);
      if (cc) p.country = cc;
      else if (cc === '') p.country = '??';
    }
    saveProxies();
    render();
  } catch { /* offline / blocked — silent */ }
}

/* ------------------------------------------------------------------ *
 * Source sync
 * ------------------------------------------------------------------ */

async function syncSource(src, silent) {
  const card = document.querySelector(`[data-src="${src.id}"]`);
  if (card) card.classList.add('syncing');
  try {
    const res = await fetch(src.url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const items = parseAll(text, src.proto);
    if (!items.length) throw new Error('no valid proxies in list');

    const { added } = mergeProxies(items, src.id);
    src.lastSync = Date.now();
    src.count = items.length;
    saveSources();
    render();
    updateStats();
    const known = items.length - added;
    if (!silent) toast(`${src.name}: ${added} new · ${known} already known (kept) · ${items.length} in list.`, 'ok');
    if (added) geoLookup();
  } catch (e) {
    if (!silent) toast(`${src.name} sync failed: ${e.message}`, 'err');
  } finally {
    if (card) card.classList.remove('syncing');
  }
}

async function syncEnabled(silent) {
  const list = state.sources;
  if (!list.length) {
    if (!silent) toast('No sources added yet.', 'warn');
    return;
  }
  for (const src of list) await syncSource(src, silent);
  if (!silent) toast('All sources synced.', 'ok');
}

/* ------------------------------------------------------------------ *
 * Connect
 * ------------------------------------------------------------------ */

async function connect() {
  if (state.conn.status === 'connected') {
    // Disconnect
    if (bridge && typeof bridge.disconnect === 'function') {
      await bridge.disconnect();
    }
    state.conn = { status: 'idle', id: null };
    saveConn();
    renderConn();
    toast('Disconnected — system proxy restored to direct connection.', 'ok');
    return;
  }

  const proxy = state.proxies.find(p => p.id === state.selectedId)
    || state.proxies.filter(p => p.alive).sort((a, b) => (a.latency ?? 9e9) - (b.latency ?? 9e9))[0];

  if (!proxy) {
    toast('No proxy selected — click a row first, or run "Ping all".', 'warn');
    return;
  }

  state.selectedId = proxy.id;
  state.conn = { status: 'connecting', id: proxy.id };
  renderConn();
  render();

  if (bridge && typeof bridge.connect === 'function') {
    const ok = await bridge.connect(proxy);
    state.conn = ok ? { status: 'connected', id: proxy.id } : { status: 'idle', id: null };
    toast(ok ? `Connected via ${proxy.host}:${proxy.port}.` : 'Connection failed.', ok ? 'ok' : 'err');
  } else {
    state.conn = { status: 'idle', id: null };
    toast('System-wide connect needs the Korona Proxy desktop or mobile app.', 'warn', 4200);
  }
  saveConn();
  renderConn();
  render();
}

/* ------------------------------------------------------------------ *
 * Filtering / rendering
 * ------------------------------------------------------------------ */

function filteredProxies() {
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  let list = state.proxies.filter(p => {
    if (f.proto !== 'all' && p.protocol !== f.proto) return false;
    if (f.status === 'alive' && !p.alive) return false;
    if (f.status === 'dead' && (p.alive !== false)) return false;
    if (f.status === 'unchecked' && p.alive !== null) return false;
    if (f.status === 'fav' && !p.fav) return false;
    if (q && !(p.host.includes(q) || String(p.port).includes(q) || (p.country || '').toLowerCase().includes(q))) return false;
    return true;
  });

  const sorters = {
    latency: (a, b) => {
      const av = a.alive ? (a.latency ?? 9e9) : 9e10;
      const bv = b.alive ? (b.latency ?? 9e9) : 9e10;
      if (av !== bv) return av - bv;
      return b.addedAt - a.addedAt;
    },
    newest: (a, b) => b.addedAt - a.addedAt,
    host: (a, b) => a.host.localeCompare(b.host) || a.port - b.port,
  };
  list.sort(sorters[f.sort] || sorters.latency);
  return list;
}

const EMPTY_SVG = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a15.3 15.3 0 0 1 0 18M12 3a15.3 15.3 0 0 0 0 18"/></svg>';

function emptyHTML() {
  const f = state.filter;
  if (state.proxies.length === 0) {
    return `<div class="empty">${EMPTY_SVG}
      <b>List is empty</b>
      <p>Add proxies manually, or open <b>Sources</b> and sync a free proxy list from GitHub.</p>
      <button class="btn btn-primary" onclick="switchView('sources')">Open sources</button>
    </div>`;
  }
  return `<div class="empty">${EMPTY_SVG}
    <b>No matches</b>
    <p>Nothing fits the current filters${f.q ? ` (“${esc(f.q)}”)` : ''}. Try clearing the search or filters.</p>
  </div>`;
}

function proxyRowHTML(p) {
  const pingClass = p._pinging ? 'checking'
    : p.alive === null ? 'none'
    : !p.alive ? 'bad'
    : p.latency < 150 ? 'good'
    : p.latency < 500 ? 'mid' : 'bad';
  const pingText = p._pinging ? '···' : p.alive === null ? 'untested' : p.alive ? fmtPing(p.latency) : 'dead';

  return `<div class="proxy-row${p.id === state.selectedId ? ' selected' : ''}" data-id="${esc(p.id)}">
    <div class="addr">
      <svg class="fav${p.fav ? ' on' : ''}" data-act="fav" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
      <span class="addr-text">${esc(p.host)}:${p.port}</span>
    </div>
    <span class="badge ${esc(p.protocol)}">${esc(p.protocol)}</span>
    <span class="country">${esc(p.country || '—')}</span>
    <span class="ping ${pingClass}">${pingText}</span>
    <div class="row-actions">
      <button class="row-btn" data-act="ping" title="Check this proxy">
        <svg viewBox="0 0 24 24"><path d="M3 12h4l2-7 4 14 2-7h6"/></svg>
      </button>
      <button class="row-btn" data-act="copy" title="Copy address">
        <svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
      </button>
      <button class="row-btn del" data-act="del" title="Remove">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
      </button>
    </div>
  </div>`;
}

function render() {
  // view titles
  $('viewTitle').textContent = state.view === 'proxies' ? 'Proxies' : 'Sources';
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.view === state.view));
  document.querySelectorAll('.view').forEach(el =>
    el.classList.toggle('active', el.id === `view-${state.view}`));

  $('navProxyCount').textContent = state.proxies.length;
  $('navSourceCount').textContent = state.sources.length;

  if (state.view === 'proxies') renderList();
  else renderSources();
}

function renderList() {
  const list = filteredProxies();
  const box = $('proxyList');
  const shown = list.slice(0, MAX_ROWS);
  box.innerHTML = shown.length ? shown.map(proxyRowHTML).join('') : emptyHTML();

  const foot = $('listFoot');
  if (!list.length) foot.textContent = '';
  else if (list.length > MAX_ROWS) foot.textContent = `Showing ${MAX_ROWS} of ${list.length} — refine filters or search to see more`;
  else foot.textContent = `${list.length} proxy${list.length === 1 ? '' : 'ies'}`;
}

function updateRow(p) {
  const row = document.querySelector(`.proxy-row[data-id="${CSS.escape(p.id)}"]`);
  if (row) row.outerHTML = proxyRowHTML(p);
}

function renderSources() {
  const grid = $('sourcesGrid');
  const countFor = (id) => state.proxies.filter(p => (p.providers || [p.source]).includes(id)).length;
  grid.innerHTML = state.sources.map(s => `
    <div class="src-card card${s._syncing ? ' syncing' : ''}" data-src="${esc(s.id)}">
      <div class="src-head">
        <div class="src-name">${esc(s.name)}</div>
      </div>
      <span class="src-url" title="${esc(s.url)}">${esc(s.url)}</span>
      <div class="src-meta">
        <span>${s.proto === 'auto' ? 'auto-detect' : esc(s.proto)}</span>
        <span>local: <b>${countFor(s.id)}</b></span>
        <span>list: <b>${s.count || '—'}</b></span>
        <span>synced <b>${timeAgo(s.lastSync)}</b></span>
      </div>
      <div class="src-actions">
        <button class="btn btn-ghost" data-act="sync">Sync now</button>
        <button class="btn btn-ghost" data-act="clear" title="Remove proxies that come only from this source">Clear proxies</button>
        ${s.builtin ? '' : `<button class="btn btn-danger" data-act="remove">Remove</button>`}
      </div>
    </div>`).join('');
}

function renderConn() {
  const card = $('connCard'), dot = $('connDot'), st = $('connState'),
    tgt = $('connTarget'), btn = $('connectBtn');
  const proxy = state.proxies.find(p => p.id === state.conn.id);

  card.classList.toggle('connected', state.conn.status === 'connected');
  card.classList.toggle('connecting', state.conn.status === 'connecting');
  dot.className = 'conn-dot ' + (state.conn.status === 'connected' ? 'connected' : state.conn.status === 'connecting' ? 'connecting' : '');
  btn.classList.toggle('disconnecting', state.conn.status === 'connected');

  if (state.conn.status === 'connected') {
    st.textContent = 'Connected';
    tgt.textContent = proxy ? `${proxy.host}:${proxy.port} · ${proxy.protocol}` : state.conn.id;
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg> Disconnect';
  } else if (state.conn.status === 'connecting') {
    st.textContent = 'Connecting…';
    tgt.textContent = proxy ? `${proxy.host}:${proxy.port} · ${proxy.protocol}` : '…';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/></svg> Connecting…';
    btn.disabled = true;
    return;
  } else {
    st.textContent = 'Not connected';
    const sel = state.proxies.find(p => p.id === state.selectedId);
    tgt.textContent = sel ? `Selected: ${sel.host}:${sel.port}` : 'No proxy selected';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/></svg> Connect';
  }
  btn.disabled = false;
}

function updateStats() {
  const total = state.proxies.length;
  const alive = state.proxies.filter(p => p.alive).length;
  const best = state.proxies.reduce((min, p) =>
    p.alive && p.latency != null && p.latency < min ? p.latency : min, Infinity);

  $('statTotal').textContent = total;
  $('statAlive').textContent = alive;
  $('statAlive').parentElement.querySelector('.stat-val').classList.toggle('accent', alive > 0);
  $('statBest').textContent = best === Infinity ? '—' : best;
}

function switchView(v) {
  state.view = v;
  render();
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

function bindEvents() {
  // Sidebar nav
  document.querySelectorAll('.nav-item').forEach(el =>
    el.addEventListener('click', () => switchView(el.dataset.view)));

  $('toggleSidebarBtn').addEventListener('click', () => $('sidebar').classList.toggle('collapsed'));

  // Toolbar
  $('searchInput').addEventListener('input', e => { state.filter.q = e.target.value; renderList(); });
  $('protoFilter').addEventListener('change', e => { state.filter.proto = e.target.value; renderList(); });
  $('statusFilter').addEventListener('change', e => { state.filter.status = e.target.value; renderList(); });
  $('sortSelect').addEventListener('change', e => { state.filter.sort = e.target.value; renderList(); });

  $('pingAllBtn').addEventListener('click', pingAll);
  $('connectBtn').addEventListener('click', connect);

  // Proxy list (delegated)
  $('proxyList').addEventListener('click', async e => {
    const row = e.target.closest('.proxy-row');
    if (!row) return;
    const p = state.proxies.find(x => x.id === row.dataset.id);
    if (!p) return;

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'fav') {
      p.fav = !p.fav;
      saveProxies(); updateRow(p); return;
    }
    if (act === 'del') {
      if (state.conn.id === p.id && state.conn.status === 'connected') {
        toast('Disconnect before removing the active proxy.', 'warn');
        return;
      }
      state.proxies = state.proxies.filter(x => x.id !== p.id);
      if (state.selectedId === p.id) state.selectedId = null;
      saveProxies(); render(); updateStats();
      toast(`Removed ${p.host}:${p.port}.`, 'ok');
      return;
    }
    if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(`${p.protocol}://${p.host}:${p.port}`);
        toast('Address copied.', 'ok', 1600);
      } catch { toast('Copy failed.', 'err'); }
      return;
    }
    if (act === 'ping') {
      p._pinging = true; updateRow(p);
      await pingProxy(p);
      p._pinging = false; saveProxies(); updateRow(p); updateStats();
      return;
    }
    // plain click: select for connect
    state.selectedId = p.id;
    document.querySelectorAll('.proxy-row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    renderConn();
  });

  // Sources (delegated)
  $('sourcesGrid').addEventListener('click', async e => {
    const card = e.target.closest('[data-src]');
    if (!card) return;
    const src = state.sources.find(s => s.id === card.dataset.src);
    if (!src) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'sync') await syncSource(src);
    if (act === 'clear') {
      const n = purgeSourceProxies(src.id);
      toast(n ? `${src.name}: removed ${n} proxies.` : `${src.name}: nothing to clear.`, 'ok');
    }
    if (act === 'remove') {
      const n = purgeSourceProxies(src.id);
      state.sources = state.sources.filter(s => s.id !== src.id);
      saveSources(); renderSources(); render(); updateStats();
      toast(n ? `${src.name} removed with ${n} proxies.` : `Source removed: ${src.name}`, 'ok');
    }
  });

  $('addSourceBtn').addEventListener('click', () => {
    const url = $('srcUrlInput').value.trim();
    if (!/^https?:\/\/.+/i.test(url)) { toast('Enter a valid http(s) URL.', 'err'); return; }
    const proto = $('srcProtoSelect').value;
    if (state.sources.some(s => s.url === url)) { toast('This source already exists.', 'warn'); return; }
    const name = 'Custom · ' + (url.split('/').pop() || 'list').slice(0, 28);
    state.sources.push({ id: 'custom-' + Date.now(), name, url, proto, enabled: true, builtin: false, lastSync: 0, count: 0 });
    saveSources();
    $('srcUrlInput').value = '';
    renderSources();
    toast('Source added — syncing…', 'ok');
    syncSource(state.sources[state.sources.length - 1]);
  });

  // Add proxy modal
  const addModal = $('addModal');
  const openAdd = () => { addModal.classList.add('open'); $('bulkInput').focus(); };
  const closeAdd = () => addModal.classList.remove('open');
  $('addProxyBtn').addEventListener('click', openAdd);
  $('closeAddBtn').addEventListener('click', closeAdd);
  $('cancelAddBtn').addEventListener('click', closeAdd);
  addModal.addEventListener('click', e => { if (e.target === addModal) closeAdd(); });

  const recount = () => {
    const proto = $('bulkProtoSelect').value;
    $('bulkCount').textContent = `${parseAll($('bulkInput').value, proto).length} valid`;
  };
  $('bulkInput').addEventListener('input', recount);
  $('bulkProtoSelect').addEventListener('change', recount);

  $('confirmAddBtn').addEventListener('click', () => {
    const proto = $('bulkProtoSelect').value;
    const items = parseAll($('bulkInput').value, proto);
    if (!items.length) { toast('No valid proxies found.', 'err'); return; }
    const { added } = mergeProxies(items, 'manual');
    $('bulkInput').value = '';
    recount();
    closeAdd();
    render(); updateStats();
    toast(`${added} proxies added (${items.length - added} duplicates skipped).`, 'ok');
    geoLookup();
  });

  // Settings modal
  const sm = $('settingsModal');
  $('openSettingsBtn').addEventListener('click', () => { syncSettingsUI(); sm.classList.add('open'); });
  $('closeSettingsBtn').addEventListener('click', () => sm.classList.remove('open'));
  sm.addEventListener('click', e => { if (e.target === sm) sm.classList.remove('open'); });

  $('timeoutRange').addEventListener('input', e => {
    state.settings.pingTimeout = +e.target.value;
    $('timeoutVal').textContent = e.target.value + ' ms';
    saveSettings();
  });
  $('concRange').addEventListener('input', e => {
    state.settings.concurrency = +e.target.value;
    $('concVal').textContent = e.target.value;
    saveSettings();
  });
  $('autoRefreshSelect').addEventListener('change', e => {
    state.settings.autoRefreshHours = +e.target.value;
    saveSettings();
  });
  $('geoCheck').addEventListener('change', e => {
    state.settings.geoLookup = e.target.checked;
    saveSettings();
    if (e.target.checked) geoLookup();
  });

  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ proxies: state.proxies, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `korona-proxies-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const items = Array.isArray(data) ? data : data.proxies;
        if (!Array.isArray(items)) throw new Error('bad format');
        const clean = items
          .filter(x => x && validHost(x.host) && validPort(x.port))
          .map(x => ({ host: x.host, port: +x.port, protocol: ['http', 'socks4', 'socks5'].includes(x.protocol) ? x.protocol : 'http', id: `${x.protocol}|${x.host}|${x.port}` }));
        const { added } = mergeProxies(clean, 'import');
        render(); updateStats();
        toast(`Imported ${added} proxies.`, 'ok');
      } catch (err) { toast('Import failed: ' + err.message, 'err'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  let clearArmed = false;
  $('clearBtn').addEventListener('click', () => {
    if (!clearArmed) {
      clearArmed = true;
      $('clearBtn').textContent = 'Really clear everything?';
      setTimeout(() => { clearArmed = false; $('clearBtn').textContent = 'Clear all data'; }, 3500);
      return;
    }
    state.proxies = [];
    saveProxies();
    render(); updateStats(); renderConn();
    clearArmed = false;
    $('clearBtn').textContent = 'Clear all data';
    toast('All proxies cleared.', 'ok');
  });

  // Esc closes modals
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $('addModal').classList.remove('open');
      $('settingsModal').classList.remove('open');
    }
  });
}

function syncSettingsUI() {
  $('timeoutRange').value = state.settings.pingTimeout;
  $('timeoutVal').textContent = state.settings.pingTimeout + ' ms';
  $('concRange').value = state.settings.concurrency;
  $('concVal').textContent = state.settings.concurrency;
  $('autoRefreshSelect').value = String(state.settings.autoRefreshHours);
  $('geoCheck').checked = !!state.settings.geoLookup;
}

/* ------------------------------------------------------------------ *
 * Deep links — korona://connect?host=&port=&protocol=
 * Fired by the website's Connect button; the desktop app forwards here.
 * ------------------------------------------------------------------ */

if (bridge && typeof bridge.onConnectRequest === 'function') {
  bridge.onConnectRequest((params) => {
    const host = params.host;
    const port = +params.port;
    const protocol = ['http', 'socks4', 'socks5'].includes(params.protocol) ? params.protocol : 'http';
    if (!validHost(host) || !validPort(port)) {
      toast('Invalid proxy in connect link.', 'err');
      return;
    }
    mergeProxies([{ host, port, protocol }], 'deeplink');
    state.selectedId = `${protocol}|${host}|${port}`;
    switchView('proxies');
    render();
    toast(`Website requested connect: ${host}:${port}`, 'ok');
    connect();
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function maybeAutoSync() {
  const hours = state.settings.autoRefreshHours;
  if (!hours) return;
  const newest = Math.max(0, ...state.sources.filter(s => s.enabled).map(s => s.lastSync));
  if (Date.now() - newest > hours * 3600000) {
    toast('Auto-refreshing sources…', 'ok');
    syncEnabled(true);
  }
}

loadState();
bindEvents();
render();
updateStats();
renderConn();

// Reconcile with reality: if Windows proxy is off but UI says "Connected", fix the UI
if (bridge && typeof bridge.isProxyOn === 'function') {
  bridge.isProxyOn().then(on => {
    if (!on && state.conn.status === 'connected') {
      state.conn = { status: 'idle', id: null };
      saveConn();
      renderConn();
    }
  });
}

if (!state.proxies.length && !state.sources.some(s => s.lastSync)) {
  toast('Welcome to Korona Proxy — syncing starter lists…', 'ok', 4000);
  syncEnabled(true).then(maybeAutoSync);
} else {
  maybeAutoSync();
}
