// Types de l'API exposée par electron/preload.js sur `window.navette`.

export type Device = { id: string; name: string; ip: string; port: number };
export type FileMeta = { name: string; size: number };
export type SharedFile = { id: string; name: string; size: number };
export type Direction = "send" | "receive";

export type NodeInfo = {
  id: string;
  name: string;
  ip: string;
  port: number;
  addresses: string[];
  phoneUrl: string;
  phoneQrSvg: string;
  downloadDir: string;
  discoveryActive: boolean;
};

export type NavetteEvent =
  | { type: "deviceFound"; device: Device }
  | { type: "deviceLost"; id: string }
  | { type: "transferRequest"; requestId: string; fromName: string; files: FileMeta[]; totalSize: number }
  | { type: "requestClosed"; requestId: string }
  | {
      type: "progress";
      transferId: string;
      direction: Direction;
      peer: string;
      fileName: string;
      fileIndex: number;
      fileCount: number;
      bytes: number;
      total: number;
    }
  | { type: "fileDone"; transferId: string; direction: Direction; peer: string; fileName: string; path: string | null }
  | { type: "transferFinished"; transferId: string; direction: Direction; peer: string }
  | { type: "transferRejected"; transferId: string; peer: string }
  | { type: "transferFailed"; transferId: string; direction: Direction; peer: string; error: string };

export type UpdateInfo = { version: string; notes: string | null };
export type UpdateProgress = { percent: number; transferred: number; total: number; bytesPerSecond: number };

type Unsubscribe = () => void;

export type NavetteApi = {
  info(): Promise<NodeInfo>;
  devices(): Promise<Device[]>;
  addDevice(ip: string, port?: number): Promise<Device>;
  sendFiles(deviceId: string, paths: string[]): Promise<void>;
  respond(requestId: string, accept: boolean): Promise<boolean>;
  shareForPhone(paths: string[]): Promise<SharedFile[]>;
  phoneShared(): Promise<SharedFile[]>;
  unshareForPhone(id: string): Promise<SharedFile[]>;
  pickFiles(): Promise<string[]>;
  pickDownloadDir(): Promise<string | null>;
  openDownloadDir(): Promise<void>;
  revealFile(path: string): Promise<void>;
  version(): Promise<string>;
  pathForFile(file: File): string;
  onEvent(cb: (ev: NavetteEvent) => void): Unsubscribe;
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximized(cb: (max: boolean) => void): Unsubscribe;
  };
  update: {
    check(): Promise<UpdateInfo | null>;
    install(): Promise<void>;
    onProgress(cb: (p: UpdateProgress) => void): Unsubscribe;
    onReady(cb: () => void): Unsubscribe;
    onError(cb: (message: string) => void): Unsubscribe;
  };
};

declare global {
  interface Window {
    navette?: NavetteApi;
  }
}

/** L'API Electron, ou une erreur claire si la page est ouverte hors de l'app. */
export function api(): NavetteApi {
  if (!window.navette) throw new Error("Navette doit être lancée depuis l'application (npm run dev ou l'installateur).");
  return window.navette;
}

export const fmtSize = (n: number) =>
  n < 1024
    ? `${n} o`
    : n < 1048576
      ? `${(n / 1024).toFixed(0)} Ko`
      : n < 1073741824
        ? `${(n / 1048576).toFixed(1)} Mo`
        : `${(n / 1073741824).toFixed(2)} Go`;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
