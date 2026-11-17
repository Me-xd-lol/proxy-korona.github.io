# Korona Proxy

Free proxy manager: import servers from public GitHub/GitLab lists, check their latency, and route your whole PC through the one you pick.

| Part | Status | Role |
|---|---|---|
| Core app (`app/`) | ✅ working | Shared UI + logic, used by every platform |
| Website (`index.html` at repo root) | ✅ working | Live list browser + download buttons + connect deep-link |
| PC app (root: `main.js`, `preload.js`) | ✅ working | Electron wrapper — true TCP ping, system-wide connect, korona:// links |
| CLI (`korona-cli.js`) | ✅ working | Single-file terminal app — same engine, no deps, needs Node 18+ |
| Mobile | ⏳ later | Capacitor wrapper + native VPN connect |

## Design system

- Fully squared — zero border-radius anywhere
- Dark obsidian surfaces, 1px crisp borders
- Korona Yellow accent `#ffd60a` — squared yellow primary buttons
- Animated moving-grid background layer (pure CSS)
- Fonts: Space Grotesk (UI) + JetBrains Mono (addresses, data, badges)
- Ping badges: green < 150 ms · yellow 150–500 ms · red > 500 ms / dead

## Import & parsing

Lists are imported from raw URLs (GitHub, GitLab, anything serving text). The shared parser (`app/parse.js`) detects actual server addresses inside arbitrary text:

```
127.0.0.1:5555           ✓ detected
socks5://5.6.7.8:1080    ✓ detected (prefix wins)
user:pass@host:port      ✓ credentials stripped
#FREE PROXY LIST 2026    ✗ no address → ignored
```

Duplicate servers are merged automatically.

## Website

- Live list browser: fetches public lists, search/filter, copy any address into the app for a real latency check
- **Connect via app** — opens the installed PC app through `korona://connect?host=…&port=…&protocol=…`; if the app isn't installed, a notice with download links appears
- **Download buttons** — link directly to GitHub release assets:
  - `KoronaProxy-Setup-x64.exe` (64-bit Windows)
  - `KoronaProxy-Setup-ia32.exe` (32-bit Windows)
  - `KoronaProxy-x86_64.AppImage` + `KoronaProxy-amd64.deb` (Linux)
  - `korona-cli.js` (CLI, any OS with Node 18+)
  - fallback: releases page

> Set your repo in `website/site.js` → `GITHUB_REPO` so the download buttons point at your releases.

## PC app (Windows 32-bit & 64-bit)

```cmd
npm install
npm start          -- run in dev
npm run dist       -- build installers (both architectures)
```

Installers land in `release/`:
- `KoronaProxy-Setup-x64.exe`
- `KoronaProxy-Setup-ia32.exe`

What the desktop wrapper adds over the browser:

- **True TCP latency** (`net.Socket` connect timing, no estimates)
- **System-wide connect** — Windows: registry `ProxyEnable`/`ProxyServer` + WinINET refresh (SOCKS via `socks=host:port`); Linux: GNOME proxy settings via `gsettings`
- **`korona://` protocol handler** — website Connect button opens the app and auto-connects
- Single instance lock, dark squared window

## CLI (single file, no deps)

`korona-cli.js` — the same engine as the desktop app in one terminal-friendly file. Requires Node.js 18+ (built-in `fetch`), zero npm dependencies.

```bash
# install (Linux/macOS)
curl -fL https://github.com/Me-xd-lol/proxy-korona.github.io/releases/latest/download/korona-cli.js -o korona
sudo install -m 755 korona /usr/local/bin/korona

# usage
korona fetch                  # sync proxy lists from GitHub
korona list [n]               # show proxies, best ping first
korona ping [n|--all]         # true TCP latency check
korona connect <id|addr>      # system-wide proxy (Windows registry / GNOME gsettings)
korona disconnect             # back to direct connection
korona status
```

Database lives at `~/.korona-proxy.json`. If `raw.githubusercontent.com` is blocked on the network, the CLI automatically falls back to the GitHub contents API.

## Structure

```
korona-proxy/
├── index.html      # the website itself (repo root = GitHub Pages)
├── site.css / site.js / logo.png
├── korona-cli.js   # single-file CLI (Node 18+, no deps)
├── app/            # shared core app (UI + logic, used by site + desktop)
│   ├── index.html
│   ├── styles.css  # single source of truth for the design (site imports it)
│   ├── parse.js    # shared address parser
│   └── app.js
├── main.js         # Electron main process (PC app)
├── preload.js      # koronaBridge: ping / connect / disconnect / deep links
└── package.json    # Electron + builder config
```

## Bridge contract

```js
window.koronaBridge = {
  ping(proxy, timeoutMs)  -> Promise<number|null>,  // true TCP latency, null = dead
  connect(proxy)          -> Promise<boolean>,      // system-wide route
  disconnect()            -> Promise<void>,
  onConnectRequest(cb)    -> void,                  // korona://connect deep links
  platform: 'win32',
}
```

Without a bridge (plain browser) the app stays fully functional: lists, sync, estimated pings.
