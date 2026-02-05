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
const DEFAULT_EXIT_TARGET = 74500;
const TRAILING_START = 74000;
const EXIT_NOTE = 'Raise the stop once BTC clears 74,000 so that 74,500 is the full-profit target.';

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

      const dbPath = path.join(HOME_DIR, '.openclaw', 'workspace', 'repos', 'coinbase-trading-support', 'data', 'trades.db');
      const statsQuery = `SELECT
        COUNT(*) AS trades,
        IFNULL(SUM(realized_pnl), 0) AS total_pnl,
        IFNULL(AVG(realized_pnl), 0) AS average_pnl,
        SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END) AS win_amount,
        SUM(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE 0 END) AS loss_amount
      FROM trades
      WHERE realized_pnl IS NOT NULL;`;

      let profitLoss = null;
      try {
        const statsRows = await runSqliteJson(dbPath, statsQuery);
        const row = statsRows[0] || {};
        const trades = Number.isFinite(Number(row.trades)) ? Number(row.trades) : 0;
        const wins = Number.isFinite(Number(row.wins)) ? Number(row.wins) : 0;
        const losses = Number.isFinite(Number(row.losses)) ? Number(row.losses) : 0;
        const totalPnl = Number.isFinite(Number(row.total_pnl)) ? Number(row.total_pnl) : 0;
        const averagePnl = Number.isFinite(Number(row.average_pnl)) ? Number(row.average_pnl) : 0;
        const winAmount = Number.isFinite(Number(row.win_amount)) ? Number(row.win_amount) : 0;
        const lossAmount = Number.isFinite(Number(row.loss_amount)) ? Number(row.loss_amount) : 0;
        const winRate = trades ? (wins / trades) * 100 : 0;
        profitLoss = {
          trades,
          totalPnl,
          averagePnl,
          wins,
          losses,
          winRate,
          winAmount,
          lossAmount
        };
      } catch (err) {
        console.error('failed to read ledger stats', err?.message || err);
      }

      let latestTrade = null;
      try {
        const latestRows = await runSqliteJson(dbPath, `SELECT id, status, asset, timestamp, entry_price, exit_price, realized_pnl FROM trades ORDER BY timestamp DESC LIMIT 1;`);
        if (latestRows[0]) {
          const row = latestRows[0];
          latestTrade = {
            id: row.id,
            status: row.status,
            asset: row.asset,
            timestamp: row.timestamp,
            entryPrice: Number.isFinite(Number(row.entry_price)) ? Number(row.entry_price) : null,
            exitPrice: Number.isFinite(Number(row.exit_price)) ? Number(row.exit_price) : null,
            realizedPnl: Number.isFinite(Number(row.realized_pnl)) ? Number(row.realized_pnl) : null
          };
        }
      } catch (err) {
        console.error('failed to read latest trade', err?.message || err);
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

      return safeJson(res, 200, {
        ok: true,
        jobs: jobInsights,
        profitLoss,
        latestTrade,
        tokens,
        nextExit: {
          target: DEFAULT_EXIT_TARGET,
          trailingStart: TRAILING_START,
          note: EXIT_NOTE
        }
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
