// Interface de Navette. Pas de framework : Tauri injecte son API dans
// window.__TAURI__ (option "withGlobalTauri" dans tauri.conf.json).

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;
const { getCurrentWebview } = window.__TAURI__.webview;
const { getCurrentWindow } = window.__TAURI__.window;
const appWindow = getCurrentWindow();

// Barre de titre intégrée : boutons réduire / agrandir / fermer.
document.getElementById("winMin").addEventListener("click", () => appWindow.minimize());
document.getElementById("winMax").addEventListener("click", () => appWindow.toggleMaximize());
document.getElementById("winClose").addEventListener("click", () => appWindow.close());
async function syncMaximized() {
  const max = await appWindow.isMaximized();
  const box = document.querySelector(".win-controls");
  box.classList.toggle("maximized", max);
  document.getElementById("winMax").title = max ? "Restaurer" : "Agrandir";
}
appWindow.onResized(syncMaximized);
syncMaximized();

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtSize = (n) => n < 1024 ? `${n} o`
  : n < 1048576 ? `${(n / 1024).toFixed(0)} Ko`
  : n < 1073741824 ? `${(n / 1048576).toFixed(1)} Mo`
  : `${(n / 1073741824).toFixed(2)} Go`;

const state = {
  info: null,
  devices: new Map(),      // id → appareil
  selected: "phone",       // "phone" ou id d'un PC
  transfers: new Map(),    // transferId → infos de progression
};

// ------------------------------------------------------------ utilitaires UI

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

let renderQueued = false;
function renderTransfersSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderTransfers(); });
}

// ------------------------------------------------------------ appareils

function renderDevices() {
  const list = $("#devices");
  list.querySelectorAll(".device.pc").forEach((el) => el.remove());
  const devices = [...state.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const d of devices) {
    const li = document.createElement("li");
    li.className = "device pc";
    li.dataset.id = d.id;
    li.innerHTML = `<span class="dev-icon">💻</span>
      <span class="dev-text"><strong>${esc(d.name)}</strong><small>${esc(d.ip)}</small></span>`;
    list.appendChild(li);
  }
  $("#noDevices").hidden = devices.length > 0;
  if (state.selected !== "phone" && !state.devices.has(state.selected)) state.selected = "phone";
  select(state.selected);
}

function select(id) {
  state.selected = id;
  document.querySelectorAll(".device").forEach((el) =>
    el.classList.toggle("selected", el.dataset.id === id));
  const isPhone = id === "phone";
  const device = state.devices.get(id);
  $("#phoneView").hidden = !isPhone;
  $("#pcView").hidden = isPhone || !device;
  $("#emptyView").hidden = isPhone || !!device;
  if (device) $("#targetName").textContent = device.name;
}

$("#devices").addEventListener("click", (e) => {
  const li = e.target.closest(".device");
  if (li) select(li.dataset.id);
});

$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("#addIp").value.trim();
  if (!raw) return;
  const [ip, port] = raw.split(":");
  const msg = $("#addMsg");
  msg.className = "";
  msg.textContent = "Connexion…";
  try {
    const device = await invoke("add_device", { ip, port: port ? Number(port) : null });
    state.devices.set(device.id, device);
    renderDevices();
    select(device.id);
    msg.textContent = `${device.name} ajouté.`;
    $("#addIp").value = "";
  } catch (err) {
    msg.className = "err";
    msg.textContent = String(err);
  }
});

// ------------------------------------------------------------ envoi

async function sendToSelected(paths) {
  const device = state.devices.get(state.selected);
  if (!device || !paths.length) return;
  try {
    await invoke("send_files", { deviceId: device.id, paths });
  } catch (err) {
    toast(String(err));
  }
}

async function shareWithPhone(paths) {
  if (!paths.length) return;
  try {
    renderShared(await invoke("share_for_phone", { paths }));
  } catch (err) {
    toast(String(err));
  }
}

async function pickFiles() {
  const picked = await dialog.open({ multiple: true, directory: false });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

$("#pickForPc").addEventListener("click", async () => sendToSelected(await pickFiles()));
$("#pickForPhone").addEventListener("click", async () => shareWithPhone(await pickFiles()));

function renderShared(files) {
  $("#sharedList").innerHTML = files.map((f) => `
    <li><span class="name">${esc(f.name)}</span><span class="size">${fmtSize(f.size)}</span>
    <button class="ghost tiny" data-unshare="${f.id}">Retirer</button></li>`).join("");
}

$("#sharedList").addEventListener("click", async (e) => {
  const id = e.target.dataset.unshare;
  if (!id) return;
  await invoke("unshare_for_phone", { id });
  renderShared(await invoke("phone_shared"));
});

// Glisser-déposer depuis l'Explorateur : Tauri fournit les vrais chemins.
getCurrentWebview().onDragDropEvent(({ payload }) => {
  const zone = state.selected === "phone" ? $("#phoneDrop") : $("#dropZone");
  if (payload.type === "enter" || payload.type === "over") {
    zone.classList.add("over");
  } else if (payload.type === "leave") {
    zone.classList.remove("over");
  } else if (payload.type === "drop") {
    zone.classList.remove("over");
    if (state.selected === "phone") shareWithPhone(payload.paths);
    else sendToSelected(payload.paths);
  }
});

// ------------------------------------------------------------ demandes entrantes

function showRequest({ requestId, fromName, files, totalSize }) {
  const card = document.createElement("div");
  card.className = "request";
  card.id = `req-${requestId}`;
  const preview = files.slice(0, 8).map((f) => `<li>${esc(f.name)} — ${fmtSize(f.size)}</li>`).join("");
  const more = files.length > 8 ? `<li>… et ${files.length - 8} autre(s)</li>` : "";
  card.innerHTML = `
    <h3>${esc(fromName)} veut vous envoyer ${files.length} fichier${files.length > 1 ? "s" : ""}</h3>
    <div class="timer">${fmtSize(totalSize)} · <span class="left">120</span> s pour répondre</div>
    <ul>${preview}${more}</ul>
    <div class="actions">
      <button data-answer="no">Refuser</button>
      <button class="primary" data-answer="yes">Accepter</button>
    </div>`;
  let left = 120;
  const timer = setInterval(() => {
    left -= 1;
    const el = card.querySelector(".left");
    if (el) el.textContent = Math.max(left, 0);
    if (left <= 0) clearInterval(timer);
  }, 1000);
  card.addEventListener("click", async (e) => {
    const answer = e.target.dataset.answer;
    if (!answer) return;
    clearInterval(timer);
    await invoke("respond_transfer", { requestId, accept: answer === "yes" });
    card.remove();
  });
  $("#requests").appendChild(card);
}

// ------------------------------------------------------------ transferts

function transfer(id, defaults) {
  if (!state.transfers.has(id)) {
    state.transfers.set(id, {
      id, filesDone: 0, fileIndex: 0, fileCount: 1, bytes: 0, total: 0,
      status: "running", error: null, lastPath: null, ...defaults,
    });
  }
  return state.transfers.get(id);
}

function renderTransfers() {
  const items = [...state.transfers.values()].reverse();
  $("#noTransfers").hidden = items.length > 0;
  $("#transferList").innerHTML = items.map((t) => {
    const arrow = t.direction === "send" ? "→" : "←";
    const pct = t.total ? Math.min(100, (100 * t.bytes) / t.total) : 0;
    const count = t.fileCount > 1 ? ` (${Math.min(t.fileIndex + 1, t.fileCount)}/${t.fileCount})` : "";
    let status = "";
    let cls = "";
    if (t.status === "done") {
      cls = "done";
      status = `Terminé · ${t.filesDone} fichier${t.filesDone > 1 ? "s" : ""}`;
      if (t.lastPath) status += ` · <button class="link" data-reveal="${esc(t.lastPath)}">Afficher</button>`;
    } else if (t.status === "failed") {
      cls = "failed"; status = `Échec : ${esc(t.error)}`;
    } else if (t.status === "rejected") {
      cls = "rejected"; status = "Refusé par le destinataire";
    } else if (t.direction === "send" && t.bytes === 0 && t.filesDone === 0) {
      status = "En attente de l'accord du destinataire…";
    }
    return `<li class="transfer ${cls}">
      <div class="line">
        <span class="what">${arrow} <strong>${esc(t.peer)}</strong> · ${esc(t.fileName || "")}${count}</span>
        <span class="meta">${t.total ? `${fmtSize(t.bytes)} / ${fmtSize(t.total)}` : ""}</span>
      </div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      ${status ? `<div class="status">${status}</div>` : ""}
    </li>`;
  }).join("");
}

$("#transferList").addEventListener("click", (e) => {
  const path = e.target.dataset.reveal;
  if (path) invoke("reveal_file", { path }).catch((err) => toast(String(err)));
});

$("#clearDone").addEventListener("click", () => {
  for (const [id, t] of state.transfers) if (t.status !== "running") state.transfers.delete(id);
  renderTransfers();
});

// ------------------------------------------------------------ événements du cœur

listen("navette-event", ({ payload: ev }) => {
  switch (ev.type) {
    case "deviceFound":
      state.devices.set(ev.device.id, ev.device);
      renderDevices();
      break;
    case "deviceLost":
      state.devices.delete(ev.id);
      renderDevices();
      break;
    case "transferRequest":
      showRequest(ev);
      break;
    case "requestClosed":
      $(`#req-${ev.requestId}`)?.remove();
      break;
    case "progress": {
      const t = transfer(ev.transferId, { direction: ev.direction, peer: ev.peer });
      Object.assign(t, {
        fileName: ev.fileName, fileIndex: ev.fileIndex, fileCount: ev.fileCount,
        bytes: ev.bytes, total: ev.total,
      });
      if (t.status !== "running" && t.status !== "done") t.status = "running";
      renderTransfersSoon();
      break;
    }
    case "fileDone": {
      const t = transfer(ev.transferId, { direction: ev.direction, peer: ev.peer });
      t.filesDone += 1;
      t.fileName = ev.fileName;
      if (ev.path) t.lastPath = ev.path;
      renderTransfersSoon();
      break;
    }
    case "transferFinished": {
      const t = transfer(ev.transferId, { direction: ev.direction, peer: ev.peer });
      t.status = "done";
      t.bytes = t.total;
      renderTransfersSoon();
      if (ev.direction === "receive") toast(`Fichiers reçus de ${ev.peer}`);
      break;
    }
    case "transferRejected": {
      const t = transfer(ev.transferId, { direction: "send", peer: ev.peer });
      t.status = "rejected";
      renderTransfersSoon();
      break;
    }
    case "transferFailed": {
      const t = transfer(ev.transferId, { direction: ev.direction, peer: ev.peer });
      t.status = "failed";
      t.error = ev.error;
      renderTransfersSoon();
      break;
    }
  }
});

// ------------------------------------------------------------ démarrage

async function refreshInfo() {
  const info = await invoke("get_info");
  state.info = info;
  $("#me").textContent = `${info.name} · ${info.ip}:${info.port}`;
  $("#qr").innerHTML = info.phoneQrSvg;
  $("#phoneUrl").textContent = info.phoneUrl;
  const chip = $("#discovery");
  chip.className = `chip ${info.discoveryActive ? "ok" : "off"}`;
  chip.textContent = info.discoveryActive ? "Visible sur le réseau" : "Découverte indisponible";
  $("#changeFolder").title = `Dossier de réception : ${info.downloadDir}`;
}

$("#openFolder").addEventListener("click", () =>
  invoke("open_download_dir").catch((err) => toast(String(err))));

$("#changeFolder").addEventListener("click", async () => {
  const dir = await dialog.open({ directory: true, multiple: false });
  if (!dir) return;
  try {
    await invoke("set_download_dir", { path: dir });
    await refreshInfo();
    toast(`Les fichiers reçus iront dans ${dir}`);
  } catch (err) {
    toast(String(err));
  }
});

(async () => {
  await refreshInfo();
  for (const d of await invoke("list_devices")) state.devices.set(d.id, d);
  renderDevices();
  renderShared(await invoke("phone_shared"));
  renderTransfers();
})();
