// Mises à jour depuis les Releases GitHub (electron-updater).
// L'interface demande une vérification au démarrage ; si une version plus
// récente existe, l'utilisateur clique « Mettre à jour » : téléchargement,
// installation silencieuse puis redémarrage de Navette.

const { autoUpdater } = require("electron-updater");

function setupUpdater({ send, isDev, handle }) {
  autoUpdater.autoDownload = false; // on attend le clic de l'utilisateur
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  // Pour tester la mise à jour en développement : un dossier servi en HTTP
  // qui contient un latest.yml (voir README, « Tester la mise à jour »).
  const testUrl = process.env.NAVETTE_UPDATE_TEST_URL;
  if (testUrl) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: "generic", url: testUrl });
  }

  autoUpdater.on("download-progress", (p) =>
    send("navette:update-progress", { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }),
  );
  autoUpdater.on("update-downloaded", () => {
    send("navette:update-ready", null);
    // isSilent = true : l'installateur s'exécute sans fenêtre ;
    // isForceRunAfter = true : Navette se relance à la fin.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 800);
  });
  autoUpdater.on("error", (e) => send("navette:update-error", e?.message ?? String(e)));

  /** Renvoie { version, notes } si une mise à jour existe, sinon null. */
  handle("update:check", async () => {
    if (isDev && !testUrl) return null; // pas de mise à jour en développement
    const result = await autoUpdater.checkForUpdates();
    if (!result?.isUpdateAvailable) return null;
    const info = result.updateInfo;
    const notes = Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((n) => n.note).join("\n")
      : info.releaseNotes ?? null;
    return { version: info.version, notes: stripHtml(notes) };
  });

  handle("update:install", async () => {
    await autoUpdater.downloadUpdate();
  });
}

/** GitHub renvoie les notes en HTML : on garde le texte. */
function stripHtml(html) {
  if (!html) return null;
  return (
    String(html)
      .replace(/<li>/gi, "• ")
      .replace(/<\/(p|li|h\d|ul|ol)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || null
  );
}

module.exports = { setupUpdater };
