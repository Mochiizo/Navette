//! Côté expéditeur : annonce les fichiers à l'autre PC, attend son accord,
//! puis envoie chaque fichier en flux avec suivi de progression.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;

use crate::files::{display_name, Throttle};
use crate::server::{InfoResponse, TransferRequestBody, TransferResponse, ANSWER_TIMEOUT};
use crate::{Device, Direction, Event, FileMeta, Shared};

fn base_url(ip: &str, port: u16) -> String {
    format!("http://{ip}:{port}")
}

/// Vérifie qu'une adresse correspond bien à une instance de Navette.
pub async fn probe(shared: &Shared, ip: &str, port: u16) -> Result<Device> {
    let info: InfoResponse = shared
        .http
        .get(format!("{}/api/v1/info", base_url(ip, port)))
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .context("aucune réponse à cette adresse")?
        .error_for_status()?
        .json()
        .await
        .context("ce n'est pas une instance de Navette")?;
    if info.app != "navette" {
        bail!("ce n'est pas une instance de Navette");
    }
    Ok(Device { id: info.id, name: info.name, ip: ip.to_string(), port })
}

pub async fn send_files(shared: &Arc<Shared>, device: &Device, paths: Vec<PathBuf>) -> Result<()> {
    if paths.is_empty() {
        bail!("aucun fichier sélectionné");
    }
    let mut metas = Vec::with_capacity(paths.len());
    for path in &paths {
        let meta = tokio::fs::metadata(path)
            .await
            .with_context(|| format!("lecture de {}", path.display()))?;
        if meta.is_dir() {
            bail!(
                "« {} » est un dossier : l'envoi de dossiers arrive dans une prochaine étape",
                display_name(path)
            );
        }
        metas.push(FileMeta { name: display_name(path), size: meta.len() });
    }

    let transfer_id = uuid::Uuid::new_v4().simple().to_string();
    let peer = device.name.clone();
    let base = base_url(&device.ip, device.port);

    let fail = |error: String| {
        shared.emit(Event::TransferFailed {
            transfer_id: transfer_id.clone(),
            direction: Direction::Send,
            peer: peer.clone(),
            error: error.clone(),
        });
        anyhow::anyhow!(error)
    };

    // Progression "0 %" pour que l'interface affiche tout de suite le transfert
    // pendant que l'autre PC décide.
    shared.emit(Event::Progress {
        transfer_id: transfer_id.clone(),
        direction: Direction::Send,
        peer: peer.clone(),
        file_name: metas[0].name.clone(),
        file_index: 0,
        file_count: metas.len(),
        bytes: 0,
        total: metas[0].size,
    });

    let answer: TransferResponse = match async {
        shared
            .http
            .post(format!("{base}/api/v1/request"))
            .json(&TransferRequestBody {
                from_id: shared.id.clone(),
                from_name: shared.name.clone(),
                files: metas.clone(),
            })
            .timeout(ANSWER_TIMEOUT + Duration::from_secs(10))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
    }
    .await
    {
        Ok(a) => a,
        Err(e) => return Err(fail(format!("impossible de joindre {peer} : {e}"))),
    };

    let Some(session) = answer.session.filter(|_| answer.accepted) else {
        shared.emit(Event::TransferRejected { transfer_id, peer });
        return Ok(());
    };

    let count = paths.len();
    for (index, (path, meta)) in paths.iter().zip(&metas).enumerate() {
        let file = match tokio::fs::File::open(path).await {
            Ok(f) => f,
            Err(e) => return Err(fail(format!("lecture de {} : {e}", meta.name))),
        };

        let sent = Arc::new(Mutex::new((0u64, Throttle::new())));
        let progress_shared = shared.clone();
        let (tid, pr, name, total) =
            (transfer_id.clone(), peer.clone(), meta.name.clone(), meta.size);
        let stream = tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024).inspect(
            move |chunk| {
                if let Ok(bytes) = chunk {
                    let mut guard = sent.lock().unwrap();
                    guard.0 += bytes.len() as u64;
                    let done = guard.0;
                    if guard.1.ready() || done == total {
                        progress_shared.emit(Event::Progress {
                            transfer_id: tid.clone(),
                            direction: Direction::Send,
                            peer: pr.clone(),
                            file_name: name.clone(),
                            file_index: index,
                            file_count: count,
                            bytes: done,
                            total,
                        });
                    }
                }
            },
        );

        let response = shared
            .http
            .post(format!("{base}/api/v1/upload"))
            .query(&[("session", session.as_str()), ("index", &index.to_string())])
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await;

        match response {
            Ok(r) if r.status().is_success() => {
                shared.emit(Event::FileDone {
                    transfer_id: transfer_id.clone(),
                    direction: Direction::Send,
                    peer: peer.clone(),
                    file_name: meta.name.clone(),
                    path: None,
                });
            }
            Ok(r) => {
                let status = r.status();
                let text = r.text().await.unwrap_or_default();
                return Err(fail(format!("{} refusé ({status}) : {text}", meta.name)));
            }
            Err(e) => return Err(fail(format!("envoi de {} interrompu : {e}", meta.name))),
        }
    }

    shared.emit(Event::TransferFinished { transfer_id, direction: Direction::Send, peer });
    Ok(())
}
