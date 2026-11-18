import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Navette",
  description: "Transfert de fichiers en réseau local : PC ⇄ PC et PC ⇄ téléphone",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
