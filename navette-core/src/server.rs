//! Serveur HTTP local : reçoit les fichiers des autres PC et sert la page
//! web utilisée par les téléphones.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::files::{self, Incoming};
use crate::{Direction, Event, FileMeta, Session, Shared, SharedFile};

/// Délai laissé à l'utilisateur pour accepter un transfert.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

const MOBILE_PAGE: &str = include_str!("mobile.html");

type AppState = State<Arc<Shared>>;
type ApiError = (StatusCode, String);

pub fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/", get(mobile_page))
        .route("/api/v1/info", get(info))
        .route("/api/v1/request", post(request))
        .route("/api/v1/upload", post(upload))
        .route("/api/v1/phone/upload", post(phone_upload))
        .route("/api/v1/phone/shared", get(phone_shared))
        .route("/api/v1/phone/download/{id}", get(phone_download))
        // Les fichiers sont lus en flux : pas de limite de taille globale.
        .layer(DefaultBodyLimit::disable())
        .with_state(shared)
}

// ---------------------------------------------------------------- PC ⇄ PC

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoResponse {
    pub app: String,
    pub id: String,
    pub name: String,
    pub port: u16,
}

async fn info(State(s): AppState) -> Json<InfoResponse> {
    Json(InfoResponse {
        app: "navette".into(),
        id: s.id.clone(),
        name: s.name.clone(),
        port: s.port,
    })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequestBody {
    pub from_id: String,
    pub from_name: String,
    pub files: Vec<FileMeta>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResponse {
    pub accepted: bool,
    pub session: Option<String>,
}

/// Étape 1 : l'expéditeur annonce les fichiers. On attend que l'utilisateur
/// accepte ou refuse dans l'interface (ou que le délai expire).
async fn request(
    State(s): AppState,
    Json(req): Json<TransferRequestBody>,
) -> Result<Json<TransferResponse>, ApiError> {
    if req.files.is_empty() || req.files.len() > 10_000 {
        return Err((StatusCode::BAD_REQUEST, "liste de fichiers invalide".into()));
    }
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = oneshot::channel();
    s.pending.lock().unwrap().insert(request_id.clone(), tx);

    let from_name = req.from_name.chars().take(64).collect::<String>();
    s.emit(Event::TransferRequest {
        request_id: request_id.clone(),
        from_name: from_name.clone(),
        total_size: req.files.iter().map(|f| f.size).sum(),
        files: req.files.clone(),
    });

    let accepted = matches!(tokio::time::timeout(ANSWER_TIMEOUT, rx).await, Ok(Ok(true)));
    s.pending.lock().unwrap().remove(&request_id);
    s.emit(Event::RequestClosed { request_id });

    if !accepted {
        return Ok(Json(TransferResponse { accepted: false, session: None }));
    }
    let session = uuid::Uuid::new_v4().simple().to_string();
    s.sessions.lock().unwrap().insert(
        session.clone(),
        Session {
            peer: from_name,
            received: vec![false; req.files.len()],
            files: req.files,
        },
    );
    Ok(Json(TransferResponse { accepted: true, session: Some(session) }))
}

#[derive(Deserialize)]
struct UploadQuery {
    session: String,
    index: usize,
}

/// Étape 2 : un appel par fichier, le contenu arrive en flux dans le corps.
async fn upload(
    State(s): AppState,
    Query(q): Query<UploadQuery>,
    body: Body,
) -> Result<StatusCode, ApiError> {
    let (peer, meta, count) = {
        let mut sessions = s.sessions.lock().unwrap();
        let sess = sessions
            .get_mut(&q.session)
            .ok_or((StatusCode::FORBIDDEN, "session inconnue".into()))?;
        if q.index >= sess.files.len() {
            return Err((StatusCode::BAD_REQUEST, "index invalide".into()));
        }
        if sess.received[q.index] {
            return Err((StatusCode::CONFLICT, "fichier déjà reçu".into()));
        }
        sess.received[q.index] = true; // réservé pendant la réception
        (sess.peer.clone(), sess.files[q.index].clone(), sess.files.len())
    };

    let result = files::save_stream(
        &s,
        Incoming {
            transfer_id: &q.session,
            peer: &peer,
            file_name: &meta.name,
            file_index: q.index,
            file_count: count,
            expected_size: Some(meta.size),
        },
        body.into_data_stream(),
    )
    .await;

    match result {
        Ok(path) => {
            s.emit(Event::FileDone {
                transfer_id: q.session.clone(),
                direction: Direction::Receive,
                peer: peer.clone(),
                file_name: meta.name,
                path: Some(path.display().to_string()),
            });
            let finished = {
                let mut sessions = s.sessions.lock().unwrap();
                let done = sessions
                    .get(&q.session)
                    .map(|sess| sess.received.iter().all(|r| *r))
                    .unwrap_or(false);
                if done {
                    sessions.remove(&q.session);
                }
                done
            };
            if finished {
                s.emit(Event::TransferFinished {
                    transfer_id: q.session,
                    direction: Direction::Receive,
                    peer,
                });
            }
            Ok(StatusCode::OK)
        }
        Err(e) => {
            // On libère la place pour permettre un nouvel essai.
            if let Some(sess) = s.sessions.lock().unwrap().get_mut(&q.session) {
                sess.received[q.index] = false;
            }
            s.emit(Event::TransferFailed {
                transfer_id: q.session,
                direction: Direction::Receive,
                peer,
                error: format!("{e:#}"),
            });
            Err((StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))
        }
    }
}

// ---------------------------------------------------------------- Téléphone

#[derive(Deserialize)]
struct TokenQuery {
    t: Option<String>,
}

fn check_token(s: &Shared, token: Option<&str>) -> Result<(), ApiError> {
    if token == Some(s.phone_token.as_str()) {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            "Lien expiré : scannez à nouveau le QR code affiché sur l'ordinateur.".into(),
        ))
    }
}

async fn mobile_page(State(s): AppState, Query(q): Query<TokenQuery>) -> Response {
    if check_token(&s, q.t.as_deref()).is_err() {
        return (
            StatusCode::FORBIDDEN,
            Html(
                "<meta name=viewport content='width=device-width'>\
                 <p style='font-family:sans-serif;padding:2em'>Lien expiré. \
                 Scannez à nouveau le QR code affiché dans Navette sur l'ordinateur.</p>",
            ),
        )
            .into_response();
    }
    let page = MOBILE_PAGE.replace("{{PC_NAME}}", &html_escape(&s.name));
    let mut resp = Html(page).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

#[derive(Deserialize)]
struct PhoneUploadQuery {
    t: Option<String>,
    name: String,
    size: Option<u64>,
    batch: Option<String>,
    index: Option<usize>,
    count: Option<usize>,
}

async fn phone_upload(
    State(s): AppState,
    Query(q): Query<PhoneUploadQuery>,
    body: Body,
) -> Result<StatusCode, ApiError> {
    check_token(&s, q.t.as_deref())?;
    let peer = "Téléphone".to_string();
    let transfer_id = q
        .batch
        .clone()
        .filter(|b| b.len() <= 64)
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let index = q.index.unwrap_or(0);
    let count = q.count.unwrap_or(1).max(1);

    let result = files::save_stream(
        &s,
        Incoming {
            transfer_id: &transfer_id,
            peer: &peer,
            file_name: &q.name,
            file_index: index,
            file_count: count,
            expected_size: q.size,
        },
        body.into_data_stream(),
    )
    .await;

    match result {
        Ok(path) => {
            s.emit(Event::FileDone {
                transfer_id: transfer_id.clone(),
                direction: Direction::Receive,
                peer: peer.clone(),
                file_name: q.name,
                path: Some(path.display().to_string()),
            });
            if index + 1 >= count {
                s.emit(Event::TransferFinished {
                    transfer_id,
                    direction: Direction::Receive,
                    peer,
                });
            }
            Ok(StatusCode::OK)
        }
        Err(e) => {
            s.emit(Event::TransferFailed {
                transfer_id,
                direction: Direction::Receive,
                peer,
                error: format!("{e:#}"),
            });
            Err((StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))
        }
    }
}

async fn phone_shared(
    State(s): AppState,
    Query(q): Query<TokenQuery>,
) -> Result<Json<Vec<SharedFile>>, ApiError> {
    check_token(&s, q.t.as_deref())?;
    Ok(Json(s.shared_files.lock().unwrap().clone()))
}

async fn phone_download(
    State(s): AppState,
    Path(id): Path<String>,
    Query(q): Query<TokenQuery>,
) -> Result<Response, ApiError> {
    check_token(&s, q.t.as_deref())?;
    let shared = s
        .shared_files
        .lock()
        .unwrap()
        .iter()
        .find(|f| f.id == id)
        .cloned()
        .ok_or((StatusCode::NOT_FOUND, "fichier plus partagé".into()))?;
    let file = tokio::fs::File::open(&shared.path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    let len = file.metadata().await.map(|m| m.len()).unwrap_or(shared.size);

    let body = Body::from_stream(tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024));
    let disposition = format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        ascii_fallback(&shared.name),
        percent_encode(&shared.name)
    );
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, len.to_string()),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        body,
    )
        .into_response())
}

// ---------------------------------------------------------------- utilitaires

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn ascii_fallback(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' })
        .collect()
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
