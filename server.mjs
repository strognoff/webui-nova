import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SQLITE_MAX_BUFFER = 8 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const HOME_DIR = process.env.HOME || os.homedir();

const WEB_PORT = process.env.NOVA_WEBUI_PORT ? Number(process.env.NOVA_WEBUI_PORT) : 18881;
const GATEWAY_HOST = '127.0.0.1';
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(HOME_DIR, '.openclaw', 'openclaw.json');

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

function normalizeTimestamp(value) {
  if (typeof value === 'number') return value;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function runSqliteJson(dbPath, query) {
  const result = [];
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, query], { maxBuffer: SQLITE_MAX_BUFFER });
    if (!stdout) return result;
    result.push(...JSON.parse(stdout));
  } catch (err) {
    console.error('sqlite3 error', err?.message || err);
  }
  return result;
}

const baseDir = path.dirname(new URL(import.meta.url).pathname);
const DIST_DIR = path.join(baseDir, '..', 'nova-ui-react', 'dist');
const ASSET_DIR = path.join(DIST_DIR, 'assets');
const TOKEN_HISTORY_PATH = path.join(HOME_DIR, '.openclaw', 'workspace', 'data', 'token_usage.json');

function londonDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

function loadTokenHistory() {
  try {
    const raw = fs.readFileSync(TOKEN_HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastTotalTokens: Number.isFinite(Number(parsed?.lastTotalTokens)) ? Number(parsed.lastTotalTokens) : 0,
      history: parsed?.history || {}
    };
  } catch (error) {
    return { lastTotalTokens: 0, history: {} };
  }
}

function saveTokenHistory(data) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_HISTORY_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_HISTORY_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('failed to persist token history', error?.message || error);
  }
}

function normalizeHistoryEntries(history, limit = 14) {
  const entries = Object.entries(history || {}).map(([date, tokens]) => ({
    date,
    tokens: Number.isFinite(Number(tokens)) ? Number(tokens) : 0
  }));
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries.slice(-limit);
}

function updateTokenHistory(currentTotal, today) {
  const data = loadTokenHistory();
  const prevTotal = Number.isFinite(Number(data.lastTotalTokens)) ? Number(data.lastTotalTokens) : 0;
  const delta = Math.max(0, Number(currentTotal) - prevTotal);
  const history = { ...data.history };
  if (!history[today]) history[today] = 0;
  history[today] += delta;
  const pruned = normalizeHistoryEntries(history, 5).reduce((acc, entry) => {
    acc[entry.date] = entry.tokens;
    return acc;
  }, {});
  const result = {
    lastTotalTokens: Number(currentTotal) || prevTotal,
    history: pruned
  };
  saveTokenHistory(result);
  return result;
}

function loadOrUpdateTokenHistory(currentTotal) {
  const today = londonDateString();
  if (Number.isFinite(Number(currentTotal))) {
    return updateTokenHistory(currentTotal, today);
  }
  return loadTokenHistory();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${WEB_PORT}`);

    const distDir = path.join(baseDir, '..', 'nova-ui-react', 'dist');

    if (req.method === 'GET' && url.pathname === '/') {
      return serveFile(res, path.join(distDir, 'index.html'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET') {
      const candidate = path.join(distDir, url.pathname.replace(/^\//, ''));
      if (candidate.startsWith(distDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const ext = path.extname(candidate);
        const type = ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : ext === '.css'
            ? 'text/css; charset=utf-8'
            : ext === '.svg'
              ? 'image/svg+xml'
              : 'application/octet-stream';
        return serveFile(res, candidate, type);
      }
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

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      try {
        const sessionsPath = path.join(HOME_DIR, '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
        const rawSessions = fs.readFileSync(sessionsPath, 'utf8');
        const sessions = JSON.parse(rawSessions);
        const items = Object.entries(sessions || {}).map(([key, value]) => ({
          key,
          label: value?.label || key,
          totalTokens: value?.totalTokens || 0,
          lastUpdated: value?.lastUpdated || null
        }));
        items.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
        return safeJson(res, 200, { ok: true, sessions: items });
      } catch (err) {
        return safeJson(res, 500, { ok: false, error: err?.message || String(err) });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/session-history') {
      try {
        const sessionKey = url.searchParams.get('sessionKey');
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
        if (!sessionKey) {
          return safeJson(res, 400, { ok: false, error: 'sessionKey required' });
        }
        const sessionsPath = path.join(HOME_DIR, '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
        const rawSessions = fs.readFileSync(sessionsPath, 'utf8');
        const sessions = JSON.parse(rawSessions);
        const sess = sessions?.[sessionKey];
        const sessionFile = sess?.sessionFile;
        if (!sessionFile || !fs.existsSync(sessionFile)) {
          return safeJson(res, 404, { ok: false, error: 'session file not found' });
        }
        const raw = fs.readFileSync(sessionFile, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        const messages = [];
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry?.type !== 'message') continue;
            const msg = entry?.message;
            const role = msg?.role;
            if (!role || !['user', 'assistant', 'system'].includes(role)) continue;
            const content = Array.isArray(msg?.content) ? msg.content : [];
            const textParts = content
              .map(part => {
                if (!part) return null;
                if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
                  return part.text || null;
                }
                return null;
              })
              .filter(Boolean);
            const text = textParts.join('\n').trim();
            if (!text) continue;
            messages.push({
              id: entry.id,
              role,
              text,
              timestamp: entry.timestamp
            });
          } catch (err) {
            // ignore parse errors
          }
        }
        const sliced = messages.slice(-limit);
        return safeJson(res, 200, { ok: true, messages: sliced });
      } catch (err) {
        return safeJson(res, 500, { ok: false, error: err?.message || String(err) });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/insights') {
      const jobsPath = path.join(HOME_DIR, '.openclaw', 'cron', 'jobs.json');
      let jobInsights = [];
      try {
        const raw = fs.readFileSync(jobsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
        jobInsights = jobs.map(job => {
          const schedule = job.schedule || {};
          const state = job.state || {};
          return {
            id: job.id,
            name: job.name,
            enabled: Boolean(job.enabled),
            scheduleKind: schedule.kind,
            scheduleExpr: schedule.expr,
            scheduleTz: schedule.tz,
            nextRunAtMs: normalizeTimestamp(state.nextRunAtMs),
            lastRunAtMs: normalizeTimestamp(state.lastRunAtMs),
            lastStatus: state.lastStatus || 'idle',
            lastError: state.lastError || null
          };
        });
      } catch (err) {
        console.error('failed to read cron jobs', err?.message || err);
      }

      let tokens = null;
      try {
        const sessionsPath = path.join(HOME_DIR, '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
        const rawSessions = fs.readFileSync(sessionsPath, 'utf8');
        const sessions = JSON.parse(rawSessions);
        const mainSess = sessions['agent:main:main'];
        if (mainSess) {
          const inputTokens = Number.isFinite(Number(mainSess.inputTokens)) ? Number(mainSess.inputTokens) : 0;
          const outputTokens = Number.isFinite(Number(mainSess.outputTokens)) ? Number(mainSess.outputTokens) : 0;
          const totalTokens = Number.isFinite(Number(mainSess.totalTokens)) ? Number(mainSess.totalTokens) : 0;
          tokens = { inputTokens, outputTokens, totalTokens };
        }
      } catch (err) {
        console.error('failed to read session tokens', err?.message || err);
      }

      const tokenHistoryData = loadOrUpdateTokenHistory(tokens?.totalTokens);
      const tokenHistoryArray = normalizeHistoryEntries(tokenHistoryData.history, 5);

      const percentChange = (() => {
        if (tokenHistoryArray.length < 2) return null;
        const last = tokenHistoryArray[tokenHistoryArray.length - 1].tokens;
        const prev = tokenHistoryArray[tokenHistoryArray.length - 2].tokens || 1;
        if (prev === 0) return last === 0 ? 0 : 100;
        return ((last - prev) / prev) * 100;
      })();
      return safeJson(res, 200, {
        ok: true,
        jobs: jobInsights,
        tokens,
        tokenHistory: tokenHistoryArray,
        tokenChangePercent: percentChange,
      });
    }


    if (req.method === 'GET' && url.pathname === '/api/activity') {
      const logPath = path.join(HOME_DIR, '.openclaw', 'workspace', 'activity-log.json');
      try {
        const raw = fs.readFileSync(logPath, 'utf8');
        const parsed = JSON.parse(raw);
        const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];
        updates.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        return safeJson(res, 200, { ok: true, updates: updates.slice(0, 5) });
      } catch (err) {
        return safeJson(res, 200, { ok: true, updates: [] });
      }
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
