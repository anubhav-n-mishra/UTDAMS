/**
 * UTDAMS Popup Script
 * Manages feature toggles, per-feature UI panels, and live updates.
 */

const $ = id => document.getElementById(id);

// ─── Feature toggle definitions ───
const FEATURES = [
  { key: 'deepfakeVideo',  cardId: 'card-video',    toggleId: 'toggle-deepfakeVideo',  bodyId: 'body-video'    },
  { key: 'phishing',       cardId: 'card-phishing',  toggleId: 'toggle-phishing',       bodyId: 'body-phishing'  },
  { key: 'deepfakeAudio',  cardId: 'card-audio',    toggleId: 'toggle-deepfakeAudio',  bodyId: 'body-audio'    },
  { key: 'aiText',         cardId: 'card-aitext',   toggleId: 'toggle-aiText',         bodyId: 'body-aitext'   },
];

// ─── State ───
let currentTabId = null;
let videoResults  = [];
let isAudioDetecting = false;

// ─── Stored settings keys ───
const SETTINGS_KEYS = [
  'deepfakeVideoEnabled', 'phishingEnabled', 'deepfakeAudioEnabled', 'aiTextEnabled',
  'phishingApiUrl', 'aiTextApiUrl',
];

// ─── Load settings and wire toggles ───
chrome.storage.sync.get(SETTINGS_KEYS, (stored) => {
  for (const f of FEATURES) {
    const enabledKey = f.key + 'Enabled';
    const enabled = stored[enabledKey] !== false; // default true
    const toggleEl = $(f.toggleId);
    toggleEl.checked = enabled;

    const card = $(f.cardId);
    const body = $(f.bodyId);

    // Show body only when enabled
    if (enabled) {
      card.classList.add('expanded');
      card.classList.add('active-card');
    }

    toggleEl.addEventListener('change', () => {
      const on = toggleEl.checked;
      const update = {};
      update[enabledKey] = on;
      chrome.storage.sync.set(update);
      if (on) {
        card.classList.add('expanded', 'active-card');
      } else {
        card.classList.remove('expanded', 'active-card');
      }
    });
  }

  // Fill saved URLs
  if (stored.phishingApiUrl) $('phishing-api-url').value = stored.phishingApiUrl;
  if (stored.aiTextApiUrl)   $('aitext-api-url').value   = stored.aiTextApiUrl;
});

// ─── Get current tab ───
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  currentTabId = tab?.id;
  initVideoPanel();
  initAudioPanel();
});

// ═══════════════════════════════════════════════
// VIDEO PANEL (DeepShield)
// ═══════════════════════════════════════════════

async function loadVideoResults() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'GET_VIDEO_RESULTS', tabId: currentTabId }, res => {
      resolve(res?.results || []);
    });
  });
}

async function pingContentScript() {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(currentTabId, { type: 'PING' }, res => {
      if (chrome.runtime.lastError || !res) { resolve(null); return; }
      resolve(res);
    });
  });
}

function renderVideoResults(results) {
  const real     = results.filter(r => r.state === 'real').length;
  const fake     = results.filter(r => r.state === 'fake').length;

  $('vid-total').textContent = results.length;
  $('vid-real').textContent  = real;
  $('vid-fake').textContent  = fake;

  const list = $('video-results');
  list.innerHTML = '';

  const statusEl = $('video-status');
  if (fake > 0)       statusEl.textContent = `⚠ ${fake} deepfake${fake > 1 ? 's' : ''} detected`;
  else if (real > 0)  statusEl.textContent = `✓ ${real} video${real > 1 ? 's' : ''} appear authentic`;
  else                statusEl.textContent = 'No results yet — click Scan Now';

  if (!results.length) return;

  [...results].reverse().slice(0, 8).forEach(r => {
    const item = document.createElement('div');
    item.className = 'result-item';
    const pct = Math.round((r.score || 0) * 100);
    let domain = 'unknown';
    try { domain = new URL(r.url).hostname; } catch {}
    item.innerHTML = `
      <div class="result-dot ${r.state}"></div>
      <div class="result-text">${r.label || r.state} · ${domain}</div>
      <div class="result-pct">${pct}%</div>
    `;
    list.appendChild(item);
  });
}

async function initVideoPanel() {
  if (!currentTabId) return;
  videoResults = await loadVideoResults();
  renderVideoResults(videoResults);
  const ping = await pingContentScript();
  if (ping) {
    $('vid-total').textContent = ping.videoCount || 0;
  }
  setInterval(async () => {
    videoResults = await loadVideoResults();
    renderVideoResults(videoResults);
  }, 2000);
}

$('btn-scan').addEventListener('click', async () => {
  if (!currentTabId) return;
  $('btn-scan').textContent = '⏳ Scanning…';
  $('btn-scan').disabled = true;
  chrome.tabs.sendMessage(currentTabId, { type: 'RESCAN' }, () => {});
  setTimeout(async () => {
    videoResults = await loadVideoResults();
    renderVideoResults(videoResults);
    $('btn-scan').textContent = '⚡ Scan Now';
    $('btn-scan').disabled = false;
  }, 1800);
});

$('btn-rescan').addEventListener('click', async () => {
  if (!currentTabId) return;
  chrome.tabs.sendMessage(currentTabId, { type: 'RESCAN' }, () => {});
  setTimeout(async () => {
    videoResults = await loadVideoResults();
    renderVideoResults(videoResults);
  }, 1800);
});

// ═══════════════════════════════════════════════
// PHISHING PANEL
// ═══════════════════════════════════════════════

$('btn-save-phishing').addEventListener('click', () => {
  const url = $('phishing-api-url').value.trim();
  if (!url) return;
  chrome.storage.sync.set({ phishingApiUrl: url });
  $('btn-save-phishing').textContent = 'Saved ✓';
  setTimeout(() => ($('btn-save-phishing').textContent = 'Save URL'), 1600);
});

// ═══════════════════════════════════════════════
// AUDIO PANEL (Deepfake Voice)
// ═══════════════════════════════════════════════

const waveformCanvas = $('aud-waveform');
const waveCtx = waveformCanvas.getContext('2d');
const waveData = new Array(80).fill(0);
let animId = null;

function drawWaveform() {
  const w = waveformCanvas.width, h = waveformCanvas.height;
  waveCtx.clearRect(0, 0, w, h);

  // Soft paper background
  waveCtx.fillStyle = 'rgba(244,239,230,0.6)';
  waveCtx.fillRect(0, 0, w, h);

  // Bars
  const bw = w / waveData.length;
  const grad = waveCtx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#7b9ec1');
  grad.addColorStop(1, '#c17b8a');
  waveCtx.fillStyle = grad;

  for (let i = 0; i < waveData.length; i++) {
    const val = Math.min(waveData[i] * 9, 1);
    const bh  = Math.max(val * h * 0.85, 1);
    const x   = i * bw;
    const y   = (h - bh) / 2;
    waveCtx.beginPath();
    waveCtx.roundRect ? waveCtx.roundRect(x + 1, y, bw - 2, bh, 1) : waveCtx.rect(x + 1, y, bw - 2, bh);
    waveCtx.fill();
  }

  animId = requestAnimationFrame(drawWaveform);
}

function updateAudioResult(result) {
  if (!result) return;
  const prob = result.smoothedProbability ?? result.probability ?? 0.5;
  const probPct = Math.round(prob * 100);
  const conf = result.confidence ?? Math.abs(prob - 0.5) * 2;

  // SVG meter: circumference = 2π × 44 = 276.46
  const C = 276.46;
  const offset = C - prob * C;
  const fill = $('aud-meter-fill');
  fill.style.strokeDashoffset = offset;
  $('aud-meter-val').textContent = probPct;

  const label = $('aud-meter-label');
  fill.className = 'meter-fill';
  if (result.label === 'FAKE') {
    fill.classList.add('danger');
    $('aud-meter-val').style.color = '#c17b8a';
    label.textContent = 'FAKE'; label.className = 'meter-label danger';
  } else if (result.label === 'REAL') {
    fill.classList.add('safe');
    $('aud-meter-val').style.color = '#7a9e8e';
    label.textContent = 'REAL'; label.className = 'meter-label safe';
  } else {
    $('aud-meter-val').style.color = '#c4985a';
    label.textContent = 'ANALYZING'; label.className = 'meter-label analyzing';
  }

  $('aud-conf').textContent    = `${Math.round(conf * 100)}%`;
  $('aud-latency').textContent = `${Math.round(result.latency_ms || 0)}ms`;
  $('aud-chunks').textContent  = result.chunkNumber || '0';
}

function setAudioDetecting(active) {
  isAudioDetecting = active;
  const btn = $('btn-audio-toggle');
  if (active) {
    btn.textContent = '⏹ Stop Detection';
    btn.style.background = 'linear-gradient(135deg, #c17b8a, #a86070)';
    $('aud-meter-label').textContent = 'ANALYZING';
    $('aud-meter-label').className   = 'meter-label analyzing';
  } else {
    btn.textContent = '▶ Start Detection';
    btn.style.background = '';
    $('aud-meter-val').textContent = '--';
    $('aud-meter-label').textContent = 'IDLE';
    $('aud-meter-label').className = 'meter-label';
    $('aud-meter-fill').style.strokeDashoffset = '276.46';
    waveData.fill(0);
  }
}

async function initAudioPanel() {
  drawWaveform();

  chrome.runtime.sendMessage({ action: 'get-audio-status' }, res => {
    if (!res) return;
    updateBackendDot(res.backendAvailable);
    if (res.isAudioCapturing) {
      setAudioDetecting(true);
      if (res.latestAudioResult) updateAudioResult(res.latestAudioResult);
    }
  });

  chrome.runtime.sendMessage({ action: 'check-backend' }, res => {
    if (res) updateBackendDot(res.backendAvailable);
  });
}

function updateBackendDot(available) {
  const dot  = $('aud-backend-dot');
  const txt  = $('audio-status-text');
  dot.className = 'backend-dot ' + (available ? 'online' : 'offline');
  txt.textContent = available ? 'Backend connected' : 'Backend offline';
}

$('btn-audio-toggle').addEventListener('click', () => {
  if (isAudioDetecting) {
    chrome.runtime.sendMessage({ action: 'stop-detection' }, () => setAudioDetecting(false));
  } else {
    if (!currentTabId) return;
    chrome.runtime.sendMessage({ action: 'start-detection', tabId: currentTabId, target: 'service-worker' }, res => {
      if (res?.success) setAudioDetecting(true);
      else {
        $('audio-status-text').textContent = res?.error || 'Failed to start';
      }
    });
  }
});

// ═══════════════════════════════════════════════
// AI TEXT PANEL
// ═══════════════════════════════════════════════

$('btn-analyse-text').addEventListener('click', async () => {
  const text = $('aitext-input').value.trim();
  if (!text) return;

  const resultEl = $('aitext-result');
  resultEl.textContent = 'Analysing…';
  resultEl.className   = 'aitext-result';

  // Get saved API URL
  const stored = await new Promise(resolve =>
    chrome.storage.sync.get({ aiTextApiUrl: 'http://127.0.0.1:5050/predict' }, resolve)
  );

  try {
    const res = await fetch(stored.aiTextApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Expects: { label: "AI"|"Human", confidence: 0.92, probability: 0.92 }
    const label = (data.label || '').toString().toLowerCase();
    const conf  = data.confidence ?? data.probability ?? 0;
    const isAI  = label.includes('ai') || label === '1' || label === 'true';
    resultEl.className = 'aitext-result ' + (isAI ? 'ai' : 'human');
    resultEl.innerHTML = `
      <strong>${isAI ? '⚠ Likely AI-generated' : '✓ Likely Human-written'}</strong>
      <br>Confidence: ${Math.round(conf * 100)}%
    `;
  } catch (err) {
    resultEl.className   = 'aitext-result';
    resultEl.textContent = `Error: ${err.message} — is the backend running?`;
  }
});

$('aitext-api-url').addEventListener('change', () => {
  chrome.storage.sync.set({ aiTextApiUrl: $('aitext-api-url').value.trim() });
});

// ═══════════════════════════════════════════════
// Runtime messages from service worker
// ═══════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'popup') return;
  if (msg.action === 'update-audio-result') updateAudioResult(msg.data);
  if (msg.action === 'audio-level' && Array.isArray(msg.data)) {
    msg.data.forEach(l => { waveData.push(l); if (waveData.length > 80) waveData.shift(); });
  }
});

// ─── Cleanup ───
window.addEventListener('unload', () => {
  if (animId) cancelAnimationFrame(animId);
});
