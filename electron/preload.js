// Pont sécurisé entre l'interface et le processus principal :
// l'interface n'a accès qu'à ces fonctions, jamais à Node.js directement.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

/** Appelle le processus principal ; une erreur côté principal devient une exception ici. */
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function subscribe(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("navette", {
  info: () => call("info"),
  devices: () => call("devices"),
  addDevice: (ip, port) => call("addDevice", ip, port),
  sendFiles: (deviceId, paths) => call("sendFiles", deviceId, paths),
  respond: (requestId, accept) => call("respond", requestId, accept),
  shareForPhone: (paths) => call("shareForPhone", paths),
  phoneShared: () => call("phoneShared"),
  unshareForPhone: (id) => call("unshareForPhone", id),
  pickFiles: () => call("pickFiles"),
  pickDownloadDir: () => call("pickDownloadDir"),
  openDownloadDir: () => call("openDownloadDir"),
  revealFile: (p) => call("revealFile", p),
  version: () => call("version"),
  /** Chemin réel d'un fichier glissé depuis l'Explorateur. */
  pathForFile: (file) => webUtils.getPathForFile(file),
  onEvent: (cb) => subscribe("navette:event", cb),

  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggleMaximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => call("window:isMaximized"),
    onMaximized: (cb) => subscribe("navette:maximized", cb),
  },

  update: {
    check: () => call("update:check"),
    install: () => call("update:install"),
    onProgress: (cb) => subscribe("navette:update-progress", cb),
    onReady: (cb) => subscribe("navette:update-ready", cb),
    onError: (cb) => subscribe("navette:update-error", cb),
  },
});
