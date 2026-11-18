// Écriture des fichiers reçus : noms sûrs, pas d'écrasement,
// fichier temporaire renommé seulement quand tout est arrivé.

const fsp = require("node:fs/promises");
const path = require("node:path");

const PART_SUFFIX = ".navette-part";

const RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** Nom de fichier sans chemin, pour l'affichage. */
function displayName(filePath) {
  return path.basename(filePath) || "fichier";
}

/**
 * Rend un nom de fichier venu du réseau inoffensif : pas de chemin,
 * pas de caractères interdits sous Windows, pas de nom réservé.
 */
function sanitizeFileName(raw) {
  const base = String(raw ?? "").split(/[/\\]/).pop() ?? "";
  let name = [...base]
    .map((c) => (/[<>:"|?*]/.test(c) || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? "_" : c))
    .join("");
  name = name.trim().replace(/^\.+|\.+$/g, "").trim();
  if (!name) name = "fichier";
  const stem = name.split(".")[0].toUpperCase();
  if (RESERVED.has(stem)) name = `_${name}`;
  const chars = [...name];
  if (chars.length > 180) {
    const ext = path.extname(name);
    name = chars.slice(0, 180 - [...ext].length).join("") + ext;
  }
  return name;
}

/** `photo.jpg` → `photo (1).jpg`, `photo (2).jpg`… */
function candidate(dir, name, n) {
  if (n === 0) return path.join(dir, name);
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return path.join(dir, ext && stem ? `${stem} (${n})${ext}` : `${name} (${n})`);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Réserve un nom libre en créant le fichier temporaire de façon exclusive. */
async function reserve(dir, name) {
  for (let n = 0; n < 10000; n++) {
    const finalPath = candidate(dir, name, n);
    if (await exists(finalPath)) continue;
    try {
      const handle = await fsp.open(finalPath + PART_SUFFIX, "wx");
      return { finalPath, handle };
    } catch (e) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
  }
  throw new Error(`impossible de trouver un nom libre pour ${name}`);
}

/** Limite le nombre d'événements de progression envoyés à l'interface. */
function throttle(ms = 150) {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < ms) return false;
    last = now;
    return true;
  };
}

/**
 * Écrit un flux reçu (requête HTTP) dans le dossier de réception.
 * @param {import('./index').Node} node
 * @param {{transferId:string, peer:string, fileName:string, fileIndex:number, fileCount:number, expectedSize?:number|null}} info
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>} chemin final
 */
async function saveStream(node, info, stream) {
  const dir = node.downloadDir;
  await fsp.mkdir(dir, { recursive: true });
  const safeName = sanitizeFileName(info.fileName);
  const { finalPath, handle } = await reserve(dir, safeName);
  const tmp = finalPath + PART_SUFFIX;
  const total = info.expectedSize ?? 0;
  const ready = throttle();
  const progress = (bytes) =>
    node.emit("event", {
      type: "progress",
      transferId: info.transferId,
      direction: "receive",
      peer: info.peer,
      fileName: safeName,
      fileIndex: info.fileIndex,
      fileCount: info.fileCount,
      bytes,
      total,
    });

  let received = 0;
  // `flush` : données forcées sur le disque avant la fermeture du fichier.
  const out = handle.createWriteStream({ highWaterMark: 1 << 20, flush: true });
  const closed = new Promise((resolve) => out.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        stream.unpipe?.(out);
        out.destroy();
        reject(err);
      };
      stream.on("data", (chunk) => {
        received += chunk.length;
        if (info.expectedSize != null && received > info.expectedSize) {
          fail(new Error("le fichier est plus gros qu'annoncé"));
          stream.destroy?.();
          return;
        }
        if (ready()) progress(received);
      });
      stream.on("aborted", () => fail(new Error("connexion interrompue")));
      stream.on("error", (e) => fail(new Error(`connexion interrompue : ${e.message}`)));
      out.on("error", fail);
      out.on("close", () => !failed && resolve());
      stream.pipe(out);
    });
    if (info.expectedSize != null && received !== info.expectedSize) {
      throw new Error(`fichier incomplet (${received} octets reçus sur ${info.expectedSize})`);
    }
    progress(received);
    // Si quelqu'un a créé le nom final entre-temps, on en prend un autre.
    let target = finalPath;
    for (let n = 1; await exists(target); n++) target = candidate(dir, safeName, n);
    await fsp.rename(tmp, target);
    return target;
  } catch (e) {
    out.destroy();
    await closed;
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

module.exports = { displayName, sanitizeFileName, candidate, saveStream, throttle, PART_SUFFIX };
