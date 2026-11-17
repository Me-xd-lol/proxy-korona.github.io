/* Korona Proxy — preload bridge
   Exposes platform powers to the renderer as window.koronaBridge. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('koronaBridge', {
  // True TCP connect latency; null = unreachable
  ping: (proxy, timeoutMs) => ipcRenderer.invoke('korona:ping', proxy, timeoutMs),
  // System-wide route through the proxy (Windows proxy settings)
  connect: (proxy) => ipcRenderer.invoke('korona:connect', proxy),
  disconnect: () => ipcRenderer.invoke('korona:disconnect'),
  // Website deep links: korona://connect?host=&port=&protocol=
  onConnectRequest: (cb) => ipcRenderer.on('korona:connect-request', (e, params) => cb(params)),
  // Is the Windows system proxy currently enabled?
  isProxyOn: () => ipcRenderer.invoke('korona:proxy-active'),
  platform: process.platform,
});
