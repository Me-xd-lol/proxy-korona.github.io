#!/usr/bin/env node
/* ==========================================================================
   Korona Proxy CLI — the same engine as the desktop app, no GUI, no deps.
   Needs Node.js 18+. Single file, safe to drop into /usr/local/bin/korona.

     korona fetch                sync all proxy lists from GitHub
     korona list [n]             show proxies (best ping first)
     korona ping [n|--all]       true TCP latency check
     korona connect <id|addr>    system-wide proxy (GNOME / Windows)
     korona disconnect           back to direct connection
     korona status               current system proxy + database info
     korona help
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');

/* ------------------------------------------------------------------ *
 * Colors
 * ------------------------------------------------------------------ */
const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};

/* ------------------------------------------------------------------ *
 * Parser — compact mirror of app/parse.js
 * Detects real server addresses: "1.2.3.4:5555", "socks5://5.6.7.8:1080".
 * Header junk like "#FREE PROXY LIST 2026" produces nothing.
 * ------------------------------------------------------------------ */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

function validHost(h) {
  if (!h) return false;
  if (IPV4_RE.test(h)) return h.split('.').every(n => +n >= 0 && +n <= 255);
  return HOSTNAME_RE.test(h);
}

function validPort(p) {
  const n = +p;
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function normProto(p) {
  p = String(p || '').toLowerCase();
  if (p === 'http' || p === 'https') return 'http';
  if (p === 'socks4') return 'socks4';
  if (p === 'socks5' || p === 'socks') return 'socks5';
  return null;
}

function parsePrefixed(token) {
  const m = token.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\s"'<>]+)$/i);
  if (!m) return null;
  const protocol = normProto(m[1]);
  if (!protocol) return null;
  let rest = m[2];
  const at = rest.lastIndexOf('@');
  if (at !== -1) rest = rest.slice(at + 1);
  const i = rest.lastIndexOf(':');
  if (i === -1) return null;
  const host = rest.slice(0, i), port = rest.slice(i + 1);
  if (!/^\d+$/.test(port) || !validHost(host) || !validPort(port)) return null;
  return { host, port: +port, protocol };
}

function parseAll(text, defaultProto) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const id = `${p.protocol}|${p.host}|${p.port}`;
    if (!seen.has(id)) { seen.add(id); out.push({ ...p, id }); }
  };
  const bareProto = defaultProto === 'socks4' || defaultProto === 'socks5' ? defaultProto : 'http';

  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.split('#')[0];
    if (!line.trim()) continue;
    line = line.replace(/\b(?:https?|socks[45]?):\/\/[^\s"'<>]+/gi, (tok) => {
      const p = parsePrefixed(tok);
      if (p) push(p);
      return ' ';
    });
    const re = /(?<![\w.])((?:\d{1,3}\.){3}\d{1,3})\s*(?::|\s)\s*(\d{1,5})(?![\d.])/g;
    let m;
    while ((m = re.exec(line))) {
      if (validHost(m[1]) && validPort(m[2])) push({ host: m[1], port: +m[2], protocol: bareProto });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Sources & storage
 * ------------------------------------------------------------------ */
const SOURCES = [
  { id: 'speedx-http',   name: 'TheSpeedX HTTP',   url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',      proto: 'http' },
  { id: 'speedx-socks4', name: 'TheSpeedX SOCKS4', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',    proto: 'socks4' },
  { id: 'speedx-socks5', name: 'TheSpeedX SOCKS5', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',    proto: 'socks5' },
  { id: 'monosans-http', name: 'monosans HTTP',    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt', proto: 'http' },
  { id: 'monosans-socks5', name: 'monosans SOCKS5', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt', proto: 'socks5' },
  { id: 'proxifly-all',  name: 'proxifly all',     url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt', proto: 'auto' },
];

const STORE = path.join(os.homedir(), '.korona-proxy.json');

function load() {
  try {
    const db = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    db.proxies = db.proxies || {};
    return db;
  } catch {
    return { proxies: {} };
  }
}

function save(db) {
  fs.writeFileSync(STORE, JSON.stringify(db));
}

function sortedProxies(db) {
  return Object.values(db.proxies).sort((a, b) =>
    (a.latency == null ? 9e9 : a.latency) - (b.latency == null ? 9e9 : b.latency));
}

/* ------------------------------------------------------------------ *
 * Platform helpers
 * ------------------------------------------------------------------ */
function execCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

function tcpPing(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ms) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ms);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(Date.now() - t0));
    socket.once('error', () => finish(null));
    socket.once('timeout', () => finish(null));
    socket.connect(port, host);
  });
}

async function pool(items, worker, concurrency = 10) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

/* System-wide proxy: Windows registry (WinINET) or GNOME gsettings. */
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

async function sysSet(proxy) {
  if (process.platform === 'win32') {
    const server = (proxy.protocol === 'socks4' || proxy.protocol === 'socks5')
      ? `socks=${proxy.host}:${proxy.port}`
      : `${proxy.host}:${proxy.port}`;
    await execCmd('reg', ['add', REG_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f']);
    await execCmd('reg', ['add', REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', '<local>', '/f']);
    await execCmd('reg', ['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
    return true;
  }
  if (process.platform === 'linux') {
    if (!await execCmd('sh', ['-c', 'command -v gsettings'])) return false;
    const g = (a) => execCmd('gsettings', a);
    await g(['set', 'org.gnome.system.proxy', 'mode', 'manual']);
    await g(['set', 'org.gnome.system.proxy', 'ignore-hosts', "['localhost', '127.0.0.0/8', '::1']"]);
    if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
      await g(['set', 'org.gnome.system.proxy.socks', 'host', proxy.host]);
      await g(['set', 'org.gnome.system.proxy.socks', 'port', String(proxy.port)]);
    } else {
      await g(['set', 'org.gnome.system.proxy.http', 'host', proxy.host]);
      await g(['set', 'org.gnome.system.proxy.http', 'port', String(proxy.port)]);
      await g(['set', 'org.gnome.system.proxy.http', 'use-authentication', 'false']);
      await g(['set', 'org.gnome.system.proxy.https', 'host', proxy.host]);
      await g(['set', 'org.gnome.system.proxy.https', 'port', String(proxy.port)]);
    }
    return true;
  }
  return false;
}

async function sysClear() {
  if (process.platform === 'win32') {
    await execCmd('reg', ['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
    return true;
  }
  if (process.platform === 'linux') {
    if (!await execCmd('sh', ['-c', 'command -v gsettings'])) return false;
    await execCmd('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'none']);
    return true;
  }
  return false;
}

async function sysActive() {
  if (process.platform === 'win32') {
    const out = await execCmd('reg', ['query', REG_KEY, '/v', 'ProxyEnable']);
    return !!out && /0x1\b/.test(out);
  }
  if (process.platform === 'linux') {
    const mode = await execCmd('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);
    return !!mode && mode.includes('manual');
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/* Download list text. raw.githubusercontent.com is blocked on some networks;
   if it fails, transparently fall back to the GitHub contents API. */
async function fetchText(url) {
  let res = null;
  try { res = await fetch(url, { cache: 'no-store' }); } catch { /* raw unreachable */ }
  if (res && res.ok) return res.text();

  const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(?:refs\/heads\/)?(.+)$/);
  if (m) {
    try {
      const r2 = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/contents/${m[3]}`, { cache: 'no-store' });
      if (r2.ok) {
        const j = await r2.json();
        if (j.encoding === 'base64' && typeof j.content === 'string') {
          return Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8');
        }
      } else if (r2.status === 403) {
        throw new Error('GitHub API rate limit reached, try again in an hour');
      }
    } catch (e) { throw e.message.startsWith('GitHub API rate limit') ? e : new Error(`HTTP ${res ? res.status : 'error'}`); }
  }
  throw new Error(`HTTP ${res ? res.status : 'error'}`);
}

async function cmdFetch() {
  if (typeof fetch !== 'function') return console.log(C.r('Node 18+ required (global fetch missing).'));
  const db = load();
  let total = 0, added = 0;
  for (const src of SOURCES) {
    process.stdout.write(C.dim(`fetching ${src.name}... `));
    try {
      const items = parseAll(await fetchText(src.url), src.proto);
      for (const it of items) {
        if (!db.proxies[it.id]) added++;
        db.proxies[it.id] = { host: it.host, port: it.port, protocol: it.protocol, source: src.id, latency: db.proxies[it.id]?.latency ?? null, lastChecked: db.proxies[it.id]?.lastChecked ?? 0 };
      }
      total += items.length;
      console.log(C.g(`${items.length} found`));
    } catch (e) {
      console.log(C.r(`failed (${e.message})`));
    }
  }
  save(db);
  console.log(`\n${C.b(total + ' proxies seen')}, ${C.g(added + ' new')} · database: ${Object.keys(db.proxies).length}`);
}

function cmdList(n) {
  const db = load();
  const list = sortedProxies(db).slice(0, n || 20);
  if (!list.length) return console.log(C.y('Database is empty — run "korona fetch" first.'));
  console.log(`${C.dim('#   address                  proto   ping      source')}`);
  list.forEach((p, i) => {
    const ping = p.latency == null ? C.dim('—') : p.latency < 150 ? C.g(p.latency + 'ms') : p.latency < 500 ? C.y(p.latency + 'ms') : C.r(p.latency + 'ms');
    console.log(`${String(i).padEnd(3)} ${(p.host + ':' + p.port).padEnd(24)} ${p.protocol.padEnd(7)} ${String(ping).padEnd(12)} ${C.dim(p.source)}`);
  });
}

async function cmdPing(arg) {
  const db = load();
  const all = arg === '--all';
  const targets = all ? sortedProxies(db) : sortedProxies(db).slice(0, +arg || 20);
  if (!targets.length) return console.log(C.y('Database is empty — run "korona fetch" first.'));
  console.log(C.dim(`TCP pinging ${targets.length} proxies (10 at a time)...`));
  let alive = 0, done = 0;
  await pool(targets, async (p) => {
    const ms = await tcpPing(p.host, p.port);
    p.latency = ms;
    p.lastChecked = Date.now();
    if (ms != null) alive++;
    done++;
    const addr = (p.host + ':' + p.port).padEnd(23);
    const tag = ms == null ? C.r('dead') : ms < 150 ? C.g(ms + 'ms') : ms < 500 ? C.y(ms + 'ms') : C.r(ms + 'ms');
    console.log(`${C.dim(String(done).padStart(4))}  ${addr} ${tag}`);
  });
  save(db);
  console.log(`\n${C.g(alive + ' alive')} / ${targets.length} · run "korona list" for the sorted result`);
}

async function cmdConnect(arg) {
  const db = load();
  const list = sortedProxies(db);
  let p = null;

  if (arg == null) return console.log(C.y('Usage: korona connect <id from list | 1.2.3.4:8080 | socks5://1.2.3.4:1080>'));
  if (/^\d+$/.test(arg)) {
    p = list[+arg];
    if (!p) return console.log(C.y(`No proxy with index ${arg} — run "korona list".`));
  } else {
    const parsed = parseAll(arg, 'http')[0] || (arg.includes(':') ? { host: arg.split(':')[0], port: +arg.split(':')[1], protocol: 'http' } : null);
    if (!parsed || !validHost(parsed.host) || !validPort(parsed.port)) return console.log(C.r('Invalid proxy address.'));
    const id = `${parsed.protocol}|${parsed.host}|${parsed.port}`;
    p = db.proxies[id] || { ...parsed, source: 'cli', latency: null, lastChecked: 0 };
    db.proxies[id] = p;
    save(db);
  }

  console.log(C.dim(`routing system traffic via ${p.protocol}://${p.host}:${p.port} ...`));
  const ok = await sysSet(p);
  if (ok) console.log(C.g(`Connected. Browsers/apps honoring system settings now use ${p.host}:${p.port}`));
  else console.log(C.r('System proxy not supported on this platform (or gsettings missing).'));
  console.log(C.dim('run "korona disconnect" to restore direct connection'));
}

async function cmdDisconnect() {
  const ok = await sysClear();
  console.log(ok ? C.g('Disconnected — direct connection restored.') : C.r('Not supported on this platform.'));
}

async function cmdStatus() {
  const db = load();
  const active = await sysActive();
  const total = Object.keys(db.proxies).length;
  const alive = Object.values(db.proxies).filter(p => p.latency != null).length;
  const best = Math.min(...Object.values(db.proxies).map(p => p.latency == null ? Infinity : p.latency));
  console.log(`system proxy: ${active ? C.g('ON') : C.r('off' )}`);
  console.log(`proxies in database: ${total} (checked: ${alive}, best: ${best === Infinity ? '—' : best + 'ms'})`);
  console.log(C.dim(`database file: ${STORE}`));
}

function cmdHelp() {
  console.log(`${C.b('korona')} — free proxy manager CLI
  ${C.y('fetch')}                sync proxy lists from GitHub
  ${C.y('list')} [n]            show proxies, best ping first (default 20)
  ${C.y('ping')} [n|--all]      true TCP latency check
  ${C.y('connect')} <id|addr>   route system traffic via a proxy
  ${C.y('disconnect')}          restore direct connection
  ${C.y('status')}              system proxy + database info`);
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */
const [cmd, arg] = process.argv.slice(2);
const commands = { fetch: cmdFetch, list: cmdList, ping: cmdPing, connect: cmdConnect, disconnect: cmdDisconnect, status: cmdStatus, help: cmdHelp, '--help': cmdHelp, '-h': cmdHelp };

if (!commands[cmd]) {
  cmdHelp();
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(commands[cmd](arg)).catch(e => { console.error(C.r(e.message)); process.exit(1); });
