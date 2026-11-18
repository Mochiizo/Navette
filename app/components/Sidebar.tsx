"use client";

import { useState, type FormEvent } from "react";
import { api, errorText, type Device } from "@/lib/navette";
import { IconPc, IconPhone, IconRefresh } from "./icons";

type Props = {
  devices: Device[];
  selected: string;
  onSelect: (id: string) => void;
  onAdded: (device: Device) => void;
  version: string;
  checking: boolean;
  onCheckUpdate: () => void;
};

export default function Sidebar({ devices, selected, onSelect, onAdded, version, checking, onCheckUpdate }: Props) {
  const [address, setAddress] = useState("");
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    const raw = address.trim();
    if (!raw) return;
    const [ip, port] = raw.split(":");
    setMsg({ text: "Connexion…" });
    try {
      const device = await api().addDevice(ip, port ? Number(port) : undefined);
      onAdded(device);
      setMsg({ text: `${device.name} ajouté.` });
      setAddress("");
    } catch (err) {
      setMsg({ text: errorText(err), error: true });
    }
  }

  return (
    <aside className="sidebar glass">
      <h2>Appareils</h2>
      <ul className="devices">
        <li>
          <button className={`device ${selected === "phone" ? "selected" : ""}`} onClick={() => onSelect("phone")}>
            <span className="dev-icon"><IconPhone /></span>
            <span className="dev-text"><strong>Téléphone</strong><small>Via QR code, sans app</small></span>
          </button>
        </li>
        {devices.map((d) => (
          <li key={d.id}>
            <button className={`device ${selected === d.id ? "selected" : ""}`} onClick={() => onSelect(d.id)}>
              <span className="dev-icon"><IconPc /></span>
              <span className="dev-text"><strong>{d.name}</strong><small>{d.ip}</small></span>
            </button>
          </li>
        ))}
      </ul>
      {devices.length === 0 && (
        <p className="hint no-devices">Aucun autre ordinateur détecté. Lancez Navette sur un PC connecté au même Wi-Fi.</p>
      )}

      <form className="add-form glass-soft" onSubmit={add}>
        <label htmlFor="addIp">Ajouter un PC par adresse IP</label>
        <div className="row">
          <input
            id="addIp"
            placeholder="192.168.1.20"
            autoComplete="off"
            spellCheck={false}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <button type="submit">Ajouter</button>
        </div>
        <small className={msg?.error ? "err" : ""}>{msg?.text ?? ""}</small>
      </form>

      <div className="version-row">
        <span>Navette {version ? `v${version}` : ""}</span>
        <button className="tiny" onClick={onCheckUpdate} disabled={checking} title="Rechercher une mise à jour">
          <IconRefresh className={`icon ${checking ? "spin" : ""}`} />
          {checking ? "Recherche…" : "Mises à jour"}
        </button>
      </div>
    </aside>
  );
}
