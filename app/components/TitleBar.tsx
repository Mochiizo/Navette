"use client";

import { useEffect, useState } from "react";
import { api, type NodeInfo, type UpdateInfo } from "@/lib/navette";
import { IconFolder, IconSparkle, LogoMark } from "./icons";

type Props = {
  info: NodeInfo | null;
  update: UpdateInfo | null;
  onOpenUpdate: () => void;
  onOpenFolder: () => void;
  onChangeFolder: () => void;
};

/** Barre de titre intégrée : on déplace la fenêtre en tirant dessus (CSS app-region). */
export default function TitleBar({ info, update, onOpenUpdate, onOpenFolder, onChangeFolder }: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const w = api().window;
    w.isMaximized().then(setMaximized);
    return w.onMaximized(setMaximized);
  }, []);

  return (
    <header className="topbar glass">
      <div className="brand">
        <div className="logo" aria-hidden="true">
          <LogoMark />
        </div>
        <div>
          <h1>Navette</h1>
          <p>{info ? `${info.name} · ${info.ip}:${info.port}` : "Démarrage…"}</p>
        </div>
      </div>
      <div className="spacer" />
      <div className="top-actions">
        {update && (
          <button className="update-btn" onClick={onOpenUpdate} title={`Navette ${update.version} est disponible`}>
            <IconSparkle />
            Mise à jour
            <span className="update-dot" aria-hidden="true" />
          </button>
        )}
        <span className={`chip glass-soft ${info ? (info.discoveryActive ? "ok" : "off") : ""}`}>
          {info ? (info.discoveryActive ? "Visible sur le réseau" : "Découverte indisponible") : "…"}
        </span>
        <button onClick={onOpenFolder} title={info ? `Dossier de réception : ${info.downloadDir}` : undefined}>
          <IconFolder />
          Fichiers reçus
        </button>
        <button onClick={onChangeFolder} title="Changer le dossier de réception">
          Changer…
        </button>
      </div>
      <div className="win-controls">
        <button onClick={() => api().window.minimize()} title="Réduire" aria-label="Réduire">
          <svg viewBox="0 0 10 10"><path d="M0 5h10" /></svg>
        </button>
        <button
          onClick={() => api().window.toggleMaximize()}
          title={maximized ? "Restaurer" : "Agrandir"}
          aria-label={maximized ? "Restaurer" : "Agrandir"}
        >
          {maximized ? (
            <svg viewBox="0 0 10 10"><rect x=".5" y="2.5" width="7" height="7" /><path d="M2.5 2.5V.5h7v7h-2" /></svg>
          ) : (
            <svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" /></svg>
          )}
        </button>
        <button className="close" onClick={() => api().window.close()} title="Fermer" aria-label="Fermer">
          <svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0 0 10" /></svg>
        </button>
      </div>
    </header>
  );
}
