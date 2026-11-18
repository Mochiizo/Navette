"use client";

import { useEffect, useState } from "react";
import { fmtSize, type FileMeta, type UpdateInfo, type UpdateProgress } from "@/lib/navette";
import { IconDownload, IconSparkle } from "./icons";

export type IncomingRequest = { requestId: string; fromName: string; files: FileMeta[]; totalSize: number; receivedAt: number };

/** Carte « X veut vous envoyer N fichiers », 120 s pour répondre. */
export function RequestCard({ req, onAnswer }: { req: IncomingRequest; onAnswer: (accept: boolean) => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, 120 - Math.floor((now - req.receivedAt) / 1000));
  const n = req.files.length;
  return (
    <div className="request glass">
      <div className="req-head">
        <span className="req-ico"><IconDownload /></span>
        <div>
          <h3>{req.fromName} veut vous envoyer {n} fichier{n > 1 ? "s" : ""}</h3>
          <div className="timer">{fmtSize(req.totalSize)} · {left} s pour répondre</div>
        </div>
      </div>
      <ul>
        {req.files.slice(0, 8).map((f, i) => (
          <li key={i}>{f.name} — {fmtSize(f.size)}</li>
        ))}
        {n > 8 && <li>… et {n - 8} autre(s)</li>}
      </ul>
      <div className="actions">
        <button onClick={() => onAnswer(false)}>Refuser</button>
        <button className="primary" onClick={() => onAnswer(true)}>Accepter</button>
      </div>
    </div>
  );
}

type UpdateCardProps = {
  update: UpdateInfo;
  currentVersion: string;
  stage: "idle" | "downloading" | "installing" | "error";
  progress: UpdateProgress | null;
  error: string | null;
  onInstall: () => void;
  onClose: () => void;
};

/** Fenêtre de mise à jour : notes de version, puis progression du téléchargement. */
export function UpdateCard({ update, currentVersion, stage, progress, error, onInstall, onClose }: UpdateCardProps) {
  const busy = stage === "downloading" || stage === "installing";
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="update-card glass" role="dialog" aria-modal="true" aria-labelledby="update-title" onClick={(e) => e.stopPropagation()}>
        <div className="req-head">
          <span className="req-ico accent"><IconSparkle /></span>
          <div>
            <h3 id="update-title">Navette {update.version} est disponible</h3>
            <div className="timer">Version installée : {currentVersion || "?"}</div>
          </div>
        </div>
        {update.notes && <div className="notes">{update.notes}</div>}

        {stage === "downloading" && (
          <div className="update-progress">
            <div className="bar"><i style={{ width: `${(progress?.percent ?? 0).toFixed(1)}%` }} /></div>
            <span className="meta">
              {progress ? `${fmtSize(progress.transferred)} / ${fmtSize(progress.total)} · ${fmtSize(progress.bytesPerSecond)}/s` : "Téléchargement…"}
            </span>
          </div>
        )}
        {stage === "installing" && <p className="hint">Installation… Navette va redémarrer toute seule.</p>}
        {stage === "error" && <p className="error-text">La mise à jour a échoué : {error}</p>}

        <div className="actions">
          <button onClick={onClose} disabled={busy}>Plus tard</button>
          <button className="primary" onClick={onInstall} disabled={busy}>
            {stage === "error" ? "Réessayer" : busy ? "Mise à jour…" : "Mettre à jour"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Background() {
  return (
    <div className="bg" aria-hidden="true">
      <div className="bg-dots" />
      <div className="bg-src">
        <span className="wave" />
        <span className="wave w2" />
        <span className="wave w3" />
        <span className="wave w4" />
        <span className="bg-core" />
      </div>
      <div className="bg-grain" />
    </div>
  );
}
