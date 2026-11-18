// Icônes en traits SVG (couleur = currentColor).

type Props = { className?: string };

function Svg({ children, className = "icon" }: Props & { children: React.ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export const LogoMark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 9h12m-3-3 3 3-3 3M19 15H7m3 3-3-3 3-3" />
  </svg>
);
export const IconPhone = (p: Props) => (
  <Svg {...p}><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M11 18h2" /></Svg>
);
export const IconPc = (p: Props) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Svg>
);
export const IconFolder = (p: Props) => (
  <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>
);
export const IconUpload = (p: Props) => (
  <Svg {...p}><path d="M12 15V3m0 0-4 4m4-4 4 4" /><path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" /></Svg>
);
export const IconDownload = (p: Props) => (
  <Svg {...p}><path d="M12 3v12m0 0-4-4m4 4 4-4" /><path d="M4 17v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1" /></Svg>
);
export const IconFile = (p: Props) => (
  <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Svg>
);
export const IconImage = (p: Props) => (
  <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></Svg>
);
export const IconVideo = (p: Props) => (
  <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3z" /></Svg>
);
export const IconRefresh = (p: Props) => (
  <Svg {...p}><path d="M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4" /></Svg>
);
export const IconSparkle = (p: Props) => (
  <Svg {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></Svg>
);

export function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg"].includes(ext)) return <IconImage />;
  if (["mp4", "mov", "mkv", "avi", "webm", "m4v", "hevc"].includes(ext)) return <IconVideo />;
  return <IconFile />;
}
