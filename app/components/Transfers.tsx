"use client";

import { fmtSize, type Direction } from "@/lib/navette";

export type Transfer = {
  id: string;
  direction: Direction;
  peer: string;
  fileName: string;
  fileIndex: number;
  fileCount: number;
  bytes: number;
  total: number;
  filesDone: number;
  status: "running" | "done" | "failed" | "rejected";
  error: string | null;
  lastPath: string | null;
};

type Props = { transfers: Transfer[]; onClear: () => void; onReveal: (path: string) => void };

export default function Transfers({ transfers, onClear, onReveal }: Props) {
  const items = [...transfers].reverse();
  return (
    <div className="transfers glass">
      <div className="transfers-head">
        <h2>Transferts</h2>
        <button className="tiny" onClick={onClear}>Effacer les terminés</button>
      </div>
      {items.length === 0 ? (
        <p className="hint">Aucun transfert pour l&apos;instant.</p>
      ) : (
        <ul className="transfer-list">
          {items.map((t) => {
            const pct = t.total ? Math.min(100, (100 * t.bytes) / t.total) : 0;
            const count = t.fileCount > 1 ? ` (${Math.min(t.fileIndex + 1, t.fileCount)}/${t.fileCount})` : "";
            const waiting = t.status === "running" && t.direction === "send" && t.bytes === 0 && t.filesDone === 0;
            return (
              <li key={t.id} className={`transfer ${t.status === "running" ? "" : t.status}`}>
                <div className="line">
                  <span className="what">
                    {t.direction === "send" ? "→" : "←"} <strong>{t.peer}</strong> · {t.fileName}
                    {count}
                  </span>
                  <span className="meta">{t.total ? `${fmtSize(t.bytes)} / ${fmtSize(t.total)}` : ""}</span>
                </div>
                <div className="bar"><i style={{ width: `${pct.toFixed(1)}%` }} /></div>
                {t.status === "done" && (
                  <div className="status">
                    Terminé · {t.filesDone} fichier{t.filesDone > 1 ? "s" : ""}
                    {t.lastPath && (
                      <>
                        {" · "}
                        <button className="link" onClick={() => onReveal(t.lastPath!)}>Afficher</button>
                      </>
                    )}
                  </div>
                )}
                {t.status === "failed" && <div className="status">Échec : {t.error}</div>}
                {t.status === "rejected" && <div className="status">Refusé par le destinataire</div>}
                {waiting && <div className="status">En attente de l&apos;accord du destinataire…</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
