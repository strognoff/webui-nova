const chatEl = document.getElementById('chat');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const clearBtn = document.getElementById('clear');
const statusEl = document.getElementById('status');
const reconnectBtn = document.getElementById('reconnect');
const moodEl = document.getElementById('mood');
const sessionSelect = document.getElementById('sessionSelect');
const sessionKeyBadge = document.getElementById('sessionKey');

const mouth = document.getElementById('mouth');
const pupilL = document.getElementById('pupilL');
const pupilR = document.getElementById('pupilR');
const browL = document.getElementById('browL');
const browR = document.getElementById('browR');

let ws = null;
let connected = false;
let pending = new Map();
let lastSeq = null;

let isReplying = false;
let mood = 'neutral';
let selectedSessionKey = localStorage.getItem('nova_webui_sessionKey') || '';
let lastRunId = null;
let currentAssistantMsgEl = null;

function uuid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'id-' + Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function setStatus(text, ok = false, bad = false) {
  statusEl.textContent = text;
  statusEl.className = 'badge' + (ok ? ' ok' : '') + (bad ? ' bad' : '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function inferMood(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('sorry') || t.includes('unfortunately') || t.includes("can't") || t.includes('cannot')) return 'serious';
  if (t.includes('done') || t.includes('ok') || t.includes('great')) return 'happy';
  if (t.includes('?')) return 'curious';
  return 'neutral';
}

function setMood(m) {
  mood = m;
  moodEl.textContent = m;
  moodEl.className = 'badge' + (m === 'happy' ? ' ok' : '');

  if (m === 'happy') {
    browL.setAttribute('d', 'M66 82 Q82 70 98 82');
    browR.setAttribute('d', 'M122 82 Q138 70 154 82');
    mouth.setAttribute('d', 'M86 140 Q110 162 134 140');
  } else if (m === 'serious') {
    browL.setAttribute('d', 'M66 80 Q82 86 98 80');
    browR.setAttribute('d', 'M122 80 Q138 86 154 80');
    mouth.setAttribute('d', 'M88 146 Q110 140 132 146');
  } else if (m === 'curious') {
    browL.setAttribute('d', 'M66 78 Q82 66 98 78');
    browR.setAttribute('d', 'M122 84 Q138 72 154 84');
    mouth.setAttribute('d', 'M86 144 Q110 150 134 144');
  } else {
    browL.setAttribute('d', 'M66 82 Q82 74 98 82');
    browR.setAttribute('d', 'M122 82 Q138 74 154 82');
    mouth.setAttribute('d', 'M86 140 Q110 155 134 140');
  }
}

function jsonSend(obj) {
  ws.send(JSON.stringify(obj));
}

function request(method, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('not connected');
  const id = uuid();
  const req = { type: 'req', id, method, params };
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  jsonSend(req);
  return p;
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }

  if (msg?.type === 'event') {
    if (msg.event === 'connect.challenge') {
      // For localhost + token auth, we can generally ignore challenge.
      // Control UI uses this for device identity signatures.
      return;
    }

    const seq = typeof msg.seq === 'number' ? msg.seq : null;
    if (seq !== null) {
      if (lastSeq !== null && seq > lastSeq + 1) {
        // gap detected; not fatal for this lightweight UI
      }
      lastSeq = seq;
    }

    if (msg.event === 'chat') {
      onChatEvent(msg.payload);
    }
    return;
  }

  if (msg?.type === 'res') {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.payload);
    else waiter.reject(new Error(msg?.error?.message || 'request failed'));
  }
}

function onChatEvent(payload) {
  if (!payload) return;
  if (payload.sessionKey && payload.sessionKey !== selectedSessionKey) return;

  // Stream handling
  if (payload.runId && lastRunId && payload.runId !== lastRunId) {
    // ignore other runs
    return;
  }

  if (payload.state === 'delta') {
    // payload.message is a structured message; simplest is to try to find assistant text
    const text = extractAssistantText(payload.message);
    if (typeof text === 'string') {
      if (!currentAssistantMsgEl) currentAssistantMsgEl = addMsg('assistant', '');
      currentAssistantMsgEl.textContent = text;
      chatEl.scrollTop = chatEl.scrollHeight;
    }
    return;
  }

  if (payload.state === 'final') {
    const text = extractAssistantText(payload.message) || currentAssistantMsgEl?.textContent || '';
    if (currentAssistantMsgEl && text) currentAssistantMsgEl.textContent = text;
    setMood(inferMood(text));
    isReplying = false;
    lastRunId = null;
    currentAssistantMsgEl = null;
    // restore baseline mouth
    setMood(mood);
    return;
  }

  if (payload.state === 'error' || payload.state === 'aborted') {
    isReplying = false;
    lastRunId = null;
    if (currentAssistantMsgEl) currentAssistantMsgEl.textContent = payload.errorMessage || 'Error.';
    currentAssistantMsgEl = null;
    setMood('serious');
    setMood(mood);
  }
}

function extractAssistantText(message) {
  // The gateway chat payload can be:
  // - a string
  // - { role, content: [{type:'text', text:'...'}] }
  // - { role, content: '...' }
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return null;

  const role = message.role;
  if (role && role !== 'assistant') return null;

  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    let out = '';
    for (const part of c) {
      if (!part) continue;
      if (part.type === 'text' && typeof part.text === 'string') out += part.text;
      if (part.type === 'output_text' && typeof part.text === 'string') out += part.text;
    }
    return out || null;
  }
  return null;
}

async function connect() {
  try {
    setStatus('connecting…');
    const info = await fetch('/api/gateway').then(r => r.json());
    if (!info?.ok) throw new Error(info?.error || 'missing gateway info');

    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }

    ws = new WebSocket(info.wsUrl);

    ws.addEventListener('open', async () => {
      try {
        // Connect handshake
        const params = {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            // Gateway validates known client IDs; reuse the Control UI identity.
            id: 'openclaw-control-ui',
            version: 'dev',
            platform: navigator.platform || 'web',
            mode: 'webchat',
            instanceId: 'nova-webui'
          },
          role: 'operator',
          scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
          caps: [],
          auth: info.token ? { token: info.token } : undefined,
          userAgent: navigator.userAgent,
          locale: navigator.language
        };

        await request('connect', params);
        connected = true;
        setStatus('connected', true, false);

        await refreshSessions();

        if (selectedSessionKey) {
          selectSession(selectedSessionKey);
        }
      } catch (e) {
        setStatus(`connect failed: ${e?.message || e}`, false, true);
        try { ws.close(4008, 'connect failed'); } catch {}
      }
    });

    ws.addEventListener('message', (ev) => handleMessage(ev.data));

    ws.addEventListener('close', (ev) => {
      connected = false;
      const code = ev?.code;
      const reason = ev?.reason;
      const extra = (code || reason) ? ` (${code || ''}${code && reason ? ': ' : ''}${reason || ''})` : '';
      setStatus(`disconnected${extra}`, false, true);
      // fail all pending
      for (const [, waiter] of pending) waiter.reject(new Error('disconnected'));
      pending.clear();
    });

    ws.addEventListener('error', (ev) => {
      connected = false;
      setStatus('ws error (see console)', false, true);
      console.error('ws error', ev);
    });
  } catch (e) {
    setStatus(`connect error: ${e?.message || e}`, false, true);
  }
}

async function refreshSessions() {
  if (!connected) return;
  // sessions.list shape: the Control UI uses sessions.list; response is { sessions: [...] }
  const resp = await request('sessions.list', { limit: 50, activeMinutes: 720 });
  const sessions = Array.isArray(resp?.sessions) ? resp.sessions : [];

  sessionSelect.innerHTML = '';
  for (const s of sessions) {
    const key = (s?.key || '').trim();
    if (!key) continue;
    const kind = (s?.kind || '').trim();
    const age = (s?.age || s?.ageHuman || '').toString();
    const label = `${kind || 'session'} — ${key}${age ? ' (' + age + ')' : ''}`;

    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = label;
    sessionSelect.appendChild(opt);
  }

  // keep selection if possible
  if (selectedSessionKey) {
    sessionSelect.value = selectedSessionKey;
  }
}

async function loadHistory() {
  if (!connected || !selectedSessionKey) return;
  chatEl.innerHTML = '';

  const h = await request('chat.history', { sessionKey: selectedSessionKey, limit: 200 });
  const messages = Array.isArray(h?.messages) ? h.messages : [];

  for (const m of messages) {
    const role = m?.role === 'user' ? 'user' : 'assistant';
    const text = renderContentToText(m?.content);
    if (text) addMsg(role, text);
  }
}

function renderContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const c of content) {
      if (!c) continue;
      if (c.type === 'text' && typeof c.text === 'string') out += c.text;
      if (c.type === 'output_text' && typeof c.text === 'string') out += c.text;
    }
    return out;
  }
  return '';
}

async function selectSession(key) {
  selectedSessionKey = key;
  localStorage.setItem('nova_webui_sessionKey', key);
  sessionKeyBadge.textContent = key || '(none)';
  sessionKeyBadge.className = 'badge' + (key ? ' ok' : '');

  if (!key) return;
  await loadHistory();
}

async function send() {
  const msg = inputEl.value.trim();
  if (!msg || isReplying || !connected || !selectedSessionKey) return;
  inputEl.value = '';

  addMsg('user', msg);
  currentAssistantMsgEl = addMsg('assistant', '…');
  isReplying = true;
  lastRunId = uuid();

  try {
    // deliver=false keeps it in session but doesn't route to Telegram
    await request('chat.send', {
      sessionKey: selectedSessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: lastRunId,
      attachments: []
    });

    // If the gateway doesn't stream for some reason, fallback:
    // wait a moment and refresh history
    window.setTimeout(async () => {
      if (isReplying) return;
    }, 250);
  } catch (e) {
    currentAssistantMsgEl.textContent = `Error: ${e.message}`;
    isReplying = false;
    setMood('serious');
    setMood(mood);
  }
}

// Idle animation
let t0 = performance.now();
let blinkAt = performance.now() + 1200 + Math.random() * 1800;

async function doBlink() {
  const eyeL = document.getElementById('eyeL');
  const eyeR = document.getElementById('eyeR');
  eyeL.setAttribute('ry', '2');
  eyeR.setAttribute('ry', '2');
  await sleep(80);
  eyeL.setAttribute('ry', '10');
  eyeR.setAttribute('ry', '10');
}

function tick(t) {
  t0 = t;

  const s = isReplying ? 1.8 : 1.0;
  const x = Math.sin(t / 900) * 5 * s;
  const y = Math.cos(t / 1100) * 3 * s;
  pupilL.setAttribute('cx', (82 + x).toFixed(2));
  pupilR.setAttribute('cx', (138 + x).toFixed(2));
  pupilL.setAttribute('cy', (98 + y).toFixed(2));
  pupilR.setAttribute('cy', (98 + y).toFixed(2));

  if (t > blinkAt && !isReplying) {
    blinkAt = t + 1800 + Math.random() * 2600;
    doBlink();
  }

  if (isReplying) {
    const a = (Math.sin(t / 80) + 1) / 2;
    const open = 140 + a * 10;
    mouth.setAttribute('d', `M86 140 Q110 ${open.toFixed(1)} 134 140`);
  }

  requestAnimationFrame(tick);
}

// events
sendBtn.addEventListener('click', send);
reconnectBtn.addEventListener('click', connect);
clearBtn.addEventListener('click', () => {
  chatEl.innerHTML = '';
  setMood('neutral');
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

sessionSelect.addEventListener('change', async () => {
  await selectSession(sessionSelect.value);
});

setMood('neutral');
connect();
requestAnimationFrame(tick);
