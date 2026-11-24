# 🏠 HomePlan

[![Homey Pro](https://img.shields.io/badge/Homey%20Pro-WebSocket%20%26%20REST-00A4E4)](https://homey.app/)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-WebSocket%20%26%20REST-18BCF2?logo=homeassistant&logoColor=white)](https://www.home-assistant.io/)
[![Three.js](https://img.shields.io/badge/Three.js-r128-000000?logo=threedotjs)](https://threejs.org/)
[![PWA Ready](https://img.shields.io/badge/PWA-Ready-5A0FC8)](https://web.dev/progressive-web-apps/)

**HomePlan** vereint das **2D Smart-Home-Dashboard** und das interaktive **3D-Hausmodell (Three.js + Haus-Editor)** in einer einzigen Anwendung – **ohne `<iframe>`**, mit gemeinsamer **Homey Pro & Home Assistant Multi-Bridge**, Dark/Light-Mode, Homey Insights-Charts, Mediensteuerung, Roborock-Integration und iPhone-/PWA-Optimierung.

---

## ✨ Highlights

- **Alles in einer App (ohne `<iframe>`):** Nahtloser Wechsel zwischen *Übersicht*, *Räume*, *Energie & Charts*, *Medien & System*, *Sicherheit* und der nativen *3D-Haus*-Ansicht inkl. 4-Schritte-Haus-Editor & First-Person-Rundgang.
- **Multi-Bridge (Homey Pro & Home Assistant):**
  - Gemeinsame Verbindung & `config.json` für beide Oberflächen (2D + 3D).
  - Live-WebSocket-Updates für beide Bridges sowie Branded Connector-Karten im `⚙️`-Modal.
- **2D-Dashboard:**
  - **Medien**: Automatische Album-Cover-Aktualisierung & Song-Fortschritt (`speaker_position` / `speaker_duration` + Laufzeit-Fallback).
  - **Energie & Insights**: Tagesverbrauch (*Energie heute* nach Raum) + Verlaufscharts (`Heute`, `24h`, `7 Tage`, `30 Tage`) mit Klick-Filter pro Raum/Serie.
  - **Räume**: Lichter, Dimmer & Rolladen (`Offen` / `Zu` / `%`).
  - **Roborock Cloud**: Status, Start/Pause/Station/Orten, Raumwahl, Saugkraft & Wischintensität.
  - **Dark & Light Mode + iPhone Safe-Area:** Vollständiges Dark/Light/Auto-Theme inkl. passendem Sperrbildschirm.

---

## 📁 Projektstruktur

```text
homeplan/
├── index.html            # Einheitliche App (2D-Dashboard + natives #hp-3d-root Canvas)
├── css/
│   ├── dashboard.css     # 2D-Dashboard Dark/Light/Mobile Styles
│   └── 3d.css            # Scoped 3D-Szene, Editor & HUD Styles
├── js/
│   ├── dashboard.js      # 2D-Dashboard, Charts, Media, Roborock & Multi-Bridge
│   ├── i18n.js           # 3D Mehrsprachigkeit (DE / EN)
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
└── sw.js                 # Service Worker
```

---

## 🚀 Starten

### Option A: Node.js Server (empfohlen bei Home Assistant wegen `/api/proxy`)
```bash
node server.js
```

### Option B: Statisch auf Homey Micro Web Server
```powershell
$env:HOMEY_HOST = "192.168.x.x"
python deploy.py
```

*(Für automatische Anmeldung auf allen Geräten `config.example.json` als `config.json` kopieren und IP/Tokens eintragen – `config.json` ist in `.gitignore` ausgeschlossen.)*
