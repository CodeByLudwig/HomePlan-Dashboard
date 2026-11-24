# 🏠 HomePlan

[![Homey Pro](https://img.shields.io/badge/Homey%20Pro-WebSocket%20%26%20REST-00A4E4)](https://homey.app/)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-WebSocket%20%26%20REST-18BCF2?logo=homeassistant&logoColor=white)](https://www.home-assistant.io/)
[![Three.js](https://img.shields.io/badge/Three.js-r128-000000?logo=threedotjs)](https://threejs.org/)
[![PWA Ready](https://img.shields.io/badge/PWA-Ready-5A0FC8)](https://web.dev/progressive-web-apps/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

**HomePlan** vereint ein modernes **2D Smart-Home-Dashboard** und ein interaktives **3D-Hausmodell (Three.js + Grundriss-Editor)** in einer einzigen Web-App – **ohne `<iframe>`**, mit gemeinsamer **Homey Pro & Home Assistant Multi-Bridge**, zentralen Einstellungen, Dark/Light/Auto-Mode, Homey-Insights-Charts und iPhone-/PWA-Optimierung.

---

## ✨ Features

- **Alles in einer App (ohne `<iframe>`):**
  - **2D-Dashboard** (*Übersicht*, *Räume*, *Energie & Charts*, *Medien & System*, *Sicherheit*) startet sofort ohne Verzögerung.
  - **Natives 3D-Haus** (*3D-Haus*-Tab) wird erst bei Bedarf per Lazy-Loading geladen – inkl. 3D-Kamera-Presets, **First-Person-Rundgang**, **4-Schritte-Haus-Editor** und **3D-Vollbildmodus**.
- **Direkt-Links:**
  - `index.html?view=3d` → Öffnet direkt die 3D-Ansicht.
  - `index.html?view=3d&fullscreen=1` → Startet direkt im 3D-Vollbild (auch `?3d=fullscreen` oder `?kiosk=1`).
- **Zentrale Einstellungen (`⚙️ Einstellungen`) & Multi-Bridge:**
  - **Homey Pro** (Socket.IO WebSocket + REST API) und **Home Assistant** (WebSocket + REST API) parallel oder einzeln nutzbar.
  - Einheitliche Konfiguration über `config.json` (bzw. `localStorage`) für 2D **und** 3D.
  - Globales **Dark / Light / Auto**-Design (inkl. angepasstem Sperrbildschirm) und Sprachauswahl (`Auto / DE / EN`).
- **Räume & Geräte-Sync:**
  - Räume und Geräte-Verknüpfungen aus dem 3D-Haus synchronisieren sich automatisch in den **Räume**-Tab (Lichter, Dimmer, Rolladen, TV, Speaker, Sensoren).
  - Einrichtungs-Wizard beim ersten Start, falls noch kein eigenes Haus angelegt wurde.
- **Medien, Energie & Sicherheit:**
  - **Medien:** Automatische Album-Cover-Aktualisierung beim Songwechsel & Song-Fortschritt (`speaker_position`/`speaker_duration` + Laufzeit-Fallback).
  - **Energie & Insights:** *Energie heute* (Tagesverbrauch & Live-Verteilung nach Raum) sowie Verlaufscharts (`Heute`, `24h`, `7 Tage`, `30 Tage`) mit Klick-Filter pro Raum/Serie.
  - **Roborock Cloud:** Status, Start/Pause/Station/Orten, gezielte Raumreinigung, Saugkraft & Wischintensität.
  - **Sicherheit:** Aktiver Schutz-Status (*Schutz AN/AUS*), Protokoll & Alarm-Overlay.

---

## 📁 Projektstruktur

```text
homeplan/
├── index.html            # Einheitliche App (2D-Dashboard + natives #hp-3d-root Canvas)
├── css/
│   ├── dashboard.css     # 2D-Dashboard, Dark/Light/Mobile, Modals & 3D-Overlay-Styles
│   └── 3d.css            # Scoped 3D-Szene, Editor & HUD Styles
├── js/
│   ├── dashboard.js      # 2D-Dashboard, Lazy-3D-Loader, Insights, Media, Roborock & Multi-Bridge
│   ├── i18n.js           # Mehrsprachigkeit (DE / EN)
│   ├── scene-core.js     # Three.js Szene, Räume, Wände, Rolladen & ResizeObserver
│   ├── devices-3d.js     # 3D-Geräte, Lichter & Halos
│   ├── ha-connector.js   # Home Assistant Connector
│   ├── homey-api.js      # 3D Homey/HA Sync & HUD
│   ├── animations-fpv.js # Render-Loop & First-Person-Rundgang
│   └── house-editor.js   # 3D-Haus-Editor
├── server.js             # Optionaler Node.js Server (/api/config, /api/proxy, /api/bootstrap.js)
├── deploy.py             # FTP-Deploy-Script für Homey Micro Web Server
├── config.example.json   # Vorlage für Multi-Bridge config.json
├── manifest.webmanifest  # PWA-Manifest
└── sw.js                 # Service Worker (Network-First)
```

---

## 🚀 Starten & Deployment

### Option A: Statisch auf Homey Micro Web Server
```powershell
$env:HOMEY_HOST = "192.168.x.x"
$env:HOMEY_REMOTE_DIR = "/homeplan"
python deploy.py
```

### Option B: Node.js Server (empfohlen bei Home Assistant wegen `/api/proxy`)
```bash
node server.js
```

### Konfiguration (`config.json`)
Kopiere `config.example.json` nach `config.json` und trage dort deine Homey-/Home-Assistant-Zugangsdaten ein (`config.json` und `local/` stehen in `.gitignore` und werden nicht in Git eingecheckt).

---

## 📄 Lizenz

Dieses Projekt steht unter der [GNU General Public License v3.0 (GPLv3)](LICENSE).  
Für eine kommerzielle Nutzung ohne Open-Source-Pflicht oder individuelle Anpassungen ist eine separate Lizenzierung auf Anfrage möglich.
