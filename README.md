# Navette

Application desktop pour transférer des fichiers sur le réseau local, sans câble, sans compte, sans cloud :

- **PC ⇄ PC** : les ordinateurs qui lancent Navette sur le même Wi-Fi se trouvent automatiquement. On glisse des fichiers, l'autre PC accepte ou refuse.
- **PC ⇄ téléphone** (iPhone ou Android) : le PC affiche un QR code, le téléphone l'ouvre dans son navigateur. **Rien à installer sur le téléphone.**

Stack : [Tauri 2](https://tauri.app) (Rust + interface HTML/CSS/JS sans framework).

## Lancer le projet

### Prérequis (Windows)

1. **Rust** : installer depuis <https://rustup.rs> (accepter l'installation des « Visual Studio C++ Build Tools » proposée).
2. **WebView2** : déjà présent sur Windows 10 et 11.
3. **Tauri CLI** (une seule fois) :
   ```
   cargo install tauri-cli --version "^2" --locked
   ```

Sous Linux, il faut aussi : `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`.

### Développement

```
cargo tauri dev
```

### Installateur

```
cargo tauri build
```

Les installateurs (`.msi` et `.exe`) sont générés dans `target/release/bundle/`.

### Obtenir le .exe sans rien installer (GitHub Actions)

1. Créer un dépôt GitHub (privé si tu veux) et y pousser le projet.
2. Le workflow `.github/workflows/build-windows.yml` compile l'app sur une machine Windows de GitHub (≈ 10 min la première fois).
3. Onglet **Actions** → dernier run → **Artifacts** → télécharger **Navette-Windows**.

Il contient `navette.exe` (version portable, se lance directement) et les installateurs `.exe` / `.msi`.

### Tests

```
cargo test -p navette-core                 # transferts PC→PC, refus, téléphone
cargo test -p navette-core -- --ignored    # découverte mDNS (réseau réel)
```

## Premier lancement sous Windows

- Windows demande d'autoriser Navette dans le **pare-feu** : cocher **Réseaux privés**.
- Le Wi-Fi doit être en profil **Privé** (Paramètres → Réseau et Internet → Wi-Fi → propriétés), sinon les autres PC ne voient pas Navette.
- Si un PC n'apparaît pas (certaines box bloquent la découverte), utiliser **« Ajouter un PC par adresse IP »** en bas à gauche. L'adresse s'affiche sous le nom, en haut de la fenêtre de l'autre PC.

Les fichiers reçus vont directement dans `Téléchargements`. Le bouton **Changer…** permet de choisir un autre dossier, qui est mémorisé pour les prochains lancements.

## Avec un iPhone

- Ouvrir l'appareil photo, viser le QR code, toucher le lien.
- **Garder l'écran allumé** pendant l'envoi : Safari met les transferts en pause quand l'iPhone se verrouille. La page demande à l'iPhone de rester allumé quand c'est possible, et réessaie automatiquement les fichiers en échec.
- Safari peut convertir certaines photos HEIC en JPEG au moment de l'envoi, et les Live Photos arrivent comme des images fixes.
- Pour une sauvegarde complète avant de changer de téléphone, le câble USB reste le plus fiable pour de très gros volumes.

## Architecture

```
navette/
├─ navette-core/          Cœur réseau (Rust, indépendant de Tauri, testé)
│  ├─ src/lib.rs          Node : démarrage, API publique, événements
│  ├─ src/discovery.rs    Découverte des PC via mDNS (_navette._tcp)
│  ├─ src/server.rs       Serveur HTTP : réception PC + API téléphone
│  ├─ src/client.rs       Envoi vers un autre PC
│  ├─ src/files.rs        Écriture sûre des fichiers reçus
│  ├─ src/mobile.html     Page web du téléphone
│  └─ tests/transfer.rs   Tests de bout en bout
├─ src-tauri/             Application desktop (commandes + relais d'événements)
└─ ui/                    Interface (index.html, style.css, app.js)
```

### Protocole PC ⇄ PC

1. `POST /api/v1/request` : l'expéditeur annonce les fichiers (noms + tailles). Le destinataire voit une carte « Accepter / Refuser » (120 s pour répondre).
2. Si accepté, il reçoit un jeton de session.
3. `POST /api/v1/upload?session=…&index=…` : un appel par fichier, le contenu est envoyé en flux (pas de limite de taille, mémoire constante).

### Téléphone

Le QR code contient l'adresse du PC et un **jeton aléatoire** généré à chaque lancement : sans ce jeton, la page et l'API refusent l'accès.

### Sécurité déjà en place

- Acceptation obligatoire pour tout transfert venant d'un PC.
- Noms de fichiers nettoyés (pas de `../`, pas de noms interdits sous Windows).
- Aucun écrasement : `photo.jpg` existant → `photo (1).jpg`.
- Fichier écrit d'abord en `.navette-part`, renommé seulement quand il est complet et à la bonne taille.

## Prochaines étapes

- [ ] **Chiffrement TLS** + code d'appairage à 4 chiffres (aujourd'hui le trafic est en HTTP clair sur le réseau local).
- [ ] Icône dans la zone de notification et notifications système à la réception.
- [ ] Envoi de dossiers entiers.
- [ ] Reprise d'un gros fichier là où il s'est arrêté.
- [ ] Rangement automatique des photos par date (`Photos/2025/08/`).
- [ ] Bouton « Annuler » sur un transfert en cours.
- [ ] Liste des appareils de confiance (accepter automatiquement).
