const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8765;
const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');

const DEFAULT_CONFIG = {
  connections: {
    homey: {
      ip: '',
      token: ''
    },
    homeassistant: {
      url: '',
      token: ''
    }
  },
  ip: '',
  token: '',
  mapping: {},
  settings: {
    theme: 'mica',
    wallHeight: 1.8,
    ambient: 0.35,
    showLabels: true,
    showGrid: true,
    showPedestal: false,
    auroraAnim: true,
    groundShadow: false
  },
  pictures: [],
  defaultHouseId: 'demo',
  activeHouseId: 'demo',
  houses: [],
  house: null
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon'
};

function mergeWithDefaults(raw = {}) {
  const ip = (raw.connections && raw.connections.homey && raw.connections.homey.ip) ?? raw.ip ?? '';
  const token = (raw.connections && raw.connections.homey && raw.connections.homey.token) ?? raw.token ?? '';
  const haUrl = (raw.connections && raw.connections.homeassistant && raw.connections.homeassistant.url) ?? '';
  const haToken = (raw.connections && raw.connections.homeassistant && raw.connections.homeassistant.token) ?? '';
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    pictures: Array.isArray(raw.pictures) ? raw.pictures : [],
    ip,
    token,
    connections: {
      ...DEFAULT_CONFIG.connections,
      ...(raw.connections || {}),
      homey: {
        ...DEFAULT_CONFIG.connections.homey,
        ...((raw.connections && raw.connections.homey) || {}),
        ip,
        token
      },
      homeassistant: {
        ...DEFAULT_CONFIG.connections.homeassistant,
        ...((raw.connections && raw.connections.homeassistant) || {}),
        url: haUrl,
        token: haToken
      }
    },
    mapping: {
      ...DEFAULT_CONFIG.mapping,
      ...(raw.mapping || {})
    },
    settings: {
      ...DEFAULT_CONFIG.settings,
      ...(raw.settings || {})
    },
    defaultHouseId: raw.defaultHouseId || raw.activeHouseId || (raw.house && raw.house.mode === 'custom' ? (raw.house.id || 'custom_1') : 'demo'),
    activeHouseId: raw.activeHouseId || raw.defaultHouseId || (raw.house && raw.house.mode === 'custom' ? (raw.house.id || 'custom_1') : 'demo'),
    houses: Array.isArray(raw.houses)
      ? raw.houses
      : (raw.house && raw.house.mode === 'custom' ? [{ id: 'custom_1', ...raw.house }] : [])
  };
}

function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const initial = {
      ...DEFAULT_CONFIG,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(initial, null, 2), 'utf8');
    console.log('Standard-Konfiguration automatisch erstellt: config.json');
  }
}

function readConfig() {
  try {
    ensureConfigFile();
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return mergeWithDefaults(raw);
  } catch (e) {
    return mergeWithDefaults({});
  }
}

function writeConfig(newData) {
  const current = readConfig();
  const nextConnections = newData.connections
    ? {
        ...current.connections,
        ...newData.connections,
        homey: {
          ...current.connections.homey,
          ...(newData.connections.homey || {})
        },
        homeassistant: {
          ...current.connections.homeassistant,
          ...(newData.connections.homeassistant || {})
        }
      }
    : { ...current.connections };

  if (typeof newData.ip === 'string') nextConnections.homey.ip = newData.ip;
  if (typeof newData.token === 'string') nextConnections.homey.token = newData.token;

  const merged = mergeWithDefaults({
    ...current,
    ...newData,
    connections: nextConnections,
    ip: nextConnections.homey.ip,
    token: nextConnections.homey.token,
    mapping: newData.mapping !== undefined ? newData.mapping : current.mapping,
    settings: {
      ...current.settings,
      ...(newData.settings || {})
    },
    updatedAt: new Date().toISOString()
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

ensureConfigFile();

function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const iface of Object.values(interfaces)) {
    for (const info of iface || []) {
      if (info.family === 'IPv4' && !info.internal) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}

function forwardProxyRequest(targetUrl, method, headers, bodyData, res) {
  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
    if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
      throw new Error('Nur http/https erlaubt');
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Ungültige Ziel-URL: ' + err.message }));
    return;
  }

  const client = parsedTarget.protocol === 'https:' ? https : http;
  const reqHeaders = { ...(headers || {}) };
  const payload = bodyData != null ? (typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData)) : null;
  if (payload !== null && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
    reqHeaders['Content-Length'] = Buffer.byteLength(payload);
  }

  const proxyReq = client.request(
    {
      hostname: parsedTarget.hostname,
      port: parsedTarget.port || (parsedTarget.protocol === 'https:' ? 443 : 80),
      path: parsedTarget.pathname + parsedTarget.search,
      method: (method || 'GET').toUpperCase(),
      headers: reqHeaders,
      timeout: 8000
    },
    (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const respBody = Buffer.concat(chunks);
        res.writeHead(proxyRes.statusCode || 200, {
          'Content-Type': proxyRes.headers['content-type'] || 'application/json; charset=utf-8'
        });
        res.end(respBody);
      });
    }
  );

  proxyReq.on('timeout', () => proxyReq.destroy(new Error('Proxy-Timeout')));
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  if (payload !== null) proxyReq.write(payload);
  proxyReq.end();
}

const server = http.createServer((req, res) => {
  // CORS erlauben, damit auch eine lokal geöffnete file:/// Seite Einstellungen synchronisieren kann
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (urlObj.pathname === '/api/proxy' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const { url, method, headers, body: targetBody } = JSON.parse(body || '{}');
        forwardProxyRequest(url, method, headers, targetBody, res);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (urlObj.pathname === '/api/bootstrap.js') {
    const cfg = readConfig();
    const slim = { ...cfg, pictures: undefined };
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(`window.__INITIAL_CONFIG__ = ${JSON.stringify(slim)};\n`);
    return;
  }

  if (urlObj.pathname === '/api/config') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(readConfig()));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const saved = writeConfig(parsed);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, config: saved }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }
  }

  // Statische Dateien ausliefern (index.html, manifest.json, Icons), aber config.json schützen
  const requestedPath = urlObj.pathname === '/' ? 'index.html' : urlObj.pathname.replace(/^\/+/, '');
  const resolvedPath = path.resolve(DIR, requestedPath);

  if (!resolvedPath.startsWith(DIR) || path.basename(resolvedPath) === 'config.json' || path.basename(resolvedPath) === 'server.js') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (requestedPath.startsWith('local/') && !fs.existsSync(resolvedPath)) {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end('// optional local preset\n');
    return;
  }

  const targetPath = fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()
    ? resolvedPath
    : path.join(DIR, 'index.html');

  const ext = path.extname(targetPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(targetPath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Fehler beim Laden der Datei');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HomePlan 3D Server laeuft auf:`);
  console.log(`  Lokal:   http://localhost:${PORT}/`);
  for (const ip of getLocalIPv4Addresses()) {
    console.log(`  Netzwerk: http://${ip}:${PORT}/?kiosk=1`);
  }
});
