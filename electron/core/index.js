// Cœur réseau de Navette : découverte des appareils, serveur de réception,
// envoi vers un autre PC et page web pour les téléphones (QR code).
// Ne dépend pas d'Electron : on peut le tester seul avec `npm test`.

const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const QRCode = require("qrcode");
const { createHandler } = require("./server");
const { startDiscovery } = require("./discovery");
const { probe, sendFiles } = require("./client");
const { displayName } = require("./files");

/** Port par défaut. S'il est occupé, un port libre est choisi automatiquement. */
const DEFAULT_PORT = 53420;

const newId = () => randomUUID().replaceAll("-", "");

function defaultDeviceName() {
  return os.hostname() || "Mon ordinateur";
}

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const looksVirtual = (name) => /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|vbox|virbr|hamachi|tailscale|zerotier/i.test(name);

/** Toutes les adresses IPv4 utilisables (Wi-Fi, Ethernet, Hamachi…). */
function localIPv4s() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push({ ifname, address: a.address });
    }
  }
  return out;
}

/** Adresse de cet ordinateur sur le réseau local (celle du QR code). */
function primaryIp() {
  const all = localIPv4s();
  const best =
    all.find((a) => isPrivate(a.address) && !looksVirtual(a.ifname)) ??
    all.find((a) => isPrivate(a.address)) ??
    all[0];
  return best?.address ?? "127.0.0.1";
}

/** Une instance de Navette en cours d'exécution. Émet des événements « event ». */
class Node extends EventEmitter {
  constructor(config) {
    super();
    this.id = newId();
    this.name = config.name ?? defaultDeviceName();
    this.downloadDir = config.downloadDir;
    this.phoneToken = newId();
    this.port = 0;
    /** @type {Map<string, (accept:boolean)=>void>} */
    this.pending = new Map();
    this.sessions = new Map();
    /** @type {{id:string,name:string,size:number,path:string}[]} */
    this.sharedFiles = [];
    /** @type {Map<string, {id:string,name:string,ip:string,port:number}>} */
    this.devices = new Map();
    this.discovery = null;
    this.server = null;
    this._config = config;
  }

  /** Démarre le serveur de réception et la découverte réseau. */
  static async start(config) {
    const node = new Node(config);
    await fs.promises.mkdir(node.downloadDir, { recursive: true });
    node.server = http.createServer(createHandler(node));
    node.server.requestTimeout = 0; // gros fichiers : pas de limite de durée
    node.server.headersTimeout = 30_000;
    const listen = (port) =>
      new Promise((resolve, reject) => {
        node.server.once("error", reject);
        node.server.listen(port, "0.0.0.0", () => {
          node.server.off("error", reject);
          resolve();
        });
      });
    try {
      await listen(config.port ?? DEFAULT_PORT);
    } catch {
      await listen(0);
    }
    node.port = node.server.address().port;

    if (config.enableDiscovery !== false) {
      try {
        node.discovery = startDiscovery(node);
      } catch (e) {
        node.emit("log", `découverte mDNS indisponible : ${e.message}`);
      }
    }
    return node;
  }

  async stop() {
    await this.discovery?.stop().catch(() => {});
    await new Promise((resolve) => {
      this.server?.close(() => resolve());
      this.server?.closeAllConnections?.();
    });
  }

  async info() {
    const ip = primaryIp();
    const phoneUrl = `http://${ip}:${this.port}/?t=${this.phoneToken}`;
    return {
      id: this.id,
      name: this.name,
      ip,
      port: this.port,
      addresses: localIPv4s().map((a) => a.address),
      phoneUrl,
      phoneQrSvg: await QRCode.toString(phoneUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" }),
      downloadDir: this.downloadDir,
      discoveryActive: this.discovery != null,
    };
  }

  listDevices() {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
  }

  /** Ajout manuel par adresse IP (box qui bloque le mDNS, Hamachi, Tailscale…). */
  async addDeviceByAddress(ip, port = DEFAULT_PORT) {
    const device = await probe(ip, port);
    if (device.id === this.id) throw new Error("c'est cet ordinateur");
    this.devices.set(device.id, device);
    this.emit("event", { type: "deviceFound", device });
    return device;
  }

  async sendFiles(deviceId, paths) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error("appareil introuvable (il s'est peut-être déconnecté)");
    return sendFiles(this, device, paths);
  }

  /** Répond à une demande de transfert entrante. */
  respond(requestId, accept) {
    const answer = this.pending.get(requestId);
    if (!answer) return false;
    this.pending.delete(requestId);
    answer(Boolean(accept));
    return true;
  }

  /** Met des fichiers à disposition des téléphones connectés. */
  async shareForPhone(paths) {
    for (const p of paths) {
      const stat = await fs.promises.stat(p).catch(() => null);
      if (!stat) throw new Error(`lecture impossible : ${p}`);
      if (!stat.isFile()) throw new Error(`${displayName(p)} n'est pas un fichier`);
      this.sharedFiles.push({ id: newId(), name: displayName(p), size: stat.size, path: p });
    }
    return this.phoneShared();
  }

  /** Liste envoyée au téléphone et à l'interface (sans les chemins). */
  phoneShared() {
    return this.sharedFiles.map(({ id, name, size }) => ({ id, name, size }));
  }

  unshareForPhone(id) {
    this.sharedFiles = this.sharedFiles.filter((f) => f.id !== id);
    return this.phoneShared();
  }

  async setDownloadDir(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
    this.downloadDir = path.resolve(dir);
  }
}

module.exports = { Node, DEFAULT_PORT, defaultDeviceName, primaryIp, localIPv4s };
