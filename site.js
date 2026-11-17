/* ==========================================================================
   Korona Proxy — website logic
   Live list browser, estimated ping, download links, connect deep links.
   Parsing is shared with the app (../app/parse.js).
   ========================================================================== */

'use strict';

/* ------------------------------------------------------------------ *
 * Config — set this to your GitHub repo where releases are published
 * ------------------------------------------------------------------ */

const GITHUB_REPO = 'me-xd-lol/proxy-korona.github.io'; // releases live here
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
const ASSET = (arch) => `https://github.com/${GITHUB_REPO}/releases/latest/download/KoronaProxy-Setup-${arch === 'ia32' ? '32' : arch}.exe`;
const SCHEME = 'korona';

const SOURCES = [
  { id: 'speedx-http',   name: 'TheSpeedX · HTTP',   url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',      proto: 'http' },
  { id: 'speedx-socks4', name: 'TheSpeedX · SOCKS4', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',    proto: 'socks4' },
  { id: 'speedx-socks5', name: 'TheSpeedX · SOCKS5', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',    proto: 'socks5' },
  { id: 'monosans-http', name: 'monosans · HTTP',    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', proto: 'http' },
  { id: 'monosans-socks5', name: 'monosans · SOCKS5', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', proto: 'socks5' },
  { id: 'proxifly-all',  name: 'proxifly · All',     url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt', proto: 'auto' },
];

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

let proxies = [];                 // { id, host, port, protocol, source, latency, alive, pinging }
let filter = { q: '', proto: 'all', source: 'all' };
let selected = null;
let pinging = false;
let pingAbort = false;
let fetching = false;

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind = 'warn', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

function proxyId(p) { return `${p.protocol}|${p.host}|${p.port}`; }

/** Browser ping estimate: opaque fetch to the proxy port, timed. */
function webPing(proxy, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort(); resolve(null); }, timeoutMs);
    fetch(`http://${proxy.host}:${proxy.port}/`, {
      mode: 'no-cors',
      cache: 'no-store',
      redirect: 'manual',
      signal: ctrl.signal,
    }).then(() => { clearTimeout(timer); resolve(Math.round(performance.now() - t0)); })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}

/* ------------------------------------------------------------------ *
 * Fetch lists
 * ------------------------------------------------------------------ */

async function fetchSources() {
  if (fetching) return;
  fetching = true;
  const btn = $('refreshBtn');
  btn.disabled = true;

  let fetched = 0, added = 0;
  const known = new Set(proxies.map(proxyId));

  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const items = parseAll(text, src.proto);
      fetched += items.length;
      let addedHere = 0;
      for (const item of items) {
        const id = item.id;
        if (known.has(id)) continue;
        known.add(id);
        proxies.push({ id, host: item.host, port: item.port, protocol: item.protocol, source: src.name, latency: null, alive: null, pinging: false });
        addedHere++;
      }
      added += addedHere;
    } catch (e) {
      toast(`${src.name}: fetch failed (${e.message})`, 'err');
    }
  }

  fetching = false;
  btn.disabled = false;
  fillSourceSelect();
  render();
  updateStats();
  if (fetched) toast(`Fetched ${fetched} proxies — ${added} new. Ping is an estimate.`, 'ok');
  else toast('No proxies fetched — check your connection.', 'err');
}

function fillSourceSelect() {
  const sel = $('sourceSelect');
  const cur = sel.value;
  const names = [...new Set(proxies.map(p => p.source))];
  sel.innerHTML = '<option value="all">All sources</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  if (names.includes(cur)) sel.value = cur;
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

const EMPTY_SVG = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a15.3 15.3 0 0 1 0 18M12 3a15.3 15.3 0 0 0 0 18"/></svg>';

function filtered() {
  const q = filter.q.trim().toLowerCase();
  let list = proxies.filter(p => {
    if (filter.proto !== 'all' && p.protocol !== filter.proto) return false;
    if (filter.source !== 'all' && p.source !== filter.source) return false;
    if (q && !(p.host.includes(q) || String(p.port).includes(q))) return false;
    return true;
  });
  list.sort((a, b) => {
    const av = a.alive ? (a.latency ?? 9e9) : 9e10;
    const bv = b.alive ? (b.latency ?? 9e9) : 9e10;
    return av - bv;
  });
  return list;
}

function rowHTML(p) {
  const pingClass = p.pinging ? 'checking'
    : p.alive === null ? 'none'
    : !p.alive ? 'bad'
    : p.latency < 150 ? 'good'
    : p.latency < 500 ? 'mid' : 'bad';
  const pingText = p.pinging ? '···' : p.alive === null ? 'untested' : p.alive ? p.latency + ' ms' : 'dead';

  return `<div class="proxy-row${p.id === selected ? ' selected' : ''}" data-id="${esc(p.id)}">
    <div class="addr"><span class="addr-text">${esc(p.host)}:${p.port}</span></div>
    <span class="badge ${esc(p.protocol)}">${esc(p.protocol)}</span>
    <span class="ping ${pingClass}">${pingText}</span>
    <div class="row-actions">
      <button class="row-btn" data-act="ping" title="Estimate ping">
        <svg viewBox="0 0 24 24"><path d="M3 12h4l2-7 4 14 2-7h6"/></svg>
      </button>
      <button class="row-btn" data-act="copy" title="Copy address">
        <svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="0"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
      </button>
    </div>
  </div>`;
}

function updateRow(p) {
  const row = document.querySelector(`.proxy-row[data-id="${CSS.escape(p.id)}"]`);
  if (row) row.outerHTML = rowHTML(p);
}

const MAX_ROWS = 300;

function render() {
  const list = filtered();
  const shown = list.slice(0, MAX_ROWS);
  $('proxyList').innerHTML = shown.length
    ? shown.map(rowHTML).join('')
    : `<div class="empty">${EMPTY_SVG}<b>No proxies loaded</b><p>Press <b>Fetch lists</b> to import fresh servers from public GitHub lists.</p></div>`;

  $('listFoot').textContent = !list.length ? '' :
    list.length > MAX_ROWS ? `Showing ${MAX_ROWS} of ${list.length} — refine filters to see more` :
    `${list.length} proxies · ping values are browser estimates`;

  $('connectBtn').disabled = !selected;
}

function updateStats() {
  $('statTotal').textContent = proxies.length;
  $('statAlive').textContent = proxies.filter(p => p.alive).length;
  const best = proxies.reduce((m, p) => p.alive && p.latency != null && p.latency < m ? p.latency : m, Infinity);
  $('statBest').textContent = best === Infinity ? '—' : best;
}

/* ------------------------------------------------------------------ *
 * Ping all (estimated)
 * ------------------------------------------------------------------ */

async function runPool(items, worker, concurrency, shouldStop) {
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      if (shouldStop()) return;
      await worker(items[i++]);
    }
  }));
}

async function pingAll() {
  if (pinging) { pingAbort = true; return; }
  const targets = filtered();
  if (!targets.length) { toast('Nothing to check — fetch lists first.', 'warn'); return; }

  pinging = true;
  pingAbort = false;
  const label = $('pingLabel');
  let done = 0;

  await runPool(targets, async (p) => {
    p.pinging = true;
    updateRow(p);
    const ms = await webPing(p);
    p.latency = ms;
    p.alive = ms != null;
    p.pinging = false;
    updateRow(p);
    done++;
    if (done % 10 === 0 || done === targets.length) label.textContent = `${done}/${targets.length}`;
    if (done % 50 === 0) { render(); updateStats(); }
  }, 12, () => pingAbort);

  pinging = false;
  label.textContent = 'Estimate ping';
  render();
  updateStats();
  const alive = targets.filter(p => p.alive).length;
  toast(`Estimated ${alive}/${targets.length} alive. Install the app for true TCP ping.`, 'ok', 4200);
}

/* ------------------------------------------------------------------ *
 * Connect → deep link into the desktop app
 * ------------------------------------------------------------------ */

function openInApp(proxy) {
  const params = new URLSearchParams({ host: proxy.host, port: proxy.port, protocol: proxy.protocol });
  const url = `${SCHEME}://connect?${params}`;

  let leftPage = false;
  const onLeave = () => { leftPage = true; };
  window.addEventListener('blur', onLeave);
  document.addEventListener('visibilitychange', onLeave);

  // conn card: trying state
  $('connState').textContent = 'Opening app…';
  $('connDot').className = 'conn-dot connecting';

  location.href = url;

  setTimeout(() => {
    window.removeEventListener('blur', onLeave);
    document.removeEventListener('visibilitychange', onLeave);
    if (!leftPage && !document.hidden) {
      $('connState').textContent = 'App not detected';
      $('connDot').className = 'conn-dot';
      $('connTarget').textContent = proxy ? `${proxy.host}:${proxy.port} · ${proxy.protocol}` : '—';
      $('siteNotice').hidden = false;
      $('siteNoticeText').textContent = `Korona Proxy isn't installed (or the browser blocked the link). Install it, then try again — or copy the address below into the app: ${proxy.host}:${proxy.port}`;
      toast('App not detected — download it first.', 'warn', 4200);
    }
  }, 1500);
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

function bind() {
  // download links
  document.querySelectorAll('[data-dl]').forEach(a => {
    const kind = a.dataset.dl;
    a.href = kind === 'releases' ? RELEASES_URL : ASSET(kind);
    a.target = '_blank';
    a.rel = 'noopener';
  });

  $('searchInput').addEventListener('input', e => { filter.q = e.target.value; render(); });
  $('protoFilter').addEventListener('change', e => { filter.proto = e.target.value; render(); });
  $('sourceSelect').addEventListener('change', e => { filter.source = e.target.value; render(); });
  $('refreshBtn').addEventListener('click', fetchSources);

  // On HTTPS pages (GitHub Pages), browsers block http:// fetches — ping
  // estimates are impossible, so the button points people to the app instead.
  if (location.protocol === 'https:') {
    const pb = $('pingBtn');
    pb.disabled = true;
    pb.title = 'Ping checks need the Korona Proxy app (browsers block http:// checks on https pages)';
    $('pingLabel').textContent = 'Ping: use the app';
  } else {
    $('pingBtn').addEventListener('click', pingAll);
  }

  $('proxyList').addEventListener('click', async (e) => {
    const row = e.target.closest('.proxy-row');
    if (!row) return;
    const p = proxies.find(x => x.id === row.dataset.id);
    if (!p) return;
    const act = e.target.closest('[data-act]')?.dataset.act;

    if (act === 'copy') {
      try { await navigator.clipboard.writeText(`${p.protocol}://${p.host}:${p.port}`); toast('Address copied.', 'ok', 1600); }
      catch { toast('Copy failed.', 'err'); }
      return;
    }
    if (act === 'ping') {
      p.pinging = true; render();
      const ms = await webPing(p);
      p.latency = ms; p.alive = ms != null; p.pinging = false;
      render(); updateStats();
      return;
    }
    // select for connect
    selected = p.id;
    $('connState').textContent = 'Ready to connect';
    $('connTarget').textContent = `${p.host}:${p.port} · ${p.protocol}`;
    $('siteNotice').hidden = true;
    $('connDot').className = 'conn-dot';
    render();
  });

  $('connectBtn').addEventListener('click', () => {
    const p = proxies.find(x => x.id === selected);
    if (!p) return;
    openInApp(p);
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

bind();
fetchSources();
