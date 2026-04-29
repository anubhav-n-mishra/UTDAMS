/**
 * UTDAMS Service Worker
 * Unified message routing, badge management, and state for all four detectors.
 */

// ─── State ───
let isAudioCapturing = false;
let activeAudioTabId = null;
let backendAvailable = false;
let latestAudioResult = null;

// Per-tab deepfake video results
const videoResults = {};

// Default feature toggle states
const DEFAULT_SETTINGS = {
  deepfakeVideoEnabled: true,
  phishingEnabled: true,
  deepfakeAudioEnabled: true,
  aiTextEnabled: true,
  phishingApiUrl: 'http://127.0.0.1:5000/predict',
  aiTextApiUrl:   'http://127.0.0.1:5050/predict',
  audioBackendUrl: 'http://localhost:8000',
};

const BACKEND_URL = 'http://localhost:8000';
const HEALTH_CHECK_INTERVAL = 15000;

// ─── Init ───
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    const initial = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (stored[k] === undefined) initial[k] = DEFAULT_SETTINGS[k];
    }
    if (Object.keys(initial).length) chrome.storage.sync.set(initial);
  });
  setBadge('idle', '');
  checkAudioBackend();
});

chrome.runtime.onStartup.addListener(() => {
  checkAudioBackend();
});

// ─── Badge ───
function setBadge(status, text = '') {
  const colors = {
    idle:      '#9a8a7a',
    safe:      '#7a9e8e',
    danger:    '#c17b8a',
    analyzing: '#c4985a',
    error:     '#9a8a7a',
  };
  chrome.action.setBadgeBackgroundColor({ color: colors[status] || colors.idle });
  chrome.action.setBadgeText({ text: String(text) });
}

// ─── Audio Backend Health ───
async function checkAudioBackend() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    backendAvailable = res.ok;
  } catch {
    backendAvailable = false;
  }
  setTimeout(checkAudioBackend, HEALTH_CHECK_INTERVAL);
  return backendAvailable;
}

// ─── Offscreen Document ───
async function ensureOffscreen() {
  const ctxs = await chrome.runtime.getContexts({});
  if (!ctxs.find(c => c.contextType === 'OFFSCREEN_DOCUMENT')) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture tab audio for deepfake voice detection',
    });
  }
}

async function closeOffscreen() {
  const ctxs = await chrome.runtime.getContexts({});
  if (ctxs.find(c => c.contextType === 'OFFSCREEN_DOCUMENT')) {
    await chrome.offscreen.closeDocument();
  }
}

// ─── Audio Capture ───
async function startAudioCapture(tabId) {
  if (isAudioCapturing) return { success: false, error: 'Already capturing' };
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start-capture',
      data: {
        streamId,
        tabId,
        backendWsUrl: `ws://localhost:8000/ws/stream`,
        mode: backendAvailable ? 'backend' : 'standalone',
      },
    });
    isAudioCapturing = true;
    activeAudioTabId = tabId;
    setBadge('analyzing', '…');
    return { success: true };
  } catch (err) {
    setBadge('error', '!');
    return { success: false, error: err.message };
  }
}

async function stopAudioCapture() {
  if (!isAudioCapturing) return { success: true };
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop-capture' });
  isAudioCapturing = false;
  activeAudioTabId = null;
  latestAudioResult = null;
  setBadge('idle', '');
  await closeOffscreen();
  return { success: true };
}

// ─── Message Router ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target && msg.target !== 'service-worker') return;

  switch (msg.action || msg.type) {

    // ── Audio detection ──
    case 'start-detection':
      startAudioCapture(msg.tabId).then(sendResponse);
      return true;

    case 'stop-detection':
      stopAudioCapture().then(sendResponse);
      return true;

    case 'get-audio-status':
      sendResponse({ isAudioCapturing, activeAudioTabId, backendAvailable, latestAudioResult });
      return false;

    case 'check-backend':
      checkAudioBackend().then(ok => sendResponse({ backendAvailable: ok }));
      return true;

    case 'detection-result':
      latestAudioResult = msg.data;
      // update badge colour
      if (latestAudioResult?.label === 'FAKE') setBadge('danger', '!');
      else if (latestAudioResult?.label === 'REAL') setBadge('safe', '✓');
      // forward to popup
      chrome.runtime.sendMessage({ target: 'popup', action: 'update-audio-result', data: latestAudioResult }).catch(() => {});
      // forward to content
      if (activeAudioTabId) {
        chrome.tabs.sendMessage(activeAudioTabId, {
          action: 'badge-update',
          status: latestAudioResult.label === 'FAKE' ? 'danger' : 'safe',
          probability: latestAudioResult.smoothedProbability || latestAudioResult.probability,
          label: latestAudioResult.label,
        }).catch(() => {});
      }
      if (latestAudioResult?.label === 'FAKE' && latestAudioResult.confidence > 0.6) {
        showNotification('deepfake-audio-alert', '⚠️ Deepfake Voice Detected',
          `Audio appears AI-generated (${Math.round((latestAudioResult.smoothedProbability || 0.5) * 100)}% probability).`);
      }
      return false;

    case 'audio-level':
      chrome.runtime.sendMessage({ target: 'popup', action: 'audio-level', data: msg.data }).catch(() => {});
      return false;

    // ── Video deepfake (DeepShield) ──
    case 'DEEPSHIELD_RESULT': {
      const tabId = sender.tab?.id;
      if (!tabId) return false;
      if (!videoResults[tabId]) videoResults[tabId] = [];
      videoResults[tabId].push({ ...msg.payload, timestamp: Date.now() });
      const s = msg.payload.state;
      chrome.action.setBadgeText({ text: s === 'fake' ? '!' : s === 'real' ? '✓' : '?', tabId });
      chrome.action.setBadgeBackgroundColor({
        color: s === 'fake' ? '#c17b8a' : s === 'real' ? '#7a9e8e' : '#c4985a',
        tabId,
      });
      return false;
    }

    case 'GET_VIDEO_RESULTS':
    case 'get-video-results':
      sendResponse({ results: videoResults[msg.tabId] || [] });
      return true;

    // ── Phishing prediction (forwarded from content script) ──
    case 'PREDICT_PHISHING': {
      const payload = msg.payload;
      chrome.storage.sync.get({ phishingApiUrl: 'http://127.0.0.1:5000/predict' }, (stored) => {
        const url = stored.phishingApiUrl || 'http://127.0.0.1:5000/predict';
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(r => r.json()).then(data => {
          const label      = data.label || (data.prediction?.label) || 'safe';
          const confidence = data.confidence || data.score || (data.prediction?.score) || 0;
          const explanation = data.explanation || '';
          const keywords   = data.keywords_detected || data.keywords || [];
          sendResponse({ label, confidence, explanation, keywords });
        }).catch(() => {
          sendResponse({ label: 'safe', confidence: 0, explanation: 'Backend unavailable', keywords: [] });
        });
      });
      return true;
    }

    case 'PING':
      sendResponse({ alive: true });
      return false;

    default:
      return false;
  }
});

// ─── Tab lifecycle for video results ───
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    delete videoResults[tabId];
    chrome.action.setBadgeText({ text: '', tabId });
  }
});
chrome.tabs.onRemoved.addListener(tabId => { delete videoResults[tabId]; });

// ─── Notifications ───
let lastNotifTime = 0;
function showNotification(id, title, message) {
  const now = Date.now();
  if (now - lastNotifTime < 30000) return;
  lastNotifTime = now;
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2,
  });
}
