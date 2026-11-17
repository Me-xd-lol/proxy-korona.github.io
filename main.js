/* ==========================================================================
   Korona Proxy — Electron main process
   - loads the shared core app (app/index.html)
   - real TCP ping via net.Socket
   - system-wide connect: Windows proxy settings (registry + WinINET refresh)
   - korona:// protocol: website's Connect button opens the app here
   ========================================================================== */

const { app, BrowserWindow, ipcMain } = require('electron');
const net = require('net');
const { execFile } = require('child_process');
const path = require('path');

const PROTOCOL = 'korona';
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

let win = null;
let pendingLink = null;

/* ------------------------------------------------------------------ *
 * Windows system proxy (WinINET)
 * ------------------------------------------------------------------ */

function regAdd(name, type, value) {
  return new Promise((resolve) => {
    execFile('reg', ['add', REG_KEY, '/v', name, '/t', type, '/d', value, '/f'],
      { windowsHide: true }, () => resolve());
  });
}

/** Tell Windows that proxy settings changed, without a reboot/relogon. */
function refreshWinInet() {
  const script = [
    "Add-Type -TypeDefinition '",
    'using System; using System.Runtime.InteropServices;',
    'public class WinInet {',
    '  [DllImport("wininet.dll", SetLastError = true)]',
    '  public static extern bool InternetSetOption(IntPtr h, int opt, IntPtr buf, int len);',
    "}'",
    '[WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null',  // SETTINGS_CHANGED
    '[WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null',  // REFRESH
  ].join('\n');
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true }, () => {});
}

async function setSystemProxy(proxy) {
  if (process.platform === 'win32') {
    // WinINET supports HTTP proxies natively; SOCKS via the socks= scheme
    const server = (proxy.protocol === 'socks4' || proxy.protocol === 'socks5')
      ? `socks=${proxy.host}:${proxy.port}`
      : `${proxy.host}:${proxy.port}`;
    await regAdd('ProxyServer', 'REG_SZ', server);
    await regAdd('ProxyOverride', 'REG_SZ', '<local>');
    await regAdd('ProxyEnable', 'REG_DWORD', '1');
    refreshWinInet();
    return true;
  }

  if (process.platform === 'linux') {
    // GNOME desktop proxy settings (works for GNOME apps & anything honoring them)
    const has = await execCmd('sh', ['-c', 'command -v gsettings']);
    if (!has) return false;
    const g = (args) => execCmd('gsettings', args);
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

async function clearSystemProxy() {
  if (process.platform === 'win32') {
    await regAdd('ProxyEnable', 'REG_DWORD', '0');
    refreshWinInet();
    return;
  }
  if (process.platform === 'linux') {
    const has = await execCmd('sh', ['-c', 'command -v gsettings']);
    if (has) await execCmd('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'none']);
  }
}

function execCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

/* ------------------------------------------------------------------ *
 * True TCP latency
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Deep links — korona://connect?host=&port=&protocol=
 * ------------------------------------------------------------------ */

function parseDeepLink(arg) {
  const prefix = PROTOCOL + '://';
  if (typeof arg !== 'string' || !arg.toLowerCase().startsWith(prefix)) return null;
  try {
    const rest = arg.slice(prefix.length);
    const qi = rest.indexOf('?');
    const action = (qi === -1 ? rest : rest.slice(0, qi)).toLowerCase();
    const params = {};
    if (qi !== -1) {
      for (const [k, v] of new URLSearchParams(rest.slice(qi + 1))) params[k] = v;
    }
    return { action, params };
  } catch { return null; }
}

function dispatchLink(link) {
  if (!win) { pendingLink = link; return; }
  if (link && link.action === 'connect') {
    win.show();
    win.focus();
    win.webContents.send('korona:connect-request', link.params || {});
  }
}

function handleArgs(argv) {
  for (const a of argv) {
    const link = parseDeepLink(a);
    if (link) { dispatchLink(link); break; }
  }
}

/* ------------------------------------------------------------------ *
 * Window & lifecycle
 * ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0a0d12',
    icon: path.join(__dirname, 'app', 'icon.png'),
    autoHideMenuBar: true,
    title: 'Korona Proxy',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.on('closed', () => { win = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    handleArgs(argv);
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    // Register korona:// so the website's Connect button opens the app
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }

    ipcMain.handle('korona:ping', (e, proxy, timeout) => tcpPing(proxy.host, proxy.port, timeout || 3000));
    ipcMain.handle('korona:connect', (e, proxy) => setSystemProxy(proxy));
    ipcMain.handle('korona:disconnect', () => clearSystemProxy());
    ipcMain.handle('korona:proxy-active', async () => {
      if (process.platform === 'win32') {
        return new Promise((resolve) => {
          execFile('reg', ['query', REG_KEY, '/v', 'ProxyEnable'], { windowsHide: true }, (err, stdout) => {
            resolve(!err && /0x1\b/.test(String(stdout)));
          });
        });
      }
      if (process.platform === 'linux') {
        const mode = await execCmd('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);
        return !!mode && mode.includes('manual');
      }
      return false;
    });

    createWindow();
    handleArgs(process.argv);
    if (pendingLink) { dispatchLink(pendingLink); pendingLink = null; }
  });

  app.on('window-all-closed', () => app.quit());
}
