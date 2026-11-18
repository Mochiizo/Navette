// Serveur HTTP local : reçoit les fichiers des autres PC et sert la page web
// utilisée par les téléphones. Même protocole que les versions précédentes de
// Navette, donc les anciennes et nouvelles versions peuvent échanger.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { saveStream } = require("./files");

/** Délai laissé à l'utilisateur pour accepter un transfert. */
const ANSWER_TIMEOUT_MS = 120_000;

const MOBILE_PAGE = fs.readFileSync(path.join(__dirname, "mobile.html"), "utf8");

const newId = () => randomUUID().replaceAll("-", "");

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req, limit = 4 << 20) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("requête trop grosse"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON invalide"), { status: 400 });
  }
}

const htmlEscape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const asciiFallback = (s) => [...s].map((c) => (/[\x20-\x7e]/.test(c) && c !== '"' && c !== "\\" ? c : "_")).join("");

/**
 * Crée le gestionnaire de requêtes du serveur.
 * @param {import('./index').Node} node
 */
function createHandler(node) {
  const phoneTokenOk = (url) => url.searchParams.get("t") === node.phoneToken;
  const forbiddenPhone = (res) =>
    sendText(res, 403, "Lien expiré : scannez à nouveau le QR code affiché sur l'ordinateur.");

  const routes = {
    // ------------------------------------------------------------ PC ⇄ PC
    "GET /api/v1/info": (req, res) =>
      sendJson(res, 200, { app: "navette", id: node.id, name: node.name, port: node.port }),

    /** Étape 1 : l'expéditeur annonce les fichiers, l'utilisateur accepte ou refuse. */
    "POST /api/v1/request": async (req, res) => {
      const body = await readJson(req);
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length || files.length > 10000 || files.some((f) => typeof f?.name !== "string" || !(f.size >= 0))) {
        return sendText(res, 400, "liste de fichiers invalide");
      }
      const requestId = newId();
      const fromName = String(body.fromName ?? "Ordinateur").slice(0, 64);
      const answer = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ANSWER_TIMEOUT_MS);
        node.pending.set(requestId, (accept) => {
          clearTimeout(timer);
          resolve(accept);
        });
        // L'expéditeur a abandonné : on retire la demande.
        res.on("close", () => !res.writableEnded && resolve(false));
      });
      node.emit("event", {
        type: "transferRequest",
        requestId,
        fromName,
        files: files.map((f) => ({ name: f.name, size: f.size })),
        totalSize: files.reduce((a, f) => a + f.size, 0),
      });
      const accepted = await answer;
      node.pending.delete(requestId);
      node.emit("event", { type: "requestClosed", requestId });
      if (!accepted) return sendJson(res, 200, { accepted: false, session: null });
      const session = newId();
      node.sessions.set(session, { peer: fromName, files, received: files.map(() => false) });
      sendJson(res, 200, { accepted: true, session });
    },

    /** Étape 2 : un appel par fichier, le contenu arrive en flux dans le corps. */
    "POST /api/v1/upload": async (req, res, url) => {
      const sessionId = url.searchParams.get("session") ?? "";
      const index = Number(url.searchParams.get("index"));
      const sess = node.sessions.get(sessionId);
      if (!sess) return sendText(res, 403, "session inconnue");
      if (!Number.isInteger(index) || index < 0 || index >= sess.files.length) return sendText(res, 400, "index invalide");
      if (sess.received[index]) return sendText(res, 409, "fichier déjà reçu");
      sess.received[index] = true; // réservé pendant la réception
      const meta = sess.files[index];
      try {
        const filePath = await saveStream(
          node,
          { transferId: sessionId, peer: sess.peer, fileName: meta.name, fileIndex: index, fileCount: sess.files.length, expectedSize: meta.size },
          req,
        );
        node.emit("event", { type: "fileDone", transferId: sessionId, direction: "receive", peer: sess.peer, fileName: meta.name, path: filePath });
        if (sess.received.every(Boolean)) {
          node.sessions.delete(sessionId);
          node.emit("event", { type: "transferFinished", transferId: sessionId, direction: "receive", peer: sess.peer });
        }
        sendText(res, 200, "");
      } catch (e) {
        sess.received[index] = false; // nouvel essai possible
        node.emit("event", { type: "transferFailed", transferId: sessionId, direction: "receive", peer: sess.peer, error: e.message });
        if (!res.headersSent) sendText(res, 500, e.message);
      }
    },

    // ------------------------------------------------------------ Téléphone
    "GET /": (req, res, url) => {
      if (!phoneTokenOk(url)) {
        return sendText(
          res,
          403,
          "<meta name=viewport content='width=device-width'><p style='font-family:sans-serif;padding:2em'>Lien expiré. Scannez à nouveau le QR code affiché dans Navette sur l'ordinateur.</p>",
          "text/html; charset=utf-8",
        );
      }
      const page = MOBILE_PAGE.replace("{{PC_NAME}}", htmlEscape(node.name));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(page);
    },

    "POST /api/v1/phone/upload": async (req, res, url) => {
      if (!phoneTokenOk(url)) return forbiddenPhone(res);
      const q = url.searchParams;
      const name = q.get("name") ?? "fichier";
      const size = q.has("size") ? Number(q.get("size")) : null;
      const batch = (q.get("batch") ?? "").slice(0, 64) || newId();
      const index = Number(q.get("index") ?? 0) || 0;
      const count = Math.max(1, Number(q.get("count") ?? 1) || 1);
      const peer = "Téléphone";
      try {
        const filePath = await saveStream(
          node,
          { transferId: batch, peer, fileName: name, fileIndex: index, fileCount: count, expectedSize: Number.isFinite(size) ? size : null },
          req,
        );
        node.emit("event", { type: "fileDone", transferId: batch, direction: "receive", peer, fileName: name, path: filePath });
        if (index + 1 >= count) node.emit("event", { type: "transferFinished", transferId: batch, direction: "receive", peer });
        sendText(res, 200, "");
      } catch (e) {
        node.emit("event", { type: "transferFailed", transferId: batch, direction: "receive", peer, error: e.message });
        if (!res.headersSent) sendText(res, 500, e.message);
      }
    },

    "GET /api/v1/phone/shared": (req, res, url) => {
      if (!phoneTokenOk(url)) return forbiddenPhone(res);
      sendJson(res, 200, node.phoneShared());
    },
  };

  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    try {
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) return await route(req, res, url);

      const dl = url.pathname.match(/^\/api\/v1\/phone\/download\/([A-Za-z0-9]+)$/);
      if (req.method === "GET" && dl) {
        if (!phoneTokenOk(url)) return forbiddenPhone(res);
        const shared = node.sharedFiles.find((f) => f.id === dl[1]);
        if (!shared) return sendText(res, 404, "fichier plus partagé");
        const stat = await fs.promises.stat(shared.path).catch(() => null);
        if (!stat) return sendText(res, 404, "fichier introuvable");
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": stat.size,
          "Content-Disposition": `attachment; filename="${asciiFallback(shared.name)}"; filename*=UTF-8''${encodeURIComponent(shared.name)}`,
        });
        return fs.createReadStream(shared.path, { highWaterMark: 256 * 1024 }).pipe(res);
      }
      sendText(res, 404, "introuvable");
    } catch (e) {
      if (!res.headersSent) sendText(res, e.status ?? 500, e.message);
      else res.destroy();
    }
  };
}

module.exports = { createHandler, ANSWER_TIMEOUT_MS };
