// Côté expéditeur : annonce les fichiers à l'autre PC, attend son accord,
// puis envoie chaque fichier en flux avec suivi de progression.

const fs = require("node:fs");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { displayName, throttle } = require("./files");
const { ANSWER_TIMEOUT_MS } = require("./server");

/** Petite requête HTTP avec corps JSON ou flux, réponse texte. */
function request(device, { method = "GET", path, json, body, timeout = 0, onSent }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload = null;
    if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json));
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    } else if (body?.size != null) {
      headers["Content-Length"] = body.size;
      headers["Content-Type"] = "application/octet-stream";
    }
    const req = http.request({ host: device.ip, port: device.port, method, path, headers, timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("délai dépassé")));
    req.on("error", reject);
    if (payload) req.end(payload);
    else if (body?.stream) {
      body.stream.on("data", (chunk) => onSent?.(chunk.length));
      body.stream.on("error", (e) => req.destroy(e));
      body.stream.pipe(req);
    } else req.end();
  });
}

/** Vérifie qu'une adresse correspond bien à une instance de Navette. */
async function probe(ip, port) {
  let res;
  try {
    res = await request({ ip, port }, { path: "/api/v1/info", timeout: 4000 });
  } catch {
    throw new Error("aucune réponse à cette adresse");
  }
  let info;
  try {
    info = JSON.parse(res.text);
  } catch {
    info = null;
  }
  if (res.status !== 200 || info?.app !== "navette") throw new Error("ce n'est pas une instance de Navette");
  return { id: info.id, name: info.name, ip, port };
}

/**
 * Envoie des fichiers à un autre PC. Rend la main quand tout est envoyé
 * (ou refusé) ; la progression passe par les événements du nœud.
 * @param {import('./index').Node} node
 */
async function sendFiles(node, device, paths) {
  if (!paths?.length) throw new Error("aucun fichier sélectionné");
  const metas = [];
  for (const p of paths) {
    const stat = await fs.promises.stat(p).catch(() => null);
    if (!stat) throw new Error(`lecture impossible : ${p}`);
    if (stat.isDirectory()) throw new Error(`« ${displayName(p)} » est un dossier : l'envoi de dossiers arrive dans une prochaine étape`);
    metas.push({ name: displayName(p), size: stat.size });
  }

  const transferId = randomUUID().replaceAll("-", "");
  const peer = device.name;
  const emit = (ev) => node.emit("event", { transferId, direction: "send", peer, ...ev });
  const fail = (error) => {
    emit({ type: "transferFailed", error });
    return new Error(error);
  };

  // « 0 % » pour afficher tout de suite le transfert pendant que l'autre PC décide.
  emit({ type: "progress", fileName: metas[0].name, fileIndex: 0, fileCount: metas.length, bytes: 0, total: metas[0].size });

  let answer;
  try {
    const res = await request(device, {
      method: "POST",
      path: "/api/v1/request",
      json: { fromId: node.id, fromName: node.name, files: metas },
      timeout: ANSWER_TIMEOUT_MS + 10_000,
    });
    if (res.status !== 200) throw new Error(`réponse ${res.status}`);
    answer = JSON.parse(res.text);
  } catch (e) {
    throw fail(`impossible de joindre ${peer} : ${e.message}`);
  }
  if (!answer.accepted || !answer.session) {
    node.emit("event", { type: "transferRejected", transferId, peer });
    return;
  }

  for (let index = 0; index < paths.length; index++) {
    const meta = metas[index];
    let sent = 0;
    const ready = throttle();
    let res;
    try {
      res = await request(device, {
        method: "POST",
        path: `/api/v1/upload?session=${encodeURIComponent(answer.session)}&index=${index}`,
        body: { stream: fs.createReadStream(paths[index], { highWaterMark: 256 * 1024 }), size: meta.size },
        onSent: (n) => {
          sent += n;
          if (ready() || sent === meta.size) {
            emit({ type: "progress", fileName: meta.name, fileIndex: index, fileCount: paths.length, bytes: sent, total: meta.size });
          }
        },
      });
    } catch (e) {
      throw fail(`envoi de ${meta.name} interrompu : ${e.message}`);
    }
    if (res.status !== 200) throw fail(`${meta.name} refusé (${res.status}) : ${res.text}`);
    emit({ type: "fileDone", fileName: meta.name, path: null });
  }
  emit({ type: "transferFinished" });
}

module.exports = { probe, sendFiles };
