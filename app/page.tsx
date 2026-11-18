"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorText,
  type Device,
  type NavetteEvent,
  type NodeInfo,
  type SharedFile,
  type UpdateInfo,
  type UpdateProgress,
} from "@/lib/navette";
import TitleBar from "./components/TitleBar";
import Sidebar from "./components/Sidebar";
import { PcView, PhoneView } from "./components/Views";
import Transfers, { type Transfer } from "./components/Transfers";
import { Background, RequestCard, UpdateCard, type IncomingRequest } from "./components/Overlays";

const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000; // toutes les 6 heures

export default function Home() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [info, setInfo] = useState<NodeInfo | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState("phone");
  const [shared, setShared] = useState<SharedFile[]>([]);
  const [transfers, setTransfers] = useState<Map<string, Transfer>>(new Map());
  const [requests, setRequests] = useState<IncomingRequest[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateStage, setUpdateStage] = useState<"idle" | "downloading" | "installing" | "error">("idle");
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showToast = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  // ---------------------------------------------------------------- démarrage
  useEffect(() => {
    let n: ReturnType<typeof api>;
    try {
      n = api();
    } catch (e) {
      setFatal(errorText(e));
      return;
    }
    setReady(true);
    n.info().then(setInfo);
    n.devices().then(setDevices);
    n.phoneShared().then(setShared);
    n.version().then(setVersion);
  }, []);

  // ---------------------------------------------------------------- événements du cœur
  useEffect(() => {
    if (!ready) return;
    const n = api();
    const patch = (id: string, defaults: Partial<Transfer>, change: (t: Transfer) => Partial<Transfer>) =>
      setTransfers((prev) => {
        const next = new Map(prev);
        const base: Transfer = next.get(id) ?? {
          id, direction: "receive", peer: "", fileName: "", fileIndex: 0, fileCount: 1,
          bytes: 0, total: 0, filesDone: 0, status: "running", error: null, lastPath: null, ...defaults,
        };
        next.set(id, { ...base, ...change(base) });
        return next;
      });

    return n.onEvent((ev: NavetteEvent) => {
      switch (ev.type) {
        case "deviceFound":
          setDevices((prev) =>
            [...prev.filter((d) => d.id !== ev.device.id), ev.device].sort((a, b) => a.name.localeCompare(b.name, "fr")),
          );
          break;
        case "deviceLost":
          setDevices((prev) => prev.filter((d) => d.id !== ev.id));
          setSelected((s) => (s === ev.id ? "phone" : s));
          break;
        case "transferRequest":
          setRequests((prev) => [...prev, { ...ev, receivedAt: Date.now() }]);
          break;
        case "requestClosed":
          setRequests((prev) => prev.filter((r) => r.requestId !== ev.requestId));
          break;
        case "progress":
          patch(ev.transferId, { direction: ev.direction, peer: ev.peer }, (t) => ({
            fileName: ev.fileName, fileIndex: ev.fileIndex, fileCount: ev.fileCount, bytes: ev.bytes, total: ev.total,
            status: t.status === "done" ? "done" : "running",
          }));
          break;
        case "fileDone":
          patch(ev.transferId, { direction: ev.direction, peer: ev.peer }, (t) => ({
            filesDone: t.filesDone + 1, fileName: ev.fileName, lastPath: ev.path ?? t.lastPath,
          }));
          break;
        case "transferFinished":
          patch(ev.transferId, { direction: ev.direction, peer: ev.peer }, (t) => ({ status: "done", bytes: t.total }));
          if (ev.direction === "receive") showToast(`Fichiers reçus de ${ev.peer}`);
          break;
        case "transferRejected":
          patch(ev.transferId, { direction: "send", peer: ev.peer }, () => ({ status: "rejected" }));
          break;
        case "transferFailed":
          patch(ev.transferId, { direction: ev.direction, peer: ev.peer }, () => ({ status: "failed", error: ev.error }));
          break;
      }
    });
  }, [ready, showToast]);

  // Les ondes du fond s'accélèrent tant qu'un transfert est en cours.
  const busy = [...transfers.values()].some((t) => t.status === "running");
  useEffect(() => {
    document.body.classList.toggle("busy", busy);
  }, [busy]);

  // ---------------------------------------------------------------- mises à jour
  const checkUpdate = useCallback(
    async (manual: boolean) => {
      setChecking(true);
      try {
        const found = await api().update.check();
        setUpdate(found);
        if (manual) {
          if (found) setUpdateOpen(true);
          else showToast("Navette est à jour.");
        }
      } catch (e) {
        if (manual) showToast(`Vérification impossible : ${errorText(e)}`);
      } finally {
        setChecking(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    if (!ready) return;
    const u = api().update;
    const offs = [
      u.onProgress(setUpdateProgress),
      u.onReady(() => setUpdateStage("installing")),
      u.onError((message) => {
        setUpdateError(message);
        setUpdateStage((s) => (s === "idle" ? s : "error"));
      }),
    ];
    const first = setTimeout(() => checkUpdate(false), 3000);
    const every = setInterval(() => checkUpdate(false), UPDATE_RECHECK_MS);
    return () => {
      offs.forEach((off) => off());
      clearTimeout(first);
      clearInterval(every);
    };
  }, [ready, checkUpdate]);

  async function installUpdate() {
    setUpdateError(null);
    setUpdateProgress(null);
    setUpdateStage("downloading");
    try {
      await api().update.install();
    } catch (e) {
      setUpdateError(errorText(e));
      setUpdateStage("error");
    }
  }

  // ---------------------------------------------------------------- actions
  const device = devices.find((d) => d.id === selected) ?? null;
  const isPhone = selected === "phone" || !device;

  const sendTo = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      try {
        if (isPhone) setShared(await api().shareForPhone(paths));
        else await api().sendFiles(device!.id, paths);
      } catch (e) {
        showToast(errorText(e));
      }
    },
    [isPhone, device, showToast],
  );

  async function pick() {
    sendTo(await api().pickFiles());
  }

  async function changeFolder() {
    try {
      const dir = await api().pickDownloadDir();
      if (!dir) return;
      setInfo(await api().info());
      showToast(`Les fichiers reçus iront dans ${dir}`);
    } catch (e) {
      showToast(errorText(e));
    }
  }

  async function answer(requestId: string, accept: boolean) {
    setRequests((prev) => prev.filter((r) => r.requestId !== requestId));
    await api().respond(requestId, accept).catch(() => {});
  }

  // Glisser-déposer depuis l'Explorateur, n'importe où dans la fenêtre.
  useEffect(() => {
    if (!ready) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragOver(true);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      sendTo(files.map((f) => api().pathForFile(f)).filter(Boolean));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [ready, sendTo]);

  if (fatal) {
    return (
      <>
        <Background />
        <main className="fatal glass"><p>{fatal}</p></main>
      </>
    );
  }

  return (
    <>
      <Background />
      <TitleBar
        info={info}
        update={update}
        onOpenUpdate={() => setUpdateOpen(true)}
        onOpenFolder={() => api().openDownloadDir().catch((e) => showToast(errorText(e)))}
        onChangeFolder={changeFolder}
      />

      <main className="layout">
        <Sidebar
          devices={devices}
          selected={isPhone ? "phone" : selected}
          onSelect={setSelected}
          onAdded={(d) => {
            setDevices((prev) => [...prev.filter((x) => x.id !== d.id), d]);
            setSelected(d.id);
          }}
          version={version}
          checking={checking}
          onCheckUpdate={() => checkUpdate(true)}
        />
        <section className="stage">
          {isPhone ? (
            <PhoneView
              info={info}
              shared={shared}
              dragOver={dragOver}
              onPick={pick}
              onUnshare={async (id) => setShared(await api().unshareForPhone(id))}
            />
          ) : (
            <PcView device={device!} dragOver={dragOver} onPick={pick} />
          )}
          <Transfers
            transfers={[...transfers.values()]}
            onClear={() => setTransfers((prev) => new Map([...prev].filter(([, t]) => t.status === "running")))}
            onReveal={(p) => api().revealFile(p).catch((e) => showToast(errorText(e)))}
          />
        </section>
      </main>

      <div className="requests">
        {requests.map((r) => (
          <RequestCard key={r.requestId} req={r} onAnswer={(accept) => answer(r.requestId, accept)} />
        ))}
      </div>

      {update && updateOpen && (
        <UpdateCard
          update={update}
          currentVersion={version}
          stage={updateStage}
          progress={updateProgress}
          error={updateError}
          onInstall={installUpdate}
          onClose={() => setUpdateOpen(false)}
        />
      )}

      {toast && <div className="toast glass" role="status">{toast}</div>}
    </>
  );
}
