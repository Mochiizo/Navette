// Découverte automatique des autres PC via mDNS (même principe que les
// imprimantes réseau) : chaque instance s'annonce et écoute les autres.
// Type de service « _navette._tcp », identique aux versions précédentes.

const { Bonjour } = require("bonjour-service");

function startDiscovery(node) {
  const bonjour = new Bonjour({}, (err) => node.emit("log", `mDNS : ${err?.message ?? err}`));
  bonjour.publish({
    name: node.id,
    type: "navette",
    protocol: "tcp",
    port: node.port,
    txt: { id: node.id, name: node.name, v: "1" },
    disableIPv6: true,
  });

  // nom mDNS → id de l'appareil, pour gérer les départs.
  const byName = new Map();
  const browser = bonjour.find({ type: "navette", protocol: "tcp" });

  const onUp = (svc) => {
    const id = svc.txt?.id;
    if (!id || id === node.id) return; // c'est nous
    const ip =
      (svc.addresses ?? []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)).sort()[0] ??
      (svc.referer?.family === "IPv4" ? svc.referer.address : null);
    if (!ip) return;
    const device = { id, name: String(svc.txt?.name ?? "Ordinateur"), ip, port: svc.port };
    byName.set(svc.fqdn ?? svc.name, id);
    const before = node.devices.get(id);
    node.devices.set(id, device);
    if (!before || before.ip !== device.ip || before.port !== device.port || before.name !== device.name) {
      node.emit("event", { type: "deviceFound", device });
    }
  };

  browser.on("up", onUp);
  browser.on("txt-update", onUp);
  browser.on("srv-update", onUp);
  browser.on("down", (svc) => {
    const key = svc.fqdn ?? svc.name;
    const id = byName.get(key);
    if (!id) return;
    byName.delete(key);
    node.devices.delete(id);
    node.emit("event", { type: "deviceLost", id });
  });

  // Relance régulière de la recherche (appareils qui arrivent tardivement).
  const timer = setInterval(() => browser.update(), 15_000);

  return {
    stop() {
      clearInterval(timer);
      browser.stop();
      return new Promise((resolve) => bonjour.unpublishAll(() => bonjour.destroy(resolve)));
    },
  };
}

module.exports = { startDiscovery };
