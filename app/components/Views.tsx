"use client";

import type { Device, NodeInfo, SharedFile } from "@/lib/navette";
import { fmtSize } from "@/lib/navette";
import { FileIcon, IconUpload } from "./icons";

export function PcView({ device, dragOver, onPick }: { device: Device; dragOver: boolean; onPick: () => void }) {
  return (
    <div className="view pc-view glass">
      <div className={`dropzone main-drop ${dragOver ? "over" : ""}`}>
        <div className="drop-art"><IconUpload /></div>
        <p className="drop-title">Glissez des fichiers ici</p>
        <p className="drop-sub">pour les envoyer à <strong>{device.name}</strong></p>
        <button className="primary big" onClick={onPick}>Choisir des fichiers</button>
      </div>
    </div>
  );
}

type PhoneProps = {
  info: NodeInfo | null;
  shared: SharedFile[];
  dragOver: boolean;
  onPick: () => void;
  onUnshare: (id: string) => void;
};

export function PhoneView({ info, shared, dragOver, onPick, onUnshare }: PhoneProps) {
  return (
    <div className="view phone-grid">
      <div className="qr-card glass">
        <div className="qr-wrap">
          <div className="qr-ring" aria-hidden="true" />
          <div
            className="qr"
            role="img"
            aria-label="QR code de connexion du téléphone"
            // SVG généré localement par la bibliothèque qrcode.
            dangerouslySetInnerHTML={{ __html: info?.phoneQrSvg ?? "" }}
          />
        </div>
        <h3>Scannez avec l&apos;appareil photo</h3>
        <ol className="steps">
          <li><span>Connectez le téléphone au <strong>même Wi-Fi</strong>.</span></li>
          <li><span>Visez le QR code et touchez le lien.</span></li>
          <li><span>Envoyez photos et vidéos depuis la page.</span></li>
        </ol>
        <p className="url"><code>{info?.phoneUrl ?? ""}</code></p>
      </div>
      <div className="share-card glass">
        <div>
          <h3>Envoyer vers le téléphone</h3>
          <p className="hint">Les fichiers ajoutés ici apparaissent sur la page du téléphone, prêts à télécharger.</p>
        </div>
        <div className={`dropzone phone-drop ${dragOver ? "over" : ""}`}>
          <IconUpload />
          <p>Glissez des fichiers ici ou</p>
          <button className="primary" onClick={onPick}>Choisir des fichiers</button>
        </div>
        <ul className="shared">
          {shared.map((f) => (
            <li key={f.id}>
              <span className="file-ico"><FileIcon name={f.name} /></span>
              <span className="name">{f.name}</span>
              <span className="size">{fmtSize(f.size)}</span>
              <button className="tiny" onClick={() => onUnshare(f.id)}>Retirer</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
