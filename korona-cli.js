#!/usr/bin/env node
/* ==========================================================================
   Korona Proxy CLI — the same engine as the desktop app, no GUI, no deps.
   Needs Node.js 18+. Single file, safe to drop into /usr/local/bin/korona.

     korona                     interactive session (prompt + picker)
     korona fetch               sync all proxy lists from GitHub
     korona list [n]            show proxies (best ping first)
     korona ping [n|--all]      true TCP latency check
     korona connect [#|addr]    system-wide proxy (GNOME / Windows)
     korona disconnect          back to direct connection
     korona status              current system proxy + database info
     korona install             register the "korona" command (win: per-user shim)
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dns = require('dns');
const readline = require('readline');
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

/* true while the interactive session is running */
let REPL_MODE = false;

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
  return Object.values(db.proxies).sort((a, b) => {
    const key = (p) => (p.alive === false ? 9e9 : (p.latency == null ? 9e8 : p.latency));  // working → untested → dead
    return key(a) - key(b);
  });
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

/* ------------------------------------------------------------------ *
 * Full proxy verification — the honest check.
 * TCP connect alone proves nothing (a dead proxy can accept the socket),
 * so we speak the proxy's own protocol to it and fetch our exit IP +
 * country through the tunnel. Result: real alive/dead + region.
 * ------------------------------------------------------------------ */
const GEO_ECHO_HOST = 'ip-api.com';
const GEO_ECHO_PATH = '/json/?fields=status,countryCode,query';

function dnsLookup4(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { family: 4 }, (err, addr) => resolve(err ? null : addr));
  });
}

/** Read from the socket until the server closes it. Full text or null. */
function readUntilClose(socket, timeoutMs) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (val) => { if (!done) { done = true; clearTimeout(timer); resolve(val); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('data', (d) => { buf += d.toString('utf8'); });
    socket.on('close', () => finish(buf));
    socket.on('error', () => finish(null));
  });
}

/** Plain HTTP GET written on an already-connected socket (absolute form → via proxy). */
function httpOverSocket(socket, timeoutMs) {
  socket.write(`GET http://${GEO_ECHO_HOST}${GEO_ECHO_PATH} HTTP/1.1\r\nHost: ${GEO_ECHO_HOST}\r\nUser-Agent: korona-cli\r\nConnection: close\r\n\r\n`);
  return readUntilClose(socket, timeoutMs);
}

/** SOCKS5: greeting (no auth) → connect request → server connects out for us. */
function socks5Handshake(socket, host, port, timeoutMs) {
  return new Promise((resolve) => {
    const hb = Buffer.from(host, 'ascii');
    let stage = 0, buf = Buffer.alloc(0), done = false;
    const finish = (ok) => { if (!done) { done = true; socket.removeListener('data', onData); clearTimeout(timer); resolve(ok); } };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[0] !== 5 || buf[1] !== 0) return finish(false);   // not a SOCKS5 proxy / no free auth
        stage = 1;
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([port >> 8, port & 255])]));
      } else if (stage === 1 && buf.length >= 4) {
        const atyp = buf[3];
        const need = 6 + (atyp === 1 ? 4 : atyp === 3 ? 1 + buf[4] : 16);
        if (buf.length >= need) finish(buf[1] === 0);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('data', onData);
    socket.once('error', () => finish(false));
    socket.write(Buffer.from([5, 1, 0]));
  });
}

/** SOCKS4: IP-only connect request (we resolve the target ourselves). */
function socks4Handshake(socket, hostIp, port, timeoutMs) {
  return new Promise((resolve) => {
    const b = Buffer.alloc(9);
    b[0] = 4; b[1] = 1; b.writeUInt16BE(port, 2);
    const o = hostIp.split('.').map(Number);
    b[4] = o[0] & 255; b[5] = o[1] & 255; b[6] = o[2] & 255; b[7] = o[3] & 255;
    let buf = Buffer.alloc(0), done = false;
    const finish = (ok) => { if (!done) { done = true; socket.removeListener('data', onData); clearTimeout(timer); resolve(ok); } };
    const onData = (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= 8) finish(buf[1] === 0x5a); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('data', onData);
    socket.once('error', () => finish(false));
    socket.write(b);
  });
}

/** Pull status/country/exit-IP out of the ip-api HTTP response (chunked-safe). */
function parseEcho(data, res) {
  if (!data || !/^HTTP\/1\.\d 2\d\d/.test(data)) return;
  res.alive = true;
  const cc = data.match(/"countryCode"\s*:\s*"([A-Z]{2})"/);
  if (cc) res.country = cc[1];
  const ip = data.match(/"query"\s*:\s*"([\d.]+)"/);
  if (ip) res.exitIp = ip[1];
}

/**
 * Verify a proxy end to end.
 * @returns {Promise<{ms: number|null, alive: boolean, country: string|null, exitIp: string|null}>}
 *   ms = TCP connect latency; alive = the proxy actually relays traffic.
 */
async function fullCheck(p, tcpTimeoutMs = 3000) {
  const res = { ms: null, alive: false, country: null, exitIp: null };
  const t0 = Date.now();
  const socket = new net.Socket();
  let connected = false;
  try {
    connected = await new Promise((resolve) => {
      socket.setTimeout(tcpTimeoutMs);
      socket.once('connect', () => resolve(true));
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => resolve(false));
      socket.connect(p.port, p.host);
    });
  } catch { connected = false; }
  if (!connected) { socket.destroy(); return res; }
  res.ms = Date.now() - t0;

  const HOP_MS = tcpTimeoutMs + 4000;   // extra time for the tunnel round-trip
  try {
    if (p.protocol === 'http') {
      const data = await httpOverSocket(socket, HOP_MS);
      parseEcho(data, res);
    } else if (p.protocol === 'socks5') {
      const ok = await socks5Handshake(socket, GEO_ECHO_HOST, 80, HOP_MS);
      if (ok) parseEcho(await httpOverSocket(socket, HOP_MS), res);
    } else if (p.protocol === 'socks4') {
      const ip = await dnsLookup4(GEO_ECHO_HOST);
      if (ip) {
        const ok = await socks4Handshake(socket, ip, 80, HOP_MS);
        if (ok) parseEcho(await httpOverSocket(socket, HOP_MS), res);
      }
    }
  } catch { /* keep whatever we learned */ }
  socket.destroy();
  return res;
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
        const old = db.proxies[it.id];
        db.proxies[it.id] = { host: it.host, port: it.port, protocol: it.protocol, source: src.id, latency: old?.latency ?? null, lastChecked: old?.lastChecked ?? 0, country: old?.country ?? null };
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
  console.log(`${C.dim('#   address                  proto   ping      geo    source')}`);
  list.forEach((p, i) => {
    const ping = p.alive === false ? C.r('dead') : pingColor(p.latency);
    const geo = p.country ? C.b(p.country) : C.dim('—');
    console.log(`${String(i).padEnd(3)} ${(p.host + ':' + p.port).padEnd(24)} ${p.protocol.padEnd(7)} ${String(ping).padEnd(10)} ${String(geo).padEnd(6)} ${C.dim(p.source)}`);
  });
}

async function cmdPing(arg) {
  const db = load();
  const tokens = String(arg || '').split(/\s+/).filter(Boolean);
  const all = tokens.includes('--all');
  const fast = tokens.includes('--fast');
  const verify = tokens.includes('--verify');
  const nTok = tokens.find(t => /^\d+$/.test(t));
  const n = nTok ? +nTok : 20;
  // honest handshake check for small runs (default), raw TCP for --all / --fast
  const full = !fast && (all ? verify : n <= 100);
  const targets = all ? sortedProxies(db) : sortedProxies(db).slice(0, n);
  if (!targets.length) return console.log(C.y('Database is empty — run "korona fetch" first.'));

  console.log(C.dim(`${full ? 'verifying' : 'TCP pinging'} ${targets.length} proxies (12 at a time)${full ? ' — checks the proxy actually relays + exit country' : ''}...`));
  let alive = 0, done = 0;
  await pool(targets, async (p) => {
    let ms = null, country = null, works = false;
    if (full) {
      const r = await fullCheck(p);
      ms = r.ms; works = r.alive; country = r.country;
    } else {
      ms = await tcpPing(p.host, p.port);
      works = ms != null;
    }
    p.latency = ms;
    p.alive = works;
    if (country) p.country = country;
    p.lastChecked = Date.now();
    if (works) alive++;
    done++;
    const addr = (p.host + ':' + p.port).padEnd(23);
    const geo = country ? ` ${C.b(country)}` : '';
    const tag = works ? pingColor(ms) : C.r(full ? 'dead' : 'no-answer');
    console.log(`${C.dim(String(done).padStart(4))}  ${addr} ${tag}${geo}`);
  }, 12);
  save(db);
  console.log(`\n${C.g(alive + ' working')} / ${targets.length} · run "korona list" for the sorted result`);
}

function pingColor(ms, dead) {
  if (ms == null) return dead ? C.r('dead') : C.dim('—');
  if (ms < 150) return C.g(ms + 'ms');
  if (ms < 500) return C.y(ms + 'ms');
  return C.r(ms + 'ms');
}

/* Show the best proxies and let the user pick one to connect. */
async function pickProxy(db) {
  const list = sortedProxies(db).slice(0, 15);
  if (!list.length) { console.log(C.y('Database is empty — run "fetch" first.')); return null; }
  console.log(C.dim('pick a proxy (best ping first):'));
  list.forEach((p, i) => {
    const ping = p.alive === false ? C.r('dead') : pingColor(p.latency);
    const geo = p.country ? C.b(p.country) : C.dim('—');
    console.log(`  ${C.b(String(i).padEnd(3))} ${(p.host + ':' + p.port).padEnd(24)} ${p.protocol.padEnd(7)} ${ping} ${String(geo).padEnd(6)} ${C.dim(p.source)}`);
  });
  if (!REPL_MODE && process.stdin.isTTY) {
    const answer = await new Promise((resolve) => {
      const r = readline.createInterface({ input: process.stdin, output: process.stdout });
      r.question(`${C.b('connect to #')} ${C.dim('❯ ')}`, (a) => { r.close(); resolve(String(a || '').trim()); });
    });
    if (/^\d+$/.test(answer)) {
      if (!list[+answer]) console.log(C.y(`No proxy with index ${answer}.`));
      return list[+answer] || null;
    }
    const parsed = answer ? parseAll(answer, 'http')[0] : null;
    if (!parsed) { console.log(C.y('Cancelled.')); return null; }
    const id = `${parsed.protocol}|${parsed.host}|${parsed.port}`;
    if (!db.proxies[id]) db.proxies[id] = { ...parsed, source: 'cli', latency: null, lastChecked: 0 };
    return db.proxies[id];
  }
  console.log(C.dim('→ run "connect <#>"  (or connect <address>)'));
  return null;
}

async function cmdConnect(arg) {
  const db = load();
  const list = sortedProxies(db);
  const tokens = String(arg || '').split(/\s+/).filter(Boolean);
  const force = tokens.includes('--force') || tokens.includes('-f');
  const target = tokens.find(t => !t.startsWith('-'));
  let p = null;

  if (target == null) {
    p = await pickProxy(db);
    if (!p) return;
  } else if (/^\d+$/.test(target)) {
    p = list[+target];
    if (!p) return console.log(C.y(`No proxy with index ${target} — run "korona list".`));
  } else {
    const parsed = parseAll(target, 'http')[0] || (target.includes(':') ? { host: target.split(':')[0], port: +target.split(':')[1], protocol: 'http' } : null);
    if (!parsed || !validHost(parsed.host) || !validPort(parsed.port)) return console.log(C.r('Invalid proxy address.'));
    const id = `${parsed.protocol}|${parsed.host}|${parsed.port}`;
    p = db.proxies[id] || { ...parsed, source: 'cli', latency: null, lastChecked: 0, country: null };
    db.proxies[id] = p;
    save(db);
  }

  // honest check first — never route the whole system through something dead
  if (!force) {
    process.stdout.write(C.dim(`testing ${p.host}:${p.port} ... `));
    const r = await fullCheck(p);
    p.latency = r.ms;
    p.alive = r.alive;
    if (r.country) p.country = r.country;
    save(db);
    if (!r.alive) {
      console.log(C.r('dead — the proxy does not relay traffic.'));
      console.log(C.dim('add --force to connect anyway'));
      return;
    }
    console.log(C.g(`alive ${r.ms}ms`) + (r.country ? C.b(` [${r.country}]`) : ''));
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
  const all = Object.values(db.proxies);
  const total = all.length;
  const alive = all.filter(p => p.alive).length;
  const geo = all.filter(p => p.country).length;
  const best = Math.min(...all.map(p => p.alive && p.latency != null ? p.latency : Infinity));
  console.log(`system proxy: ${active ? C.g('ON') : C.r('off' )}`);
  console.log(`proxies in database: ${total} (working: ${alive}, geo known: ${geo}, best: ${best === Infinity ? '—' : best + 'ms'})`);
  console.log(C.dim(`database file: ${STORE}`));
}

function cmdHelp() {
  console.log(`${C.y('♛')} ${C.b('korona')} — free proxy manager CLI
  ${C.y('(no args)')}         interactive session — prompt, tab-completion, picker
  ${C.y('fetch')}                sync proxy lists from GitHub
  ${C.y('list')} [n]            show proxies, best ping first (default 20)
  ${C.y('ping')} [n|--all]      handshake verify + exit country (default 20; --all/--fast = raw TCP)
  ${C.y('connect')} [#|addr]    test first, then route system-wide (--force skips the test)
  ${C.y('disconnect')}          restore direct connection
  ${C.y('status')}              system proxy + database info
  ${C.y('install')}             register the "korona" command (per-user, no admin)
  ${C.y('uninstall')}           remove it again
  ${C.y('exit')}                leave the interactive session`);
  console.log(C.dim('  first time? run:  node korona-cli.js install   → then just "korona" everywhere'));
}

/* ------------------------------------------------------------------ *
 * install / uninstall — register "korona" on PATH, no admin required
 * ------------------------------------------------------------------ */
function shimTargets() {
  if (process.platform === 'win32') {
    const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps');
    return { dir, dst: path.join(dir, 'korona-cli.js'), shim: path.join(dir, 'korona.cmd') };
  }
  const dir = path.join(os.homedir(), '.local', 'bin');
  return { dir, dst: path.join(dir, 'korona'), shim: null };
}

function cmdInstall() {
  const { dir, dst, shim } = shimTargets();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(__filename, dst);
    fs.chmodSync(dst, 0o755);
    if (shim) fs.writeFileSync(shim, '@echo off\r\nnode "%~dp0korona-cli.js" %*\r\n');
    console.log(C.g(`installed: "korona" → ${dst}`));
    console.log(C.dim('open a NEW terminal, then run: korona status'));
    if (!shim && !String(process.env.PATH || '').split(path.delimiter).includes(dir)) {
      console.log(C.y(`note: add ~/.local/bin to PATH if "korona" is not found`));
    }
  } catch (e) {
    console.log(C.r(`install failed: ${e.message}`));
    console.log(C.dim(`fallback: keep korona-cli.js anywhere and run it with "node korona-cli.js"`));
  }
}

function cmdUninstall() {
  const { dst, shim } = shimTargets();
  let n = 0;
  for (const f of [dst, shim]) {
    if (!f) continue;
    try { fs.unlinkSync(f); n++; } catch { /* not there */ }
  }
  console.log(n ? C.g('korona command removed.') : C.y('nothing to remove.'));
}

/* ------------------------------------------------------------------ *
 * Interactive session — `korona` with no arguments, like opencode / claude
 * ------------------------------------------------------------------ */
function cmdInteractive() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { cmdHelp(); return; }
  REPL_MODE = true;
  console.log('');
  console.log(`  ${C.y('♛')} ${C.b('Korona Proxy')}`);
  console.log(C.dim('  fetch · list · ping · connect · disconnect · status · help · exit'));
  console.log('');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.y('♛')} ${C.b('korona')} ${C.dim('❯ ')}`,
    completer: (line) => {
      const names = [...new Set([...Object.keys(COMMANDS), 'exit', 'quit'])];
      const hits = names.filter((c) => c.startsWith(line));
      return [hits.length ? hits : names, line];
    },
  });
  rl.prompt();
  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) { rl.prompt(); return; }
    const sp = line.indexOf(' ');
    const c = sp === -1 ? line : line.slice(0, sp);
    const a = sp === -1 ? undefined : line.slice(sp + 1);
    if (c === 'exit' || c === 'quit' || c === 'q') { rl.close(); return; }
    const fn = COMMANDS[c];
    if (fn) {
      try { await Promise.resolve(fn(a)); }
      catch (e) { console.error(C.r(e.message || String(e))); }
    } else {
      console.log(C.r(`unknown command: ${c}`) + C.dim('  — "help" lists them all'));
    }
    rl.prompt();
  });
  rl.on('close', () => { console.log(C.dim('bye 👑')); process.exit(0); });
}

/* ------------------------------------------------------------------ *
 * Exports (desktop app reuses the engine; nothing auto-runs on require)
 * ------------------------------------------------------------------ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tcpPing, fullCheck, parseAll, validHost, validPort, normProto };
}

/* ------------------------------------------------------------------ *
 * Dispatch — only when run directly
 * ------------------------------------------------------------------ */
const COMMANDS = { fetch: cmdFetch, list: cmdList, ping: cmdPing, connect: cmdConnect, disconnect: cmdDisconnect, status: cmdStatus, help: cmdHelp, '--help': cmdHelp, '-h': cmdHelp, install: cmdInstall, uninstall: cmdUninstall };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd) cmdInteractive();
  else if (!COMMANDS[cmd]) { cmdHelp(); process.exit(1); }
  else Promise.resolve(COMMANDS[cmd](arg)).catch(e => { console.error(C.r(e.message)); process.exit(1); });
}
