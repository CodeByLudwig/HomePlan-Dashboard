// =========================================================================
// HOME ASSISTANT CONNECTOR (REST API + optionaler /api/proxy CORS-Fallback)
// =========================================================================
(function () {
  const SUPPORTED_DOMAINS = new Set([
    'light',
    'switch',
    'vacuum',
    'binary_sensor',
    'sensor',
    'media_player',
    'cover',
    'fan',
    'input_boolean',
    'climate',
    'lock',
    'scene',
    'script',
    'automation'
  ]);

  function normalizeHaUrl(rawUrl) {
    let u = String(rawUrl || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) {
      u = u.includes(':') ? `http://${u}` : `http://${u}:8123`;
    }
    return u;
  }

  function getProxyEndpoint() {
    if (window.location.protocol.startsWith('http')) {
      return `${window.location.origin}/api/proxy`;
    }
    return 'http://localhost:8765/api/proxy';
  }

  async function haFetch(baseUrl, token, endpoint, options = {}) {
    const targetUrl = `${baseUrl}${endpoint}`;
    const method = (options.method || 'GET').toUpperCase();
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    };
    const body = options.body !== undefined ? options.body : undefined;

    try {
      const directRes = await fetch(targetUrl, {
        method,
        cache: 'no-store',
        headers,
        body
      });
      return directRes;
    } catch (directErr) {
      // Fallback über lokalen Node-Proxy (verhindert CORS-Probleme bei Home Assistant)
      const proxyRes = await fetch(getProxyEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          method,
          headers,
          body
        })
      });
      return proxyRes;
    }
  }

  function rgbArrayToHex(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3) return null;
    const toHex = n => Math.max(0, Math.min(255, Math.round(Number(n) || 0))).toString(16).padStart(2, '0');
    return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
  }

  function hexToRgbArray(hex) {
    const clean = String(hex || '').replace('#', '');
    if (clean.length !== 6) return [255, 255, 255];
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16)
    ];
  }

  function getDomain(entityId) {
    const idx = String(entityId || '').indexOf('.');
    return idx > 0 ? entityId.slice(0, idx) : '';
  }

  function getEntityName(entity) {
    return (entity && entity.attributes && entity.attributes.friendly_name) || entity.entity_id;
  }

  async function fetchStates(baseUrl, token) {
    const res = await haFetch(baseUrl, token, '/api/states');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('Ungültige HA-Antwort');
    const byId = {};
    const entities = [];
    list.forEach(item => {
      if (!item || !item.entity_id) return;
      byId[item.entity_id] = item;
      const domain = getDomain(item.entity_id);
      if (SUPPORTED_DOMAINS.has(domain)) {
        entities.push(item);
      }
    });
    entities.sort((a, b) => getEntityName(a).localeCompare(getEntityName(b)));
    return { byId, entities };
  }

  async function callService(baseUrl, token, domain, service, data) {
    const res = await haFetch(baseUrl, token, `/api/services/${domain}/${service}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    });
    return res.ok;
  }

  function evaluateEntity(entity, dev3d) {
    const entityId = entity.entity_id || '';
    const domain = getDomain(entityId);
    const state = String(entity.state || '').toLowerCase();
    const attrs = entity.attributes || {};

    const extras = [];
    const temp = attrs.current_temperature ?? attrs.temperature;
    if (typeof temp === 'number') extras.push(`${temp.toFixed(1)}°C`);
    if (typeof attrs.illuminance === 'number') extras.push(`${Math.round(attrs.illuminance)} lx`);
    if (typeof attrs.battery_level === 'number') extras.push(`🔋${Math.round(attrs.battery_level)}%`);

    // 1. Saugroboter
    if (dev3d.type === 'vacuum' || domain === 'vacuum') {
      const active = state === 'cleaning' || state === 'spot_cleaning';
      const isReturning = state === 'returning';
      const isPaused = state === 'paused';
      const batStr = typeof attrs.battery_level === 'number' ? ` (${Math.round(attrs.battery_level)}%)` : '';
      const cleanText = attrs.fan_speed ? `Saugt (${attrs.fan_speed})` : 'Saugt & Wischt';
      let dockedText = `Station${batStr}`;
      if (isReturning) dockedText = `Fährt zur Station${batStr}`;
      else if (isPaused) dockedText = `Pausiert${batStr}`;
      return {
        active,
        label: active ? cleanText : dockedText,
        cleanText,
        dockedText,
        extras,
        mode: 'vacuum'
      };
    }

    // 2. Rolladen / Cover
    if (dev3d.type === 'blinds' || domain === 'cover') {
      let pos = 1.0;
      if (typeof attrs.current_position === 'number') {
        pos = Math.max(0, Math.min(1, attrs.current_position / 100));
      } else {
        pos = (state === 'closed') ? 0.0 : 1.0;
      }
      let movingState = 'idle';
      if (state === 'opening') movingState = 'up';
      else if (state === 'closing') movingState = 'down';
      const pct = Math.round(pos * 100);
      const label = pct <= 2 ? 'Zu (0%)' : (pct >= 98 ? 'Offen (100%)' : `${pct}% offen`);
      return { active: pos < 0.98, label, extras, mode: 'blinds', position: pos, movingState };
    }

    // 3. Sensoren / Binary Sensoren
    if (dev3d.type === 'sensor' || domain === 'binary_sensor' || domain === 'sensor') {
      const active = state === 'on' || state === 'detected' || state === 'home' || state === 'open' || state === 'true';
      const dc = String(attrs.device_class || '').toLowerCase();
      let label = '';
      if (domain === 'sensor') {
        const unit = attrs.unit_of_measurement ? ` ${attrs.unit_of_measurement}` : '';
        label = `${entity.state}${unit}`;
        return { active: Number(entity.state) > 0, label, extras, mode: 'sensor' };
      }
      if (dc === 'presence' || dc === 'occupancy' || dev3d.id.includes('praesenz')) {
        label = active ? '👤 PRÄSENZ!' : 'Frei';
      } else {
        label = active ? '🏃 BEWEGUNG!' : 'Ruhig';
      }
      if (extras.length > 0) label += ` (${extras[0]})`;
      return { active, label, extras, mode: 'sensor' };
    }

    // 4. Media Player
    if (domain === 'media_player') {
      if (dev3d.type === 'tv') {
        const active = !['off', 'standby', 'unavailable', 'unknown'].includes(state);
        return { active, label: active ? 'AN' : 'AUS', extras, mode: 'onoff' };
      }
      const active = state === 'playing';
      return { active, label: active ? '▶️ Spielt' : '⏸️ Pause', extras, mode: 'speaker' };
    }

    // 5. Schaltgeräte (light, switch, input_boolean, fan, lock)
    const active = state === 'on' || state === 'unlocked' || state === 'open';
    let dim = null;
    if (domain === 'light' && typeof attrs.brightness === 'number') {
      dim = Math.max(0.01, Math.min(1, attrs.brightness / 255));
    }
    const colorHex = (domain === 'light' && Array.isArray(attrs.rgb_color)) ? rgbArrayToHex(attrs.rgb_color) : null;
    let label = active ? 'AN' : 'AUS';
    if (active && dim !== null) {
      label = `AN (${Math.round(dim * 100)}%)`;
    }
    return { active, label, extras, mode: 'onoff', dim, colorHex };
  }

  async function controlEntity(baseUrl, token, entity, dev3d, newState, evalInfo) {
    const entityId = entity.entity_id;
    const domain = getDomain(entityId);

    if (evalInfo.mode === 'vacuum' || domain === 'vacuum') {
      return callService(baseUrl, token, 'vacuum', newState ? 'start' : 'return_to_base', { entity_id: entityId });
    }
    if (evalInfo.mode === 'blinds' || domain === 'cover') {
      return callService(baseUrl, token, 'cover', newState ? 'close_cover' : 'open_cover', { entity_id: entityId });
    }
    if (evalInfo.mode === 'speaker' && domain === 'media_player') {
      return callService(baseUrl, token, 'media_player', newState ? 'media_play' : 'media_pause', { entity_id: entityId });
    }
    if (domain === 'lock') {
      return callService(baseUrl, token, 'lock', newState ? 'unlock' : 'lock', { entity_id: entityId });
    }
    if (domain === 'scene' || domain === 'script') {
      return callService(baseUrl, token, domain, 'turn_on', { entity_id: entityId });
    }
    const targetDomain = SUPPORTED_DOMAINS.has(domain) ? domain : 'homeassistant';
    return callService(baseUrl, token, targetDomain, newState ? 'turn_on' : 'turn_off', { entity_id: entityId });
  }

  async function setDim(baseUrl, token, entityId, dev3d, dimVal) {
    const domain = getDomain(entityId);
    if (dev3d.type === 'blinds' || domain === 'cover') {
      return callService(baseUrl, token, 'cover', 'set_cover_position', {
        entity_id: entityId,
        position: Math.round(dimVal * 100)
      });
    }
    if (domain === 'light') {
      return callService(baseUrl, token, 'light', 'turn_on', {
        entity_id: entityId,
        brightness: Math.round(dimVal * 255)
      });
    }
    return false;
  }

  async function setColor(baseUrl, token, entityId, hexColor) {
    const domain = getDomain(entityId);
    if (domain !== 'light') return false;
    return callService(baseUrl, token, 'light', 'turn_on', {
      entity_id: entityId,
      rgb_color: hexToRgbArray(hexColor)
    });
  }

  window.HAConnector = {
    normalizeHaUrl,
    getDomain,
    getEntityName,
    fetchStates,
    evaluateEntity,
    controlEntity,
    setDim,
    setColor
  };
})();
