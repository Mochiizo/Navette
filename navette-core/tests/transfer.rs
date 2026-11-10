//! Tests de bout en bout sur la machine locale (sans mDNS).

use std::time::Duration;

use navette_core::{Config, Event, Node};

async fn node(name: &str, dir: &std::path::Path) -> Node {
    Node::start(Config {
        name: name.into(),
        port: 0,
        download_dir: dir.to_path_buf(),
        enable_discovery: false,
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn pc_to_pc_transfer_with_acceptance() {
    let src = tempfile::tempdir().unwrap();
    let dst_a = tempfile::tempdir().unwrap();
    let dst_b = tempfile::tempdir().unwrap();

    let a = node("PC-A", dst_a.path()).await;
    let b = std::sync::Arc::new(node("PC-B", dst_b.path()).await);

    // B accepte automatiquement toute demande.
    let mut events = b.subscribe();
    let b2 = b.clone();
    tokio::spawn(async move {
        while let Ok(ev) = events.recv().await {
            if let Event::TransferRequest { request_id, from_name, files, .. } = ev {
                assert_eq!(from_name, "PC-A");
                assert_eq!(files.len(), 2);
                b2.respond(&request_id, true);
            }
        }
    });

    let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(src.path().join("video.mov"), &big).unwrap();
    std::fs::write(src.path().join("note.txt"), "bonjour").unwrap();
    // Un fichier du même nom existe déjà chez B : il ne doit pas être écrasé.
    std::fs::write(dst_b.path().join("note.txt"), "ancien").unwrap();

    let device = a.add_device_by_address("127.0.0.1", b.port()).await.unwrap();
    assert_eq!(device.name, "PC-B");

    a.send_files(
        &device.id,
        vec![src.path().join("video.mov"), src.path().join("note.txt")],
    )
    .await
    .unwrap();

    assert_eq!(std::fs::read(dst_b.path().join("video.mov")).unwrap(), big);
    assert_eq!(std::fs::read_to_string(dst_b.path().join("note.txt")).unwrap(), "ancien");
    assert_eq!(std::fs::read_to_string(dst_b.path().join("note (1).txt")).unwrap(), "bonjour");
    // Aucun fichier temporaire ne doit rester.
    for entry in std::fs::read_dir(dst_b.path()).unwrap() {
        assert!(!entry.unwrap().file_name().to_string_lossy().ends_with(".navette-part"));
    }
}

#[tokio::test]
async fn refused_transfer_writes_nothing() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let a = node("PC-A", tempfile::tempdir().unwrap().path()).await;
    let b = std::sync::Arc::new(node("PC-B", dst.path()).await);

    let mut events = b.subscribe();
    let b2 = b.clone();
    tokio::spawn(async move {
        while let Ok(ev) = events.recv().await {
            if let Event::TransferRequest { request_id, .. } = ev {
                b2.respond(&request_id, false);
            }
        }
    });
    let mut a_events = a.subscribe();

    std::fs::write(src.path().join("secret.txt"), "x").unwrap();
    let device = a.add_device_by_address("127.0.0.1", b.port()).await.unwrap();
    a.send_files(&device.id, vec![src.path().join("secret.txt")]).await.unwrap();

    assert_eq!(std::fs::read_dir(dst.path()).unwrap().count(), 0);
    let mut rejected = false;
    while let Ok(ev) = tokio::time::timeout(Duration::from_millis(200), a_events.recv()).await {
        if matches!(ev, Ok(Event::TransferRejected { .. })) {
            rejected = true;
        }
    }
    assert!(rejected);
}

#[tokio::test]
async fn phone_upload_and_download() {
    let dst = tempfile::tempdir().unwrap();
    let pc = node("PC", dst.path()).await;
    let info = pc.info();
    let token = info.phone_url.split("t=").nth(1).unwrap().to_string();
    let base = format!("http://127.0.0.1:{}", pc.port());
    let http = reqwest::Client::new();

    // Page mobile : refusée sans jeton, servie avec.
    assert_eq!(http.get(format!("{base}/")).send().await.unwrap().status(), 403);
    let page = http.get(format!("{base}/?t={token}")).send().await.unwrap();
    assert!(page.text().await.unwrap().contains("Connecté à <strong>PC</strong>"));

    // Le téléphone envoie une photo.
    let photo = vec![7u8; 500_000];
    let r = http
        .post(format!("{base}/api/v1/phone/upload"))
        .query(&[("t", token.as_str()), ("name", "IMG_0001.HEIC"), ("size", "500000")])
        .body(photo.clone())
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success());
    assert_eq!(std::fs::read(dst.path().join("IMG_0001.HEIC")).unwrap(), photo);

    // Taille annoncée fausse → refus et pas de fichier.
    let r = http
        .post(format!("{base}/api/v1/phone/upload"))
        .query(&[("t", token.as_str()), ("name", "court.jpg"), ("size", "999")])
        .body(vec![1u8; 10])
        .send()
        .await
        .unwrap();
    assert!(!r.status().is_success());
    assert!(!dst.path().join("court.jpg").exists());

    // Le PC partage un document, le téléphone le télécharge.
    let doc_dir = tempfile::tempdir().unwrap();
    let doc = doc_dir.path().join("Facture été.pdf");
    std::fs::write(&doc, b"%PDF-test").unwrap();
    let shared = pc.share_for_phone(vec![doc]).unwrap();
    let list: serde_json::Value = http
        .get(format!("{base}/api/v1/phone/shared?t={token}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list[0]["name"], "Facture été.pdf");
    let dl = http
        .get(format!("{base}/api/v1/phone/download/{}?t={token}", shared[0].id))
        .send()
        .await
        .unwrap();
    assert!(dl.headers()["content-disposition"].to_str().unwrap().contains("UTF-8''Facture%20%C3%A9t%C3%A9.pdf"));
    assert_eq!(dl.bytes().await.unwrap().as_ref(), b"%PDF-test");
}

/// Nécessite un réseau qui laisse passer le multicast : `cargo test -- --ignored`
#[tokio::test]
#[ignore]
async fn mdns_discovery_between_two_nodes() {
    let mk = |n: &str, d: &std::path::Path| Config {
        name: n.into(),
        port: 0,
        download_dir: d.to_path_buf(),
        enable_discovery: true,
    };
    let (d1, d2) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let a = Node::start(mk("PC-A", d1.path())).await.unwrap();
    let _b = Node::start(mk("PC-B", d2.path())).await.unwrap();
    for _ in 0..50 {
        if a.devices().iter().any(|d| d.name == "PC-B") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("PC-B non découvert");
}
