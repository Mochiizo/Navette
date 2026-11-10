//! Couche Tauri : démarre le cœur réseau, expose des commandes à l'interface
//! et relaie les événements du cœur vers la fenêtre.

use std::path::PathBuf;
use std::sync::Arc;

use navette_core::{Config, Device, Node, NodeInfo, SharedFile, DEFAULT_PORT};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::broadcast::error::RecvError;

/// Nom de l'événement écouté côté interface.
const EVENT_NAME: &str = "navette-event";

struct AppState(Arc<Node>);

/// Réglages gardés entre deux lancements, dans
/// %APPDATA%\app.navette.desktop\settings.json sous Windows.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    download_dir: Option<PathBuf>,
}

impl Settings {
    fn file(app: &tauri::AppHandle) -> Option<PathBuf> {
        app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
    }

    fn load(app: &tauri::AppHandle) -> Settings {
        Self::file(app)
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self, app: &tauri::AppHandle) -> std::io::Result<()> {
        let file = Self::file(app)
            .ok_or_else(|| std::io::Error::other("dossier de configuration introuvable"))?;
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(file, serde_json::to_string_pretty(self)?)
    }
}

type CmdResult<T> = Result<T, String>;

fn to_err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[tauri::command]
fn get_info(state: State<'_, AppState>) -> NodeInfo {
    state.0.info()
}

#[tauri::command]
fn list_devices(state: State<'_, AppState>) -> Vec<Device> {
    state.0.devices()
}

#[tauri::command]
async fn add_device(state: State<'_, AppState>, ip: String, port: Option<u16>) -> CmdResult<Device> {
    state
        .0
        .add_device_by_address(ip.trim(), port.unwrap_or(DEFAULT_PORT))
        .await
        .map_err(to_err)
}

#[tauri::command]
async fn send_files(
    state: State<'_, AppState>,
    device_id: String,
    paths: Vec<String>,
) -> CmdResult<()> {
    let paths = paths.into_iter().map(PathBuf::from).collect();
    state.0.send_files(&device_id, paths).await.map_err(to_err)
}

#[tauri::command]
fn respond_transfer(state: State<'_, AppState>, request_id: String, accept: bool) -> bool {
    state.0.respond(&request_id, accept)
}

#[tauri::command]
fn share_for_phone(state: State<'_, AppState>, paths: Vec<String>) -> CmdResult<Vec<SharedFile>> {
    let paths = paths.into_iter().map(PathBuf::from).collect();
    state.0.share_for_phone(paths).map_err(to_err)
}

#[tauri::command]
fn phone_shared(state: State<'_, AppState>) -> Vec<SharedFile> {
    state.0.phone_shared()
}

#[tauri::command]
fn unshare_for_phone(state: State<'_, AppState>, id: String) {
    state.0.unshare_for_phone(&id)
}

#[tauri::command]
fn set_download_dir(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> CmdResult<String> {
    let dir = PathBuf::from(&path);
    state.0.set_download_dir(dir.clone()).map_err(to_err)?;
    // Mémorisé pour les prochains lancements.
    let mut settings = Settings::load(&app);
    settings.download_dir = Some(dir);
    settings.save(&app).map_err(|e| format!("réglage non enregistré : {e}"))?;
    Ok(path)
}

#[tauri::command]
fn open_download_dir(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let dir = state.0.download_dir().display().to_string();
    app.opener()
        .open_path(dir, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_file(app: tauri::AppHandle, path: String) -> CmdResult<()> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Dossier choisi par l'utilisateur s'il existe encore,
            // sinon directement le dossier Téléchargements de Windows.
            let saved = Settings::load(app.handle())
                .download_dir
                .filter(|dir| dir.is_dir());
            let download_dir = match saved {
                Some(dir) => dir,
                None => app
                    .path()
                    .download_dir()
                    .or_else(|_| app.path().home_dir())?,
            };
            let config = Config::new(download_dir);

            let node = Arc::new(tauri::async_runtime::block_on(Node::start(config))?);
            eprintln!("Navette prête · page téléphone : {}", node.info().phone_url);

            // Relais des événements du cœur vers l'interface.
            let mut events = node.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            let _ = handle.emit(EVENT_NAME, &event);
                        }
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => break,
                    }
                }
            });

            app.manage(AppState(node));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_info,
            list_devices,
            add_device,
            send_files,
            respond_transfer,
            share_for_phone,
            phone_shared,
            unshare_for_phone,
            set_download_dir,
            open_download_dir,
            reveal_file,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Navette");
}
