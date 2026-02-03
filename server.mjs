import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const WEB_PORT = process.env.NOVA_WEBUI_PORT ? Number(process.env.NOVA_WEBUI_PORT) : 18881;
const GATEWAY_HOST = '127.0.0.1';
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(process.env.HOME, '.openclaw', 'openclaw.json');

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function safeJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveFile(res, filePath, contentType) {
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const baseDir = path.dirname(new URL(import.meta.url).pathname);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${WEB_PORT}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return serveFile(res, path.join(baseDir, 'public', 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      return serveFile(res, path.join(baseDir, 'public', 'app.js'), 'text/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/styles.css') {
      return serveFile(res, path.join(baseDir, 'public', 'styles.css'), 'text/css; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const cfg = readConfig();
      const port = cfg?.gateway?.port;
      return safeJson(res, 200, {
        ok: true,
        webuiPort: WEB_PORT,
        gateway: {
          host: GATEWAY_HOST,
          port
        }
      });
    }

    // Provide gateway WS URL + token to the local UI.
    // Localhost-only web UI; do not expose this server on LAN.
    if (req.method === 'GET' && url.pathname === '/api/gateway') {
      const cfg = readConfig();
      const gatewayPort = cfg?.gateway?.port;
      const token = cfg?.gateway?.auth?.token;
      if (!gatewayPort) {
        return safeJson(res, 500, { ok: false, error: 'missing gateway port in config' });
      }
      // ws:// because gateway is loopback HTTP/WebSocket
      return safeJson(res, 200, {
        ok: true,
        wsUrl: `ws://${GATEWAY_HOST}:${gatewayPort}`,
        token: token || null
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/respond') {
      const cfg = readConfig();
      const gatewayPort = cfg?.gateway?.port;
      const token = cfg?.gateway?.auth?.token;
      if (!gatewayPort || !token) {
        return safeJson(res, 500, { ok: false, error: 'missing gateway port or token in config' });
      }

      const raw = await collectBody(req);
      const { message, moodHint, sessionUser } = JSON.parse(raw || '{}');
      if (!message || typeof message !== 'string') {
        return safeJson(res, 400, { ok: false, error: 'message required' });
      }

      const payload = {
        model: 'openclaw:main',
        user: sessionUser || 'webui:nova',
        input: [
          { type: 'message', role: 'system', content: 'You are Nova. Be concise, competent, and practical. No emoji unless the user asks.' },
          moodHint ? { type: 'message', role: 'system', content: `UI mood context: ${moodHint}` } : null,
          { type: 'message', role: 'user', content: message }
        ].filter(Boolean),
        stream: false
      };

      const resp = await fetch(`http://${GATEWAY_HOST}:${gatewayPort}/v1/responses`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const text = await resp.text();
      if (!resp.ok) {
        return safeJson(res, resp.status, { ok: false, error: 'gateway_error', details: text.slice(0, 4000) });
      }

      const data = JSON.parse(text);
      // Extract assistant text from OpenResponses items
      let out = '';
      const items = data?.output || [];
      for (const it of items) {
        if (it?.type === 'message' && it?.role === 'assistant') {
          if (Array.isArray(it.content)) {
            for (const c of it.content) {
              if (c?.type === 'output_text') out += c.text;
            }
          } else if (typeof it.content === 'string') {
            out += it.content;
          }
        }
      }

      return safeJson(res, 200, { ok: true, text: out || '(no text)', raw: data });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    safeJson(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

server.listen(WEB_PORT, '127.0.0.1', () => {
  console.log(`Nova WebUI running: http://127.0.0.1:${WEB_PORT}`);
});
