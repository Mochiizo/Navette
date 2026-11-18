// Processus principal Electron : fenêtre, cœur réseau, réglages, mises à jour.
// L'interface (Next.js exporté en statique) est servie par le protocole app://.

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { Node } = require("./core");
const { setupUpdater } = require("./updater");

const DEV_URL = process.env.NAVETTE_DEV_URL; // `npm run dev` : serveur Next.js
const UI_DIR = path.join(__dirname, "..", "out");

// Une seule instance de Navette à la fois (sinon deux serveurs se battent pour le port).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Node | null} */
let node = null;

// ------------------------------------------------------------------ réglages

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}

// ------------------------------------------------------------------ fenêtre

function serveUi() {
  // app://navette/chemin → fichier du dossier `out` (export statique Next.js).
  protocol.handle("app", (request) => {
    const { pathname } = new URL(request.url);
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith("/")) rel += "index.html";
    let file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR)) return new Response("interdit", { status: 403 });
    if (!fs.existsSync(file) && fs.existsSync(file + ".html")) file += ".html";
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  win = new BrowserWindow({
    title: "Navette",
    width: 1080,
    height: 720,
    minWidth: 780,
    minHeight: 540,
    frame: false,
    backgroundColor: "#0b0d12",
    show: false,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("maximize", () => win.webContents.send("navette:maximized", true));
  win.on("unmaximize", () => win.webContents.send("navette:maximized", false));
  // Les liens externes s'ouvrent dans le navigateur, jamais dans l'app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://") && !(DEV_URL && url.startsWith(DEV_URL))) e.preventDefault();
  });
  win.loadURL(DEV_URL ?? "app://navette/");
  win.on("closed", () => (win = null));
}

const send = (channel, payload) => win?.webContents.send(channel, payload);

// ------------------------------------------------------------------ IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
}

function registerIpc() {
  handle("info", () => node.info());
  handle("devices", () => node.listDevices());
  handle("addDevice", (ip, port) => node.addDeviceByAddress(String(ip).trim(), port || undefined));
  handle("sendFiles", (deviceId, paths) => node.sendFiles(deviceId, paths));
  handle("respond", (requestId, accept) => node.respond(requestId, accept));
  handle("shareForPhone", (paths) => node.shareForPhone(paths));
  handle("phoneShared", () => node.phoneShared());
  handle("unshareForPhone", (id) => node.unshareForPhone(id));
  handle("pickFiles", async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : r.filePaths;
  });
  handle("pickDownloadDir", async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "Dossier de réception",
      defaultPath: node.downloadDir,
      properties: ["openDirectory", "createDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    await node.setDownloadDir(r.filePaths[0]);
    saveSettings({ downloadDir: node.downloadDir });
    return node.downloadDir;
  });
  handle("openDownloadDir", async () => {
    const err = await shell.openPath(node.downloadDir);
    if (err) throw new Error(err);
  });
  handle("revealFile", (p) => shell.showItemInFolder(p));
  handle("version", () => app.getVersion());

  ipcMain.on("window:minimize", () => win?.minimize());
  ipcMain.on("window:toggleMaximize", () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  ipcMain.on("window:close", () => win?.close());
  handle("window:isMaximized", () => win?.isMaximized() ?? false);
}

// ------------------------------------------------------------------ démarrage

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  const saved = loadSettings().downloadDir;
  const downloadDir = saved && fs.existsSync(saved) ? saved : app.getPath("downloads");
  try {
    node = await Node.start({ downloadDir });
  } catch (e) {
    dialog.showErrorBox("Navette", `Impossible de démarrer le serveur de réception :\n${e.message}`);
    app.quit();
    return;
  }
  node.on("event", (ev) => send("navette:event", ev));
  node.on("log", (msg) => console.warn(msg));
  console.log(`Navette prête · page téléphone : ${(await node.info()).phoneUrl}`);

  serveUi();
  registerIpc();
  createWindow();
  setupUpdater({ send, isDev: !app.isPackaged, handle });
});

app.on("window-all-closed", async () => {
  await node?.stop().catch(() => {});
  app.quit();
});
