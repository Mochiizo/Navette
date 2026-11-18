/** @type {import('next').NextConfig} */
const nextConfig = {
  // Export statique : l'interface est un simple dossier `out/` chargé par Electron.
  output: "export",
  images: { unoptimized: true },
  devIndicators: false,
};

export default nextConfig;
