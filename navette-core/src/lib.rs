//! Cœur réseau de Navette : découverte des appareils sur le réseau local,
//! serveur HTTP de réception, envoi de fichiers vers un autre PC et
//! page web pour les téléphones (via QR code).
//!
//! Cette crate ne dépend pas de Tauri : on peut la tester seule
//! (`cargo test -p navette-core`) et la réutiliser ailleurs (CLI, service…).

mod client;
mod discovery;
mod files;
mod server;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot};

pub use discovery::SERVICE_TYPE;

/// Port par défaut. Si occupé, un port libre est choisi automatiquement.
pub const DEFAULT_PORT: u16 = 53_420;

/// Un autre ordinateur qui fait tourner Navette sur le même réseau.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
}

/// Nom et taille d'un fichier annoncé avant un transfert.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub name: String,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Send,
    Receive,
}

/// Fichier que le PC met à disposition des téléphones.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFile {
    pub id: String,
    pub name: String,
    pub size: u64,
    #[serde(skip)]
    pub path: PathBuf,
}

/// Informations affichées dans l'interface (nom, adresse, QR code…).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub phone_url: String,
    pub phone_qr_svg: String,
    pub download_dir: String,
    pub discovery_active: bool,
}

/// Tout ce qui se passe dans le cœur est publié sous forme d'événements.
/// L'app Tauri les relaie à l'interface.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    DeviceFound {
        device: Device,
    },
    DeviceLost {
        id: String,
    },
    /// Un autre PC veut nous envoyer des fichiers : il faut accepter ou refuser.
    TransferRequest {
        request_id: String,
        from_name: String,
        files: Vec<FileMeta>,
        total_size: u64,
    },
    /// La demande a expiré ou a reçu une réponse : retirer la carte de l'écran.
    RequestClosed {
        request_id: String,
    },
    Progress {
        transfer_id: String,
        direction: Direction,
        peer: String,
        file_name: String,
        file_index: usize,
        file_count: usize,
        bytes: u64,
        total: u64,
    },
    FileDone {
        transfer_id: String,
        direction: Direction,
        peer: String,
        file_name: String,
        path: Option<String>,
    },
    TransferFinished {
        transfer_id: String,
        direction: Direction,
        peer: String,
    },
    TransferRejected {
        transfer_id: String,
        peer: String,
    },
    TransferFailed {
        transfer_id: String,
        direction: Direction,
        peer: String,
        error: String,
    },
}

pub struct Config {
    /// Nom affiché sur les autres appareils (par défaut : nom de l'ordinateur).
    pub name: String,
    pub port: u16,
    pub download_dir: PathBuf,
    /// Désactivable pour les tests.
    pub enable_discovery: bool,
}

impl Config {
    pub fn new(download_dir: impl Into<PathBuf>) -> Self {
        Self {
            name: default_device_name(),
            port: DEFAULT_PORT,
            download_dir: download_dir.into(),
            enable_discovery: true,
        }
    }
}

pub fn default_device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "Mon ordinateur".into())
}

/// Transfert accepté en attente des fichiers.
pub(crate) struct Session {
    pub peer: String,
    pub files: Vec<FileMeta>,
    pub received: Vec<bool>,
}

pub(crate) struct Shared {
    pub id: String,
    pub name: String,
    pub port: u16,
    pub phone_token: String,
    pub download_dir: RwLock<PathBuf>,
    pub events: broadcast::Sender<Event>,
    pub pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    pub sessions: Mutex<HashMap<String, Session>>,
    pub shared_files: Mutex<Vec<SharedFile>>,
    pub devices: Mutex<HashMap<String, Device>>,
    pub http: reqwest::Client,
}

impl Shared {
    pub fn emit(&self, event: Event) {
        // Pas d'abonné = pas grave, on ignore l'erreur.
        let _ = self.events.send(event);
    }

    pub fn download_dir(&self) -> PathBuf {
        self.download_dir.read().unwrap().clone()
    }
}

/// Une instance de Navette en cours d'exécution.
pub struct Node {
    shared: Arc<Shared>,
    discovery: Option<discovery::Discovery>,
}

impl Node {
    /// Démarre le serveur de réception et la découverte réseau.
    /// Doit être appelé depuis un runtime Tokio.
    pub async fn start(config: Config) -> Result<Node> {
        tokio::fs::create_dir_all(&config.download_dir)
            .await
            .with_context(|| format!("création de {}", config.download_dir.display()))?;

        let listener = match tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await {
            Ok(l) => l,
            Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", 0)).await?,
        };
        let port = listener.local_addr()?.port();

        let (events, _) = broadcast::channel(512);
        let shared = Arc::new(Shared {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name: config.name,
            port,
            phone_token: uuid::Uuid::new_v4().simple().to_string(),
            download_dir: RwLock::new(config.download_dir),
            events,
            pending: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            shared_files: Mutex::new(Vec::new()),
            devices: Mutex::new(HashMap::new()),
            http: reqwest::Client::new(),
        });

        let app = server::router(shared.clone());
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!("serveur arrêté : {e}");
            }
        });

        let discovery = if config.enable_discovery {
            match discovery::Discovery::start(shared.clone()) {
                Ok(d) => Some(d),
                Err(e) => {
                    tracing::warn!("découverte mDNS indisponible : {e:#}");
                    None
                }
            }
        } else {
            None
        };

        Ok(Node { shared, discovery })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.shared.events.subscribe()
    }

    pub fn port(&self) -> u16 {
        self.shared.port
    }

    pub fn info(&self) -> NodeInfo {
        let ip = primary_ip().to_string();
        let phone_url = format!(
            "http://{ip}:{}/?t={}",
            self.shared.port, self.shared.phone_token
        );
        NodeInfo {
            id: self.shared.id.clone(),
            name: self.shared.name.clone(),
            ip,
            port: self.shared.port,
            phone_qr_svg: qr_svg(&phone_url),
            phone_url,
            download_dir: self.shared.download_dir().display().to_string(),
            discovery_active: self.discovery.is_some(),
        }
    }

    pub fn devices(&self) -> Vec<Device> {
        let mut list: Vec<Device> = self.shared.devices.lock().unwrap().values().cloned().collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        list
    }

    /// Ajout manuel par adresse IP, utile si le routeur bloque le mDNS.
    pub async fn add_device_by_address(&self, ip: &str, port: u16) -> Result<Device> {
        let device = client::probe(&self.shared, ip, port).await?;
        if device.id == self.shared.id {
            anyhow::bail!("c'est cet ordinateur");
        }
        self.shared
            .devices
            .lock()
            .unwrap()
            .insert(device.id.clone(), device.clone());
        self.shared.emit(Event::DeviceFound { device: device.clone() });
        Ok(device)
    }

    /// Envoie des fichiers à un appareil découvert. Rend la main quand tout
    /// est envoyé (ou refusé). La progression arrive par les événements.
    pub async fn send_files(&self, device_id: &str, paths: Vec<PathBuf>) -> Result<()> {
        let device = self
            .shared
            .devices
            .lock()
            .unwrap()
            .get(device_id)
            .cloned()
            .context("appareil introuvable (il s'est peut-être déconnecté)")?;
        client::send_files(&self.shared, &device, paths).await
    }

    /// Répond à une demande de transfert entrante.
    pub fn respond(&self, request_id: &str, accept: bool) -> bool {
        match self.shared.pending.lock().unwrap().remove(request_id) {
            Some(tx) => tx.send(accept).is_ok(),
            None => false,
        }
    }

    /// Met des fichiers à disposition des téléphones connectés.
    pub fn share_for_phone(&self, paths: Vec<PathBuf>) -> Result<Vec<SharedFile>> {
        let mut added = Vec::new();
        for path in paths {
            let meta = std::fs::metadata(&path)
                .with_context(|| format!("lecture de {}", path.display()))?;
            if !meta.is_file() {
                anyhow::bail!("{} n'est pas un fichier", path.display());
            }
            added.push(SharedFile {
                id: uuid::Uuid::new_v4().simple().to_string(),
                name: files::display_name(&path),
                size: meta.len(),
                path,
            });
        }
        let mut list = self.shared.shared_files.lock().unwrap();
        list.extend(added);
        Ok(list.clone())
    }

    pub fn phone_shared(&self) -> Vec<SharedFile> {
        self.shared.shared_files.lock().unwrap().clone()
    }

    pub fn unshare_for_phone(&self, id: &str) {
        self.shared.shared_files.lock().unwrap().retain(|f| f.id != id);
    }

    pub fn download_dir(&self) -> PathBuf {
        self.shared.download_dir()
    }

    pub fn set_download_dir(&self, dir: PathBuf) -> Result<()> {
        std::fs::create_dir_all(&dir)?;
        *self.shared.download_dir.write().unwrap() = dir;
        Ok(())
    }
}

/// Adresse IP de cet ordinateur sur le réseau local (celle du QR code).
pub fn primary_ip() -> IpAddr {
    local_ip_address::local_ip().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
}

/// Toutes les adresses IPv4 utilisables pour l'annonce mDNS.
pub(crate) fn local_ipv4s() -> Vec<IpAddr> {
    let mut ips: Vec<IpAddr> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .map(|(_, ip)| ip)
        .filter(|ip| match ip {
            IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified(),
            IpAddr::V6(_) => false,
        })
        .collect();
    ips.sort();
    ips.dedup();
    ips
}

fn qr_svg(data: &str) -> String {
    match qrcode::QrCode::new(data.as_bytes()) {
        Ok(code) => code
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .build(),
        Err(_) => String::new(),
    }
}

