(() => {
  const metaToken = document.querySelector('meta[name="dash-token"]')?.content || '';
  const isBridge = Boolean(metaToken);
  const pathParts = location.pathname.replace(/^\/+|\/+$/g, '').split('/');
  const bridgeSlug = (pathParts[0] === 'dashboard' && pathParts[1]) ? decodeURIComponent(pathParts[1]) : '';

  const state = {
    isBridge,
    token: metaToken || localStorage.getItem('mz_homey_token') || '',
    slug: bridgeSlug,
    ip: localStorage.getItem('mz_homey_ip') || (location.hostname && location.hostname !== 'localhost' ? location.hostname : 'homey.local'),
    haUrl: localStorage.getItem('mz_ha_url') || '',
    haToken: localStorage.getItem('mz_ha_token') || '',
    values: {},      // Bridge flat key->value map (e.g. "devId:cap": val)
    devices: {},     // Standalone REST devices map
    haEntities: {},  // Home Assistant entities map (entity_id -> state obj)
    haWsAuthed: false,
    logic: {},       // Standalone REST logic map
    users: {},       // Standalone REST users map
    calcs: {},
    system: {},
    weather: null,
    artCache: {},
    mediaProg: {},
    insightsCache: {},
    todayEnergy: { loading: false, ts: 0, kwh: null },
    powerHistory: JSON.parse(localStorage.getItem('mz_power_history') || '[]'),
    tempHistory: JSON.parse(localStorage.getItem('mz_temp_history') || '{}'),
    secTimeline: JSON.parse(localStorage.getItem('mz_sec_timeline') || '[]'),
    es: null
  };

  if (isBridge) {
    const fab = document.getElementById('mz-cfg-open');
    if (fab) fab.style.display = 'none';
  }

  const SCENE_COLORS = {
    'basic:cc44f16e-c7f6-4e25-b341-b507a6e20cdd': '#4ade80',
    'basic:7a60e36c-b21d-4cd5-922f-ad36120b1b38': '#f87171',
    'basic:fc4cde16-7950-49c7-9b88-07a739ce8bbc': '#60a5fa',
    'basic:971f53ce-fea1-4dbb-a3db-64924815f4b8': '#38bdf8',
    'basic:faf5c7ca-874a-410e-9e72-cb8c74e40a58': '#818cf8',
    'basic:0fcaed1b-f05a-4556-98ea-777833ac3985': '#a78bfa',
    'basic:18e1fedf-b9f9-455d-9cda-0798db2de741': '#60a5fa',
    'basic:1fb7f214-ef22-4fb9-9690-f55be709cab6': '#818cf8',
    'basic:2e77d626-32ca-4eda-a8d9-193a72730d73': '#818cf8',
    'd46a2735-7c3e-4a1b-b98f-ea62958bb629|windowcoverings_state|up': '#60a5fa',
    'd46a2735-7c3e-4a1b-b98f-ea62958bb629|windowcoverings_state|down': '#818cf8'
  };

  function baseUrl() {
    const raw = (state.ip || 'homey.local').trim().replace(/\/+$/, '');
    return raw.startsWith('http') ? raw : `http://${raw}`;
  }

  async function bridgePost(path, body) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Dashboard-Token': state.token
    };
    if (state.slug) headers['X-Dashboard-Slug'] = state.slug;
    const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function restApi(path, options = {}) {
    if (!state.token) throw new Error('Kein API-Token');
    const res = await fetch(`${baseUrl()}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function collectAllKeys() {
    const keys = new Set();
    document.querySelectorAll('[data-live]').forEach(el => keys.add(el.dataset.live));
    document.querySelectorAll('[data-show-if]').forEach(el => {
      const p = el.dataset.showIf.split(':');
      if (p.length >= 2) keys.add(`${p[0]}:${p[1]}`);
    });
    document.querySelectorAll('[data-count]').forEach(el => {
      const [idsPart, cap] = el.dataset.count.split('|');
      idsPart.split(',').filter(Boolean).forEach(id => {
        keys.add(id.startsWith('__') ? id : `${id}:${cap}`);
      });
    });
    document.querySelectorAll('[data-dial]').forEach(el => keys.add(el.dataset.dial));
    document.querySelectorAll('[data-device][data-cap]').forEach(el => keys.add(`${el.dataset.device}:${el.dataset.cap}`));
    document.querySelectorAll('[data-dim]').forEach(el => keys.add(el.dataset.dim));
    document.querySelectorAll('[data-segfor]').forEach(el => keys.add(el.dataset.segfor));
    document.querySelectorAll('[data-ppl]').forEach(el => keys.add(el.dataset.ppl));
    document.querySelectorAll('[data-attention]').forEach(el => keys.add(el.dataset.attention));
    document.querySelectorAll('[data-status]').forEach(el => keys.add(el.dataset.status));
    document.querySelectorAll('[data-calc]').forEach(el => {
      const parts = el.dataset.calc.split('|');
      for (let i = 1; i < parts.length; i++) {
        const k = parts[i].replace(/^[+-]/, '');
        if (k) keys.add(k);
      }
    });
    return Array.from(keys).filter(Boolean);
  }

  function resolveKey(key) {
    if (!key) return undefined;
    if (key.startsWith('__calc:')) return state.calcs[key.slice(7)];
    if (isBridge) return state.values[key];

    if (key.startsWith('__logic:')) {
      const id = key.slice(8);
      return state.logic[id] ? state.logic[id].value : undefined;
    }
    if (key.startsWith('__system:')) {
      return state.system[key.slice(9)];
    }
    if (key.startsWith('__')) return undefined;
    const idx = key.indexOf(':');
    if (idx === -1) return undefined;
    const id = key.slice(0, idx);
    const cap = key.slice(idx + 1);
    if (id.includes('.')) return resolveHaValue(id, cap);
    return state.devices[id]?.capabilitiesObj?.[cap]?.value;
  }

  function normalizeHaUrl(raw) {
    let u = String(raw || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = u.includes(':') ? `http://${u}` : `http://${u}:8123`;
    return u;
  }

  async function haApi(path, options = {}) {
    const base = normalizeHaUrl(state.haUrl);
    if (!base || !state.haToken) throw new Error('Kein Home Assistant Token/URL');
    const res = await fetch(`${base}${path}`, {
      ...options,
      cache: 'no-store',
      headers: {
        'Authorization': `Bearer ${state.haToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!res.ok) throw new Error(`HA HTTP ${res.status}`);
    return res.json();
  }

  function resolveHaValue(entityId, cap) {
    const ent = state.haEntities[entityId];
    if (!ent) return undefined;
    const attr = ent.attributes || {};
    const st = ent.state;
    if (cap === 'onoff') return st === 'on' || st === 'playing';
    if (cap === 'dim') return attr.brightness !== undefined ? Number(attr.brightness) / 255 : (st === 'on' ? 1 : 0);
    if (cap === 'windowcoverings_set') {
      if (attr.current_position !== undefined) return Number(attr.current_position) / 100;
      return st === 'open' ? 1 : 0;
    }
    if (cap === 'measure_temperature') return Number(attr.current_temperature ?? st);
    if (cap === 'measure_humidity') return Number(attr.current_humidity ?? st);
    if (cap === 'measure_power' || cap === 'measure_battery') return Number(st);
    if (cap === 'alarm_motion' || cap === 'alarm_presence' || cap === 'alarm_tamper') return st === 'on';
    if (cap === 'speaker_playing') return st === 'playing';
    if (cap === 'speaker_track') return attr.media_title || '';
    if (cap === 'speaker_artist') return attr.media_artist || '';
    if (cap === 'speaker_album') return attr.media_album_name || '';
    if (cap === 'volume_set') return attr.volume_level;
    if (cap === 'is_cleaning') return st === 'cleaning';
    if (cap === 'dock') return st === 'docked';
    return attr[cap] !== undefined ? attr[cap] : st;
  }

  async function setHaCapability(entityId, cap, val) {
    const domain = entityId.split('.')[0];
    let service = null;
    let body = { entity_id: entityId };
    if (cap === 'onoff') {
      service = val ? 'turn_on' : 'turn_off';
    } else if (cap === 'dim') {
      const b = Math.max(0, Math.min(255, Math.round(Number(val) * 255)));
      if (b <= 0) service = 'turn_off';
      else { service = 'turn_on'; body.brightness = b; }
    } else if (cap === 'windowcoverings_set') {
      service = 'set_cover_position';
      body.position = Math.max(0, Math.min(100, Math.round(Number(val) * 100)));
    } else if (cap === 'volume_set') {
      service = 'volume_set';
      body.volume_level = Math.max(0, Math.min(1, Number(val)));
    } else if (cap === 'speaker_playing') {
      service = 'media_play_pause';
    } else if (cap === 'speaker_next') {
      service = 'media_next_track';
    } else if (cap === 'speaker_prev') {
      service = 'media_previous_track';
    } else if (cap === 'clean_full') {
      service = 'start';
    } else if (cap === 'pause_clean') {
      service = 'pause';
    } else if (cap === 'cancel_and_dock') {
      service = 'return_to_base';
    } else if (cap === 'locate') {
      service = 'locate';
    }
    if (!service) return;
    try {
      await haApi(`/api/services/${domain}/${service}`, { method: 'POST', body: JSON.stringify(body) });
      setTimeout(fetchHaStates, 400);
    } catch (e) { console.error('HA service error:', e); }
  }

  function computeCalcs() {
    document.querySelectorAll('[data-calc]').forEach(el => {
      const parts = el.dataset.calc.split('|');
      const name = parts[0];
      let sum = 0;
      for (let i = 1; i < parts.length; i++) {
        const expr = parts[i];
        const sign = expr.startsWith('-') ? -1 : 1;
        const k = (expr.startsWith('+') || expr.startsWith('-')) ? expr.slice(1) : expr;
        const v = Number(resolveKey(k));
        if (Number.isFinite(v)) sum += sign * v;
      }
      state.calcs[name] = Math.round(sum);
    });
  }

  function formatVal(val, fmt, mapAttr) {
    if (val === undefined || val === null) return '–';
    if (mapAttr) {
      try {
        if (mapAttr.startsWith('{')) {
          const obj = JSON.parse(mapAttr);
          const k = String(val);
          if (k in obj) return obj[k];
        } else {
          for (const pair of mapAttr.split('|')) {
            const [k, v] = pair.split(':');
            if (String(val) === k) return v;
          }
        }
      } catch {}
    }
    switch (fmt) {
      case 'temp': return `${Number(val).toFixed(1)}°C`;
      case 'humid': return `${Math.round(Number(val))}%`;
      case 'watt': return `${Math.round(Number(val))} W`;
      case 'power': return `${Math.round(Number(val))}`;
      case 'pct': {
        const num = Number(val);
        return `${Math.round(num <= 1 ? num * 100 : num)}%`;
      }
      case 'alarm': return val ? 'Alarm!' : 'Ruhig';
      default: return String(val);
    }
  }

  function hslToHex(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function lampColor(devId) {
    const hue = resolveKey(`${devId}:light_hue`);
    const sat = resolveKey(`${devId}:light_saturation`);
    if (typeof hue === 'number' && typeof sat === 'number' && sat > 0.08) {
      return hslToHex(hue * 360, sat, 0.56);
    }
    return '#fbbf24';
  }

  function applySceneColors() {
    document.querySelectorAll('.tile.scene').forEach(tile => {
      const key = tile.dataset.flowrun || tile.dataset.macro || '';
      const color = SCENE_COLORS[key];
      if (!color) return;
      tile.style.borderColor = '';
      tile.style.background = '';
      const ico = tile.querySelector('.t-ico');
      if (ico) ico.style.color = color;
    });
  }

  function updateClock() {
    const now = new Date();
    const h = now.getHours();
    const greetText = h < 11 ? 'Guten Morgen' : h < 18 ? 'Hallo' : 'Guten Abend';
    document.querySelectorAll('[data-greet]').forEach(el => {
      const name = el.dataset.greet || '';
      el.textContent = name ? `${greetText}, ${name}` : greetText;
    });
    const t = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const d = now.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long' });
    document.querySelectorAll('[data-clock]').forEach(el => {
      const mode = el.dataset.clock;
      if (mode === 'time') el.textContent = t;
      else if (mode === 'date') el.textContent = d;
      else el.textContent = `${t} · ${d}`;
    });
  }

  function renderAll() {
    computeCalcs();
    applySceneColors();

    document.querySelectorAll('[data-live]').forEach(el => {
      if (el.tagName === 'INPUT') return;
      const val = resolveKey(el.dataset.live);
      el.textContent = formatVal(val, el.dataset.fmt || '', el.dataset.map || '');
    });

    document.querySelectorAll('[data-show-if]').forEach(el => {
      const parts = el.dataset.showIf.split(':');
      const v = resolveKey(`${parts[0]}:${parts[1]}`);
      let show = false;
      if (parts[2] === 'truthy') show = Boolean(v);
      else if (parts[2] === 'gt') show = Number(v) > Number(parts[3] || 0);
      else show = String(v) === parts[2];
      el.style.display = show ? '' : 'none';
    });

    document.querySelectorAll('[data-active-group]').forEach(grp => {
      const items = Array.from(grp.querySelectorAll('.active-item'));
      const anyVisible = items.some(it => it.style.display !== 'none');
      const emptyEl = grp.querySelector('.active-empty');
      if (emptyEl) emptyEl.style.display = anyVisible ? 'none' : '';
    });

    document.querySelectorAll('[data-count]').forEach(el => {
      const [idsPart, cap] = el.dataset.count.split('|');
      const ids = idsPart.split(',').filter(Boolean);
      const activeNames = [];
      let n = 0;
      ids.forEach(id => {
        const key = id.startsWith('__') ? id : `${id}:${cap}`;
        if (resolveKey(key)) {
          n++;
          const nmEl = el.querySelector(`[data-nm="${id}"]`);
          activeNames.push(nmEl ? nmEl.textContent : (state.devices[id]?.name || id));
        }
      });
      const w0 = el.dataset.w0 || '0';
      const w1 = el.dataset.w1 || '1';
      const wn = el.dataset.wn || '{n}';
      const text = (n === 0 ? w0 : n === 1 ? w1 : wn)
        .replace('{n}', String(n))
        .replace('{names}', activeNames.join(', '));
      const statN = el.querySelector('.stat-n');
      if (statN) statN.textContent = String(n);
      const c2x = el.querySelector('.c2-x');
      if (c2x) c2x.textContent = text;
      const s2c = el.querySelector('.s2-c');
      if (s2c) s2c.textContent = text;
      const sbl = el.querySelector('.sb-l');
      if (sbl) sbl.textContent = n === 1 ? 'Licht an' : 'Lichter an';
      if (el.classList.contains('s2') || el.classList.contains('chip2')) el.classList.toggle('on', n > 0);
      if (el.classList.contains('home')) document.querySelector('.hero.has-home')?.classList.toggle('lit', n > 0);
    });

    document.querySelectorAll('.chip2[data-tones]').forEach(el => {
      const liveEl = el.querySelector('[data-live]');
      if (!liveEl) return;
      const val = Number(resolveKey(liveEl.dataset.live));
      if (!Number.isFinite(val)) return;
      let tone = '';
      el.dataset.tones.split(',').forEach(pair => {
        const [thr, col] = pair.split('|');
        if (val >= Number(thr)) tone = col;
      });
      if (tone) {
        el.style.setProperty('--c2', tone);
        el.classList.add('c2-t');
      } else {
        el.style.removeProperty('--c2');
        el.classList.remove('c2-t');
      }
    });

    document.querySelectorAll('[data-dial]').forEach(el => {
      const raw = resolveKey(el.dataset.dial);
      const val = Number(raw);
      const has = raw !== undefined && raw !== null && Number.isFinite(val);
      el.classList.toggle('d-has', has);
      if (!has) return;
      const min = Number(el.dataset.min || 0);
      const max = Number(el.dataset.max || 100);
      const pct = Math.max(0, Math.min(100, ((val - min) / (max - min || 1)) * 100));
      const path = el.querySelector('.d-val');
      if (path) path.setAttribute('stroke-dasharray', `${pct.toFixed(1)} 200`);
      if (el.dataset.zones) {
        let zCol = '';
        for (const z of el.dataset.zones.split('|')) {
          const [lim, col] = z.split(':');
          zCol = col;
          if (val <= Number(lim)) break;
        }
        if (zCol) {
          if (path) path.style.stroke = zCol;
          const zonePath = el.querySelector('.d-zone');
          if (zonePath) zonePath.style.stroke = zCol;
        }
      }
    });

    document.querySelectorAll('[data-device][data-cap]').forEach(el => {
      const devId = el.dataset.device;
      const cap = el.dataset.cap;
      const rawVal = resolveKey(`${devId}:${cap}`);
      const isBlind = cap === 'windowcoverings_set';
      const blindPct = isBlind && rawVal !== undefined && rawVal !== null ? Math.round(Number(rawVal) <= 1 ? Number(rawVal) * 100 : Number(rawVal)) : null;
      const isOn = isBlind ? (blindPct !== null && blindPct > 5) : Boolean(rawVal);
      if (el.dataset.state !== undefined) el.dataset.state = isOn ? 'on' : 'off';
      el.classList.toggle('on', isOn);
      if (el.dataset.lampcolor) {
        if (isOn) {
          el.classList.add('lamp-c');
          el.style.setProperty('--lamp', lampColor(el.dataset.lampcolor));
        } else {
          el.classList.remove('lamp-c');
          el.style.removeProperty('--lamp');
        }
      }
      const st = el.querySelector('.t-st');
      if (st) {
        if (isBlind) {
          st.textContent = blindPct === null ? '–' : (blindPct >= 99 ? 'Offen' : (blindPct <= 1 ? 'Zu' : `${blindPct}%`));
        } else if (el.dataset.dim) {
          const dVal = Number(resolveKey(el.dataset.dim)) || 0;
          st.textContent = isOn ? `${Math.round(dVal <= 1 ? dVal * 100 : dVal)}%` : 'Aus';
          const fill = el.querySelector('.t-fill');
          if (fill) fill.style.height = isOn ? `${Math.round(dVal <= 1 ? dVal * 100 : dVal)}%` : '0%';
        } else {
          st.textContent = isOn ? 'An' : 'Aus';
        }
      }
    });

    document.querySelectorAll('input.slider[data-device][data-cap]').forEach(inp => {
      const val = resolveKey(`${inp.dataset.device}:${inp.dataset.cap}`);
      if (val === undefined || val === null) return;
      const scale = Number(inp.dataset.scale || 1);
      const uiVal = Math.round(Number(val) / scale);
      if (document.activeElement !== inp) inp.value = String(uiVal);
      const valSpan = inp.parentElement?.querySelector('.slider-val');
      if (valSpan) valSpan.textContent = `${uiVal}${inp.dataset.unit || ''}`;
    });

    document.querySelectorAll('[data-segfor]').forEach(seg => {
      const cur = String(resolveKey(seg.dataset.segfor) ?? '');
      seg.querySelectorAll('button[data-set]').forEach(btn => btn.classList.toggle('on', btn.dataset.set === cur));
    });

    document.querySelectorAll('[data-ag]').forEach(ag => {
      const items = Array.from(ag.querySelectorAll('[data-ag-item]'));
      const triggered = items.filter(it => Boolean(resolveKey(it.dataset.live))).map(it => it.dataset.name);
      const line = ag.querySelector('.ag-x');
      if (line) {
        line.textContent = triggered.length
          ? (ag.dataset.agAlarm || '{names}').replace('{names}', triggered.join(', '))
          : (ag.dataset.agOk || 'Alles ruhig');
      }
      ag.classList.toggle('is-alarm', triggered.length > 0);
    });

    document.querySelectorAll('[data-ppl]').forEach(el => {
      const users = isBridge ? (resolveKey(el.dataset.ppl) || []) : Object.values(state.users || {});
      if (Array.isArray(users) && users.length) {
        el.innerHTML = users.map(u => `
          <div class="p-row" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;">
            <span style="display:flex;align-items:center;gap:10px;min-width:0;">
              <span style="width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:${u.present ? 'var(--on-tint,rgba(20,184,166,.16))' : 'rgba(255,255,255,.06)'};color:${u.present ? 'var(--on,#5eead4)' : 'var(--muted)'};flex:0 0 auto;">
                <svg class="i" style="width:16px;height:16px;" viewBox="0 0 24 24"><use href="#i-user"></use></svg>
              </span>
              <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${u.name}</span>
            </span>
            <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;background:${u.present ? 'rgba(48,209,88,.16)' : 'rgba(255,255,255,.06)'};color:${u.present ? '#86efac' : 'var(--muted)'};">
              <svg class="i" style="width:13px;height:13px;" viewBox="0 0 24 24"><use href="#${u.present ? 'i-home' : 'i-route'}"></use></svg>
              ${u.present ? 'Daheim' : 'Unterwegs'}
            </span>
          </div>
        `).join('');
      } else {
        el.innerHTML = '<div class="muted">Keine Benutzerdaten</div>';
      }
    });

    document.querySelectorAll('[data-attention]').forEach(el => {
      const list = el.querySelector('.attn-list') || el;
      if (isBridge) {
        const attn = resolveKey(el.dataset.attention);
        if (Array.isArray(attn) && attn.length) {
          list.innerHTML = attn.map(a => `<div class="attn-row"><span>${a.name || a.title || 'Hinweis'}</span><b>${a.value ?? ''}</b></div>`).join('');
          return;
        }
      }
      const low = Object.values(state.devices).filter(d => d.capabilitiesObj?.measure_battery?.value < 20);
      if (low.length) {
        list.innerHTML = low.map(d => `
          <div class="attn-row" style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;">
            <span style="display:flex;align-items:center;gap:8px;color:var(--warn);">
              <svg class="i" style="width:16px;height:16px;" viewBox="0 0 24 24"><use href="#i-battery"></use></svg>
              ${d.name}
            </span>
            <b>${d.capabilitiesObj.measure_battery.value}%</b>
          </div>
        `).join('');
      } else {
        list.innerHTML = `
          <div class="attn-ok" style="gap:12px;padding:4px 0;">
            <div class="attn-ic" style="display:flex;align-items:center;justify-content:center;background:rgba(48,209,88,.16);color:#86efac;">
              <svg class="i" style="width:20px;height:20px;" viewBox="0 0 24 24"><use href="#i-check"></use></svg>
            </div>
            <div>
              <b style="display:block;font-size:15px;">Alles OK</b>
              <span class="muted" style="font-size:12px;">Alle Systeme &amp; Batterien OK</span>
            </div>
          </div>
        `;
      }
    });

    const INSIGHTS_RES = {
      today: 'today',
      '24h': 'last24Hours',
      '7d': 'last7Days',
      '31d': 'last31Days'
    };
    const RANGE_LABELS = {
      today: 'Heute',
      '24h': '24h',
      '7d': '7 Tage',
      '31d': '30 Tage'
    };

    async function fetchSeriesPoints(hkey, resName) {
      const devCaps = [];
      hkey.split(',').forEach(part => {
        const clean = part.replace(/^sum:/, '').replace(/^[+-]/, '');
        const m = clean.match(/^([0-9a-f-]{36}):([a-z0-9_.]+)$/i);
        if (m) devCaps.push({ devId: m[1], cap: m[2] });
      });
      if (!devCaps.length) return [];

      const seriesList = await Promise.all(devCaps.map(async ({ devId, cap }) => {
        const uri = `homey:device:${devId}`;
        const suffixes = cap === 'measure_power' ? ['energy_power', 'measure_power'] : [cap];
        for (const logSuffix of suffixes) {
          try {
            const logId = `${uri}:${logSuffix}`;
            const data = await restApi(`/api/manager/insights/log/${encodeURIComponent(uri)}/${encodeURIComponent(logId)}/entry?resolution=${encodeURIComponent(resName)}`);
            const rows = Array.isArray(data) ? data : (Array.isArray(data?.values) ? data.values : []);
            const pts = rows
              .map(r => ({ t: new Date(r.t).getTime(), v: Number(r.v) }))
              .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v))
              .sort((a, b) => a.t - b.t);
            if (pts.length) return pts;
          } catch {}
        }
        return [];
      }));

      const nonEmpty = seriesList.filter(s => s.length > 0);
      if (!nonEmpty.length) return [];
      if (nonEmpty.length === 1 && !hkey.startsWith('sum:')) return nonEmpty[0];

      const minT = Math.min(...nonEmpty.map(s => s[0].t));
      const maxT = Math.max(...nonEmpty.map(s => s[s.length - 1].t));
      const buckets = Math.min(96, Math.max(24, Math.max(...nonEmpty.map(s => s.length))));
      const span = Math.max(1, maxT - minT);
      const idxs = nonEmpty.map(() => 0);
      const combined = [];

      for (let b = 0; b < buckets; b++) {
        const t = buckets === 1 ? maxT : minT + (span * b) / (buckets - 1);
        let sum = 0;
        nonEmpty.forEach((s, si) => {
          while (idxs[si] + 1 < s.length && s[idxs[si] + 1].t <= t) idxs[si]++;
          sum += s[idxs[si]].v;
        });
        combined.push({ t, v: Math.round(sum * 10) / 10 });
      }
      return combined;
    }

    async function fetchInsightsHistory(histEl, force = false) {
      if (!state.token || isBridge || !histEl) return;
      const spec = histEl.dataset.history || '';
      const range = histEl.dataset.range || '24h';
      const cacheKey = `${spec}|${range}`;
      const existing = state.insightsCache[cacheKey];
      if (!force && existing && (existing.loading || (Date.now() - existing.ts < 60000))) return;

      const legs = Array.from(histEl.querySelectorAll('.h-leg[data-hkey]'));
      const keys = legs.length ? legs.map(l => l.dataset.hkey) : [spec];
      const resName = INSIGHTS_RES[range] || 'last24Hours';
      state.insightsCache[cacheKey] = { loading: true, ts: existing?.ts || 0, series: existing?.series || {} };

      try {
        const results = await Promise.all(keys.map(k => fetchSeriesPoints(k, resName)));
        const series = {};
        keys.forEach((k, i) => { series[k] = results[i]; });
        state.insightsCache[cacheKey] = { loading: false, ts: Date.now(), series };
        renderAll();
      } catch {
        state.insightsCache[cacheKey] = { loading: false, ts: Date.now(), series: existing?.series || {} };
      }
    }

    // Moderne Smooth-Area-Charts (Bezier + Gradient + Grid + Endpunkt)
    document.querySelectorAll('.hist[data-history]').forEach(el => {
      const svg = el.querySelector('.h-plot svg');
      if (!svg) return;
      const note = el.querySelector('.h-note');
      const range = el.dataset.range || '24h';
      const cardTitle = el.closest('.card')?.querySelector('h2 span');
      if (cardTitle) {
        const base = cardTitle.textContent.replace(/\s*\([^)]*\)\s*$/, '');
        cardTitle.textContent = `${base} (${RANGE_LABELS[range] || range})`;
      }

      const cacheKey = `${el.dataset.history || ''}|${range}`;
      const cachedInsights = state.insightsCache[cacheKey];
      if (!cachedInsights || (!cachedInsights.loading && Date.now() - cachedInsights.ts >= 60000)) {
        fetchInsightsHistory(el);
      }

      const nowMs = Date.now();
      let cutoff = 0;
      if (range === 'today') {
        const d = new Date(); d.setHours(0, 0, 0, 0); cutoff = d.getTime();
      } else if (range === '24h') {
        cutoff = nowMs - 24 * 3600 * 1000;
      } else if (range === '7d') {
        cutoff = nowMs - 7 * 24 * 3600 * 1000;
      } else if (range === '31d') {
        cutoff = nowMs - 31 * 24 * 3600 * 1000;
      }

      const resolveHistoryLive = hkey => {
        if (!hkey) return NaN;
        if (hkey.startsWith('sum:')) {
          let sum = 0;
          let found = false;
          hkey.split(',').forEach(part => {
            const clean = part.replace(/^sum:/, '').replace(/^[+-]/, '');
            const m = clean.match(/^([0-9a-f-]{36}):([a-z0-9_.]+)$/i);
            if (m) {
              const v = resolveKey(`${m[1]}:${m[2]}`);
              if (v !== undefined && v !== null && Number.isFinite(Number(v))) {
                sum += Number(v);
                found = true;
              }
            }
          });
          return found ? Math.round(sum * 10) / 10 : NaN;
        }
        const v = resolveKey(hkey);
        return (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) ? Number(v) : NaN;
      };

      const legs = Array.from(el.querySelectorAll('.h-leg[data-hkey]'));
      const focusKey = legs.length > 1 ? (el.dataset.focusKey || '') : '';
      const seriesList = legs.map((leg, idx) => {
        const hkey = leg.dataset.hkey || '';
        const isFocused = !focusKey || focusKey === hkey;
        leg.classList.toggle('is-focus', Boolean(focusKey && focusKey === hkey));
        leg.classList.toggle('is-dim', Boolean(focusKey && focusKey !== hkey));
        leg.style.cursor = legs.length > 1 ? 'pointer' : '';
        let pts = (cachedInsights?.series?.[hkey] || []).slice();
        if (pts.length < 2 && hkey.startsWith('sum:')) {
          pts = state.powerHistory.filter(p => p.t >= cutoff).slice();
        }
        const liveVal = resolveHistoryLive(hkey);
        if (Number.isFinite(liveVal) && pts.length > 0) {
          pts.push({ t: nowMs, v: liveVal });
        }
        const unit = leg.dataset.unit || (leg.dataset.hfmt === 'watt' ? ' W' : '');
        const isWatt = leg.dataset.hfmt === 'watt' || unit.trim() === 'W';
        const palette = ['#3b82f6', '#ff9f0a', '#30d158', '#a855f7', '#ec4899'];
        const color = leg.dataset.color || palette[idx % palette.length];
        return { leg, hkey, pts, liveVal, unit, isWatt, color, visible: isFocused };
      });

      const validSeries = seriesList.filter(s => s.visible && s.pts.length >= 2);
      const ymax = el.querySelector('.h-ymax');
      const ymin = el.querySelector('.h-ymin');
      const axis = el.querySelector('.h-axis');
      const plot = svg.closest('.h-plot');
      const oldDot = plot?.querySelector('.mz-chart-dot');

      if (!validSeries.length) {
        svg.innerHTML = '';
        if (oldDot) oldDot.style.display = 'none';
        if (ymax) ymax.textContent = '';
        if (ymin) ymin.textContent = '';
        seriesList.forEach(s => { const st = s.leg.querySelector('.h-stats'); if (st) st.textContent = ''; });
        if (axis) axis.innerHTML = '';
        if (note) { note.style.display = ''; note.textContent = cachedInsights?.loading ? 'Lade Verlaufsdaten…' : 'Sammle Live-Verlaufsdaten…'; }
        return;
      }
      if (note) note.style.display = 'none';

      const allVals = validSeries.flatMap(s => s.pts.map(p => p.v));
      const allTimes = validSeries.flatMap(s => s.pts.map(p => p.t));
      const minT = Math.min(...allTimes);
      const maxT = Math.max(...allTimes);
      const tSpan = Math.max(1, maxT - minT);

      const isWattChart = validSeries.some(s => s.isWatt) || (el.dataset.history || '').includes('min:0');
      const rawMin = Math.min(...allVals);
      const rawMax = Math.max(...allVals);
      const minV = isWattChart ? 0 : Math.floor(rawMin - 1);
      const maxV = isWattChart ? Math.max(20, Math.ceil(rawMax * 1.15)) : Math.max(minV + 2, Math.ceil(rawMax + 1));
      const vSpan = Math.max(1, maxV - minV);
      const unitLabel = validSeries[0].unit || (isWattChart ? ' W' : '');

      let defsHtml = '';
      let pathsHtml = '';
      let lastPt = null;

      validSeries.forEach((s, si) => {
        const coords = s.pts.map(p => ({
          x: ((p.t - minT) / tSpan) * 300,
          y: 110 - ((p.v - minV) / vSpan) * 96
        }));
        let lineD = `M ${coords[0].x.toFixed(1)},${coords[0].y.toFixed(1)}`;
        for (let i = 1; i < coords.length; i++) {
          const p0 = coords[i - 1], p1 = coords[i];
          const cx = ((p0.x + p1.x) / 2).toFixed(1);
          lineD += ` C ${cx},${p0.y.toFixed(1)} ${cx},${p1.y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`;
        }
        if (validSeries.length === 1) {
          const gradId = `mzGrad-${si}-${Math.random().toString(36).slice(2, 6)}`;
          const strokeId = `mzStroke-${si}-${Math.random().toString(36).slice(2, 6)}`;
          defsHtml += `
            <linearGradient id="${strokeId}" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="#3b82f6"/>
              <stop offset="55%" stop-color="#4f46e5"/>
              <stop offset="100%" stop-color="#8b5cf6"/>
            </linearGradient>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#1d4ed8" stop-opacity="0.48"/>
              <stop offset="100%" stop-color="#172554" stop-opacity="0.0"/>
            </linearGradient>
          `;
          pathsHtml += `<path d="${lineD} L 300,118 L 0,118 Z" fill="url(#${gradId})"/>`;
          pathsHtml += `<path d="${lineD}" fill="none" stroke="url(#${strokeId})" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`;
          lastPt = coords[coords.length - 1];
        } else {
          pathsHtml += `<path d="${lineD}" fill="none" stroke="${s.color}" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`;
        }
      });

      svg.innerHTML = `
        <defs>${defsHtml}</defs>
        <line x1="0" y1="30" x2="300" y2="30" stroke="rgba(148,163,184,0.10)" stroke-dasharray="3 3"/>
        <line x1="0" y1="70" x2="300" y2="70" stroke="rgba(148,163,184,0.10)" stroke-dasharray="3 3"/>
        ${pathsHtml}
      `;

      if (plot) {
        if (lastPt) {
          let dot = oldDot;
          if (!dot) {
            dot = document.createElement('span');
            dot.className = 'mz-chart-dot';
            plot.appendChild(dot);
          }
          dot.style.left = `${(lastPt.x / 300) * 100}%`;
          dot.style.top = `${(lastPt.y / 120) * 100}%`;
          dot.style.display = '';
        } else if (oldDot) {
          oldDot.style.display = 'none';
        }
      }

      if (ymax) ymax.textContent = `${maxV}${unitLabel}`;
      if (ymin) ymin.textContent = `${minV}${unitLabel}`;
      seriesList.forEach(s => {
        const st = s.leg.querySelector('.h-stats');
        if (!st) return;
        if (!s.pts.length) { st.textContent = ''; return; }
        const vals = s.pts.map(p => p.v);
        const cur = vals[vals.length - 1];
        const pk = Math.max(...vals);
        const fmt = v => s.isWatt ? `${Math.round(v)} W` : `${Number(v).toFixed(1)}${s.unit}`;
        st.textContent = `Aktuell ${fmt(cur)} · Peak ${fmt(pk)}`;
      });
      if (axis) {
        const fmtT = ts => (range === '7d' || range === '31d')
          ? new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
          : new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        axis.innerHTML = `<span>${fmtT(minT)}</span><span>${fmtT(minT + tSpan / 2)}</span><span>${fmtT(maxT)}</span>`;
      }
    });

    // Sparklines für Raumtemperaturen
    document.querySelectorAll('svg[data-spark]').forEach(svg => {
      const key = svg.dataset.spark;
      const arr = state.tempHistory[key] || [];
      if (arr.length < 2) return;
      const minT = Math.min(...arr) - 0.3;
      const maxT = Math.max(...arr) + 0.3;
      const pts = arr.map((v, i) => `${((i / (arr.length - 1)) * 100).toFixed(1)},${(22 - ((v - minT) / (maxT - minT || 1)) * 18).toFixed(1)}`).join(' ');
      const poly = svg.querySelector('polyline');
      if (poly) poly.setAttribute('points', pts);
    });

    // Wetter rendern
    if (state.weather) {
      const curTemp = document.querySelector('[data-live="__weather:temperature"]');
      const curState = document.querySelector('[data-live="__weather:state"]');
      if (curTemp) curTemp.textContent = `${state.weather.temp.toFixed(1)}°C`;
      if (curState) curState.textContent = state.weather.label;
      document.querySelectorAll('.sv-wx').forEach(el => {
        el.textContent = `${state.weather.temp.toFixed(1)}°C · ${state.weather.label}`;
      });
      document.querySelectorAll('.fc-days').forEach(box => {
        box.innerHTML = state.weather.days.map(d => `
          <div class="fc-day">
            <span class="fc-d">${d.day}</span>
            <span class="fc-i"><svg class="i" viewBox="0 0 24 24"><use href="#${d.icon}"></use></svg></span>
            <span class="fc-max">${d.max}°</span>
            <span class="fc-min">${d.min}°</span>
          </div>
        `).join('');
      });
    }

    document.querySelectorAll('[data-status="__attention:all"]').forEach(hs => {
      const homeyOk = Boolean(state.token);
      const haOk = Boolean(normalizeHaUrl(state.haUrl) && state.haToken);
      hs.classList.toggle('ok', homeyOk || haOk);
      const x = hs.querySelector('.hs-x');
      if (x) {
        if (isBridge) x.textContent = 'Echtzeit (SSE)';
        else {
          const parts = [];
          if (homeyOk) parts.push(restWsAuthed ? 'Homey (Echtzeit)' : 'Homey (Verbunden)');
          if (haOk) parts.push(state.haWsAuthed ? 'HA (Echtzeit)' : 'HA (Verbunden)');
          x.textContent = parts.length ? parts.join(' · ') : 'Token über ⚙️ setzen';
        }
      }
    });

    // Schutz aktiv + Bewegung -> auffälliges Alarm-Banner + Puls-Vignette
    const secVarLoaded = Boolean(state.logic['475c7aa4-a8c2-4a28-93f6-de21501d0fde']);
    const secActive = Boolean(resolveKey('__logic:475c7aa4-a8c2-4a28-93f6-de21501d0fde'));
    document.querySelector('.hero.has-home')?.classList.toggle('sec-armed', secActive);
    document.querySelectorAll('[data-flowrun="basic:cc44f16e-c7f6-4e25-b341-b507a6e20cdd"]').forEach(b => {
      const on = secVarLoaded && secActive;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-flowrun="basic:7a60e36c-b21d-4cd5-922f-ad36120b1b38"]').forEach(b => {
      const on = secVarLoaded && !secActive;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('.mz-inline-stack').forEach(el => {
      el.style.borderColor = secActive ? 'rgba(48,209,88,.48)' : '';
      const num = el.querySelector('.k-metrics .metric .n');
      if (num) num.style.color = secActive ? '#4ade80' : '#fca5a5';
    });
    const motionHits = [
      resolveKey('9d9716c3-21fe-48b4-b856-b34a13e47612:alarm_motion') ? 'Arbeitszimmer' : null,
      resolveKey('c9e8effa-9a01-4b9d-8710-041a056cfdba:alarm_motion') ? 'Schlafzimmer' : null,
      resolveKey('82b8f342-80e1-4645-929d-7f4110562dd5:alarm_presence') ? 'Flur' : null
    ].filter(Boolean);
    const alarmTriggered = secActive && motionHits.length > 0;
    document.body.classList.toggle('mz-alarm-active', alarmTriggered);
    const roomsEl = document.getElementById('mz-alarm-rooms');
    if (roomsEl && alarmTriggered) {
      roomsEl.textContent = `Ausgelöst in: ${motionHits.join(' · ')}`;
    }

    // Dezente Status-Pills auf dem Uhr-Startbildschirm (.dash-saver)
    const svPills = document.getElementById('sv-pills');
    if (svPills) {
      const inTemp = resolveKey('82b8f342-80e1-4645-929d-7f4110562dd5:measure_temperature');
      const watt = resolveKey('__calc:gesamt_watt');
      const blinds = resolveKey('d46a2735-7c3e-4a1b-b98f-ea62958bb629:windowcoverings_set');
      const lampIds = ['119a55cd-b7b5-4534-9004-02f96ee4cf38','157bcdea-09a2-4d61-ae32-3ff001d39b56','c455a083-f644-4d76-8aa9-84d0794c6f6a','67b0ae4f-c4b1-4366-8833-884bafbf0e94','a3924bbd-4f28-44eb-9018-efb17979c88b','af8aaa38-7e5b-4287-bd9b-3815d2156f39','743bb2da-62df-4c31-98ac-67f9a7f48f51','fcbc6251-3563-4cd9-a529-c9342b905a78','972c8120-b14d-4d96-a830-66917fc967f8','f1c832ea-f19d-42ad-9dc8-688ebdfa5c39'];
      const lampsOn = lampIds.filter(id => Boolean(resolveKey(`${id}:onoff`))).length;
      const tempTxt = inTemp !== undefined && inTemp !== null ? `${Number(inTemp).toFixed(1)}°C innen` : '–';
      const lampsTxt = lampsOn === 0 ? 'Lichter aus' : lampsOn === 1 ? '1 Licht an' : `${lampsOn} Lichter an`;
      const wattTxt = watt !== undefined ? `${Math.round(watt)} W` : '– W';
      const blindsTxt = blinds !== undefined && blinds !== null ? `Rollade ${Math.round(Number(blinds) <= 1 ? Number(blinds) * 100 : Number(blinds))}%` : 'Rollade –';
      const secCls = alarmTriggered ? 'warn' : (secActive ? 'ok' : '');
      const secTxt = alarmTriggered ? `Bewegung: ${motionHits.join(', ')}` : (secActive ? 'Schutz: AKTIV' : 'Schutz: AUS');
      svPills.innerHTML = `
        <span class="sv-pill">🌡️ ${tempTxt}</span>
        <span class="sv-pill">💡 ${lampsTxt}</span>
        <span class="sv-pill">⚡ ${wattTxt}</span>
        <span class="sv-pill">🪟 ${blindsTxt}</span>
        <span class="sv-pill ${secCls}">🛡️ ${secTxt}</span>
      `;
    }

    // Überwachungs-Protokoll ([data-timeline])
    document.querySelectorAll('[data-timeline]').forEach(el => {
      const max = Number(el.dataset.max || 8);
      const items = state.secTimeline.slice(0, max);
      if (!items.length) {
        el.innerHTML = '<div class="muted" style="padding:6px 0">Keine Ereignisse seit Öffnen aufgezeichnet</div>';
        return;
      }
      el.innerHTML = items.map(it => `
        <div class="tl-row" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:13px;">
          <span style="display:flex;align-items:center;gap:8px;min-width:0;">
            <span style="width:7px;height:7px;border-radius:50%;background:${it.tone || 'var(--on)'};flex:0 0 auto;"></span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${it.text}</span>
          </span>
          <span class="muted" style="font-size:12px;font-variant-numeric:tabular-nums;flex:0 0 auto;">${it.time}</span>
        </div>
      `).join('');
    });

    async function fetchTodayEnergy() {
      if (!state.token || isBridge) return;
      const te = state.todayEnergy;
      if (te.loading || (Date.now() - te.ts < 60000 && te.kwh !== null)) return;
      te.loading = true;
      try {
        const d = new Date();
        const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        let kwh = null;
        for (const ep of [
          `/api/manager/energy/report/day?date=${todayStr}`,
          `/api/manager/energy/report/day`
        ]) {
          try {
            const rep = await restApi(ep);
            if (typeof rep?.electricity?.consumedPeriod === 'number') {
              kwh = rep.electricity.consumedPeriod;
              break;
            }
          } catch {}
        }
        if (kwh === null) {
          const meterDevs = Object.values(state.devices || {}).filter(dev => dev?.capabilitiesObj?.meter_power);
          if (meterDevs.length) {
            const deltas = await Promise.all(meterDevs.map(async dev => {
              try {
                const uri = `homey:device:${dev.id}`;
                const logId = `${uri}:meter_power`;
                const data = await restApi(`/api/manager/insights/log/${encodeURIComponent(uri)}/${encodeURIComponent(logId)}/entry?resolution=today`);
                const rows = Array.isArray(data) ? data : (Array.isArray(data?.values) ? data.values : []);
                const nums = rows.map(r => Number(r.v)).filter(Number.isFinite);
                if (nums.length >= 2) return Math.max(0, nums[nums.length - 1] - nums[0]);
              } catch {}
              return 0;
            }));
            kwh = deltas.reduce((a, b) => a + b, 0);
          }
        }
        state.todayEnergy = { loading: false, ts: Date.now(), kwh: kwh ?? 0 };
        renderAll();
      } catch {
        state.todayEnergy = { loading: false, ts: Date.now(), kwh: te.kwh ?? 0 };
      }
    }

    document.querySelectorAll('[data-today]').forEach(el => {
      const te = state.todayEnergy;
      if (!te.loading && (Date.now() - te.ts >= 60000 || te.kwh === null)) {
        fetchTodayEnergy();
      }
      const wattNow = typeof state.calcs.gesamt_watt === 'number' ? Math.round(state.calcs.gesamt_watt) : null;
      const powerIds = ['157bcdea-09a2-4d61-ae32-3ff001d39b56','c455a083-f644-4d76-8aa9-84d0794c6f6a','67b0ae4f-c4b1-4366-8833-884bafbf0e94','a3924bbd-4f28-44eb-9018-efb17979c88b','f1c832ea-f19d-42ad-9dc8-688ebdfa5c39','743bb2da-62df-4c31-98ac-67f9a7f48f51'];
      const activePowerDevs = powerIds.filter(id => Number(resolveKey(`${id}:measure_power`) || 0) >= 0.5).length;
      if (te.kwh === null) {
        if (!state.token) {
          el.innerHTML = '<div class="muted">Token über ⚙️ setzen</div>';
        }
        return;
      }
      const rooms = [
        { name: 'Arbeitszimmer', color: '#3b82f6', w: Number(resolveKey('157bcdea-09a2-4d61-ae32-3ff001d39b56:measure_power') || 0) + Number(resolveKey('c455a083-f644-4d76-8aa9-84d0794c6f6a:measure_power') || 0) },
        { name: 'Wohnzimmer', color: '#30d158', w: Number(resolveKey('67b0ae4f-c4b1-4366-8833-884bafbf0e94:measure_power') || 0) + Number(resolveKey('a3924bbd-4f28-44eb-9018-efb17979c88b:measure_power') || 0) },
        { name: 'Küche', color: '#ff9f0a', w: Number(resolveKey('f1c832ea-f19d-42ad-9dc8-688ebdfa5c39:measure_power') || 0) },
        { name: 'Schlafzimmer', color: '#f43f5e', w: Number(resolveKey('743bb2da-62df-4c31-98ac-67f9a7f48f51:measure_power') || 0) }
      ];
      const totalRoomW = rooms.reduce((s, r) => s + Math.max(0, r.w), 0);
      const barSegs = totalRoomW > 0
        ? rooms.filter(r => r.w > 0).map(r => `<span style="width:${((r.w / totalRoomW) * 100).toFixed(1)}%;background:${r.color}" title="${r.name}: ${Math.round(r.w)} W"></span>`).join('')
        : '<span style="width:100%;background:rgba(148,163,184,.18)"></span>';
      const roomPills = rooms.map(r => `
        <span class="td-rm${r.w >= 0.5 ? ' on' : ''}">
          <i style="background:${r.color}"></i>${r.name} <b>${r.w >= 0.5 && r.w < 1 ? r.w.toFixed(1) : Math.round(r.w)} W</b>
        </span>
      `).join('');
      const kwhStr = te.kwh < 0.1 ? `${Math.round(te.kwh * 1000)}<small>Wh</small>` : `${te.kwh.toFixed(2)}<small>kWh</small>`;
      el.innerHTML = `
        <div class="td td-kwh"><div class="td-l"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-bolt"></use></svg><span>Verbrauch heute</span></div><div class="td-v">${kwhStr}</div></div>
        <div class="td td-now${wattNow > 0 ? ' live' : ''}"><div class="td-l"><span class="td-dot" aria-hidden="true"></span><span>Aktuell</span></div><div class="td-v">${wattNow !== null ? wattNow : '–'}<small>W</small></div></div>
        <div class="td td-cnt"><div class="td-l"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-lamp"></use></svg><span>Verbraucher</span></div><div class="td-v">${activePowerDevs}<small>/ ${powerIds.length}</small></div></div>
        <div class="td-dist">
          <div class="td-bar">${barSegs}</div>
          <div class="td-rooms">${roomPills}</div>
        </div>
      `;
    });

    document.querySelectorAll('.k-vacuum[data-vac-dev]').forEach(card => {
      const devId = card.dataset.vacDev;
      const isCleaning = Boolean(resolveKey(`${devId}:is_cleaning`));
      const isPaused = Boolean(resolveKey(`${devId}:pause_clean`));
      const isDocked = Boolean(resolveKey(`${devId}:dock`));
      const isStuck = Boolean(resolveKey(`${devId}:alarm_stuck`));
      const isProblem = Boolean(resolveKey(`${devId}:alarm_problem`));
      const isDrying = Boolean(resolveKey(`${devId}:mop_dry_status`));
      const waterEmpty = Boolean(resolveKey(`${devId}:alarm_water_box_empty`));
      const chargeState = String(resolveKey(`${devId}:battery_charging_state`) || '');

      let stText = 'Bereit';
      if (isStuck) stText = 'Blockiert!';
      else if (isProblem) stText = 'Störung!';
      else if (isCleaning) stText = 'Reinigt gerade';
      else if (isPaused) stText = 'Pausiert';
      else if (isDrying) stText = 'Mopp trocknet';
      else if (chargeState === 'charging') stText = 'Lädt in Station';
      else if (isDocked) stText = 'In der Station';

      const stEl = card.querySelector('[data-vac-state]');
      if (stEl) {
        stEl.textContent = stText;
        stEl.style.color = (isStuck || isProblem) ? '#fca5a5' : (isCleaning ? '#60a5fa' : '');
      }
      card.classList.toggle('is-cleaning', isCleaning);

      const lastH = resolveKey(`${devId}:clean_last`);
      const area = resolveKey(`${devId}:clean_area`);
      const durH = resolveKey(`${devId}:clean_time`);
      const subEl = card.querySelector('[data-vac-sub]');
      if (subEl) {
        const parts = [];
        if (Number.isFinite(Number(lastH))) parts.push(`Vor ${Math.round(Number(lastH))} h`);
        if (Number.isFinite(Number(area))) parts.push(`${Number(area).toFixed(1)} m²`);
        if (Number.isFinite(Number(durH))) parts.push(`${Math.round(Number(durH) * 60)} min`);
        if (waterEmpty) parts.push('Wassertank leer');
        subEl.textContent = parts.join(' · ');
      }

      card.querySelector('[data-vac-cap="clean_full"]')?.classList.toggle('on', isCleaning);
      card.querySelector('[data-vac-cap="pause_clean"]')?.classList.toggle('on', isPaused && !isCleaning);
      card.querySelector('[data-vac-cap="cancel_and_dock"]')?.classList.toggle('on', isDocked && !isCleaning);

      card.querySelectorAll('select[data-vac-cap], select[data-vac-auto]').forEach(sel => {
        const cap = sel.dataset.vacCap || sel.dataset.vacAuto;
        const v = resolveKey(`${devId}:${cap}`);
        if (v !== undefined && v !== null && document.activeElement !== sel) {
          sel.value = String(v);
        }
      });
    });

    const upd = document.getElementById('dash-updated');
    if (upd) upd.textContent = new Date().toLocaleTimeString('de-DE');

    document.querySelectorAll('.room-sheet:not([hidden])').forEach(s => populateRoomSheet(s));
    updateMediaArtwork();
    updateMediaProgress();
    updateBridgeModalBadges();
  }

  function fmtMediaSec(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function updateMediaProgress() {
    const now = Date.now();
    document.querySelectorAll('.m-prog[data-pos][data-dur]').forEach(el => {
      const devId = el.dataset.pos?.split(':')[0];
      const span = el.querySelector('span');
      if (!devId || !span) return;

      const isPlaying = Boolean(resolveKey(`${devId}:speaker_playing`));
      const track = resolveKey(`${devId}:speaker_track`) || '';
      const artist = resolveKey(`${devId}:speaker_artist`) || '';
      const album = resolveKey(`${devId}:speaker_album`) || '';
      const trackKey = `${track}|${artist}|${album}`;

      const rawPos = resolveKey(el.dataset.pos);
      const rawDur = resolveKey(el.dataset.dur);
      let pos = (rawPos !== undefined && rawPos !== null && rawPos !== '') ? Number(rawPos) : NaN;
      let dur = (rawDur !== undefined && rawDur !== null && rawDur !== '') ? Number(rawDur) : NaN;
      if (Number.isFinite(dur) && dur > 36000) {
        dur /= 1000;
        if (Number.isFinite(pos)) pos /= 1000;
      }

      let st = state.mediaProg[devId];
      if (!st || st.trackKey !== trackKey) {
        st = state.mediaProg[devId] = {
          trackKey,
          pos: Number.isFinite(pos) ? pos : 0,
          dur: Number.isFinite(dur) ? dur : 0,
          posAt: now,
          elapsed: 0,
          lastTick: now,
          wasPlaying: isPlaying
        };
      }

      const card = el.closest('.card.k-media');
      const infoEl = card?.querySelector('.m-info');
      let timeChip = infoEl?.querySelector('.mz-prog-time');
      if (infoEl && !timeChip) {
        timeChip = document.createElement('span');
        timeChip.className = 'm-chip mz-prog-time';
        timeChip.style.display = 'none';
        infoEl.appendChild(timeChip);
      }

      // Option A: Echter Fortschritt (speaker_position & speaker_duration vorhanden)
      if (Number.isFinite(pos) && Number.isFinite(dur) && dur > 0) {
        if (pos !== st.pos || dur !== st.dur || isPlaying !== st.wasPlaying) {
          st.pos = pos;
          st.dur = dur;
          st.posAt = now;
          st.wasPlaying = isPlaying;
        }
        const curPos = isPlaying ? Math.min(dur, st.pos + (now - st.posAt) / 1000) : Math.min(dur, st.pos);
        const pct = Math.max(0, Math.min(100, (curPos / dur) * 100));
        el.classList.remove('is-live-fallback');
        span.style.width = `${pct.toFixed(1)}%`;
        if (timeChip) {
          timeChip.style.display = '';
          timeChip.textContent = `${fmtMediaSec(curPos)} / ${fmtMediaSec(dur)}`;
        }
        return;
      }

      // Option B (Fallback): Laufzeit-Anzeige + Live-Balken während Wiedergabe
      if (isPlaying) {
        if (st.wasPlaying) st.elapsed += (now - st.lastTick) / 1000;
        st.lastTick = now;
        st.wasPlaying = true;
        el.classList.add('is-live-fallback');
        span.style.width = '';
        if (timeChip) {
          timeChip.style.display = '';
          timeChip.textContent = `▶ ${fmtMediaSec(st.elapsed)}`;
        }
      } else {
        st.lastTick = now;
        st.wasPlaying = false;
        el.classList.remove('is-live-fallback');
        span.style.width = '0%';
        if (timeChip) {
          if (st.elapsed > 0 && track) {
            timeChip.style.display = '';
            timeChip.textContent = `⏸ ${fmtMediaSec(st.elapsed)}`;
          } else {
            timeChip.style.display = 'none';
          }
        }
      }
    });
  }

  const mediaRefreshTimers = {};
  function scheduleMediaRefresh(devId) {
    if (!state.token || isBridge || !devId) return;
    if (mediaRefreshTimers[devId]) {
      mediaRefreshTimers[devId].forEach(clearTimeout);
    }
    const run = async () => {
      try {
        const fresh = await restApi(`/api/manager/devices/device/${devId}`);
        if (fresh && fresh.id) {
          state.devices[devId] = fresh;
          updateMediaArtwork();
        }
      } catch {}
    };
    mediaRefreshTimers[devId] = [
      setTimeout(run, 600),
      setTimeout(run, 2500)
    ];
  }

  async function loadArtBlob(url, cacheKey) {
    if (state.artCache[cacheKey]) return state.artCache[cacheKey];
    state.artCache[cacheKey] = 'loading';
    try {
      const rawUrl = url.startsWith('http') ? url : `${baseUrl()}${url}`;
      const sep = rawUrl.includes('?') ? '&' : '?';
      const fullUrl = `${rawUrl}${sep}_cb=${encodeURIComponent(cacheKey)}`;
      const fetchOpts = { cache: 'no-store' };
      if (state.token) fetchOpts.headers = { 'Authorization': `Bearer ${state.token}` };
      const res = await fetch(fullUrl, fetchOpts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blobUrl = URL.createObjectURL(await res.blob());
      state.artCache[cacheKey] = blobUrl;
      updateMediaArtwork();
      return blobUrl;
    } catch {
      state.artCache[cacheKey] = '';
      return '';
    }
  }

  function updateMediaArtwork() {
    document.querySelectorAll('.card.k-media').forEach(card => {
      const liveEl = card.querySelector('[data-live*=":speaker_track"]');
      const devId = liveEl?.dataset.live?.split(':')[0];
      if (!devId) return;
      const dev = state.devices[devId];
      const imgEntry = (dev?.images || []).find(im => im.id === 'albumart' || im.type === 'media') || (dev?.images || [])[0];
      const imgUrl = imgEntry?.imageObj?.url;
      const track = dev?.capabilitiesObj?.speaker_track?.value || '';
      const artist = dev?.capabilitiesObj?.speaker_artist?.value || '';
      const album = dev?.capabilitiesObj?.speaker_album?.value || '';
      const cacheKey = imgEntry?.imageObj ? `${imgEntry.imageObj.id}:${imgEntry.imageObj.lastUpdated || ''}:${track}|${artist}|${album}` : '';

      let bg = card.querySelector('.mz-media-bg');
      if (!bg) {
        bg = document.createElement('div');
        bg.className = 'mz-media-bg';
        card.prepend(bg);
      }
      const head = card.querySelector('.m-head');
      let art = head?.querySelector('.mz-media-art');
      if (head && !art) {
        art = document.createElement('img');
        art.className = 'mz-media-art';
        art.alt = 'Album Cover';
        head.prepend(art);
      }

      if (!imgUrl || !cacheKey) {
        card.classList.remove('has-art');
        return;
      }

      const cached = state.artCache[cacheKey];
      if (cached && cached !== 'loading') {
        card.classList.add('has-art');
        if (art && art.src !== cached) art.src = cached;
        bg.style.backgroundImage = `url("${cached}")`;
      } else if (!cached) {
        loadArtBlob(imgUrl, cacheKey);
      }
    });
  }

  async function setCap(devId, cap, val) {
    if (devId && devId.includes('.')) {
      return setHaCapability(devId, cap, val);
    }
    if (isBridge) {
      state.values[`${devId}:${cap}`] = val;
      renderAll();
      await bridgePost('/dashboard/action', { action: 'set', device_id: devId, capability: cap, value: val }).catch(console.error);
      return;
    }
    try {
      await restApi(`/api/manager/devices/device/${devId}/capability/${cap}`, {
        method: 'PUT',
        body: JSON.stringify({ value: val })
      });
      if (state.devices[devId]?.capabilitiesObj?.[cap]) state.devices[devId].capabilitiesObj[cap].value = val;
      renderAll();
    } catch (e) { console.error(e); }
  }

  async function triggerFlow(flowRef) {
    if (flowRef.startsWith('ha:')) {
      const entityId = flowRef.slice(3);
      const domain = entityId.split('.')[0];
      await haApi(`/api/services/${domain}/turn_on`, { method: 'POST', body: JSON.stringify({ entity_id: entityId }) }).catch(console.error);
      return;
    }
    const idx = flowRef.indexOf(':');
    const kind = idx !== -1 ? flowRef.slice(0, idx) : 'basic';
    const id = idx !== -1 ? flowRef.slice(idx + 1) : flowRef;
    if (isBridge) {
      await bridgePost('/dashboard/action', { action: 'flow', flow_id: id, advanced: kind === 'advanced' }).catch(console.error);
      return;
    }
    try {
      if (id === 'cc44f16e-c7f6-4e25-b341-b507a6e20cdd' || id === '7a60e36c-b21d-4cd5-922f-ad36120b1b38') {
        const nextVal = id === 'cc44f16e-c7f6-4e25-b341-b507a6e20cdd';
        state.logic['475c7aa4-a8c2-4a28-93f6-de21501d0fde'] = {
          ...(state.logic['475c7aa4-a8c2-4a28-93f6-de21501d0fde'] || { id: '475c7aa4-a8c2-4a28-93f6-de21501d0fde' }),
          value: nextVal
        };
        renderAll();
      }
      try { await restApi(`/api/manager/flow/flow/${id}/trigger`, { method: 'POST', body: '{}' }); }
      catch { await restApi(`/api/manager/flow/advancedflow/${id}/trigger`, { method: 'POST', body: '{}' }); }
      setTimeout(fetchRestData, 600);
      setTimeout(fetchRestData, 1800);
    } catch (e) { console.error(e); }
  }

  // --- Bridge Realtime SSE (kein Polling!) ---
  async function startBridgeRealtime() {
    const keys = collectAllKeys();
    try {
      const initial = await bridgePost('/dashboard/state', { keys, slug: state.slug });
      Object.assign(state.values, initial || {});
      renderAll();
    } catch (e) { console.error('Initial state error:', e); }

    try {
      const ticketRes = await bridgePost('/dashboard/ticket', { keys, slug: state.slug });
      if (ticketRes?.ticket) {
        if (state.es) state.es.close();
        state.es = new EventSource(`/dashboard/events?ticket=${encodeURIComponent(ticketRes.ticket)}`);
        state.es.addEventListener('patch', (ev) => {
          try {
            const patch = JSON.parse(ev.data);
            Object.assign(state.values, patch || {});
            computeCalcs();
            if (typeof state.calcs.gesamt_watt === 'number') {
              state.powerHistory.push({ t: Date.now(), v: state.calcs.gesamt_watt });
              if (state.powerHistory.length > 120) state.powerHistory.shift();
            }
            renderAll();
          } catch {}
        });
      }
    } catch (e) { console.error('SSE ticket error:', e); }
  }

  // --- Standalone REST + Homey WebSocket (kein 5s-Polling!) ---
  let restWs = null;
  let restWsAuthed = false;
  let restReconnectTimer = null;
  let wsAckSeq = 1;

  function subscribeHomeyEntities() {
    if (!restWs || restWs.readyState !== 1 || !restWsAuthed) return;
    const uris = ['homey:manager:devices', 'homey:manager:logic', 'homey:manager:users'];
    Object.keys(state.devices || {}).forEach(id => uris.push(`homey:device:${id}`));
    uris.forEach(uri => {
      restWs.send(`42/api,${wsAckSeq++}["subscribe",${JSON.stringify(uri)}]`);
    });
  }

  function connectHomeyWebSocket() {
    if (!state.token || isBridge) return;
    if (restWs) {
      try { restWs.close(); } catch {}
      restWs = null;
    }
    restWsAuthed = false;
    const host = (state.ip || 'homey.local').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${host}/socket.io/?EIO=4&transport=websocket`;

    try {
      restWs = new WebSocket(wsUrl);
      restWs.onmessage = (ev) => {
        const msg = String(ev.data || '');
        if (msg.startsWith('0')) {
          restWs.send('40');
        } else if (msg === '2') {
          restWs.send('3');
        } else if (msg.startsWith('40{')) {
          restWs.send(`420["handshakeClient",${JSON.stringify({ token: state.token })}]`);
        } else if (msg.startsWith('430')) {
          restWs.send('40/api,');
        } else if (msg.startsWith('40/api,')) {
          restWsAuthed = true;
          fetchRestData().then(() => subscribeHomeyEntities());
        } else if (msg.startsWith('42/api,') || msg.startsWith('42[')) {
          try {
            const jsonStart = msg.indexOf('[');
            const payload = JSON.parse(msg.slice(jsonStart));
            const evName = payload[0];
            const data = payload.length >= 3 ? payload[2] : payload[1];
            const capObj = data?.data || data;
            // Capability update from homey:device:<id> or manager
            const devId = capObj?.deviceId || (typeof evName === 'string' && evName.startsWith('homey:device:') ? evName.split(':')[2] : null) || capObj?.id;
            const capId = capObj?.capabilityId || capObj?.id;
            if (devId && capId && capObj?.value !== undefined && state.devices[devId]?.capabilitiesObj?.[capId]) {
              const prev = state.devices[devId].capabilitiesObj[capId].value;
              state.devices[devId].capabilitiesObj[capId].value = capObj.value;
              if (prev !== capObj.value && (capId === 'speaker_track' || capId === 'speaker_artist' || capId === 'speaker_album' || capId === 'speaker_playing')) {
                scheduleMediaRefresh(devId);
              }
              if (prev !== capObj.value && (capId === 'alarm_motion' || capId === 'alarm_presence' || capId === 'alarm_tamper' || capId === 'windowcoverings_set')) {
                const devName = state.devices[devId].name || devId;
                const label = capId === 'windowcoverings_set'
                  ? `${devName}: ${Math.round(Number(capObj.value) * 100)}%`
                  : `${devName}: ${capObj.value ? 'Ausgelöst!' : 'Ruhig'}`;
                const tone = capObj.value ? (capId === 'alarm_tamper' ? '#f43f5e' : '#ff9f0a') : '#30d158';
                state.secTimeline.unshift({
                  text: label,
                  tone,
                  time: new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                });
                if (state.secTimeline.length > 30) state.secTimeline.length = 30;
                localStorage.setItem('mz_sec_timeline', JSON.stringify(state.secTimeline));
              }
              computeCalcs();
              if (typeof state.calcs.gesamt_watt === 'number') {
                state.powerHistory.push({ t: Date.now(), v: state.calcs.gesamt_watt });
                if (state.powerHistory.length > 120) state.powerHistory.shift();
              }
              renderAll();
            } else {
              fetchRestData();
            }
          } catch {
            fetchRestData();
          }
        }
      };
      restWs.onclose = () => {
        restWs = null;
        restWsAuthed = false;
        clearTimeout(restReconnectTimer);
        restReconnectTimer = setTimeout(connectHomeyWebSocket, 5000);
      };
      restWs.onerror = () => {
        try { restWs?.close(); } catch {}
      };
    } catch (e) {
      console.error('WebSocket error:', e);
    }
  }

  let haWs = null;
  let haReconnectTimer = null;

  async function fetchHaStates() {
    if (!normalizeHaUrl(state.haUrl) || !state.haToken) return;
    try {
      const list = await haApi('/api/states');
      if (Array.isArray(list)) {
        const map = {};
        list.forEach(item => { if (item?.entity_id) map[item.entity_id] = item; });
        state.haEntities = map;
        computeCalcs();
        renderAll();
      }
    } catch (e) { console.error('HA states error:', e); }
  }

  function connectHaWebSocket() {
    const base = normalizeHaUrl(state.haUrl);
    if (!base || !state.haToken || isBridge) return;
    if (haWs) {
      try { haWs.close(); } catch {}
      haWs = null;
    }
    state.haWsAuthed = false;
    const wsUrl = `${base.replace(/^http/i, 'ws')}/api/websocket`;
    try {
      haWs = new WebSocket(wsUrl);
      haWs.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'auth_required') {
            haWs.send(JSON.stringify({ type: 'auth', access_token: state.haToken }));
          } else if (msg.type === 'auth_ok') {
            state.haWsAuthed = true;
            haWs.send(JSON.stringify({ id: 1, type: 'subscribe_events', event_type: 'state_changed' }));
            fetchHaStates();
          } else if (msg.type === 'event' && msg.event?.data?.new_state) {
            const ns = msg.event.data.new_state;
            state.haEntities[ns.entity_id] = ns;
            computeCalcs();
            renderAll();
          }
        } catch {}
      };
      haWs.onclose = () => {
        haWs = null;
        state.haWsAuthed = false;
        clearTimeout(haReconnectTimer);
        haReconnectTimer = setTimeout(connectHaWebSocket, 5000);
      };
      haWs.onerror = () => { try { haWs?.close(); } catch {} };
    } catch (e) { console.error('HA WebSocket error:', e); }
  }

  function wmoInfo(code) {
    if (code === 0) return { label: 'Klar', icon: 'i-sun' };
    if (code <= 3) return { label: 'Leicht bewölkt', icon: 'i-cloudsun' };
    if (code <= 48) return { label: 'Nebel', icon: 'i-fog' };
    if (code <= 67 || (code >= 80 && code <= 82)) return { label: 'Regen', icon: 'i-rain' };
    if (code <= 77 || (code >= 85 && code <= 86)) return { label: 'Schnee', icon: 'i-snowfall' };
    if (code >= 95) return { label: 'Gewitter', icon: 'i-storm' };
    return { label: 'Bewölkt', icon: 'i-cloud' };
  }

  async function fetchWeather() {
    try {
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=51.16&longitude=10.45&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=5&timezone=auto';
      const r = await fetch(url);
      if (!r.ok) return;
      const d = await r.json();
      const cur = wmoInfo(d.current?.weather_code ?? 2);
      state.weather = {
        temp: Number(d.current?.temperature_2m ?? 0),
        label: cur.label,
        days: (d.daily?.time || []).map((dt, idx) => {
          const info = wmoInfo(d.daily.weather_code[idx]);
          return {
            day: new Date(dt).toLocaleDateString('de-DE', { weekday: 'short' }),
            icon: info.icon,
            max: Math.round(d.daily.temperature_2m_max[idx]),
            min: Math.round(d.daily.temperature_2m_min[idx])
          };
        })
      };
      renderAll();
    } catch (e) {
      console.error('Weather error:', e);
    }
  }

  async function fetchRestData() {
    if (!state.token) { renderAll(); return; }
    try {
      const [devices, users, secVar, sysInfo] = await Promise.all([
        restApi('/api/manager/devices/device/'),
        restApi('/api/manager/users/user/').catch(() => ({})),
        restApi('/api/manager/logic/variable/475c7aa4-a8c2-4a28-93f6-de21501d0fde').catch(() => null),
        restApi('/api/manager/system/').catch(() => null)
      ]);
      state.devices = devices || {};
      state.users = users || {};
      if (secVar) state.logic[secVar.id] = secVar;
      if (sysInfo) {
        const cores = Array.isArray(sysInfo.cpus) && sysInfo.cpus.length ? sysInfo.cpus.length : 4;
        const load = Array.isArray(sysInfo.loadavg) ? Number(sysInfo.loadavg[0] || 0) : 0;
        const cpuPct = Math.max(2, Math.min(100, Math.round((load / cores) * 100)));
        const memPct = sysInfo.totalmem ? Math.round(((sysInfo.totalmem - sysInfo.freemem) / sysInfo.totalmem) * 100) : null;
        const upSec = Number(sysInfo.uptime || 0);
        const upDays = Math.floor(upSec / 86400);
        const upHours = Math.floor((upSec % 86400) / 3600);
        const upStr = upDays > 0 ? `${upDays}T ${upHours}h` : `${upHours}h`;
        state.system = {
          cpu: cpuPct,
          mem: memPct,
          temp: sysInfo.cpuTemperature ?? sysInfo.temperature ?? null,
          uptime: upStr,
          version: sysInfo.homeyVersion ? `v${sysInfo.homeyVersion}` : '–'
        };
      }
      computeCalcs();
      if (typeof state.calcs.gesamt_watt === 'number') {
        state.powerHistory.push({ t: Date.now(), v: state.calcs.gesamt_watt });
        if (state.powerHistory.length > 120) state.powerHistory.shift();
        localStorage.setItem('mz_power_history', JSON.stringify(state.powerHistory));
      }
      document.querySelectorAll('svg[data-spark]').forEach(svg => {
        const k = svg.dataset.spark;
        const v = Number(resolveKey(k));
        if (Number.isFinite(v)) {
          state.tempHistory[k] = state.tempHistory[k] || [];
          state.tempHistory[k].push(v);
          if (state.tempHistory[k].length > 30) state.tempHistory[k].shift();
        }
      });
      localStorage.setItem('mz_temp_history', JSON.stringify(state.tempHistory));
      renderAll();
    } catch (e) { console.error(e); renderAll(); }
  }

  const ROOM_SHEETS = {
    'Wohnzimmer': {
      devices: [
        { id: 'a3924bbd-4f28-44eb-9018-efb17979c88b', name: 'Licht', dim: true },
        { id: '67b0ae4f-c4b1-4366-8833-884bafbf0e94', name: 'Stehlampe', dim: false },
        { id: 'af8aaa38-7e5b-4287-bd9b-3815d2156f39', name: 'Led', dim: true },
        { id: '202f8570-9eb6-497e-b208-0693e23d3fbc', name: 'LG Fernseher', dim: false },
        { id: '344a667a-13e0-4b02-9e30-35930072a242', name: 'Anlage', dim: false },
        { id: 'c0e03303-05b5-4999-8b06-52cae3a5c4b1', name: 'Magenta', dim: false }
      ],
      media: { id: '3a50dc1a-3123-4176-883b-159954fbc38f', name: 'Alexa Echo' }
    },
    'Arbeitszimmer': {
      devices: [
        { id: '119a55cd-b7b5-4534-9004-02f96ee4cf38', name: 'Wand', dim: true },
        { id: '157bcdea-09a2-4d61-ae32-3ff001d39b56', name: 'Led', dim: true },
        { id: 'c455a083-f644-4d76-8aa9-84d0794c6f6a', name: 'Licht', dim: true }
      ],
      media: { id: '15c20f96-01d6-4391-8f9f-f13c2637241e', name: 'Echo Dot' },
      sensors: [
        { key: '9d9716c3-21fe-48b4-b856-b34a13e47612:measure_temperature', label: 'Temperatur', fmt: 'temp' },
        { key: '9d9716c3-21fe-48b4-b856-b34a13e47612:alarm_motion', label: 'Bewegung', map: '{"false":"Ruhig","true":"Bewegung!"}' }
      ]
    },
    'Küche': {
      devices: [
        { id: 'f1c832ea-f19d-42ad-9dc8-688ebdfa5c39', name: 'Licht', dim: false },
        { id: 'b2c573c2-dd53-4145-8ca0-4c969453d90f', name: 'Doppelrelais T2 - L2', dim: false }
      ],
      blindsId: 'd46a2735-7c3e-4a1b-b98f-ea62958bb629'
    },
    'Schlafzimmer': {
      devices: [
        { id: '743bb2da-62df-4c31-98ac-67f9a7f48f51', name: 'Licht', dim: true },
        { id: 'fcbc6251-3563-4cd9-a529-c9342b905a78', name: 'LED', dim: true }
      ],
      sensors: [
        { key: 'c9e8effa-9a01-4b9d-8710-041a056cfdba:measure_temperature', label: 'Temperatur', fmt: 'temp' },
        { key: 'c9e8effa-9a01-4b9d-8710-041a056cfdba:alarm_motion', label: 'Bewegung', map: '{"false":"Ruhig","true":"Bewegung!"}' }
      ]
    },
    'Flur': {
      devices: [
        { id: '972c8120-b14d-4d96-a830-66917fc967f8', name: 'Licht', dim: false }
      ],
      sensors: [
        { key: '82b8f342-80e1-4645-929d-7f4110562dd5:measure_temperature', label: 'Temperatur', fmt: 'temp' },
        { key: '82b8f342-80e1-4645-929d-7f4110562dd5:measure_humidity', label: 'Luftfeuchtigkeit', fmt: 'humid' },
        { key: '82b8f342-80e1-4645-929d-7f4110562dd5:alarm_presence', label: 'Präsenz', map: '{"false":"Ruhig","true":"Präsenz!"}' }
      ]
    }
  };

  function populateRoomSheet(sheet) {
    const name = sheet.getAttribute('aria-label') || sheet.querySelector('.rs-head b')?.textContent || '';
    const cfg = ROOM_SHEETS[name];
    const box = sheet.querySelector('.rs-box');
    if (!cfg || !box) return;
    let body = box.querySelector('.rs-body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'rs-body';
      body.style.cssText = 'display:flex;flex-direction:column;gap:12px;margin-top:12px;';
      box.appendChild(body);
    }
    const devsHtml = (cfg.devices || []).map(d => {
      const isOn = Boolean(resolveKey(`${d.id}:onoff`));
      const dimVal = Math.round((Number(resolveKey(`${d.id}:dim`) ?? 1)) * 100);
      return `
        <div class="card" style="padding:12px 14px;gap:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <span style="font-weight:600;">${d.name}</span>
            <button type="button" class="tile ${isOn ? 'on' : ''}" style="min-height:32px;padding:4px 14px;flex:0 0 auto;" data-device="${d.id}" data-cap="onoff">${isOn ? 'AN' : 'AUS'}</button>
          </div>
          ${d.dim ? `<div class="slider-row"><input type="range" class="slider" data-device="${d.id}" data-cap="dim" data-scale="0.01" data-unit="%" min="0" max="100" value="${dimVal}"><span class="slider-val">${dimVal}%</span></div>` : ''}
        </div>
      `;
    }).join('');

    let blindsHtml = '';
    if (cfg.blindsId) {
      const bPct = Math.round((Number(resolveKey(`${cfg.blindsId}:windowcoverings_set`) ?? 1)) * 100);
      blindsHtml = `
        <div class="card" style="padding:12px 14px;gap:10px;">
          <div style="font-weight:600;">🪟 Rollade Rechts (${bPct}%)</div>
          <div class="slider-row"><input type="range" class="slider" data-device="${cfg.blindsId}" data-cap="windowcoverings_set" data-scale="0.01" data-unit="%" min="0" max="100" value="${bPct}"><span class="slider-val">${bPct}%</span></div>
          <div class="segs" data-segfor="${cfg.blindsId}:windowcoverings_state">
            <button type="button" data-set="up">Hoch</button>
            <button type="button" data-set="idle">Stopp</button>
            <button type="button" data-set="down">Runter</button>
          </div>
        </div>
      `;
    }

    let mediaHtml = '';
    if (cfg.media) {
      const trk = resolveKey(`${cfg.media.id}:speaker_track`) || '–';
      mediaHtml = `<div class="card" style="padding:12px 14px;"><div class="row"><span>🎵 ${cfg.media.name}</span><span class="v">${trk}</span></div></div>`;
    }

    let sensHtml = '';
    if (cfg.sensors && cfg.sensors.length) {
      sensHtml = `<div class="card" style="padding:12px 14px;">${cfg.sensors.map(s => {
        const val = formatVal(resolveKey(s.key), s.fmt || '', s.map || '');
        return `<div class="row"><span>${s.label}</span><span class="v">${val}</span></div>`;
      }).join('')}</div>`;
    }

    body.innerHTML = devsHtml + blindsHtml + mediaHtml + sensHtml;
  }

  function showView(viewId) {
    document.querySelectorAll('.nav button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === viewId));
    document.querySelectorAll('.view[data-view]').forEach(v => v.classList.toggle('active', v.dataset.view === viewId));
    document.body.classList.toggle('mz-3d-active', viewId === 'v5');
    if (viewId === 'v5') {
      ensure3dLoaded();
      setTimeout(() => {
        try { frame3d?.contentWindow?.dispatchEvent(new Event('resize')); } catch {}
      }, 60);
    }
  }

  document.addEventListener('click', (e) => {
    const navBtn = e.target.closest('.nav button[data-view]');
    if (navBtn) return showView(navBtn.dataset.view);

    const gotoBtn = e.target.closest('[data-goto]');
    if (gotoBtn) {
      const targetName = gotoBtn.dataset.goto.trim();
      const match = Array.from(document.querySelectorAll('.nav button[data-view]')).find(b => b.textContent.trim() === targetName);
      if (match) showView(match.dataset.view);
      return;
    }

    const flowBtn = e.target.closest('[data-flowrun]');
    if (flowBtn) return triggerFlow(flowBtn.dataset.flowrun);

    const macroBtn = e.target.closest('[data-macro]');
    if (macroBtn) {
      const [idsPart, cap, rawVal] = macroBtn.dataset.macro.split('|');
      const val = rawVal === 'true' ? true : rawVal === 'false' ? false : rawVal;
      idsPart.split(',').forEach(id => setCap(id, cap, val));
      return;
    }

    const devBtn = e.target.closest('[data-device][data-cap]');
    if (devBtn && devBtn.tagName === 'BUTTON') {
      const id = devBtn.dataset.device;
      const cap = devBtn.dataset.cap;
      if (cap === 'windowcoverings_set') {
        const cur = Number(resolveKey(`${id}:${cap}`) ?? 1);
        return setCap(id, cap, cur > 0.5 ? 0 : 1);
      }
      if (devBtn.dataset.action === 'on') return setCap(id, cap, true);
      return setCap(id, cap, !resolveKey(`${id}:${cap}`));
    }

    const segBtn = e.target.closest('[data-segfor] button[data-set]');
    if (segBtn) {
      const segfor = segBtn.closest('[data-segfor]').dataset.segfor;
      const idx = segfor.indexOf(':');
      if (idx !== -1) return setCap(segfor.slice(0, idx), segfor.slice(idx + 1), segBtn.dataset.set);
    }

    const vacBtn = e.target.closest('[data-vac-dev] button[data-vac-cap]');
    if (vacBtn) {
      const devId = vacBtn.closest('[data-vac-dev]').dataset.vacDev;
      return setCap(devId, vacBtn.dataset.vacCap, true);
    }

    const vacRoomGo = e.target.closest('[data-vac-dev] [data-vac-room-go]');
    if (vacRoomGo) {
      const card = vacRoomGo.closest('[data-vac-dev]');
      const sel = card.querySelector('select[data-vac-cap="clean_room_pick"]');
      if (sel) return setCap(card.dataset.vacDev, 'clean_room_pick', sel.value);
    }

    const openRoom = e.target.closest('[data-room-open]');
    if (openRoom) {
      const name = openRoom.dataset.name || openRoom.getAttribute('aria-label') || '';
      const sheet = openRoom.parentElement?.querySelector('.room-sheet') || document.querySelector(`.room-sheet[aria-label="${name}"]`);
      if (sheet) {
        if (sheet.parentElement !== document.body) document.body.appendChild(sheet);
        populateRoomSheet(sheet);
        sheet.hidden = false;
      }
      return;
    }
    const closeRoom = e.target.closest('[data-room-close]');
    if (closeRoom) {
      const sheet = closeRoom.closest('.room-sheet');
      if (sheet) sheet.hidden = true;
      return;
    }
    if (e.target.classList && e.target.classList.contains('room-sheet')) {
      e.target.hidden = true;
      return;
    }

    const hrangeBtn = e.target.closest('[data-hrange]');
    if (hrangeBtn) {
      const hist = hrangeBtn.closest('[data-history]');
      if (hist) {
        hist.dataset.range = hrangeBtn.dataset.hrange;
        hist.querySelectorAll('[data-hrange]').forEach(b => b.classList.toggle('on', b === hrangeBtn));
        renderAll();
      }
      return;
    }

    const hlegBtn = e.target.closest('.h-leg[data-hkey]');
    if (hlegBtn) {
      const hist = hlegBtn.closest('.hist[data-history]');
      if (hist && hist.querySelectorAll('.h-leg[data-hkey]').length > 1) {
        const k = hlegBtn.dataset.hkey || '';
        hist.dataset.focusKey = hist.dataset.focusKey === k ? '' : k;
        renderAll();
      }
      return;
    }

    const houseBtn = e.target.closest('.house');
    if (houseBtn) {
      const cur = document.querySelector('.nav button[data-view].active')?.dataset.view;
      showView(cur === 'v5' ? 'v0' : 'v5');
    }
  });

  document.addEventListener('change', (e) => {
    const slider = e.target.closest('input.slider[data-device][data-cap]');
    if (slider) {
      const scale = Number(slider.dataset.scale || 1);
      setCap(slider.dataset.device, slider.dataset.cap, Number(slider.value) * scale);
    }
    const vacAuto = e.target.closest('[data-vac-dev] select[data-vac-auto]');
    if (vacAuto) {
      const devId = vacAuto.closest('[data-vac-dev]').dataset.vacDev;
      setCap(devId, vacAuto.dataset.vacAuto, vacAuto.value);
    }
  });

  function sync3dBridgeConfig() {
    try {
      if (state.ip) localStorage.setItem('homeyIp', state.ip);
      if (state.token) localStorage.setItem('homeyToken', state.token);
      if (state.haUrl) localStorage.setItem('haUrl', state.haUrl);
      if (state.haToken) localStorage.setItem('haToken', state.haToken);
      const ipEl = document.getElementById('homey-ip');
      const tokEl = document.getElementById('homey-token');
      const haUrlEl = document.getElementById('ha-url');
      const haTokEl = document.getElementById('ha-token');
      if (ipEl && state.ip) ipEl.value = state.ip;
      if (tokEl && state.token) tokEl.value = state.token;
      if (haUrlEl && state.haUrl) haUrlEl.value = state.haUrl;
      if (haTokEl && state.haToken) haTokEl.value = state.haToken;
    } catch {}
  }

  function ensure3dLoaded() {
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
  }

  const modal = document.getElementById('mz-cfg-modal');
  function updateBridgeModalBadges() {
    const homeyOn = Boolean(state.token && (restWsAuthed || Object.keys(state.devices || {}).length > 0));
    const haOn = Boolean(normalizeHaUrl(state.haUrl) && state.haToken && (state.haWsAuthed || Object.keys(state.haEntities || {}).length > 0));
    const hc = document.getElementById('mz-bridge-homey');
    const hb = document.getElementById('mz-badge-homey');
    if (hc) hc.classList.toggle('is-connected', homeyOn);
    if (hb) {
      hb.classList.toggle('connected', homeyOn);
      hb.textContent = homeyOn ? (restWsAuthed ? 'Echtzeit' : 'Verbunden') : 'Aus';
    }
    const ac = document.getElementById('mz-bridge-ha');
    const ab = document.getElementById('mz-badge-ha');
    if (ac) ac.classList.toggle('is-connected', haOn);
    if (ab) {
      ab.classList.toggle('connected', haOn);
      ab.textContent = haOn ? (state.haWsAuthed ? 'Echtzeit' : 'Verbunden') : 'Aus';
    }
  }

  function openCfgModal() {
    document.getElementById('cfg-ip'); // noop
    document.getElementById('mz-cfg-ip').value = state.ip;
    document.getElementById('mz-cfg-token').value = state.token;
    const haUrlEl = document.getElementById('mz-cfg-ha-url');
    const haTokEl = document.getElementById('mz-cfg-ha-token');
    if (haUrlEl) haUrlEl.value = state.haUrl;
    if (haTokEl) haTokEl.value = state.haToken;
    updateBridgeModalBadges();
    modal.classList.add('open');
  }
  document.getElementById('mz-cfg-close')?.addEventListener('click', () => modal.classList.remove('open'));
  document.getElementById('mz-cfg-save')?.addEventListener('click', () => {
    state.ip = document.getElementById('mz-cfg-ip').value.trim() || 'homey.local';
    state.token = document.getElementById('mz-cfg-token').value.trim();
    state.haUrl = document.getElementById('mz-cfg-ha-url')?.value.trim() || '';
    state.haToken = document.getElementById('mz-cfg-ha-token')?.value.trim() || '';
    localStorage.setItem('mz_homey_ip', state.ip);
    localStorage.setItem('mz_homey_token', state.token);
    localStorage.setItem('mz_ha_url', state.haUrl);
    localStorage.setItem('mz_ha_token', state.haToken);
    modal.classList.remove('open');
    sync3dBridgeConfig();
    fetchRestData();
    connectHomeyWebSocket();
    fetchHaStates();
    connectHaWebSocket();
    if (typeof window.connectToHomey === 'function' && state.token) window.connectToHomey();
    if (typeof window.connectToHomeAssistant === 'function' && state.haToken && state.haUrl) window.connectToHomeAssistant();
  });

  // --- Original-Toolbar (.dash-tools) & Uhr-Startbildschirm (.dash-saver) ---
  function initToolbarAndSaver() {
    const saver = document.createElement('div');
    saver.className = 'dash-saver';
    saver.hidden = true;
    saver.innerHTML = '<div class="sv-time" data-clock="time">--:--</div><div class="sv-date" data-clock="date">--</div><div class="sv-wx"></div><div class="sv-pills" id="sv-pills"></div>';
    document.body.appendChild(saver);

    let swallowClick = false;
    saver.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      saver.hidden = true;
      swallowClick = true;
    }, true);
    document.addEventListener('click', (e) => {
      if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); }
    }, true);

    const bar = document.createElement('div');
    bar.className = 'dash-tools';
    const svgIco = (id) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${id}"></use></svg>`;
    const mkBtn = (title, icon, onClick, isMain = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = isMain ? 'dash-tool' : 'dash-tool more';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = svgIco(icon);
      b.addEventListener('click', onClick);
      return b;
    };

    bar.appendChild(mkBtn('Werkzeuge & Modi', 'sliders', () => bar.classList.toggle('open'), true));

    // Theme (dark / light / auto)
    const themes = ['dark', 'light', 'auto'];
    let curTheme = localStorage.getItem('dash-theme') || 'dark';
    const mqLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    const applyTheme = (m) => {
      const resolved = m === 'auto' ? (mqLight && mqLight.matches ? 'light' : 'dark') : m;
      document.documentElement.setAttribute('data-theme', resolved === 'light' ? 'light' : 'dark');
    };
    applyTheme(curTheme);
    if (mqLight?.addEventListener) {
      mqLight.addEventListener('change', () => { if (curTheme === 'auto') applyTheme('auto'); });
    }
    const themeIco = { auto: 'theme', light: 'sun', dark: 'moon' };
    const tb = mkBtn('Design wechseln', themeIco[curTheme] || 'theme', () => {
      curTheme = themes[(themes.indexOf(curTheme) + 1) % themes.length];
      localStorage.setItem('dash-theme', curTheme);
      applyTheme(curTheme);
      tb.innerHTML = svgIco(themeIco[curTheme]);
    });
    bar.appendChild(tb);

    // Schriftgröße
    const zooms = [1, 1.15, 1.3];
    let curZoom = Number(localStorage.getItem('dash-zoom') || 1);
    document.documentElement.style.zoom = curZoom === 1 ? '' : String(curZoom);
    bar.appendChild(mkBtn('Schriftgröße', 'text', () => {
      curZoom = zooms[(zooms.indexOf(curZoom) + 1) % zooms.length];
      localStorage.setItem('dash-zoom', String(curZoom));
      document.documentElement.style.zoom = curZoom === 1 ? '' : String(curZoom);
    }));

    // Uhr-Startbildschirm / Ruhemodus
    bar.appendChild(mkBtn('Uhr-Startbildschirm', 'clock', () => {
      bar.classList.remove('open');
      updateClock();
      saver.hidden = false;
    }));

    // Hoher Kontrast
    let contrast = localStorage.getItem('dash-contrast') === '1';
    if (contrast) document.documentElement.setAttribute('data-contrast', '1');
    bar.appendChild(mkBtn('Hoher Kontrast', 'contrast', () => {
      contrast = !contrast;
      localStorage.setItem('dash-contrast', contrast ? '1' : '0');
      if (contrast) document.documentElement.setAttribute('data-contrast', '1');
      else document.documentElement.removeAttribute('data-contrast');
    }));

    // Vollbild
    if (document.documentElement.requestFullscreen) {
      bar.appendChild(mkBtn('Vollbild', 'expand', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen().catch(() => {});
      }));
    }

    // Homey-Verbindung (⚙️)
    if (!isBridge) {
      bar.appendChild(mkBtn('Homey-Verbindung', 'wrench', () => {
        bar.classList.remove('open');
        openCfgModal();
      }));
    }

    document.body.appendChild(bar);
  }

  initToolbarAndSaver();
  updateClock();
  setInterval(() => { updateClock(); updateMediaProgress(); }, 1000);
  fetchWeather();
  setInterval(fetchWeather, 900000);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  async function loadServerConfig() {
    try {
      const res = await fetch('config.json', { cache: 'no-store' });
      if (!res.ok) return;
      const cfg = await res.json();
      if (cfg?.ip && !localStorage.getItem('mz_homey_ip')) state.ip = String(cfg.ip).trim();
      if (cfg?.token && !localStorage.getItem('mz_homey_token')) state.token = String(cfg.token).trim();
      if (cfg?.haUrl && !localStorage.getItem('mz_ha_url')) state.haUrl = String(cfg.haUrl).trim();
      if (cfg?.haToken && !localStorage.getItem('mz_ha_token')) state.haToken = String(cfg.haToken).trim();
    } catch {}
  }

  if (isBridge) {
    startBridgeRealtime();
  } else {
    loadServerConfig().finally(() => {
      sync3dBridgeConfig();
      fetchRestData();
      connectHomeyWebSocket();
      fetchHaStates();
      connectHaWebSocket();
    });
  }
})();
