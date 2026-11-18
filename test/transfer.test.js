// Tests de bout en bout sur la machine locale : `npm test`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Node } = require("../electron/core");
const { sanitizeFileName, candidate } = require("../electron/core/files");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "navette-"));
const start = (name, dir, enableDiscovery = false) => Node.start({ name, port: 0, downloadDir: dir, enableDiscovery });
const waitFor = (node, type, timeout = 2000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`pas d'événement ${type}`)), timeout);
    node.on("event", (ev) => ev.type === type && (clearTimeout(t), resolve(ev)));
  });

test("noms de fichiers nettoyés", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName("C:\\Users\\a\\photo.jpg"), "photo.jpg");
  assert.equal(sanitizeFileName("a<b>c?.txt"), "a_b_c_.txt");
  assert.equal(sanitizeFileName("CON.txt"), "_CON.txt");
  assert.equal(sanitizeFileName("..."), "fichier");
  assert.equal(sanitizeFileName("IMG_0042.HEIC"), "IMG_0042.HEIC");
  assert.equal(candidate("/x", "photo.jpg", 2), path.join("/x", "photo (2).jpg"));
  assert.equal(candidate("/x", "README", 1), path.join("/x", "README (1)"));
});

test("PC → PC avec acceptation, sans écrasement", async () => {
  const src = tmp(), dstA = tmp(), dstB = tmp();
  const a = await start("PC-A", dstA);
  const b = await start("PC-B", dstB);
  b.on("event", (ev) => {
    if (ev.type === "transferRequest") {
      assert.equal(ev.fromName, "PC-A");
      assert.equal(ev.files.length, 2);
      b.respond(ev.requestId, true);
    }
  });
  const big = Buffer.alloc(3_000_000).map((_, i) => i % 251);
  fs.writeFileSync(path.join(src, "video.mov"), big);
  fs.writeFileSync(path.join(src, "note.txt"), "bonjour");
  fs.writeFileSync(path.join(dstB, "note.txt"), "ancien");

  const device = await a.addDeviceByAddress("127.0.0.1", b.port);
  assert.equal(device.name, "PC-B");
  const finished = waitFor(a, "transferFinished");
  await a.sendFiles(device.id, [path.join(src, "video.mov"), path.join(src, "note.txt")]);
  await finished;

  assert.deepEqual(fs.readFileSync(path.join(dstB, "video.mov")), big);
  assert.equal(fs.readFileSync(path.join(dstB, "note.txt"), "utf8"), "ancien");
  assert.equal(fs.readFileSync(path.join(dstB, "note (1).txt"), "utf8"), "bonjour");
  assert.ok(!fs.readdirSync(dstB).some((f) => f.endsWith(".navette-part")));
  await a.stop();
  await b.stop();
});

test("transfert refusé : rien n'est écrit", async () => {
  const src = tmp(), dst = tmp();
  const a = await start("PC-A", tmp());
  const b = await start("PC-B", dst);
  b.on("event", (ev) => ev.type === "transferRequest" && b.respond(ev.requestId, false));
  fs.writeFileSync(path.join(src, "secret.txt"), "x");
  const device = await a.addDeviceByAddress("127.0.0.1", b.port);
  const rejected = waitFor(a, "transferRejected");
  await a.sendFiles(device.id, [path.join(src, "secret.txt")]);
  await rejected;
  assert.equal(fs.readdirSync(dst).length, 0);
  await a.stop();
  await b.stop();
});

test("téléphone : envoi, taille fausse refusée, téléchargement", async () => {
  const dst = tmp();
  const pc = await start("PC", dst);
  const info = await pc.info();
  assert.match(info.phoneQrSvg, /<svg/);
  const token = info.phoneUrl.split("t=")[1];
  const base = `http://127.0.0.1:${pc.port}`;

  assert.equal((await fetch(`${base}/`)).status, 403);
  const page = await (await fetch(`${base}/?t=${token}`)).text();
  assert.ok(page.includes("Connecté à <strong>PC</strong>"));

  const photo = Buffer.alloc(500_000, 7);
  let r = await fetch(`${base}/api/v1/phone/upload?t=${token}&name=IMG_0001.HEIC&size=500000`, { method: "POST", body: photo });
  assert.equal(r.status, 200);
  assert.deepEqual(fs.readFileSync(path.join(dst, "IMG_0001.HEIC")), photo);

  r = await fetch(`${base}/api/v1/phone/upload?t=${token}&name=court.jpg&size=999`, { method: "POST", body: Buffer.alloc(10, 1) });
  assert.notEqual(r.status, 200);
  assert.ok(!fs.existsSync(path.join(dst, "court.jpg")));
  assert.ok(!fs.readdirSync(dst).some((f) => f.endsWith(".navette-part")));

  const docDir = tmp();
  const doc = path.join(docDir, "Facture été.pdf");
  fs.writeFileSync(doc, "%PDF-test");
  const shared = await pc.shareForPhone([doc]);
  const list = await (await fetch(`${base}/api/v1/phone/shared?t=${token}`)).json();
  assert.equal(list[0].name, "Facture été.pdf");
  assert.equal(list[0].path, undefined); // le chemin ne sort jamais du PC
  const dl = await fetch(`${base}/api/v1/phone/download/${shared[0].id}?t=${token}`);
  assert.ok(dl.headers.get("content-disposition").includes("UTF-8''Facture%20%C3%A9t%C3%A9.pdf"));
  assert.equal(await dl.text(), "%PDF-test");
  await pc.stop();
});

test("découverte mDNS entre deux instances", { skip: !process.env.NAVETTE_TEST_MDNS }, async () => {
  const a = await start("PC-A", tmp(), true);
  const b = await start("PC-B", tmp(), true);
  for (let i = 0; i < 50 && !a.listDevices().some((d) => d.name === "PC-B"); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(a.listDevices().some((d) => d.name === "PC-B"), "PC-B non découvert");
  await a.stop();
  await b.stop();
});
