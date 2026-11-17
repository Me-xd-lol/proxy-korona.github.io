/* ==========================================================================
   Korona Proxy — shared proxy parser
   Used by the core app, the desktop wrapper and the website.
   Detects server addresses inside arbitrary text:
     127.0.0.1:5555            ✓
     socks5://5.6.7.8:1080     ✓
     user:pass@host:port       ✓ (credentials stripped)
     #FREE PROXY LIST 2026     ✗ (no IP:port → ignored)
   ========================================================================== */

'use strict';

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

/** Parse a "protocol://..." entry (hostnames allowed, credentials stripped). */
function parsePrefixed(token) {
  const m = token.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\s"'<>]+)$/i);
  if (!m) return null;
  const protocol = normProto(m[1]);
  if (!protocol) return null;

  let rest = m[2];
  const at = rest.lastIndexOf('@');
  if (at !== -1) rest = rest.slice(at + 1);

  let host, port;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close === -1) return null;
    host = rest.slice(1, close);
    const tail = rest.slice(close + 1);
    if (!/^:\d+$/.test(tail)) return null;
    port = tail.slice(1);
  } else {
    const i = rest.lastIndexOf(':');
    if (i === -1) return null;
    host = rest.slice(0, i);
    port = rest.slice(i + 1);
    if (!/^\d+$/.test(port)) return null;
  }
  if (!validHost(host) || !validPort(port)) return null;
  return { host, port: +port, protocol };
}

/**
 * Extract every proxy from arbitrary text. Returns [{ id, host, port, protocol }].
 * - "protocol://host:port" entries anywhere in a line → detected, prefix wins
 * - bare "IPv4:port" (colon or space separated) elsewhere → detected
 * - lines that are just text (headers, ads, "#FREE PROXY LIST 2026") → ignored
 */
function parseAll(text, defaultProto) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const id = `${p.protocol}|${p.host}|${p.port}`;
    if (!seen.has(id)) { seen.add(id); out.push({ ...p, id }); }
  };
  // bare IPs take the source's protocol (auto → http, the safest guess for free lists)
  const bareProto = defaultProto === 'socks4' || defaultProto === 'socks5' ? defaultProto : 'http';

  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.split('#')[0];
    if (!line.trim()) continue;

    // 1) protocol-prefixed entries (removed from the line afterwards)
    line = line.replace(/\b(?:https?|socks[45]?):\/\/[^\s"'<>]+/gi, (tok) => {
      const p = parsePrefixed(tok);
      if (p) push(p);
      return ' ';
    });

    // 2) bare IPv4:port, colon or space separated, not embedded in other numbers
    const re = /(?<![\w.])((?:\d{1,3}\.){3}\d{1,3})\s*(?::|\s)\s*(\d{1,5})(?![\d.])/g;
    let m;
    while ((m = re.exec(line))) {
      const host = m[1], port = +m[2];
      if (validHost(host) && validPort(port)) push({ host, port, protocol: bareProto });
    }
  }
  return out;
}

/** First proxy of a line, or null. Kept for single-line parsing. */
function parseLine(line, defaultProto) {
  return parseAll(line, defaultProto)[0] || null;
}

/* Node (CLI) support — browsers don't have `module` */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IPV4_RE, HOSTNAME_RE, validHost, validPort, normProto, parsePrefixed, parseAll, parseLine };
}
