// =========================================================================
// 5. SIDEBAR, STEUERUNG & MULTI-BRIDGE LIVE-API (HOMEY PRO & HOME ASSISTANT)
// =========================================================================
let homeyConnected = false;
let homeyBaseUrl = '';
let homeyToken = '';
let homeyDevicesList = []; // Array aus { id, name, zoneName, capabilitiesObj }

let haConnected = false;
let haBaseUrl = '';
let haToken = '';
let haEntitiesList = [];   // Array aus Home Assistant Entities
let haEntitiesById = {};   // Map: entity_id -> HA Entity

let deviceMapping = {};    // 3D-Device-ID -> 'homey:<id>' | 'ha:<entity_id>' (oder altes Format '<homey_id>')
let pollTimer = null;
let activeControlDevId = null;
let dimDebounceTimer = null;

function parseMappingTarget(mappedId) {
  if (!mappedId || typeof mappedId !== 'string') return null;
  if (mappedId.startsWith('ha:')) {
    const rawId = mappedId.slice(3);
    return { bridge: 'ha', rawId, uid: `ha:${rawId}` };
  }
  if (mappedId.startsWith('homey:')) {
    const rawId = mappedId.slice(6);
    return { bridge: 'homey', rawId, uid: `homey:${rawId}` };
  }
  return { bridge: 'homey', rawId: mappedId, uid: `homey:${mappedId}` };
}

function updateConnectionBadges() {
  const homeyCard = document.getElementById('bridge-card-homey');
  if (homeyCard) homeyCard.classList.toggle('is-connected', homeyConnected);
  const haCard = document.getElementById('bridge-card-ha');
  if (haCard) haCard.classList.toggle('is-connected', haConnected);

  const homeyBadge = document.getElementById('conn-status-homey');
  if (homeyBadge) {
    homeyBadge.textContent = homeyConnected ? `Live (${homeyDevicesList.length})` : 'Aus';
    homeyBadge.classList.toggle('connected', homeyConnected);
  }
  const haBadge = document.getElementById('conn-status-ha');
  if (haBadge) {
    haBadge.textContent = haConnected ? `Live (${haEntitiesList.length})` : 'Aus';
    haBadge.classList.toggle('connected', haConnected);
  }
  const statusBadge = document.getElementById('conn-status');
  if (statusBadge) {
    const parts = [];
    if (homeyConnected) parts.push(`Homey (${homeyDevicesList.length})`);
    if (haConnected) parts.push(`HA (${haEntitiesList.length})`);
    if (parts.length > 0) {
      statusBadge.textContent = `Live: ${parts.join(' · ')}`;
      statusBadge.classList.add('connected');
    } else {
      statusBadge.textContent = window.t ? window.t('conn.offline', 'Simulation (Offline)') : 'Simulation (Offline)';
      statusBadge.classList.remove('connected');
    }
  }
}

// Standard-Konfiguration (wird durch localStorage oder /api/config aus config.json überschrieben)
const EMBEDDED_DEFAULT_CONFIG = {
  ip: "",
  token: "",
  haUrl: "",
  haToken: "",
  mapping: {}
};

try {
  const savedIp = localStorage.getItem('homey_3d_ip') || EMBEDDED_DEFAULT_CONFIG.ip;
  const savedToken = localStorage.getItem('homey_3d_token') || EMBEDDED_DEFAULT_CONFIG.token;
  const savedHaUrl = localStorage.getItem('homey_3d_ha_url') || EMBEDDED_DEFAULT_CONFIG.haUrl;
  const savedHaToken = localStorage.getItem('homey_3d_ha_token') || EMBEDDED_DEFAULT_CONFIG.haToken;
  const savedMap = localStorage.getItem('homey_3d_mapping');
  if (savedIp && document.getElementById('homey-ip')) document.getElementById('homey-ip').value = savedIp;
  if (savedToken && document.getElementById('homey-token')) document.getElementById('homey-token').value = savedToken;
  if (savedHaUrl && document.getElementById('ha-url')) document.getElementById('ha-url').value = savedHaUrl;
  if (savedHaToken && document.getElementById('ha-token')) document.getElementById('ha-token').value = savedHaToken;
  if (savedMap) {
    deviceMapping = { ...EMBEDDED_DEFAULT_CONFIG.mapping, ...JSON.parse(savedMap) };
  } else {
    deviceMapping = { ...EMBEDDED_DEFAULT_CONFIG.mapping };
  }
} catch (e) {
  deviceMapping = { ...EMBEDDED_DEFAULT_CONFIG.mapping };
}

// Schneller lokaler Cache für sofortige 0ms-Anzeige (Optimistic UI / kein Warten auf Homey)
let cacheSaveTimer = null;
let _lastSavedCacheStr = '';
function saveDeviceStatesToCache() {
  try {
    const cache = {};
    Object.keys(deviceObjects).forEach(id => {
      const obj = deviceObjects[id];
      if (!obj) return;
      cache[id] = {
        on: !!obj.data.on,
        dim: typeof obj.dim === 'number' ? obj.dim : null,
        color: obj.currentColor || (obj.data.color ? ('#' + obj.data.color.toString(16).padStart(6, '0')) : null),
        customText: obj.lastCustomLabel || null
      };
    });
    const str = JSON.stringify(cache);
    if (str !== _lastSavedCacheStr) {
      _lastSavedCacheStr = str;
      localStorage.setItem('homey_3d_device_cache', str);
    }
  } catch (e) {}
}

function debounceSaveDeviceStates() {
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(saveDeviceStatesToCache, 120);
}

function restoreCachedDeviceStates() {
  try {
    const raw = localStorage.getItem('homey_3d_device_cache');
    if (!raw) return;
    const cache = JSON.parse(raw);
    if (!cache || typeof cache !== 'object') return;
    Object.keys(cache).forEach(id => {
      const item = cache[id];
      const obj = deviceObjects[id];
      if (!obj || !item) return;
      if (typeof item.dim === 'number') obj.dim = item.dim;
      if (item.color && (obj.data.type === 'led' || obj.data.type === 'nanoleaf')) {
        obj.currentColor = item.color;
        const hexInt = parseInt(item.color.replace('#', ''), 16);
        if (!isNaN(hexInt)) {
          obj.data.color = hexInt;
          if (obj.light) obj.light.color.setHex(hexInt);
          if (obj.fillLight) obj.fillLight.color.setHex(hexInt);
          if (obj.glowMat) obj.glowMat.color.setHex(hexInt);
          if (obj.haloMat) obj.haloMat.color.setHex(hexInt);
        }
      }
      applyDeviceState(id, item.on, item.customText);
    });
  } catch (e) {}
}

// Wenn ein Licht nicht zugewiesen ist, ist es standardmäßig AUS
function turnOffUnassignedLights() {
  Object.keys(deviceObjects).forEach(id => {
    const obj = deviceObjects[id];
    if (!obj) return;
    const isLamp = obj.data.type === 'light' || obj.data.type === 'led' || obj.data.type === 'panel_leds' || obj.data.type === 'nanoleaf';
    if (isLamp && !deviceMapping[id]) {
      applyDeviceState(id, false);
    }
  });
}
turnOffUnassignedLights();
// Zuletzt gespeicherten Live-Status sofort beim Laden anzeigen (0ms Wartezeit!)
restoreCachedDeviceStates();

const LOCAL_SERVER_API = window.location.protocol.startsWith('http')
  ? `${window.location.origin}/api/config`
  : 'http://localhost:8765/api/config';

function clearHouseScene() {
  while (houseRoot.children.length > 0) {
    houseRoot.remove(houseRoot.children[0]);
  }
  wallMeshes.length = 0;
  collisionWalls.length = 0;
  allInteractiveDoorMeshes.length = 0;
  Object.keys(apartmentDoors).forEach(k => delete apartmentDoors[k]);
  Object.keys(deviceObjects).forEach(k => delete deviceObjects[k]);
  window.windowShutters = [];
  labelsContainer.innerHTML = '';
}

function updateHouseModeBadge(houseCfg) {
  const badge = document.getElementById('house-mode-badge');
  if (!badge) return;
  const isCustom = !!(houseCfg && (houseCfg.mode === 'custom' || houseCfg.mode === 'preset'));
  badge.textContent = isCustom ? (houseCfg.name || 'Eigenes Haus') : 'Demo-Wohnung';
  badge.classList.toggle('connected', isCustom);
}

window.rebuildHouseScene = function (houseCfg) {
  window._initialHouseBuilt = true;
  clearHouseScene();
  window.currentHouseConfig = houseCfg || null;
  if (!window.HouseEditor) return;

  const isDanielPreset = !!(
    houseCfg &&
    (houseCfg.preset === 'wohnung_daniel' || houseCfg.id === 'wohnung_daniel') &&
    typeof window.buildWohnungDaniel === 'function' &&
    Array.isArray(window.WOHNUNG_DANIEL_ROOMS)
  );

  if (isDanielPreset) {
    ROOMS = window.WOHNUNG_DANIEL_ROOMS;
    withHouseTarget(() => window.buildWohnungDaniel());
  } else {
    const isCustom = !!(houseCfg && houseCfg.mode === 'custom');
    const activeCfg = isCustom
      ? houseCfg
      : window.HouseEditor.createStarterApartmentTemplate('Demo-Wohnung (2-Zimmer)');

    ROOMS = window.HouseEditor.buildRoomsFromCustomHouse(activeCfg);
    withHouseTarget(() => window.HouseEditor.buildCustomHouse(activeCfg));
  }

  withHouseTarget(() => createDeviceLights());
  if (typeof window.rebuildDeviceRoomMap === 'function') window.rebuildDeviceRoomMap();
  turnOffUnassignedLights();
  restoreCachedDeviceStates();
  if (homeyConnected || haConnected) {
    syncAllBridgesOnce();
  }
  updateHouseModeBadge(houseCfg);
  requestSidebarRender(true);
  if (typeof updateLabels === 'function') updateLabels(true);
};

const _bootCfg = window.__INITIAL_CONFIG__ || null;
window.savedHouses = (() => {
  if (_bootCfg && Array.isArray(_bootCfg.houses)) {
    try { localStorage.setItem('homey_3d_houses', JSON.stringify(_bootCfg.houses)); } catch (e) {}
    return _bootCfg.houses;
  }
  try { return JSON.parse(localStorage.getItem('homey_3d_houses') || '[]') || []; } catch (e) { return []; }
})();
window.defaultHouseId = (() => {
  if (_bootCfg && _bootCfg.defaultHouseId) {
    try { localStorage.setItem('homey_3d_default_house', _bootCfg.defaultHouseId); } catch (e) {}
    return _bootCfg.defaultHouseId;
  }
  try { return localStorage.getItem('homey_3d_default_house') || 'demo'; } catch (e) { return 'demo'; }
})();
window.activeHouseId = window.defaultHouseId !== 'demo'
  ? window.defaultHouseId
  : ((_bootCfg && _bootCfg.activeHouseId) || ((() => { try { return localStorage.getItem('homey_3d_active_house') || 'demo'; } catch (e) { return 'demo'; } })()));
window._initialHouseBuilt = false;

if (_bootCfg) {
  const bIp = (_bootCfg.connections && _bootCfg.connections.homey && _bootCfg.connections.homey.ip) || _bootCfg.ip || '';
  const bToken = (_bootCfg.connections && _bootCfg.connections.homey && _bootCfg.connections.homey.token) || _bootCfg.token || '';
  const bHaUrl = (_bootCfg.connections && _bootCfg.connections.homeassistant && _bootCfg.connections.homeassistant.url) || '';
  const bHaToken = (_bootCfg.connections && _bootCfg.connections.homeassistant && _bootCfg.connections.homeassistant.token) || '';
  if (bIp && document.getElementById('homey-ip') && !document.getElementById('homey-ip').value) {
    document.getElementById('homey-ip').value = bIp;
    try { localStorage.setItem('homey_3d_ip', bIp); } catch (e) {}
  }
  if (bToken && document.getElementById('homey-token') && !document.getElementById('homey-token').value) {
    document.getElementById('homey-token').value = bToken;
    try { localStorage.setItem('homey_3d_token', bToken); } catch (e) {}
  }
  if (bHaUrl && document.getElementById('ha-url') && !document.getElementById('ha-url').value) {
    document.getElementById('ha-url').value = bHaUrl;
    try { localStorage.setItem('homey_3d_ha_url', bHaUrl); } catch (e) {}
  }
  if (bHaToken && document.getElementById('ha-token') && !document.getElementById('ha-token').value) {
    document.getElementById('ha-token').value = bHaToken;
    try { localStorage.setItem('homey_3d_ha_token', bHaToken); } catch (e) {}
  }
  if (_bootCfg.mapping && Object.keys(_bootCfg.mapping).length > 0) {
    deviceMapping = { ..._bootCfg.mapping, ...deviceMapping };
    try { localStorage.setItem('homey_3d_mapping', JSON.stringify(deviceMapping)); } catch (e) {}
  }
}

window.saveHouseConfig = function (houseCfg) {
  if (houseCfg && houseCfg.id) {
    const idx = window.savedHouses.findIndex(h => h.id === houseCfg.id);
    if (idx >= 0) {
      window.savedHouses[idx] = houseCfg;
    } else {
      window.savedHouses.push(houseCfg);
    }
    window.activeHouseId = houseCfg.id;
  } else {
    window.activeHouseId = 'demo';
  }
  try {
    localStorage.setItem('homey_3d_houses', JSON.stringify(window.savedHouses));
    localStorage.setItem('homey_3d_active_house', window.activeHouseId);
  } catch (e) {}
  if (window.HouseEditor && typeof window.HouseEditor.renderHouseSelector === 'function') {
    window.HouseEditor.renderHouseSelector();
  }
  pushConfigToServer(false);
};

function collectCurrentSettings() {
  return {
    theme: localStorage.getItem('homey_3d_bg_theme') || 'mica',
    lang: typeof getLanguagePref === 'function' ? getLanguagePref() : (localStorage.getItem('homey_3d_lang') || 'auto'),
    wallHeight: typeof currentWallHeight === 'number' ? currentWallHeight : 1.8,
    ambient: document.getElementById('ambient-slider') ? Number(document.getElementById('ambient-slider').value) : 0.35,
    showLabels: typeof labelsVisible === 'boolean' ? labelsVisible : true,
    showGrid: typeof gridEnabled === 'boolean' ? gridEnabled : true,
    showPedestal: typeof pedestalEnabled === 'boolean' ? pedestalEnabled : false,
    auroraAnim: typeof auroraAnimEnabled === 'boolean' ? auroraAnimEnabled : true,
    groundShadow: typeof groundShadowEnabled === 'boolean' ? groundShadowEnabled : false,
    demoFpvStart: window.demoFpvStart || null
  };
}

async function pushConfigToServer(showNotification = false) {
  if (!window.location.protocol.startsWith('http') && window.location.hostname !== 'localhost') return;
  try {
    const ip = (document.getElementById('homey-ip')?.value || '').trim() || localStorage.getItem('homey_3d_ip') || '';
    const token = (document.getElementById('homey-token')?.value || '').trim() || localStorage.getItem('homey_3d_token') || '';
    const haUrl = (document.getElementById('ha-url')?.value || '').trim() || localStorage.getItem('homey_3d_ha_url') || '';
    const haToken = (document.getElementById('ha-token')?.value || '').trim() || localStorage.getItem('homey_3d_ha_token') || '';
    const payload = {
      connections: {
        homey: { ip, token },
        homeassistant: { url: haUrl, token: haToken }
      },
      ip,
      token,
      mapping: deviceMapping,
      settings: collectCurrentSettings(),
      pictures: [1, 2, 3, 4, 5]
        .map(slot => localStorage.getItem('homey_picture_img_' + slot) || null)
        .filter(Boolean),
      defaultHouseId: window.defaultHouseId || 'demo',
      activeHouseId: window.activeHouseId || 'demo',
      houses: window.savedHouses || []
    };
    const res = await fetch(LOCAL_SERVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok && showNotification) {
      showToast('✅ Konfiguration in config.json gespeichert!');
    }
  } catch (e) {}
}

async function pullConfigFromServerIfNeeded() {
  try {
    let res = await fetch(LOCAL_SERVER_API).catch(() => null);
    if (!res || !res.ok) {
      res = await fetch(`./config.json?t=${Date.now()}`).catch(() => null);
    }
    if (!res || !res.ok) return;
    const cfg = await res.json();
    let changedHomey = false;
    let changedHa = false;

    const cfgIp = (cfg.connections && cfg.connections.homey && cfg.connections.homey.ip) || cfg.ip || '';
    const cfgToken = (cfg.connections && cfg.connections.homey && cfg.connections.homey.token) || cfg.token || '';
    const cfgHaUrl = (cfg.connections && cfg.connections.homeassistant && cfg.connections.homeassistant.url) || '';
    const cfgHaToken = (cfg.connections && cfg.connections.homeassistant && cfg.connections.homeassistant.token) || '';

    if (cfgIp && document.getElementById('homey-ip') && !document.getElementById('homey-ip').value) {
      document.getElementById('homey-ip').value = cfgIp;
      localStorage.setItem('homey_3d_ip', cfgIp);
      changedHomey = true;
    }
    if (cfgToken && document.getElementById('homey-token') && !document.getElementById('homey-token').value) {
      document.getElementById('homey-token').value = cfgToken;
      localStorage.setItem('homey_3d_token', cfgToken);
      changedHomey = true;
    }
    if (cfgHaUrl && document.getElementById('ha-url') && !document.getElementById('ha-url').value) {
      document.getElementById('ha-url').value = cfgHaUrl;
      localStorage.setItem('homey_3d_ha_url', cfgHaUrl);
      changedHa = true;
    }
    if (cfgHaToken && document.getElementById('ha-token') && !document.getElementById('ha-token').value) {
      document.getElementById('ha-token').value = cfgHaToken;
      localStorage.setItem('homey_3d_ha_token', cfgHaToken);
      changedHa = true;
    }
    if (cfg.mapping && Object.keys(cfg.mapping).length > 0) {
      deviceMapping = { ...cfg.mapping, ...deviceMapping };
      localStorage.setItem('homey_3d_mapping', JSON.stringify(deviceMapping));
      changedHomey = true;
      changedHa = true;
    }
    if (cfg.settings) {
      if (cfg.settings.theme && typeof setBackgroundTheme === 'function') {
        setBackgroundTheme(cfg.settings.theme, false);
      }
      if (typeof cfg.settings.wallHeight === 'number' && typeof updateWallHeight === 'function') {
        const ws = document.getElementById('wall-slider');
        if (ws) ws.value = cfg.settings.wallHeight;
        updateWallHeight(cfg.settings.wallHeight);
      }
      if (typeof cfg.settings.ambient === 'number' && typeof updateAmbient === 'function') {
        const as = document.getElementById('ambient-slider');
        if (as) as.value = cfg.settings.ambient;
        updateAmbient(cfg.settings.ambient);
      }
      if (typeof cfg.settings.showGrid === 'boolean' && typeof toggle3DGrid === 'function') {
        toggle3DGrid(cfg.settings.showGrid);
      }
      if (typeof cfg.settings.showPedestal === 'boolean' && typeof togglePedestal === 'function') {
        togglePedestal(cfg.settings.showPedestal);
      }
      if (typeof cfg.settings.auroraAnim === 'boolean' && typeof toggleAuroraAnim === 'function') {
        toggleAuroraAnim(cfg.settings.auroraAnim);
      }
      if (typeof cfg.settings.groundShadow === 'boolean' && typeof toggleGroundShadow === 'function') {
        toggleGroundShadow(cfg.settings.groundShadow);
      }
      if (cfg.settings.demoFpvStart) {
        window.demoFpvStart = cfg.settings.demoFpvStart;
      }
      if (cfg.settings.lang && typeof setLanguage === 'function' && !localStorage.getItem('homey_3d_lang')) {
        setLanguage(cfg.settings.lang, true);
      }
    }
    const picList = Array.isArray(cfg.pictures) ? cfg.pictures : [];
    picList.slice(0, 5).forEach((dataUrl, idx) => {
      if (dataUrl && typeof applyDataUrlToPictureFrame === 'function') {
        applyDataUrlToPictureFrame(idx + 1, dataUrl);
      }
    });
    // Load multiple houses & cache in localStorage for instant 0ms next load
    if (Array.isArray(cfg.houses) && cfg.houses.length > 0) {
      window.savedHouses = cfg.houses;
      try { localStorage.setItem('homey_3d_houses', JSON.stringify(cfg.houses)); } catch (e) {}
    } else if (cfg.house && cfg.house.mode === 'custom') {
      window.savedHouses = [{ id: cfg.house.id || 'house_1', ...cfg.house }];
      try { localStorage.setItem('homey_3d_houses', JSON.stringify(window.savedHouses)); } catch (e) {}
    }
    window.defaultHouseId = cfg.defaultHouseId || localStorage.getItem('homey_3d_default_house') || 'demo';
    try { localStorage.setItem('homey_3d_default_house', window.defaultHouseId); } catch (e) {}
    const startHouseId = window.defaultHouseId !== 'demo' ? window.defaultHouseId : (cfg.activeHouseId || localStorage.getItem('homey_3d_active_house') || 'demo');
    window.activeHouseId = startHouseId;
    try { localStorage.setItem('homey_3d_active_house', window.activeHouseId); } catch (e) {}

    const currentBuiltId = window.currentHouseConfig ? window.currentHouseConfig.id : (window._initialHouseBuilt ? 'demo' : null);
    if (window.activeHouseId !== 'demo') {
      const activeHouse = window.savedHouses.find(h => h.id === window.activeHouseId);
      if (activeHouse) {
        if (currentBuiltId !== activeHouse.id) {
          window.rebuildHouseScene(activeHouse);
        }
      } else {
        window.activeHouseId = 'demo';
        window.defaultHouseId = 'demo';
        if (currentBuiltId !== 'demo') {
          window.rebuildHouseScene(null);
        }
      }
    } else if (currentBuiltId !== 'demo') {
      window.rebuildHouseScene(null);
    }
    if (window.HouseEditor && typeof window.HouseEditor.renderHouseSelector === 'function') {
      window.HouseEditor.renderHouseSelector();
    }
    if (changedHomey && document.getElementById('homey-ip')?.value && document.getElementById('homey-token')?.value) {
      connectToHomey(true);
    }
    if (changedHa && document.getElementById('ha-url')?.value && document.getElementById('ha-token')?.value) {
      connectToHomeAssistant(true);
    }
  } catch (e) {}
}

function exportFullConfig() {
  const data = {
    connections: {
      homey: {
        ip: (document.getElementById('homey-ip')?.value || '').trim(),
        token: (document.getElementById('homey-token')?.value || '').trim()
      },
      homeassistant: {
        url: (document.getElementById('ha-url')?.value || '').trim(),
        token: (document.getElementById('ha-token')?.value || '').trim()
      }
    },
    mapping: deviceMapping,
    settings: collectCurrentSettings(),
    house: window.currentHouseConfig || null
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'homey-3d-config.json';
  a.click();
}

function importFullConfig(inputEl) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const cfg = JSON.parse(reader.result);
      const ip = (cfg.connections && cfg.connections.homey && cfg.connections.homey.ip) || cfg.ip || '';
      const token = (cfg.connections && cfg.connections.homey && cfg.connections.homey.token) || cfg.token || '';
      const haUrl = (cfg.connections && cfg.connections.homeassistant && cfg.connections.homeassistant.url) || '';
      const haToken = (cfg.connections && cfg.connections.homeassistant && cfg.connections.homeassistant.token) || '';
      if (ip && document.getElementById('homey-ip')) {
        document.getElementById('homey-ip').value = ip;
        localStorage.setItem('homey_3d_ip', ip);
      }
      if (token && document.getElementById('homey-token')) {
        document.getElementById('homey-token').value = token;
        localStorage.setItem('homey_3d_token', token);
      }
      if (haUrl && document.getElementById('ha-url')) {
        document.getElementById('ha-url').value = haUrl;
        localStorage.setItem('homey_3d_ha_url', haUrl);
      }
      if (haToken && document.getElementById('ha-token')) {
        document.getElementById('ha-token').value = haToken;
        localStorage.setItem('homey_3d_ha_token', haToken);
      }
      if (cfg.mapping) {
        deviceMapping = cfg.mapping;
        localStorage.setItem('homey_3d_mapping', JSON.stringify(deviceMapping));
      }
      if (cfg.house && cfg.house.mode === 'custom') {
        window.rebuildHouseScene(cfg.house);
      } else if (cfg.house === null) {
        window.rebuildHouseScene(null);
      }
      pushConfigToServer(true);
      if (ip && token) connectToHomey();
      if (haUrl && haToken) connectToHomeAssistant();
    } catch (err) {
      showToast('❌ Import fehlgeschlagen: ' + err.message);
    }
  };
  reader.readAsText(file);
  inputEl.value = '';
}
// Auf Node-Server (mit /api/bootstrap.js) schwere Wandbilder erst nach dem ersten Render laden;
// auf statischen Servern (z.B. Homey Port 5080) config.json sofort laden.
if (window.__INITIAL_CONFIG__) {
  setTimeout(() => { pullConfigFromServerIfNeeded(); }, 1800);
} else {
  pullConfigFromServerIfNeeded();
}

function saveMapping(dev3dId, mappedId) {
  if (!mappedId) {
    delete deviceMapping[dev3dId];
    const obj = deviceObjects[dev3dId];
    if (obj && (obj.data.type === 'light' || obj.data.type === 'led' || obj.data.type === 'panel_leds' || obj.data.type === 'nanoleaf')) {
      applyDeviceState(dev3dId, false);
    }
  } else {
    deviceMapping[dev3dId] = mappedId;
  }
  try {
    localStorage.setItem('homey_3d_mapping', JSON.stringify(deviceMapping));
  } catch (e) {}
  renderSidebar();
  syncAllBridgesOnce();
  pushConfigToServer(false);
}

function get3dDeviceNameById(dev3dId) {
  for (const r of ROOMS) {
    for (const d of r.devices) {
      if (d.id === dev3dId) return d.name;
    }
  }
  return dev3dId;
}

function renderSidebar() {
  const list = document.getElementById('rooms-list');
  list.innerHTML = '';

  // Map: Unified-UID ('homey:<id>' | 'ha:<entity_id>') -> 3D-Device-ID
  const usedBy3d = {};
  Object.entries(deviceMapping).forEach(([d3d, mappedId]) => {
    const parsed = parseMappingTarget(mappedId);
    if (parsed) usedBy3d[parsed.uid] = d3d;
  });

  const hasAnyBridge = (homeyConnected && homeyDevicesList.length > 0) || (haConnected && haEntitiesList.length > 0);

  ROOMS.forEach(room => {
    const group = document.createElement('div');
    group.className = 'room-group';
    group.innerHTML = `
      <div class="room-header">
        <span>${room.name}</span>
        <span class="dims">${room.dims}</span>
      </div>
      <div class="device-list" id="devlist-${room.id}"></div>
    `;
    list.appendChild(group);

    const devList = group.querySelector(`#devlist-${room.id}`);
    room.devices.forEach(dev => {
      const wrapper = document.createElement('div');
      wrapper.className = 'device-row-card';

      const item = document.createElement('div');
      item.className = `device-item ${dev.on ? 'active' : ''}`;
      item.id = `sidebar-dev-${dev.id}`;
      const isControllableLight = dev.type === 'led' || dev.type === 'nanoleaf' || dev.type === 'panel_leds';
      const isBlinds = dev.type === 'blinds';
      item.onclick = (e) => {
        toggleDevice(dev.id);
      };
      item.innerHTML = `
        <div class="device-info">
          <div class="device-dot"></div>
          <span>${dev.icon} ${dev.name}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          ${isControllableLight ? `<span style="font-size: 0.82rem; cursor: pointer; padding: 2px 4px; border-radius: 4px; background: rgba(255,255,255,0.08);" title="Farbe & Dimmen anpassen" onclick="event.stopPropagation(); openControlCard('${dev.id}', event.clientX, event.clientY)">🎨</span>` : ''}
          ${isBlinds ? `<span style="font-size: 0.82rem; cursor: pointer; padding: 2px 4px; border-radius: 4px; background: rgba(255,255,255,0.08);" title="Position einstellen" onclick="event.stopPropagation(); openControlCard('${dev.id}', event.clientX, event.clientY)">🎚️</span>` : ''}
          <span class="device-state">${getStatusLabel(dev, dev.on)}</span>
        </div>
      `;
      wrapper.appendChild(item);

      // Wenn mindestens eine Bridge verbunden ist: Moderne Mapping-Zeile mit Bridge-Badge & Dropdown anzeigen
      if (hasAnyBridge) {
        const currentParsed = parseMappingTarget(deviceMapping[dev.id]);
        const currentUid = currentParsed ? currentParsed.uid : '';
        const mapRow = document.createElement('div');
        mapRow.className = 'mapping-row';

        const bridgePill = document.createElement('span');
        if (currentParsed && currentParsed.bridge === 'ha') {
          bridgePill.className = 'mapping-bridge-pill is-ha';
          bridgePill.textContent = '🏠 HA';
        } else if (currentParsed && currentParsed.bridge === 'homey') {
          bridgePill.className = 'mapping-bridge-pill is-homey';
          bridgePill.textContent = '🌐 Homey';
        } else {
          bridgePill.className = 'mapping-bridge-pill';
          bridgePill.textContent = '🔗 Offen';
        }

        const sel = document.createElement('select');
        sel.className = 'homey-select';
        if (currentParsed && currentParsed.bridge === 'ha') {
          sel.classList.add('is-mapped-ha');
        } else if (currentParsed && currentParsed.bridge === 'homey') {
          sel.classList.add('is-mapped-homey');
        }
        sel.onchange = (e) => saveMapping(dev.id, e.target.value);

        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = 'Gerät / Entity verknüpfen...';
        sel.appendChild(emptyOpt);

        const usedGroup = document.createElement('optgroup');
        usedGroup.label = '✅ Bereits vergeben';

        if (homeyConnected && homeyDevicesList.length > 0) {
          const homeyGroup = document.createElement('optgroup');
          homeyGroup.label = '🌐 Homey Pro';
          homeyDevicesList.forEach(hDev => {
            const uid = `homey:${hDev.id}`;
            const assignedToOther = usedBy3d[uid] && usedBy3d[uid] !== dev.id;
            const opt = document.createElement('option');
            opt.value = uid;

            if (currentUid === uid) {
              opt.textContent = `✓ ${hDev.name}`;
              opt.selected = true;
              homeyGroup.appendChild(opt);
            } else if (assignedToOther) {
              const otherName = get3dDeviceNameById(usedBy3d[uid]);
              opt.textContent = `✓ ${hDev.name} [${otherName}]`;
              opt.style.color = '#64748b';
              usedGroup.appendChild(opt);
            } else {
              opt.textContent = hDev.name;
              homeyGroup.appendChild(opt);
            }
          });
          sel.appendChild(homeyGroup);
        }

        if (haConnected && haEntitiesList.length > 0 && window.HAConnector) {
          const haGroup = document.createElement('optgroup');
          haGroup.label = '🏠 Home Assistant';
          haEntitiesList.forEach(ent => {
            const uid = `ha:${ent.entity_id}`;
            const labelName = `${window.HAConnector.getEntityName(ent)} (${ent.entity_id})`;
            const assignedToOther = usedBy3d[uid] && usedBy3d[uid] !== dev.id;
            const opt = document.createElement('option');
            opt.value = uid;

            if (currentUid === uid) {
              opt.textContent = `✓ ${labelName}`;
              opt.selected = true;
              haGroup.appendChild(opt);
            } else if (assignedToOther) {
              const otherName = get3dDeviceNameById(usedBy3d[uid]);
              opt.textContent = `✓ ${labelName} [${otherName}]`;
              opt.style.color = '#64748b';
              usedGroup.appendChild(opt);
            } else {
              opt.textContent = labelName;
              haGroup.appendChild(opt);
            }
          });
          sel.appendChild(haGroup);
        }

        if (usedGroup.children.length > 0) {
          sel.appendChild(usedGroup);
        }

        mapRow.appendChild(bridgePill);
        mapRow.appendChild(sel);
        wrapper.appendChild(mapRow);
      }

      devList.appendChild(wrapper);
    });
  });
}

let sidebarNeedsRender = true;
function requestSidebarRender(force = false) {
  const sb = document.getElementById('sidebar');
  const isVisible = sb && sb.style.display !== 'none' && getComputedStyle(sb).display !== 'none';
  if (isVisible || force) {
    renderSidebar();
    sidebarNeedsRender = false;
  } else {
    sidebarNeedsRender = true;
  }
}

if (window.location.search.includes('setup=1')) {
  renderSidebar();
  sidebarNeedsRender = false;
}

let homeyRawDevicesById = {}; // Speichert die aktuellen Rohdaten aller Homey-Geräte

function getStatusLabel(dev, state, customText) {
  if (customText) return customText;
  if (dev.type === 'sensor') {
    if (dev.id.includes('praesenz')) return state ? '👤 PRÄSENZ!' : 'Frei';
    return state ? '🏃 BEWEGUNG!' : 'Ruhig';
  }
  if (dev.type === 'vacuum') {
    return state ? 'Saugt & Wischt' : '⚡ Station';
  }
  if (dev.type === 'hub') {
    return state ? '🌐 Online' : 'Aus';
  }
  if (dev.type === 'blinds') {
    const obj = deviceObjects[dev.id];
    const pct = Math.round(((obj && typeof obj.dim === 'number') ? obj.dim : 1) * 100);
    if (pct <= 2) return 'Zu (0%)';
    if (pct >= 98) return 'Offen (100%)';
    return `${pct}% offen`;
  }
  return state ? 'AN' : 'AUS';
}

function applyDeviceState(id, state, customText = null) {
  const obj = deviceObjects[id];
  if (!obj) return;
  const dimFactor = (typeof obj.dim === 'number') ? obj.dim : 1.0;
  const colorVal = obj.currentColor || obj.data.color;

  // Vermeidet tausende unnötige DOM- & Material-Updates wenn der Zustand unverändert ist
  if (obj._hasApplied &&
      obj.data.on === state &&
      obj._lastDim === dimFactor &&
      obj._lastCustomText === customText &&
      obj._lastColor === colorVal) {
    return;
  }
  const isFirstApply = !obj._hasApplied;
  obj._hasApplied = true;
  obj._lastDim = dimFactor;
  obj._lastCustomText = customText;
  obj._lastColor = colorVal;
  obj.data.on = state;
  obj.light.intensity = state ? obj.maxIntensity * dimFactor : 0;
  if (obj.isLampSource) {
    obj.light.castShadow = state;
  }
  if (obj.fillLight) {
    const fillFactor = (id === 'wz_lowboard_led' || id === 'sz_lowboard_led') ? 0.85 : 0.45;
    obj.fillLight.intensity = state ? obj.maxIntensity * dimFactor * fillFactor : 0;
  }
  if (obj.haloMat) {
    obj.haloMat.opacity = state ? obj.haloOpacityOn * dimFactor : 0.0;
  }

  if (obj.data.type === 'nanoleaf') {
    obj.glowMesh.traverse(c => {
      if (c.isMesh && c.material) {
        if (c.userData && c.userData.isBacklight) {
          c.material.opacity = state ? 0.65 * dimFactor : 0.0;
        } else if (c.userData && c.userData.isBar) {
          c.material.opacity = state ? 0.95 * dimFactor : 0.20;
        } else if (c.material.transparent) {
          c.material.opacity = state ? 0.95 : 0.18;
        }
      }
    });
  } else if (obj.data.type === 'panel_leds') {
    obj.glowMat.opacity = state ? 0.92 : 0.14;
    obj.glowMesh.traverse(c => {
      if (c.isMesh && c.material && c.material !== obj.glowMat && c.material.transparent) {
        c.material.opacity = state ? 0.95 : 0.18;
      }
    });
  } else if (obj.data.type === 'tv') {
    obj.glowMat.opacity = state ? 1.0 : 0.0;
    if (obj.standbyLedMat) {
      obj.standbyLedMat.opacity = state ? 0.0 : 0.88;
    }
  } else if (obj.data.type === 'light') {
    obj.glowMat.opacity = state ? 0.78 : 0.14;
  } else if (obj.data.type === 'blinds') {
    obj.glowMat.opacity = state ? 0.85 : 0.25;
    if (obj.shutterControl) {
      obj.shutterControl.setPosition(dimFactor, isFirstApply);
    }
  } else {
    obj.glowMat.opacity = state ? 0.92 : 0.14;
  }

  const labelText = getStatusLabel(obj.data, state, customText);
  updateBadgeVisuals(id);
  if (obj.data.type === 'blinds') {
    const pct = Math.round(dimFactor * 100);
    obj.badge.classList.add('blinds-badge');
    obj.badge.innerHTML = `${obj.data.icon}<span class="blinds-pct">${pct}%</span>`;
  }
  if (obj.data.type === 'vacuum') {
    // Alle zweiten Emojis (⚡, 💨, ⏸️, 🔋, 🧼, 💧, 🤖) aus dem Text entfernen, damit NIE zwei Icons im Badge sind
    const cleanLabel = labelText.replace(/[🤖🧼💧⚡💨⏸️🔋🏠]/g, '').replace(/\s+/g, ' ').trim();
    obj.lastCustomLabel = cleanLabel;
    obj.badge.classList.remove('vacuum-status');
    if (state) {
      obj.badge.classList.add('vacuum-live');
      obj.badge.innerHTML = `🤖 <span>${cleanLabel}</span>`;
    } else {
      // Wenn er in der Station steht: normales, sauberes rundes 🤖-Icon (wie bei den anderen Geräten)
      obj.badge.classList.remove('vacuum-live');
      obj.badge.innerHTML = obj.data.icon;
    }
  }
  obj.badge.title = `${obj.data.name}: ${labelText}`;

  const sbItem = document.getElementById(`sidebar-dev-${id}`);
  if (sbItem) {
    sbItem.classList.toggle('active', state);
    sbItem.querySelector('.device-state').textContent = labelText;
  }

  if (activeControlDevId === id) {
    const card = document.getElementById('light-control-card');
    if (card && !card.classList.contains('hidden')) {
      const powerBtn = document.getElementById('ctrl-power-btn');
      powerBtn.classList.toggle('active', state);
      const pct = Math.round(dimFactor * 100);
      if (obj.data.type === 'blinds') {
        document.getElementById('ctrl-power-text').textContent = pct > 50 ? 'ROLLADE SCHLIESSEN (0%)' : 'ROLLADE ÖFFNEN (100%)';
        document.getElementById('ctrl-status-sub').textContent = pct <= 2 ? 'ZU · 0%' : (pct >= 98 ? 'OFFEN · 100%' : `OFFEN · ${pct}%`);
      } else {
        document.getElementById('ctrl-power-text').textContent = state ? 'GERÄT AUSSCHALTEN' : 'GERÄT EINSCHALTEN';
        document.getElementById('ctrl-status-sub').textContent = state ? `AN · ${pct}%` : 'AUS';
      }
    }
  }
  debounceSaveDeviceStates();
}

function updateBadgeVisuals(id) {
  const obj = deviceObjects[id];
  if (!obj || !obj.badge) return;
  const state = obj.data.on;
  obj.badge.classList.toggle('on', state);

  if (state && (obj.data.type === 'led' || obj.data.type === 'nanoleaf')) {
    const hex = obj.currentColor || ('#' + obj.data.color.toString(16).padStart(6, '0'));
    obj.badge.style.background = `linear-gradient(135deg, ${hex}, ${hex}cc)`;
    obj.badge.style.boxShadow = `0 0 18px ${hex}cc, 0 4px 12px rgba(0,0,0,0.5)`;
    obj.badge.style.borderColor = '#ffffff';
    obj.badge.style.color = '#ffffff';
  } else if (!state) {
    obj.badge.style.background = '';
    obj.badge.style.boxShadow = '';
    obj.badge.style.borderColor = '';
    obj.badge.style.color = '';
  }
}

// Color conversion helpers (RGB <-> HSV)
function hexToHsv(hex) {
  let r = parseInt(hex.slice(1, 3), 16) / 255;
  let g = parseInt(hex.slice(3, 5), 16) / 255;
  let b = parseInt(hex.slice(5, 7), 16) / 255;
  let max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, v = max;
  let d = max - min;
  s = max === 0 ? 0 : d / max;
  if (max === min) {
    h = 0;
  } else {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, v };
}

function hsvToHex(h, s, v) {
  let r, g, b;
  let i = Math.floor(h * 6);
  let f = h * 6 - i;
  let p = v * (1 - s);
  let q = v * (1 - f * s);
  let t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

const COLOR_PRESETS = [
  { name: 'Warmweiß', hex: '#ffdfa9' },
  { name: 'Kaltweiß', hex: '#ffffff' },
  { name: 'Rot', hex: '#ef4444' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Gelb', hex: '#facc15' },
  { name: 'Grün', hex: '#22c55e' },
  { name: 'Türkis / Cyan', hex: '#06b6d4' },
  { name: 'Blau', hex: '#3b82f6' },
  { name: 'Lila', hex: '#8b5cf6' },
  { name: 'Pink', hex: '#ec4899' }
];

function openControlCard(devId, clientX = null, clientY = null) {
  const obj = deviceObjects[devId];
  if (!obj) return;
  activeControlDevId = devId;

  const card = document.getElementById('light-control-card');
  const dev = obj.data;

  document.getElementById('ctrl-icon-badge').textContent = dev.icon;
  document.getElementById('ctrl-name').textContent = dev.name;

  const state = Boolean(dev.on);
  const pct = Math.round((typeof obj.dim === 'number' ? obj.dim : 1.0) * 100);
  const powerBtn = document.getElementById('ctrl-power-btn');
  powerBtn.classList.toggle('active', state);
  if (dev.type === 'blinds') {
    document.getElementById('ctrl-status-sub').textContent = pct <= 2 ? 'ZU · 0%' : (pct >= 98 ? 'OFFEN · 100%' : `OFFEN · ${pct}%`);
    document.getElementById('ctrl-power-text').textContent = pct > 50 ? 'ROLLADE SCHLIESSEN (0%)' : 'ROLLADE ÖFFNEN (100%)';
  } else {
    document.getElementById('ctrl-status-sub').textContent = state ? `AN · ${pct}%` : 'AUS';
    document.getElementById('ctrl-power-text').textContent = state ? 'GERÄT AUSSCHALTEN' : 'GERÄT EINSCHALTEN';
  }

  const slider = document.getElementById('ctrl-dim-slider');
  const dimTitle = document.getElementById('ctrl-dim-title');
  if (dev.type === 'blinds') {
    if (dimTitle) dimTitle.textContent = '🪟 Position (0% Zu – 100% Offen)';
    slider.min = '0';
  } else {
    if (dimTitle) dimTitle.textContent = '🔅 Helligkeit (Dimmen)';
    slider.min = '1';
  }
  slider.value = pct;
  document.getElementById('ctrl-dim-label').textContent = `${pct}%`;

  // Color Section: only for led and nanoleaf (NOT for az_wandlicht)
  const colorSection = document.getElementById('ctrl-color-section');
  const isColorDevice = (dev.type === 'led' || dev.type === 'nanoleaf') && dev.id !== 'az_wandlicht';
  colorSection.style.display = isColorDevice ? 'block' : 'none';

  if (isColorDevice) {
    const hex = obj.currentColor || ('#' + dev.color.toString(16).padStart(6, '0'));
    document.getElementById('ctrl-color-label').textContent = hex;
    document.getElementById('ctrl-color-picker').value = hex;

    const presetsContainer = document.getElementById('ctrl-color-presets');
    presetsContainer.innerHTML = '';
    COLOR_PRESETS.forEach(p => {
      const btn = document.createElement('button');
      btn.className = `ctrl-color-btn ${p.hex.toLowerCase() === hex.toLowerCase() ? 'active' : ''}`;
      btn.style.backgroundColor = p.hex;
      btn.title = p.name;
      btn.onclick = () => onControlPresetClick(p.hex);
      presetsContainer.appendChild(btn);
    });
  }

  card.classList.remove('hidden');
  if (clientX !== null && clientY !== null) {
    const cardW = 296;
    const cardH = isColorDevice ? 340 : 200;
    let left = clientX + 16;
    let top = clientY - 40;
    if (left + cardW > window.innerWidth - 16) {
      left = Math.max(16, clientX - cardW - 16);
    }
    if (top + cardH > window.innerHeight - 16) {
      top = Math.max(16, window.innerHeight - cardH - 16);
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    card.style.transform = 'none';
  } else {
    card.style.left = '50%';
    card.style.top = '50%';
    card.style.transform = 'translate(-50%, -50%)';
  }
}

function closeControlCard() {
  const card = document.getElementById('light-control-card');
  if (card) card.classList.add('hidden');
  activeControlDevId = null;
}

function toggleActiveControlDevice() {
  if (!activeControlDevId) return;
  toggleDevice(activeControlDevId);
}

function onControlDimSlider(val) {
  if (!activeControlDevId) return;
  const numVal = parseInt(val, 10);
  document.getElementById('ctrl-dim-label').textContent = `${numVal}%`;
  const obj = deviceObjects[activeControlDevId];
  const minVal = (obj && obj.data && obj.data.type === 'blinds') ? 0.0 : 0.01;
  const floatVal = Math.max(minVal, Math.min(1.0, numVal / 100));
  setDeviceDim(activeControlDevId, floatVal);
}

function onControlPresetClick(hex) {
  if (!activeControlDevId) return;
  document.getElementById('ctrl-color-label').textContent = hex;
  document.getElementById('ctrl-color-picker').value = hex;
  setDeviceColor(activeControlDevId, hex);
  const presets = document.querySelectorAll('.ctrl-color-btn');
  presets.forEach(b => {
    b.classList.toggle('active', b.style.backgroundColor === hex || b.title.includes(hex));
  });
  const powerBtn = document.getElementById('ctrl-power-btn');
  powerBtn.classList.add('active');
  document.getElementById('ctrl-power-text').textContent = 'GERÄT AUSSCHALTEN';
}

function onControlColorPicker(hex) {
  if (!activeControlDevId) return;
  document.getElementById('ctrl-color-label').textContent = hex;
  setDeviceColor(activeControlDevId, hex);
  document.querySelectorAll('.ctrl-color-btn').forEach(b => b.classList.remove('active'));
  const powerBtn = document.getElementById('ctrl-power-btn');
  powerBtn.classList.add('active');
  document.getElementById('ctrl-power-text').textContent = 'GERÄT AUSSCHALTEN';
}

async function setDeviceColor(id, hexColor) {
  const obj = deviceObjects[id];
  if (!obj) return;
  obj.currentColor = hexColor;
  const hexInt = parseInt(hexColor.replace('#', ''), 16);
  obj.data.color = hexInt;

  if (obj.light) obj.light.color.setHex(hexInt);
  if (obj.fillLight) obj.fillLight.color.setHex(hexInt);
  if (obj.glowMat) obj.glowMat.color.setHex(hexInt);
  if (obj.haloMat) obj.haloMat.color.setHex(hexInt);

  if (obj.data.type === 'nanoleaf' && obj.glowMesh) {
    obj.glowMesh.traverse(c => {
      if (c.isMesh && c.material && (c.userData.isBar || c.userData.isBacklight)) {
        c.material.color.setHex(hexInt);
      }
    });
  }

  if (!obj.data.on) {
    applyDeviceState(id, true);
  } else {
    updateBadgeVisuals(id);
  }

  const mapped = parseMappingTarget(deviceMapping[id]);
  if (mapped && mapped.bridge === 'homey' && homeyConnected) {
    const hDev = homeyRawDevicesById[mapped.rawId];
    const caps = hDev ? (hDev.capabilitiesObj || {}) : {};
    const hsv = hexToHsv(hexColor);

    if (!obj.data.on && caps.onoff) {
      sendHomeyCapability(mapped.rawId, 'onoff', true);
    }
    if (caps.light_mode) {
      sendHomeyCapability(mapped.rawId, 'light_mode', 'color');
    }
    if (caps.light_hue) {
      sendHomeyCapability(mapped.rawId, 'light_hue', hsv.h);
    }
    if (caps.light_saturation) {
      sendHomeyCapability(mapped.rawId, 'light_saturation', hsv.s);
    }
  } else if (mapped && mapped.bridge === 'ha' && haConnected && window.HAConnector) {
    window.HAConnector.setColor(haBaseUrl, haToken, mapped.rawId, hexColor);
  }
}

function setDeviceDim(id, dimVal) {
  const obj = deviceObjects[id];
  if (!obj) return;
  obj.dim = dimVal;

  const pct = Math.round(dimVal * 100);
  if (obj.data.type === 'blinds') {
    if (obj.shutterControl) {
      obj.shutterControl.movingState = 'idle';
      obj.shutterControl.setPosition(dimVal);
    }
    const labelText = pct <= 2 ? 'Zu (0%)' : (pct >= 98 ? 'Offen (100%)' : `${pct}% offen`);
    applyDeviceState(id, dimVal < 0.98, labelText);
    const mapped = parseMappingTarget(deviceMapping[id]);
    if (mapped && mapped.bridge === 'homey' && homeyConnected) {
      sendHomeyDimDebounced(mapped.rawId, dimVal, 'windowcoverings_set');
    } else if (mapped && mapped.bridge === 'ha' && haConnected) {
      sendHaDimDebounced(mapped.rawId, obj.data, dimVal);
    }
    return;
  }

  if (obj.data.on) {
    obj.light.intensity = obj.maxIntensity * dimVal;
    if (obj.fillLight) {
      const fillFactor = (id === 'wz_lowboard_led' || id === 'sz_lowboard_led') ? 0.95 : 0.45;
      obj.fillLight.intensity = obj.maxIntensity * dimVal * fillFactor;
    }
    if (obj.haloMat) {
      obj.haloMat.opacity = obj.haloOpacityOn * dimVal;
    }
  }

  const sbItem = document.getElementById(`sidebar-dev-${id}`);
  if (sbItem && obj.data.on) {
    sbItem.querySelector('.device-state').textContent = `AN (${pct}%)`;
  }
  if (activeControlDevId === id && obj.data.on) {
    document.getElementById('ctrl-status-sub').textContent = `AN · ${pct}%`;
  }

  const mapped = parseMappingTarget(deviceMapping[id]);
  if (mapped && mapped.bridge === 'homey' && homeyConnected) {
    sendHomeyDimDebounced(mapped.rawId, dimVal, 'dim');
  } else if (mapped && mapped.bridge === 'ha' && haConnected) {
    sendHaDimDebounced(mapped.rawId, obj.data, dimVal);
  }
}

function sendHomeyDimDebounced(mappedHomeyId, dimVal, capName = 'dim') {
  if (dimDebounceTimer) clearTimeout(dimDebounceTimer);
  dimDebounceTimer = setTimeout(() => {
    sendHomeyCapability(mappedHomeyId, capName, dimVal);
  }, 150);
}

function sendHaDimDebounced(entityId, dev3d, dimVal) {
  if (dimDebounceTimer) clearTimeout(dimDebounceTimer);
  dimDebounceTimer = setTimeout(() => {
    if (window.HAConnector) {
      window.HAConnector.setDim(haBaseUrl, haToken, entityId, dev3d, dimVal);
    }
  }, 150);
}

document.addEventListener('pointerdown', (e) => {
  const card = document.getElementById('light-control-card');
  if (!card || card.classList.contains('hidden')) return;
  if (card.contains(e.target)) return;
  if (e.target.closest && (e.target.closest('.device-badge') || e.target.closest('.device-item'))) return;
  closeControlCard();
});

// Liest aus einem echten Homey-Gerät intelligent den passenden Status & Zusatzwerte (Bewegung, Präsenz, Sauger, Media, Licht)
function evaluateHomeyDevice(hDev, dev3d) {
  const caps = hDev.capabilitiesObj || {};
  const capKeys = Object.keys(caps);

  // Zusatzwerte sammeln (Temperatur, Helligkeit, Akku)
  const extras = [];
  if (caps.measure_temperature && typeof caps.measure_temperature.value === 'number') {
    extras.push(`${caps.measure_temperature.value.toFixed(1)}°C`);
  }
  if (caps.measure_luminance && typeof caps.measure_luminance.value === 'number') {
    extras.push(`${Math.round(caps.measure_luminance.value)} lx`);
  }
  if (caps.measure_battery && typeof caps.measure_battery.value === 'number') {
    extras.push(`🔋${Math.round(caps.measure_battery.value)}%`);
  }

  // 1. Saugroboter ZUERST prüfen (da der Roborock auch alarm_problem / alarm_stuck besitzt!)
  if (dev3d.type === 'vacuum' || caps.is_cleaning !== undefined || caps.vacuumcleaner_state !== undefined) {
    // Wichtig: In der Homey Roborock App bleibt is_cleaning nach der Rückkehr oft noch true,
    // während dock === true und battery_charging_state === 'charging' bereits melden, dass er in der Station steht!
    const isDocked = Boolean(caps.dock && caps.dock.value === true);
    const isCharging = Boolean(caps.battery_charging_state && caps.battery_charging_state.value === 'charging');
    const isPaused = Boolean(caps.pause_clean && caps.pause_clean.value === true);

    let active = false;
    if (!isDocked && !isCharging && !isPaused) {
      if (caps.is_cleaning && caps.is_cleaning.value === true) {
        active = true;
      } else if (caps.clean_full && caps.clean_full.value === true) {
        active = true;
      } else if (caps.dock && caps.dock.value === false) {
        active = true;
      } else if (caps.battery_charging_state && caps.battery_charging_state.value === 'discharging') {
        active = true;
      } else if (caps.vacuumcleaner_state !== undefined) {
        const vState = String(caps.vacuumcleaner_state.value || '').toLowerCase();
        active = vState === 'cleaning' || vState === 'spot_cleaning';
      }
    }

    let cleanText = 'Saugt & Wischt';
    if (caps.clean_mode) {
      const cm = String(caps.clean_mode.value);
      if (cm === '0') cleanText = 'Saugt';
      else if (cm === '2') cleanText = 'Wischt';
      else cleanText = 'Saugt & Wischt';
    } else if (caps.mop_attached && caps.mop_attached.value === false) {
      cleanText = 'Saugt';
    }

    if (active && caps.clean_area && typeof caps.clean_area.value === 'number' && caps.clean_area.value > 0) {
      cleanText += ` · ${caps.clean_area.value.toFixed(1)} m²`;
    }

    const batPct = caps.measure_battery?.value;
    const batStr = typeof batPct === 'number' ? ` (${Math.round(batPct)}%)` : '';
    let dockedText = `Station${batStr}`;
    if (caps.mop_dry_status && caps.mop_dry_status.value === true) {
      dockedText = `Trocknet Mopp${batStr}`;
    } else if (isCharging) {
      dockedText = (typeof batPct === 'number' && batPct < 100)
        ? `Lädt (${Math.round(batPct)}%)`
        : `Station (${Math.round(batPct || 100)}%)`;
    } else if (isPaused) {
      dockedText = `Pausiert${batStr}`;
    }

    const label = active ? cleanText : dockedText;
    return { active, label, cleanText, dockedText, extras, mode: 'vacuum', capKey: 'is_cleaning' };
  }

  // 1b. Rolladen / Jalousien (windowcoverings_set / windowcoverings_state: 0.0 = Zu, 1.0 = Offen)
  if (dev3d.type === 'blinds' || caps.windowcoverings_set !== undefined || caps.windowcoverings_state !== undefined) {
    let pos = 1.0;
    const rawState = caps.windowcoverings_state ? String(caps.windowcoverings_state.value || '').toLowerCase() : 'idle';
    if (caps.windowcoverings_set && typeof caps.windowcoverings_set.value === 'number') {
      pos = Math.max(0, Math.min(1, caps.windowcoverings_set.value));
    } else if (caps.windowcoverings_state) {
      if (rawState === 'down') pos = 0.0;
      else if (rawState === 'up') pos = 1.0;
      else pos = 0.5;
    }
    let movingState = 'idle';
    if (rawState === 'up' && pos < 0.99) movingState = 'up';
    else if (rawState === 'down' && pos > 0.01) movingState = 'down';
    const pct = Math.round(pos * 100);
    const label = pct <= 2 ? 'Zu (0%)' : (pct >= 98 ? 'Offen (100%)' : `${pct}% offen`);
    return { active: pos < 0.98, label, extras, mode: 'blinds', capKey: 'windowcoverings_set', position: pos, movingState };
  }

  // 2. Präsenz- oder Bewegungssensor-Capabilities prüfen
  const presenceKey = capKeys.find(k => k.includes('presence') || k.includes('occupancy') || k === 'alarm_human');
  const motionKey = capKeys.find(k => k.includes('motion'));
  const anyAlarmKey = capKeys.find(k => k.startsWith('alarm_') && k !== 'alarm_battery' && k !== 'alarm_tamper' && k !== 'alarm_problem' && k !== 'alarm_stuck' && k !== 'alarm_water_box_empty');

  if (dev3d.type === 'sensor' || (!caps.onoff && (presenceKey || motionKey || anyAlarmKey))) {
    const key = presenceKey || motionKey || anyAlarmKey;
    const active = key ? Boolean(caps[key]?.value) : false;
    let label = '';
    if (presenceKey || dev3d.id.includes('praesenz')) {
      label = active ? '👤 PRÄSENZ!' : 'Frei';
    } else {
      label = active ? '🏃 BEWEGUNG!' : 'Ruhig';
    }
    if (extras.length > 0) label += ` (${extras[0]})`;
    return { active, label, extras, mode: 'sensor', capKey: key };
  }

  // 3. Media / Alexa / Lautsprecher ohne onoff (speaker_playing)
  if (!caps.onoff && caps.speaker_playing) {
    const active = Boolean(caps.speaker_playing.value);
    const label = active ? '▶️ Spielt' : '⏸️ Pause';
    return { active, label, extras, mode: 'speaker', capKey: 'speaker_playing' };
  }

  // 4. Standard Schaltgeräte (onoff)
  if (caps.onoff) {
    const active = Boolean(caps.onoff.value);
    let label = active ? 'AN' : 'AUS';
    if (active && caps.dim && typeof caps.dim.value === 'number') {
      label = `AN (${Math.round(caps.dim.value * 100)}%)`;
    }
    return { active, label, extras, mode: 'onoff', capKey: 'onoff' };
  }

  // 5. Fallback (z.B. Homey Pro Hub oder reines Info-Gerät)
  return { active: true, label: extras.length ? extras.join(' · ') : '🌐 Aktiv', extras, mode: 'readonly', capKey: null };
}

async function sendHomeyCapability(homeyId, capability, value) {
  const res = await fetch(`${homeyBaseUrl}/api/manager/devices/device/${homeyId}/capability/${capability}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${homeyToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ value })
  });
  return res.ok;
}

async function toggleDevice(id) {
  const obj = deviceObjects[id];
  if (!obj) return;

  const mapped = parseMappingTarget(deviceMapping[id]);
  if (!mapped) {
    applyDeviceState(id, !obj.data.on);
    return;
  }

  // Home Assistant Bridge
  if (mapped.bridge === 'ha') {
    const entity = haEntitiesById[mapped.rawId];
    if (!haConnected || !entity || !window.HAConnector) {
      applyDeviceState(id, !obj.data.on);
      return;
    }
    const evalInfo = window.HAConnector.evaluateEntity(entity, obj.data);
    const haName = window.HAConnector.getEntityName(entity);

    if (evalInfo.mode === 'sensor') {
      const extraStr = evalInfo.extras.length ? ` | ${evalInfo.extras.join(' | ')}` : '';
      showToast(`${obj.data.icon} ${haName}: ${evalInfo.label}${extraStr}`);
      await syncFromHomeAssistantOnce();
      return;
    }

    const newState = !obj.data.on;
    try {
      if (evalInfo.mode === 'vacuum') {
        window.roborockCommandGraceUntil = Date.now() + 15000;
        applyDeviceState(id, newState, newState ? (evalInfo.cleanText || 'Saugt & Wischt') : (evalInfo.dockedText || 'Station'));
        await window.HAConnector.controlEntity(haBaseUrl, haToken, entity, obj.data, newState, evalInfo);
        showToast(newState ? `🤖 ${haName}: Reinigung gestartet!` : `🤖 ${haName}: Fährt zurück zur Station!`);
        return;
      }
      if (evalInfo.mode === 'blinds') {
        const currentPos = typeof obj.dim === 'number' ? obj.dim : 1.0;
        const targetPos = currentPos > 0.5 ? 0.0 : 1.0;
        obj.dim = targetPos;
        const pct = Math.round(targetPos * 100);
        applyDeviceState(id, targetPos < 0.98, targetPos <= 0.02 ? 'Zu (0%)' : 'Offen (100%)');
        await window.HAConnector.setDim(haBaseUrl, haToken, entity.entity_id, obj.data, targetPos);
        showToast(`🪟 ${haName}: ${pct <= 2 ? 'Fährt herunter (0% zu)' : 'Fährt hoch (100% offen)'}`);
        return;
      }
      if (evalInfo.mode === 'speaker') {
        applyDeviceState(id, newState, newState ? '▶️ Spielt' : '⏸️ Pause');
        await window.HAConnector.controlEntity(haBaseUrl, haToken, entity, obj.data, newState, evalInfo);
        showToast(newState ? `▶️ ${haName}: Wiedergabe` : `⏸️ ${haName}: Pause`);
        return;
      }
      applyDeviceState(id, newState);
      const ok = await window.HAConnector.controlEntity(haBaseUrl, haToken, entity, obj.data, newState, evalInfo);
      if (!ok) {
        showToast(`ℹ️ ${haName}: Status aktualisiert`);
        await syncFromHomeAssistantOnce();
      }
    } catch (err) {
      showToast('⚠️ Fehler bei der Kommunikation mit Home Assistant');
    }
    return;
  }

  // Homey Pro Bridge
  const mappedHomeyId = mapped.rawId;
  const hDev = mappedHomeyId ? homeyRawDevicesById[mappedHomeyId] : null;

  // Falls kein echtes Homey-Gerät verknüpft ist: Lokale 3D-Simulation umschalten
  if (!homeyConnected || !mappedHomeyId || !hDev) {
    applyDeviceState(id, !obj.data.on);
    return;
  }

  const evalInfo = evaluateHomeyDevice(hDev, obj.data);

  // 1. Sensor (Bewegung / Präsenz): Sensoren werden nicht geschaltet, sondern zeigen beim Klick ihre Live-Messwerte!
  if (evalInfo.mode === 'sensor') {
    const extraStr = evalInfo.extras.length ? ` | ${evalInfo.extras.join(' | ')}` : '';
    showToast(`${obj.data.icon} ${hDev.name}: ${evalInfo.label}${extraStr}`);
    await syncFromHomeyOnce();
    return;
  }

  const newState = !obj.data.on;

  try {
    // 2. Saugroboter: Per Klick direkt am echten Homey Pro starten (clean_full) oder zurück zur Station schicken (cancel_and_dock / dock)!
    if (evalInfo.mode === 'vacuum') {
      const caps = hDev.capabilitiesObj || {};
      window.roborockCommandGraceUntil = Date.now() + 15000;
      applyDeviceState(id, newState, newState ? (evalInfo.cleanText || 'Saugt & Wischt') : (evalInfo.dockedText || 'Station'));

      if (newState) {
        if (caps.clean_full) {
          await sendHomeyCapability(mappedHomeyId, 'clean_full', true);
        } else if (caps.onoff && caps.onoff.setable !== false) {
          await sendHomeyCapability(mappedHomeyId, 'onoff', true);
        } else if (caps.vacuumcleaner_state) {
          await sendHomeyCapability(mappedHomeyId, 'vacuumcleaner_state', 'cleaning');
        }
        showToast(`🤖 ${hDev.name}: Reinigung gestartet!`);
      } else {
        if (caps.cancel_and_dock) {
          await sendHomeyCapability(mappedHomeyId, 'cancel_and_dock', true);
        }
        if (caps.dock) {
          await sendHomeyCapability(mappedHomeyId, 'dock', true);
        } else if (caps.onoff && caps.onoff.setable !== false) {
          await sendHomeyCapability(mappedHomeyId, 'onoff', false);
        } else if (caps.vacuumcleaner_state) {
          await sendHomeyCapability(mappedHomeyId, 'vacuumcleaner_state', 'docked');
        }
        showToast(`🤖 ${hDev.name}: Fährt zurück zur Station!`);
      }
      return;
    }

    // 3. Rolladen / Jalousien (0% = Zu <-> 100% = Offen)
    if (evalInfo.mode === 'blinds') {
      const currentPos = typeof obj.dim === 'number' ? obj.dim : 1.0;
      const targetPos = currentPos > 0.5 ? 0.0 : 1.0;
      obj.dim = targetPos;
      const pct = Math.round(targetPos * 100);
      applyDeviceState(id, targetPos < 0.98, targetPos <= 0.02 ? 'Zu (0%)' : 'Offen (100%)');
      const caps = hDev.capabilitiesObj || {};
      if (caps.windowcoverings_set) {
        await sendHomeyCapability(mappedHomeyId, 'windowcoverings_set', targetPos);
      } else if (caps.windowcoverings_state) {
        await sendHomeyCapability(mappedHomeyId, 'windowcoverings_state', targetPos < 0.5 ? 'down' : 'up');
      }
      showToast(`🪟 ${hDev.name}: ${pct <= 2 ? 'Fährt herunter (0% zu)' : 'Fährt hoch (100% offen)'}`);
      return;
    }

    // 4. Lautsprecher / Alexa über speaker_playing
    if (evalInfo.mode === 'speaker') {
      applyDeviceState(id, newState, newState ? '▶️ Spielt' : '⏸️ Pause');
      await sendHomeyCapability(mappedHomeyId, 'speaker_playing', newState);
      showToast(newState ? `▶️ ${hDev.name}: Wiedergabe` : `⏸️ ${hDev.name}: Pause`);
      return;
    }

    // 4. Normales onoff-Gerät (Lampen, LEDs, Nanoleaf, TV, Onkyo, Steckdosen)
    if (evalInfo.mode === 'onoff') {
      applyDeviceState(id, newState);
      const ok = await sendHomeyCapability(mappedHomeyId, 'onoff', newState);
      if (!ok) {
        showToast(`ℹ️ ${hDev.name}: Status aktualisiert`);
        await syncFromHomeyOnce();
      }
      return;
    }

    // 5. Reine Status-/Info-Geräte ohne Schaltbefehl
    const extraStr = evalInfo.extras.length ? ` (${evalInfo.extras.join(', ')})` : '';
    showToast(`ℹ️ ${hDev.name}: ${evalInfo.label}${extraStr}`);
  } catch (err) {
    showToast('⚠️ Fehler bei der Kommunikation mit Homey Pro');
  }
}

function applyUnmappedLightsOff() {
  Object.keys(deviceObjects).forEach(dev3dId => {
    const obj = deviceObjects[dev3dId];
    const isLamp = obj && (obj.data.type === 'light' || obj.data.type === 'led' || obj.data.type === 'panel_leds' || obj.data.type === 'nanoleaf');
    if (isLamp && !deviceMapping[dev3dId]) {
      if (obj.data.on) {
        applyDeviceState(dev3dId, false);
      }
    }
  });
}

function applyHomeyDevices(data) {
  if (!data) return;
  homeyRawDevicesById = data;

  Object.entries(deviceMapping).forEach(([dev3dId, rawMappedId]) => {
    const mapped = parseMappingTarget(rawMappedId);
    if (!mapped || mapped.bridge !== 'homey') return;
    const hDev = data[mapped.rawId];
    const obj = deviceObjects[dev3dId];
    if (!hDev || !obj) return;
    const caps = hDev.capabilitiesObj || {};

    // Live Dimmlevel synchronisieren
    if (caps.dim && typeof caps.dim.value === 'number') {
      obj.dim = caps.dim.value;
    }
    if (obj.data.type === 'blinds' && caps.windowcoverings_set && typeof caps.windowcoverings_set.value === 'number') {
      obj.dim = Math.max(0, Math.min(1, caps.windowcoverings_set.value));
    }

    // Live LED-Farbe synchronisieren (nur für Farb-LEDs & Nanoleaf, NICHT für az_wandlicht)
    if (dev3dId !== 'az_wandlicht' && (obj.data.type === 'led' || obj.data.type === 'nanoleaf')) {
      if (caps.light_hue && typeof caps.light_hue.value === 'number') {
        const h = caps.light_hue.value;
        const s = caps.light_saturation ? caps.light_saturation.value : 1.0;
        const hex = hsvToHex(h, s, 1.0);
        obj.currentColor = hex;
        const hexInt = parseInt(hex.replace('#', ''), 16);
        obj.data.color = hexInt;
        if (obj.light) obj.light.color.setHex(hexInt);
        if (obj.fillLight) obj.fillLight.color.setHex(hexInt);
        if (obj.glowMat) obj.glowMat.color.setHex(hexInt);
        if (obj.haloMat) obj.haloMat.color.setHex(hexInt);
        if (obj.data.type === 'nanoleaf' && obj.glowMesh) {
          obj.glowMesh.traverse(c => {
            if (c.isMesh && c.material && (c.userData.isBar || c.userData.isBacklight)) c.material.color.setHex(hexInt);
          });
        }
      }
    }

    const evalInfo = evaluateHomeyDevice(hDev, obj.data);
    if (evalInfo.mode === 'blinds' && obj.shutterControl) {
      obj.shutterControl.movingState = evalInfo.movingState || 'idle';
    }
    if (evalInfo.mode === 'vacuum' && window.roborockCommandGraceUntil) {
      if (Date.now() < window.roborockCommandGraceUntil && evalInfo.active !== obj.data.on) {
        return;
      }
      window.roborockCommandGraceUntil = 0;
    }
    applyDeviceState(dev3dId, evalInfo.active, evalInfo.label);
  });

  applyUnmappedLightsOff();
  saveDeviceStatesToCache();
  if (typeof updateOverviewHud === 'function') {
    updateOverviewHud();
  }
}

function applyHomeAssistantEntities(byId) {
  if (!byId || !window.HAConnector) return;
  haEntitiesById = byId;

  Object.entries(deviceMapping).forEach(([dev3dId, rawMappedId]) => {
    const mapped = parseMappingTarget(rawMappedId);
    if (!mapped || mapped.bridge !== 'ha') return;
    const entity = byId[mapped.rawId];
    const obj = deviceObjects[dev3dId];
    if (!entity || !obj) return;

    const evalInfo = window.HAConnector.evaluateEntity(entity, obj.data);

    if (typeof evalInfo.dim === 'number') {
      obj.dim = evalInfo.dim;
    }
    if (obj.data.type === 'blinds' && typeof evalInfo.position === 'number') {
      obj.dim = evalInfo.position;
    }
    if (evalInfo.colorHex && dev3dId !== 'az_wandlicht' && (obj.data.type === 'led' || obj.data.type === 'nanoleaf')) {
      obj.currentColor = evalInfo.colorHex;
      const hexInt = parseInt(evalInfo.colorHex.replace('#', ''), 16);
      if (!isNaN(hexInt)) {
        obj.data.color = hexInt;
        if (obj.light) obj.light.color.setHex(hexInt);
        if (obj.fillLight) obj.fillLight.color.setHex(hexInt);
        if (obj.glowMat) obj.glowMat.color.setHex(hexInt);
        if (obj.haloMat) obj.haloMat.color.setHex(hexInt);
        if (obj.data.type === 'nanoleaf' && obj.glowMesh) {
          obj.glowMesh.traverse(c => {
            if (c.isMesh && c.material && (c.userData.isBar || c.userData.isBacklight)) c.material.color.setHex(hexInt);
          });
        }
      }
    }

    if (evalInfo.mode === 'blinds' && obj.shutterControl) {
      obj.shutterControl.movingState = evalInfo.movingState || 'idle';
    }
    if (evalInfo.mode === 'vacuum' && window.roborockCommandGraceUntil) {
      if (Date.now() < window.roborockCommandGraceUntil && evalInfo.active !== obj.data.on) {
        return;
      }
      window.roborockCommandGraceUntil = 0;
    }
    applyDeviceState(dev3dId, evalInfo.active, evalInfo.label);
  });

  applyUnmappedLightsOff();
  saveDeviceStatesToCache();
  if (typeof updateOverviewHud === 'function') {
    updateOverviewHud();
  }
}

async function connectToHomey(isSilent = false) {
  let rawIp = (document.getElementById('homey-ip')?.value || '').trim();
  const token = (document.getElementById('homey-token')?.value || '').trim();
  if (!rawIp || !token) {
    if (!isSilent) showToast('⚠️ Bitte Homey IP-Adresse und API-Key eingeben!');
    return;
  }

  rawIp = rawIp.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  homeyBaseUrl = `http://${rawIp}`;
  homeyToken = token;

  try {
    localStorage.setItem('homey_3d_ip', rawIp);
    localStorage.setItem('homey_3d_token', token);
  } catch (e) {}

  try {
    if (!isSilent) showToast('🔄 Verbinde mit Homey Pro...');
    const res = await fetch(`${homeyBaseUrl}/api/manager/devices/device/?_t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Authorization': `Bearer ${homeyToken}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    homeyRawDevicesById = data;
    homeyDevicesList = Object.values(data).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    homeyConnected = true;

    // Automatische Namens-Zuordnung beim ersten Mal (falls Name passt)
    ROOMS.forEach(r => {
      r.devices.forEach(d => {
        if (!deviceMapping[d.id]) {
          const match = homeyDevicesList.find(hd => {
            const n = (hd.name || '').toLowerCase();
            if (d.id.includes('nanoleaf') && n.includes('nanoleaf')) return true;
            if (d.id.includes('roborock') && (n.includes('roborock') || n.includes('sauger'))) return true;
            if (d.id.includes('lgtv') && (n.includes('lg') || n.includes('tv') || n.includes('fernseher'))) return true;
            if (d.id.includes('onkyo') && n.includes('onkyo')) return true;
            if (d.id.includes('stehlampe') && n.includes('stehlampe')) return true;
            if (d.type === 'blinds' && (hd.class === 'windowcoverings' || hd.virtualClass === 'blinds' || n.includes('rollade'))) return true;
            return false;
          });
          if (match) deviceMapping[d.id] = `homey:${match.id}`;
        }
      });
    });

    updateConnectionBadges();
    applyHomeyDevices(data);
    fetchSecurityState();
    requestSidebarRender();
    scheduleNextHomeyPoll(3000);
    if (!isSilent) {
      pushConfigToServer(false);
      showToast(`✅ Homey verbunden! ${homeyDevicesList.length} Geräte geladen.`);
    }
  } catch (err) {
    if (!isSilent) showToast('❌ Homey-Verbindung fehlgeschlagen – prüfe IP & API-Key');
  }
}

async function connectToHomeAssistant(isSilent = false) {
  if (!window.HAConnector) return;
  const rawUrl = (document.getElementById('ha-url')?.value || '').trim();
  const token = (document.getElementById('ha-token')?.value || '').trim();
  if (!rawUrl || !token) {
    if (!isSilent) showToast('⚠️ Bitte Home Assistant URL und Token eingeben!');
    return;
  }

  haBaseUrl = window.HAConnector.normalizeHaUrl(rawUrl);
  haToken = token;

  try {
    localStorage.setItem('homey_3d_ha_url', rawUrl);
    localStorage.setItem('homey_3d_ha_token', token);
  } catch (e) {}

  try {
    if (!isSilent) showToast('🔄 Verbinde mit Home Assistant...');
    const { byId, entities } = await window.HAConnector.fetchStates(haBaseUrl, haToken);
    haEntitiesById = byId;
    haEntitiesList = entities;
    haConnected = true;

    updateConnectionBadges();
    applyHomeAssistantEntities(byId);
    requestSidebarRender();
    scheduleNextHomeyPoll(3000);

    if (!isSilent) {
      pushConfigToServer(false);
      showToast(`✅ Home Assistant verbunden! ${haEntitiesList.length} Entities geladen.`);
    }
  } catch (err) {
    if (!isSilent) showToast('❌ Home Assistant Verbindung fehlgeschlagen – prüfe URL & Token');
  }
}

// pollTimer is already declared above
let pollInProgress = false;
function scheduleNextHomeyPoll(delay = 3000) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if ((!homeyConnected && !haConnected) || document.hidden || pollInProgress) {
      scheduleNextHomeyPoll(delay);
      return;
    }
    pollInProgress = true;
    try {
      await syncAllBridgesOnce();
    } catch (e) {
    } finally {
      pollInProgress = false;
      const anyShutterMoving = Array.isArray(window.windowShutters) && window.windowShutters.some(ws => ws.movingState === 'up' || ws.movingState === 'down');
      scheduleNextHomeyPoll(anyShutterMoving ? 1000 : 3000);
    }
  }, delay);
}

async function syncFromHomeyOnce() {
  if (!homeyConnected || document.hidden) return;
  try {
    const res = await fetch(`${homeyBaseUrl}/api/manager/devices/device/?_t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Authorization': `Bearer ${homeyToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    applyHomeyDevices(data);
    fetchSecurityState();
  } catch (e) {}
}

async function syncFromHomeAssistantOnce() {
  if (!haConnected || document.hidden || !window.HAConnector) return;
  try {
    const { byId } = await window.HAConnector.fetchStates(haBaseUrl, haToken);
    applyHomeAssistantEntities(byId);
  } catch (e) {}
}

async function syncAllBridgesOnce() {
  const tasks = [];
  if (homeyConnected) tasks.push(syncFromHomeyOnce());
  if (haConnected) tasks.push(syncFromHomeAssistantOnce());
  if (tasks.length > 0) await Promise.all(tasks);
}

function setAllLights(state) {
  Object.keys(deviceObjects).forEach(id => {
    const t = deviceObjects[id].data.type;
    if (t === 'light' || t === 'led' || t === 'panel_leds' || t === 'nanoleaf') {
      applyDeviceState(id, state);
    }
  });
}

let _configSyncTimer = null;
function scheduleConfigSync() {
  if (_configSyncTimer) clearTimeout(_configSyncTimer);
  _configSyncTimer = setTimeout(() => pushConfigToServer(false), 450);
}

function updateAmbient(val) {
  ambientLight.intensity = parseFloat(val);
  scheduleConfigSync();
}

function updateWallHeight(val) {
  currentWallHeight = parseFloat(val);
  wallMeshes.forEach(g => {
    g.scale.y = currentWallHeight;
    g.position.y = currentWallHeight / 2;
  });
  scheduleConfigSync();
}

function toggleLabels() {
  labelsVisible = !labelsVisible;
  labelsContainer.style.display = labelsVisible ? 'block' : 'none';
  const txtEl = document.getElementById('btn-labels-text');
  const iconEl = document.getElementById('btn-labels-icon');
  if (txtEl) txtEl.textContent = `Icons: ${labelsVisible ? 'AN' : 'AUS'}`;
  if (iconEl) iconEl.textContent = labelsVisible ? '🏷️' : '🚫';
}

function hideSidebar() {
  const sb = document.getElementById('sidebar');
  if (sb) sb.style.display = 'none';
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) btnSettings.classList.remove('active-settings');
  setTimeout(() => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
    setCameraPreset('iso');
  }, 50);
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const btnSettings = document.getElementById('btn-settings');
  if (!sb) return;
  const isHidden = sb.style.display === 'none' || getComputedStyle(sb).display === 'none';
  sb.style.display = isHidden ? 'flex' : 'none';
  if (btnSettings) {
    btnSettings.classList.toggle('active-settings', isHidden);
  }
  if (isHidden && sidebarNeedsRender) {
    renderSidebar();
    sidebarNeedsRender = false;
  }
  setTimeout(() => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }, 60);
}

// Standardmäßig im Vollbild-App-Modus starten (Seitenleiste nur noch mit ?setup=1 oder Klick auf ⚙️ sichtbar):
if (!window.location.search.includes('setup=1')) {
  hideSidebar();
} else {
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) btnSettings.classList.add('active-settings');
  requestSidebarRender(true);
}

// Automatisch und vollständig asynchron mit den konfigurierten Bridges im Hintergrund verbinden:
if (document.getElementById('homey-ip')?.value && document.getElementById('homey-token')?.value) {
  connectToHomey(true);
}
if (document.getElementById('ha-url')?.value && document.getElementById('ha-token')?.value) {
  connectToHomeAssistant(true);
}

function setCameraPreset(preset) {
  const isPortrait = container.clientWidth < container.clientHeight;
  const zoomFactor = isPortrait ? 1.38 : 1.0;

  if (preset === 'iso') {
    camera.position.set(1.7, 13.5 * zoomFactor, 11.2 * zoomFactor);
    controls.target.set(1.7, 0.2, 0.3);
  } else if (preset === 'top') {
    camera.position.set(1.7, 17.5 * zoomFactor, 0.01);
    controls.target.set(1.7, 0.0, 0.3);
  }
  controls.update();
}



// --- Live Smart-Home Übersicht HUD ---
function toggleOverviewHud(forceCollapsed = null) {
  const hud = document.getElementById('overview-hud');
  const btn = document.getElementById('ov-toggle-btn');
  if (!hud) return;
  const collapse = forceCollapsed !== null ? forceCollapsed : !hud.classList.contains('collapsed');
  hud.classList.toggle('collapsed', collapse);
  if (btn) btn.textContent = collapse ? '▸' : '▾';
  try { localStorage.setItem('homey_3d_ov_collapsed', collapse ? '1' : '0'); } catch (e) {}
}

function updateOverviewClock() {
  const el = document.getElementById('ov-clock');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function updateOverviewHud() {
  const hud = document.getElementById('overview-hud');
  updateSecurityHud();
  if (!hud || hud.classList.contains('collapsed')) return;
  updateOverviewClock();

  // 1. Lichter an zählen
  let lightsOn = 0;
  let lightsTotal = 0;
  Object.values(deviceObjects).forEach(obj => {
    const t = obj.data && obj.data.type;
    if (t === 'light' || t === 'led' || t === 'panel_leds' || t === 'nanoleaf') {
      lightsTotal++;
      if (obj.data.on) lightsOn++;
    }
  });
  const lightsEl = document.getElementById('ov-lights-val');
  if (lightsEl) {
    lightsEl.textContent = lightsOn === 0 ? `Alle aus (${lightsTotal})` : `${lightsOn} von ${lightsTotal} an`;
    lightsEl.style.color = lightsOn > 0 ? '#fde047' : '#94a3b8';
  }

  // 2. Gesamtleistung (W) aus Homey (measure_power) & Home Assistant (sensor.*power / current_power_w)
  let totalWatts = 0;
  Object.values(homeyRawDevicesById || {}).forEach(hDev => {
    const p = hDev?.capabilitiesObj?.measure_power?.value;
    if (typeof p === 'number' && Number.isFinite(p) && p > 0) {
      totalWatts += p;
    }
  });
  Object.values(haEntitiesById || {}).forEach(ent => {
    const unit = String(ent?.attributes?.unit_of_measurement || '').toLowerCase();
    if (ent?.entity_id?.startsWith('sensor.') && unit === 'w') {
      const p = parseFloat(ent.state);
      if (Number.isFinite(p) && p > 0) totalWatts += p;
    }
  });
  const powerEl = document.getElementById('ov-power-val');
  if (powerEl) {
    powerEl.textContent = `${totalWatts.toFixed(1)} W`;
  }
  updateOverviewSparkline(totalWatts);

  // 3. Rollade Rechts
  const blindsObj = deviceObjects['kueche_rollade_rechts'];
  const blindsEl = document.getElementById('ov-blinds-val');
  if (blindsEl && blindsObj) {
    blindsEl.textContent = getStatusLabel(blindsObj.data, blindsObj.data.on);
  }

  // 4. Saugroboter
  const vacObj = deviceObjects['az_roborock'];
  const vacEl = document.getElementById('ov-vacuum-val');
  if (vacEl && vacObj) {
    vacEl.textContent = vacObj.lastCustomLabel || getStatusLabel(vacObj.data, vacObj.data.on);
  }

  // 5. Raumtemperaturen
  const tempsEl = document.getElementById('ov-temps');
  if (tempsEl) {
    const tempEntries = [];
    const sensorDefs = [
      { id: 'az_bewegungssensor', label: 'AZ' },
      { id: 'flur_praesenz', label: 'Flur' },
      { id: 'sz_nachttisch_sensor', label: 'SZ' }
    ];
    sensorDefs.forEach(s => {
      const mapped = parseMappingTarget(deviceMapping[s.id]);
      if (!mapped) return;
      let t = null;
      let hum = null;
      if (mapped.bridge === 'homey') {
        const hDev = homeyRawDevicesById[mapped.rawId];
        t = hDev?.capabilitiesObj?.measure_temperature?.value;
        hum = hDev?.capabilitiesObj?.measure_humidity?.value;
      } else if (mapped.bridge === 'ha') {
        const ent = haEntitiesById[mapped.rawId];
        t = ent?.attributes?.current_temperature ?? ent?.attributes?.temperature;
        hum = ent?.attributes?.humidity;
      }
      if (typeof t === 'number') {
        tempEntries.push(typeof hum === 'number' ? `${s.label} ${t.toFixed(1)}°C (${Math.round(hum)}%)` : `${s.label} ${t.toFixed(1)}°C`);
      }
    });
    tempsEl.textContent = tempEntries.length > 0 ? `🌡️ ${tempEntries.join(' · ')}` : '🌡️ Keine Sensordaten';
  }

  // 6. Aktive Medien (Alexa Echo / Echo Dot / LG Fernseher)
  const mediaEl = document.getElementById('ov-media');
  if (mediaEl) {
    const activeMedia = [];
    ['wz_alexa', 'az_alexa'].forEach(id => {
      const mapped = parseMappingTarget(deviceMapping[id]);
      if (!mapped) return;
      if (mapped.bridge === 'homey') {
        const hDev = homeyRawDevicesById[mapped.rawId];
        if (hDev?.capabilitiesObj?.speaker_playing?.value) {
          const track = hDev.capabilitiesObj.speaker_track?.value || 'Wiedergabe';
          const artist = hDev.capabilitiesObj.speaker_artist?.value;
          activeMedia.push(`🎵 ${artist ? `${artist} – ${track}` : track}`);
        }
      } else if (mapped.bridge === 'ha') {
        const ent = haEntitiesById[mapped.rawId];
        if (ent && String(ent.state).toLowerCase() === 'playing') {
          const track = ent.attributes?.media_title || 'Wiedergabe';
          const artist = ent.attributes?.media_artist;
          activeMedia.push(`🎵 ${artist ? `${artist} – ${track}` : track}`);
        }
      }
    });
    const tvMapped = parseMappingTarget(deviceMapping['wz_lgtv']);
    if (tvMapped && tvMapped.bridge === 'homey') {
      const tvDev = homeyRawDevicesById[tvMapped.rawId];
      if (tvDev?.capabilitiesObj?.onoff?.value) {
        const app = tvDev.capabilitiesObj.speaker_track?.value || 'AN';
        activeMedia.push(`📺 TV: ${app}`);
      }
    } else if (tvMapped && tvMapped.bridge === 'ha') {
      const tvEnt = haEntitiesById[tvMapped.rawId];
      if (tvEnt && !['off', 'standby', 'unavailable', 'unknown'].includes(String(tvEnt.state).toLowerCase())) {
        const app = tvEnt.attributes?.app_name || tvEnt.attributes?.source || 'AN';
        activeMedia.push(`📺 TV: ${app}`);
      }
    }
    if (activeMedia.length > 0) {
      mediaEl.textContent = activeMedia.join('  |  ');
      mediaEl.classList.remove('hidden');
    } else {
      mediaEl.classList.add('hidden');
    }
  }
}

async function turnOffAllLightsFromHud() {
  const lightIds = Object.keys(deviceObjects).filter(id => {
    const t = deviceObjects[id]?.data?.type;
    return (t === 'light' || t === 'led' || t === 'panel_leds' || t === 'nanoleaf') && deviceObjects[id].data.on;
  });
  if (lightIds.length === 0) {
    showToast('💡 Alle Lichter sind bereits aus.');
    return;
  }
  for (const id of lightIds) {
    applyDeviceState(id, false);
    const mapped = parseMappingTarget(deviceMapping[id]);
    if (mapped && mapped.bridge === 'homey' && homeyConnected) {
      sendHomeyCapability(mapped.rawId, 'onoff', false);
    } else if (mapped && mapped.bridge === 'ha' && haConnected && window.HAConnector) {
      const entity = haEntitiesById[mapped.rawId];
      if (entity) {
        window.HAConnector.controlEntity(haBaseUrl, haToken, entity, deviceObjects[id].data, false, { mode: 'onoff' });
      }
    }
  }
  updateOverviewHud();
  showToast(`💡 ${lightIds.length} Licht(er) ausgeschaltet.`);
}

// Initialzustand der Übersicht laden & Uhr jede Minute aktualisieren
try {
  if (localStorage.getItem('homey_3d_ov_collapsed') === '1') {
    toggleOverviewHud(true);
  }
} catch (e) {}
updateOverviewClock();
setInterval(updateOverviewClock, 15000);


let ovPowerHistory = [];
try {
  const savedHist = localStorage.getItem('homey_3d_power_hist');
  if (savedHist) ovPowerHistory = JSON.parse(savedHist).filter(n => typeof n === 'number' && Number.isFinite(n));
} catch (e) {}

function updateOverviewSparkline(watts) {
  ovPowerHistory.push(Math.max(0, Number(watts) || 0));
  if (ovPowerHistory.length > 36) ovPowerHistory.shift();
  try { localStorage.setItem('homey_3d_power_hist', JSON.stringify(ovPowerHistory)); } catch (e) {}

  const lineEl = document.getElementById('ov-spark-line');
  const areaEl = document.getElementById('ov-spark-area');
  const dotEl = document.getElementById('ov-spark-dot');
  const metaEl = document.getElementById('ov-chart-meta');
  if (!lineEl || !areaEl) return;

  const pts = ovPowerHistory.length >= 2 ? ovPowerHistory : [watts, watts];
  const maxVal = Math.max(10, ...pts);
  const minVal = Math.min(...pts);
  const span = Math.max(5, maxVal - minVal);
  if (metaEl) metaEl.textContent = `Peak ${Math.round(maxVal)} W`;

  const w = 260;
  const h = 46;
  const padY = 5;
  const coords = pts.map((v, idx) => {
    const x = (idx / (pts.length - 1)) * (w - 6) + 2;
    const y = h - padY - ((v - minVal) / span) * (h - padY * 2);
    return [x, y];
  });

  const dLine = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1];
  const first = coords[0];
  const dArea = `${dLine} L${last[0].toFixed(1)},${h} L${first[0].toFixed(1)},${h} Z`;

  lineEl.setAttribute('d', dLine);
  areaEl.setAttribute('d', dArea);
  if (dotEl) {
    dotEl.setAttribute('cx', last[0].toFixed(1));
    dotEl.setAttribute('cy', last[1].toFixed(1));
  }
}

// --- Sicherheits-System (Logik-Variable Sicherheit_Aktiv + Live-Sensoren) ---
const SECURITY_LOGIC_ID = '475c7aa4-a8c2-4a28-93f6-de21501d0fde';
const SECURITY_FLOW_ON = 'cc44f16e-c7f6-4e25-b341-b507a6e20cdd';
const SECURITY_FLOW_OFF = '7a60e36c-b21d-4cd5-922f-ad36120b1b38';
let homeySecurityArmed = false;

async function fetchSecurityState() {
  if (!homeyConnected || !homeyBaseUrl || !homeyToken) return;
  try {
    const res = await fetch(`${homeyBaseUrl}/api/manager/logic/variable/${SECURITY_LOGIC_ID}?_t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Authorization': `Bearer ${homeyToken}` }
    });
    if (!res.ok) return;
    const v = await res.json();
    homeySecurityArmed = Boolean(v && v.value);
    updateSecurityHud();
  } catch (e) {}
}

function getTriggeredSecurityZones() {
  const zones = [];
  const sensors = [
    { roomId: 'arbeitszimmer', id: '9d9716c3-21fe-48b4-b856-b34a13e47612', name: 'Arbeitszimmer', caps: ['alarm_motion', 'alarm_tamper'] },
    { roomId: 'schlafzimmer', id: 'c9e8effa-9a01-4b9d-8710-041a056cfdba', name: 'Schlafzimmer', caps: ['alarm_motion', 'alarm_tamper'] },
    { roomId: 'flur', id: '82b8f342-80e1-4645-929d-7f4110562dd5', name: 'Flur', caps: ['alarm_presence'] }
  ];
  sensors.forEach(s => {
    const hDev = homeyRawDevicesById ? homeyRawDevicesById[s.id] : null;
    if (!hDev || !hDev.capabilitiesObj) return;
    const hit = s.caps.some(c => Boolean(hDev.capabilitiesObj[c] && hDev.capabilitiesObj[c].value));
    if (hit) zones.push({ roomId: s.roomId, name: s.name });
  });
  return zones;
}

function updateSecurityHud() {
  const bar = document.getElementById('ov-security-bar');
  const hud = document.getElementById('overview-hud');
  const vignette = document.getElementById('security-alarm-vignette');
  const titleEl = document.getElementById('ov-sec-title');
  const subEl = document.getElementById('ov-sec-sub');
  const pillEl = document.getElementById('ov-sec-pill');
  const iconEl = document.getElementById('ov-sec-icon');
  if (!bar || !hud) return;

  const triggered = getTriggeredSecurityZones();
  const triggeredNames = triggered.map(z => z.name);
  const triggeredRoomIds = new Set(triggered.map(z => z.roomId));
  const isAlarm = homeySecurityArmed && triggered.length > 0;

  bar.classList.remove('is-off', 'is-armed', 'is-alarm');
  hud.classList.remove('sec-armed', 'sec-alarm');

  if (isAlarm) {
    bar.classList.add('is-alarm');
    hud.classList.add('sec-alarm');
    if (vignette) vignette.classList.remove('hidden');
    if (iconEl) iconEl.textContent = '🚨';
    if (titleEl) titleEl.textContent = 'ALARM AUSGELÖST!';
    if (subEl) subEl.textContent = `Wo: ${triggeredNames.join(', ')}`;
    if (pillEl) pillEl.textContent = 'ALARM';
  } else if (homeySecurityArmed) {
    bar.classList.add('is-armed');
    hud.classList.add('sec-armed');
    if (vignette) vignette.classList.add('hidden');
    if (iconEl) iconEl.textContent = '🛡️';
    if (titleEl) titleEl.textContent = 'Schutz: AKTIV';
    if (subEl) subEl.textContent = 'Alle Bereiche ruhig · Tippen = Aus';
    if (pillEl) pillEl.textContent = 'AKTIV';
  } else {
    bar.classList.add('is-off');
    if (vignette) vignette.classList.add('hidden');
    if (iconEl) iconEl.textContent = '🛡️';
    if (titleEl) titleEl.textContent = 'Schutz: AUS';
    if (subEl) subEl.textContent = triggered.length > 0 ? `Aktivität: ${triggeredNames.join(', ')}` : 'Tippen zum Aktivieren';
    if (pillEl) pillEl.textContent = 'AUS';
  }

  update3dSecurityVisuals(homeySecurityArmed, isAlarm, triggeredRoomIds);
}

let secAlarmPulseTimer = null;
let secAlarmPulsePhase = 0;
const secRoomAlarmMarkers = {};

function findClosestRoomId(x, z) {
  if (typeof ROOMS === 'undefined' || !Array.isArray(ROOMS)) return null;
  let bestId = null;
  let bestDist = Infinity;
  ROOMS.forEach(r => {
    if (!Array.isArray(r.labelPos)) return;
    const d = Math.hypot(r.labelPos[0] - x, r.labelPos[2] - z);
    if (d < bestDist) {
      bestDist = d;
      bestId = r.id;
    }
  });
  return bestId;
}

function ensureRoomAlarmMarker(room) {
  if (secRoomAlarmMarkers[room.id]) return secRoomAlarmMarkers[room.id];
  if (typeof scene === 'undefined' || !Array.isArray(room.labelPos)) return null;

  const group = new THREE.Group();
  group.position.set(room.labelPos[0], 0.04, room.labelPos[2]);

  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xef4444,
    transparent: true,
    opacity: 0.75,
    side: THREE.DoubleSide
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.78, 36), ringMat);
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  const innerMat = new THREE.MeshBasicMaterial({
    color: 0xef4444,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide
  });
  const inner = new THREE.Mesh(new THREE.CircleGeometry(0.55, 36), innerMat);
  inner.rotation.x = -Math.PI / 2;
  group.add(inner);

  const alarmLight = new THREE.PointLight(0xef4444, 0, 4.5, 2);
  alarmLight.position.set(0, 1.45, 0);
  group.add(alarmLight);

  group.visible = false;
  scene.add(group);
  secRoomAlarmMarkers[room.id] = { group, ring, ringMat, innerMat, alarmLight };
  return secRoomAlarmMarkers[room.id];
}

function update3dSecurityVisuals(isArmed, isAlarm, triggeredRoomIds = new Set()) {
  const shutters = Array.isArray(window.windowShutters) ? window.windowShutters : [];

  if (secAlarmPulseTimer && !isAlarm) {
    clearInterval(secAlarmPulseTimer);
    secAlarmPulseTimer = null;
  }

  // Pro Fenster / Rollade individuell färben: nur betroffener Raum pulsiert rot, übrige bleiben grün
  const alarmShutters = [];
  shutters.forEach(ws => {
    if (!ws.boxMat || !ws.railMat || !ws.curtainMat) return;
    const roomId = ws._roomId || (ws._roomId = findClosestRoomId(ws.cx, ws.cz));
    const roomTriggered = isAlarm && roomId && triggeredRoomIds.has(roomId);

    if (roomTriggered) {
      ws.boxMat.emissive.setHex(0xdc2626);
      ws.railMat.emissive.setHex(0xdc2626);
      ws.curtainMat.emissive.setHex(0xdc2626);
      alarmShutters.push(ws);
    } else if (isArmed) {
      ws.boxMat.emissive.setHex(0x10b981);
      ws.boxMat.emissiveIntensity = 0.28;
      ws.railMat.emissive.setHex(0x10b981);
      ws.railMat.emissiveIntensity = 0.32;
      ws.curtainMat.emissive.setHex(0x059669);
      ws.curtainMat.emissiveIntensity = 0.16;
    } else {
      ws.boxMat.emissive.setHex(0x000000);
      ws.boxMat.emissiveIntensity = 0;
      ws.railMat.emissive.setHex(0x000000);
      ws.railMat.emissiveIntensity = 0;
      ws.curtainMat.emissive.setHex(0x000000);
      ws.curtainMat.emissiveIntensity = 0;
    }
  });

  // Raum-Alarm-Markierung (pulsierender roter Bodenring + rotes Raumlicht nur im betroffenen Raum)
  const activeMarkers = [];
  if (typeof ROOMS !== 'undefined' && Array.isArray(ROOMS)) {
    ROOMS.forEach(r => {
      const m = ensureRoomAlarmMarker(r);
      if (!m) return;
      const roomTriggered = isAlarm && triggeredRoomIds.has(r.id);
      m.group.visible = roomTriggered;
      if (roomTriggered) {
        activeMarkers.push(m);
      } else {
        m.alarmLight.intensity = 0;
      }
    });
  }

  if (isAlarm && !secAlarmPulseTimer) {
    secAlarmPulseTimer = setInterval(() => {
      secAlarmPulsePhase += 0.25;
      const pulse = 0.5 + 0.5 * Math.sin(secAlarmPulsePhase);
      const intensity = 0.35 + 0.55 * pulse;
      alarmShutters.forEach(ws => {
        ws.boxMat.emissiveIntensity = intensity;
        ws.railMat.emissiveIntensity = intensity;
        ws.curtainMat.emissiveIntensity = intensity * 0.78;
      });
      activeMarkers.forEach(m => {
        const s = 0.92 + 0.18 * pulse;
        m.ring.scale.set(s, s, 1);
        m.ringMat.opacity = 0.45 + 0.45 * pulse;
        m.innerMat.opacity = 0.12 + 0.20 * pulse;
        m.alarmLight.intensity = 0.9 + 1.4 * pulse;
      });
    }, 80);
  }

  // Sensor-LEDs im 3D-Haus dezent grün hervorheben, wenn Schutz aktiv & ruhig
  const secSensorIds = ['az_bewegungssensor', 'sz_nachttisch_sensor', 'flur_praesenz'];
  secSensorIds.forEach(sid => {
    const obj = typeof deviceObjects !== 'undefined' ? deviceObjects[sid] : null;
    if (!obj || obj.data.on) return;
    if (obj.standbyLedMat) {
      obj.standbyLedMat.color.setHex(isArmed ? 0x10b981 : 0x38bdf8);
      obj.standbyLedMat.opacity = isArmed ? 0.92 : 0.45;
    }
  });
}

async function toggleSecurityModeFromHud() {
  const nextState = !homeySecurityArmed;
  homeySecurityArmed = nextState;
  updateSecurityHud();

  if (!homeyConnected || !homeyBaseUrl || !homeyToken) {
    showToast(nextState ? '🛡️ Schutz: AKTIV (Lokal)' : '🛡️ Schutz: AUS (Lokal)');
    return;
  }

  const flowId = nextState ? SECURITY_FLOW_ON : SECURITY_FLOW_OFF;
  try {
    let res = await fetch(`${homeyBaseUrl}/api/manager/flow/flow/${flowId}/trigger`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${homeyToken}` }
    });
    if (!res.ok) {
      res = await fetch(`${homeyBaseUrl}/api/manager/logic/variable/${SECURITY_LOGIC_ID}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${homeyToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ value: nextState })
      });
    }
    showToast(nextState ? '🛡️ Sicherheits-Modus AKTIVIERT' : '🛡️ Sicherheits-Modus DEAKTIVIERT');
  } catch (e) {
    showToast('⚠️ Konnte Sicherheits-Modus nicht umschalten');
  }
}
