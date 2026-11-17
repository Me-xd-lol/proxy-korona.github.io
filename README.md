# Korona Proxy

Free proxy manager: import servers from public GitHub/GitLab lists, check their latency, and route your whole PC through the one you pick.

| Part | Status | Role |
|---|---|---|
| Core app (`app/`) | ✅ working | Shared UI + logic, used by every platform |
| Website (`website/`) | ✅ working | Live list browser + download buttons + connect deep-link |
| PC app (root: `main.js`, `preload.js`) | ✅ working | Electron wrapper — true TCP ping, system-wide connect, korona:// links |
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

- Live list browser: fetches public lists, search/filter, browser-estimated ping
- **Connect via app** — opens the installed PC app through `korona://connect?host=…&port=…&protocol=…`; if the app isn't installed, a notice with download links appears
- **Download buttons** — link directly to GitHub release assets:
  - `KoronaProxy-Setup-x64.exe` (64-bit)
  - `KoronaProxy-Setup-ia32.exe` (32-bit)
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
- **System-wide connect** — sets the Windows proxy (registry `ProxyEnable`/`ProxyServer` + WinINET refresh; SOCKS via `socks=host:port`)
- **`korona://` protocol handler** — website Connect button opens the app and auto-connects
- Single instance lock, dark squared window

## Structure

```
korona-proxy/
├── app/            # shared core app (UI + logic)
│   ├── index.html
│   ├── styles.css  # single source of truth for the design (website imports it)
│   ├── parse.js    # shared address parser
│   └── app.js
├── website/        # static site (index.html + site.css + site.js)
├── main.js         # Electron main process (PC app)
├── preload.js      # koronaBridge: ping / connect / disconnect / deep links
└── package.json    # Electron + builder config (x64 + ia32 NSIS)
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
