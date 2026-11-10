//! Écriture des fichiers reçus : noms sûrs, pas d'écrasement,
//! fichier temporaire renommé seulement quand tout est arrivé.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use futures_util::{Stream, StreamExt};
use tokio::io::AsyncWriteExt;

use crate::{Direction, Event, Shared};

const PART_SUFFIX: &str = ".navette-part";

/// Nom de fichier sans chemin, pour l'affichage.
pub fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "fichier".into())
}

/// Rend un nom de fichier envoyé par le réseau inoffensif : pas de chemin,
/// pas de caractères interdits sous Windows, pas de nom réservé.
pub fn sanitize_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut name: String = base
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    name = name.trim().trim_matches('.').trim().to_string();
    if name.is_empty() {
        name = "fichier".into();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        name = format!("_{name}");
    }
    // Limite raisonnable de longueur (en caractères).
    if name.chars().count() > 180 {
        let ext = Path::new(&name)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let keep: String = name.chars().take(180 - ext.chars().count()).collect();
        name = format!("{keep}{ext}");
    }
    name
}

/// `photo.jpg` → `photo (1).jpg`, `photo (2).jpg`… jusqu'à trouver un nom libre.
fn candidate(dir: &Path, name: &str, n: u32) -> PathBuf {
    if n == 0 {
        return dir.join(name);
    }
    let p = Path::new(name);
    match (p.file_stem(), p.extension()) {
        (Some(stem), Some(ext)) => dir.join(format!(
            "{} ({n}).{}",
            stem.to_string_lossy(),
            ext.to_string_lossy()
        )),
        _ => dir.join(format!("{name} ({n})")),
    }
}

fn part_path(final_path: &Path) -> PathBuf {
    let mut s = final_path.as_os_str().to_owned();
    s.push(PART_SUFFIX);
    PathBuf::from(s)
}

/// Réserve un nom libre en créant le fichier temporaire de façon exclusive.
async fn reserve(dir: &Path, name: &str) -> Result<(PathBuf, tokio::fs::File)> {
    for n in 0..10_000 {
        let final_path = candidate(dir, name, n);
        if tokio::fs::try_exists(&final_path).await.unwrap_or(false) {
            continue;
        }
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(part_path(&final_path))
            .await
        {
            Ok(file) => return Ok((final_path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    bail!("impossible de trouver un nom libre pour {name}")
}

/// Limite le nombre d'événements de progression envoyés à l'interface.
pub struct Throttle {
    last: Option<Instant>,
}

impl Throttle {
    pub fn new() -> Self {
        Self { last: None }
    }
    pub fn ready(&mut self) -> bool {
        let now = Instant::now();
        match self.last {
            Some(t) if now.duration_since(t) < Duration::from_millis(150) => false,
            _ => {
                self.last = Some(now);
                true
            }
        }
    }
}

pub struct Incoming<'a> {
    pub transfer_id: &'a str,
    pub peer: &'a str,
    pub file_name: &'a str,
    pub file_index: usize,
    pub file_count: usize,
    /// Taille annoncée. Le transfert échoue si on reçoit plus ou moins.
    pub expected_size: Option<u64>,
}

/// Écrit un flux reçu dans le dossier de réception et renvoie le chemin final.
pub async fn save_stream<S, E>(shared: &Shared, info: Incoming<'_>, stream: S) -> Result<PathBuf>
where
    S: Stream<Item = Result<bytes::Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    let dir = shared.download_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let safe_name = sanitize_file_name(info.file_name);
    let (final_path, file) = reserve(&dir, &safe_name).await?;
    let tmp = part_path(&final_path);

    let result = write_all(shared, &info, &safe_name, file, stream).await;
    match result {
        Ok(()) => {
            // Si quelqu'un a créé le nom final entre-temps, on en prend un autre.
            let mut target = final_path;
            let mut n = 1;
            while tokio::fs::try_exists(&target).await.unwrap_or(false) {
                target = candidate(&dir, &safe_name, n);
                n += 1;
            }
            tokio::fs::rename(&tmp, &target).await?;
            Ok(target)
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(e)
        }
    }
}

async fn write_all<S, E>(
    shared: &Shared,
    info: &Incoming<'_>,
    display: &str,
    file: tokio::fs::File,
    mut stream: S,
) -> Result<()>
where
    S: Stream<Item = Result<bytes::Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    let mut writer = tokio::io::BufWriter::with_capacity(1 << 20, file);
    let total = info.expected_size.unwrap_or(0);
    let mut received: u64 = 0;
    let mut throttle = Throttle::new();
    let progress = |bytes: u64| Event::Progress {
        transfer_id: info.transfer_id.to_string(),
        direction: Direction::Receive,
        peer: info.peer.to_string(),
        file_name: display.to_string(),
        file_index: info.file_index,
        file_count: info.file_count,
        bytes,
        total,
    };

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow::anyhow!("connexion interrompue : {e}"))?;
        received += chunk.len() as u64;
        if let Some(expected) = info.expected_size {
            if received > expected {
                bail!("le fichier est plus gros qu'annoncé");
            }
        }
        writer.write_all(&chunk).await?;
        if throttle.ready() {
            shared.emit(progress(received));
        }
    }
    writer.flush().await?;
    writer.get_ref().sync_all().await?;

    if let Some(expected) = info.expected_size {
        if received != expected {
            bail!("fichier incomplet ({received} octets reçus sur {expected})");
        }
    }
    shared.emit(progress(received));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_paths_and_bad_chars() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\Users\\a\\photo.jpg"), "photo.jpg");
        assert_eq!(sanitize_file_name("a<b>c?.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_file_name("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_file_name("..."), "fichier");
        assert_eq!(sanitize_file_name("IMG_0042.HEIC"), "IMG_0042.HEIC");
    }

    #[test]
    fn candidates_number_before_extension() {
        let d = Path::new("/x");
        assert_eq!(candidate(d, "photo.jpg", 2), Path::new("/x/photo (2).jpg"));
        assert_eq!(candidate(d, "README", 1), Path::new("/x/README (1)"));
    }
}
