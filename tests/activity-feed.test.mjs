import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME = process.env.HOME || os.homedir();
const LOG_PATH = path.join(HOME, '.openclaw', 'workspace', 'activity-log.json');
const PORT = 18882;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer() {
  const child = spawn('node', ['server.mjs'], {
    cwd: path.join(HOME, '.openclaw', 'workspace', 'webui-nova'),
    env: { ...process.env, NOVA_WEBUI_PORT: String(PORT) },
    stdio: 'ignore'
  });

  for (let i = 0; i < 20; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/status`);
      if (r.ok) return child;
    } catch {}
    await wait(200);
  }
  child.kill('SIGTERM');
  throw new Error('server did not start');
}

test('activity-feed enforces max 5 and sorts newest first', async (t) => {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const backup = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8') : null;

  const updates = Array.from({ length: 8 }).map((_, i) => ({
    id: `evt-${i + 1}`,
    ts: 1700000000000 + i * 1000,
    type: 'bot',
    title: `Event ${i + 1}`,
    detail: `detail ${i + 1}`
  }));
  fs.writeFileSync(LOG_PATH, JSON.stringify({ updates }, null, 2));

  const server = await startServer();
  t.after(() => {
    server.kill('SIGTERM');
    if (backup === null) fs.rmSync(LOG_PATH, { force: true });
    else fs.writeFileSync(LOG_PATH, backup);
  });

  const res = await fetch(`http://127.0.0.1:${PORT}/api/activity-feed?limit=99`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.items));
  assert.equal(body.items.length, 5);
  assert.equal(body.items[0].id, 'evt-8');
  assert.equal(body.items[4].id, 'evt-4');
});

test('activity-feed empty state returns items: []', async (t) => {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const backup = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8') : null;
  fs.writeFileSync(LOG_PATH, JSON.stringify({ updates: [] }, null, 2));

  const server = await startServer();
  t.after(() => {
    server.kill('SIGTERM');
    if (backup === null) fs.rmSync(LOG_PATH, { force: true });
    else fs.writeFileSync(LOG_PATH, backup);
  });

  const res = await fetch(`http://127.0.0.1:${PORT}/api/activity-feed?limit=5`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { items: [] });
});
