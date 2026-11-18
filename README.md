# Navette

Application desktop pour transférer des fichiers sur le réseau local, sans câble, sans compte, sans cloud :

- **PC ⇄ PC** : les ordinateurs qui lancent Navette sur le même Wi-Fi se trouvent automatiquement. On glisse des fichiers, l'autre PC accepte ou refuse.
- **PC ⇄ téléphone** (iPhone ou Android) : le PC affiche un QR code, le téléphone l'ouvre dans son navigateur. **Rien à installer sur le téléphone.**
- **Mises à jour intégrées** : quand une nouvelle version est publiée, un bouton « Mise à jour » apparaît dans l'app.

Stack : [Electron](https://www.electronjs.org) + [Next.js](https://nextjs.org) (React, export statique) + Node.js pour le réseau.

## Lancer le projet

Prérequis : **Node.js 22** (<https://nodejs.org>, version LTS).

```
npm install
npm run dev        # interface Next.js + Electron, rechargement à chaud
```

### Créer l'installateur Windows

```
npm run dist
```

L'installateur est généré dans `dist\Navette-Setup-<version>.exe`.

### Tests

```
npm test                              # transferts PC→PC, refus, téléphone
set NAVETTE_TEST_MDNS=1 && npm test   # + découverte mDNS (réseau réel)
```

## Publier une nouvelle version

Les Navette installées vérifient les **Releases GitHub** au démarrage (puis toutes les 6 h) et proposent la mise à jour d'un clic.

1. Changer `"version"` dans `package.json` (ex. `0.5.0`).
2. Puis :
   ```
   git commit -am "Navette 0.5.0"
   git tag v0.5.0
   git push
   git push --tags
   ```
3. Le workflow **Release** compile l'installateur sur une machine Windows de GitHub et crée la Release `v0.5.0` avec `Navette-Setup-0.5.0.exe` et `latest.yml`.

Le dépôt doit rester **public** pour que l'app puisse lire les Releases.

### Tester la mise à jour en développement

Servir un dossier contenant un `latest.yml` (ou `latest-linux.yml` sous Linux) puis :

```
set NAVETTE_UPDATE_TEST_URL=http://127.0.0.1:8765 && npm run dev
```

## Premier lancement sous Windows

- SmartScreen affiche « Windows a protégé votre ordinateur » : **Informations complémentaires** → **Exécuter quand même** (l'app n'est pas signée).
- Autoriser Navette sur les **réseaux privés** dans le pare-feu, et mettre le Wi-Fi en profil **Privé**.
- Si un PC n'apparaît pas (box qui bloque la découverte, Hamachi, Tailscale), utiliser **« Ajouter un PC par adresse IP »**.

Les fichiers reçus vont directement dans `Téléchargements` (bouton **Changer…** pour un autre dossier, mémorisé).

## Avec un iPhone

- Ouvrir l'appareil photo, viser le QR code, toucher le lien.
- **Garder l'écran allumé** pendant l'envoi : Safari met les transferts en pause quand l'iPhone se verrouille.
- Les fichiers envoyés du PC vers l'iPhone arrivent dans **Fichiers › Téléchargements**.

## Architecture

```
navette/
├─ app/                    Interface Next.js (React)
│  ├─ page.tsx             État de l'app, événements, glisser-déposer, mises à jour
│  ├─ components/          Barre de titre, appareils, vues PC/téléphone, transferts…
│  └─ globals.css          Thème « Liquid Glass » + fond animé (ondes)
├─ lib/navette.ts          Types de l'API exposée par Electron
├─ electron/
│  ├─ main.js              Fenêtre, IPC, réglages, protocole app://
│  ├─ preload.js           Pont sécurisé interface ↔ processus principal
│  ├─ updater.js           Mises à jour (electron-updater + Releases GitHub)
│  └─ core/                Cœur réseau Node.js, indépendant d'Electron
│     ├─ index.js          Node : démarrage, API, événements
│     ├─ discovery.js      Découverte mDNS (_navette._tcp)
│     ├─ server.js         Serveur HTTP : réception PC + API téléphone
│     ├─ client.js         Envoi vers un autre PC
│     ├─ files.js          Écriture sûre des fichiers reçus
│     └─ mobile.html       Page web du téléphone
├─ test/                   Tests de bout en bout (node --test)
└─ build/                  Icônes et images de l'installateur
```

Le protocole est le même que celui des versions Tauri (0.1 à 0.3) : les anciennes et nouvelles versions peuvent échanger des fichiers.

### Sécurité en place

- Acceptation obligatoire pour tout transfert venant d'un PC.
- Page du téléphone protégée par un jeton aléatoire renouvelé à chaque lancement.
- Noms de fichiers nettoyés, aucun écrasement (`photo (1).jpg`), fichiers incomplets supprimés.
- Interface isolée : pas d'accès Node.js depuis la page, uniquement les fonctions du preload.

## Prochaines étapes

- [ ] Chiffrement des transferts + code d'appairage (aujourd'hui en HTTP clair sur le réseau local).
- [ ] Icône dans la zone de notification et notifications système.
- [ ] Envoi de dossiers entiers.
- [ ] Reprise d'un gros fichier interrompu.
- [ ] Annulation d'un transfert en cours.
