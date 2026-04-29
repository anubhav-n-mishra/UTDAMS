/**
 * UTDAMS Unified Content Script
 * Handles: deepfake video scanning (DeepShield), phishing email detection,
 * and deepfake audio badge display. Each module gates on its feature toggle.
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────
  let settings = {
    deepfakeVideoEnabled: true,
    phishingEnabled: true,
    deepfakeAudioEnabled: true,
    aiTextEnabled: true,
    phishingApiUrl: 'http://127.0.0.1:5000/predict',
    aiTextApiUrl:   'http://127.0.0.1:5050/predict',
  };

  chrome.storage.sync.get(settings, (stored) => {
    settings = { ...settings, ...stored };
    onSettingsLoaded();
  });

  chrome.storage.onChanged.addListener((changes) => {
    for (const k of Object.keys(changes)) {
      settings[k] = changes[k].newValue;
    }
    applyToggles();
  });

  // ─────────────────────────────────────────────
  // MODULE: Deepfake Video (DeepShield)
  // ─────────────────────────────────────────────
  const DS = (() => {
    const MODEL_ID = 'onnx-community/Deep-Fake-Detector-v2-Model-ONNX';
    const FRAME_SIZE = 224;
    const SCAN_INTERVAL_MS = 4000;
    const MIN_VIDEO_WIDTH = 300;
    const THRESHOLD = 0.50;

    let classifier = null;
    let modelLoading = false;
    let modelReady = false;
    const scannedVideos = new WeakMap();
    let domObserver = null;
    let active = false;

    async function initModel() {
      if (modelReady || modelLoading) return;
      modelLoading = true;
      try {
        const libURL = chrome.runtime.getURL('libs/transformers.min.js');
        const { pipeline, env } = await import(libURL);
        env.allowLocalModels = false;
        env.useBrowserCache = true;
        classifier = await pipeline('image-classification', MODEL_ID);
        modelReady = true;
        document.querySelectorAll('video').forEach(scanVideo);
      } catch (err) {
        console.error('[UTDAMS/Video] Model load failed:', err);
      } finally {
        modelLoading = false;
      }
    }

    function extractFrame(video) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = FRAME_SIZE; canvas.height = FRAME_SIZE;
        const ctx = canvas.getContext('2d');
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return null;
        const min = Math.min(vw, vh);
        ctx.drawImage(video, (vw - min) / 2, (vh - min) / 2, min, min, 0, 0, FRAME_SIZE, FRAME_SIZE);
        return canvas.toDataURL('image/png');
      } catch { return null; }
    }

    function makeBadge(state = 'scanning', label = 'Scanning…') {
      const b = document.createElement('div');
      b.className = `utdams-ds-badge ${state}`;
      b.innerHTML = `<span class="ds-dot"></span><span class="ds-label">${label}</span>`;
      return b;
    }

    function updateBadge(badge, scanline, state, label, score) {
      badge.className = `utdams-ds-badge ${state}`;
      const pct = score != null ? Math.round(score * 100) : null;
      badge.innerHTML = `<span class="ds-dot"></span><span class="ds-label">${label}</span>${pct != null ? `<span class="ds-score">${pct}%</span>` : ''}`;
      if (scanline) scanline.className = `utdams-ds-scanline${state === 'fake' ? ' active' : ''}`;
    }

    function injectBadge(video) {
      let wrapper = video.parentElement;
      if (!wrapper.classList.contains('utdams-ds-wrapper')) {
        const w = document.createElement('div');
        w.className = 'utdams-ds-wrapper';
        w.style.cssText = 'position:relative;display:inline-block;';
        video.parentNode.insertBefore(w, video);
        w.appendChild(video);
        wrapper = w;
      }
      const badge = makeBadge('scanning', 'Scanning…');
      const scanline = document.createElement('div');
      scanline.className = 'utdams-ds-scanline';
      wrapper.appendChild(badge);
      wrapper.appendChild(scanline);
      return { badge, scanline, wrapper };
    }

    async function analyzeVideo(video, badge, scanline) {
      if (!modelReady || video.readyState < 2 || !video.videoWidth) return;
      const frame = extractFrame(video);
      if (!frame) return;
      try {
        const results = await classifier(frame);
        const top = results[0];
        const lbl = top.label.toLowerCase();
        const score = top.score;
        let state, displayLabel;
        if (lbl.includes('deepfake') || lbl.includes('fake')) {
          state = score >= THRESHOLD ? 'fake' : 'uncertain';
          displayLabel = state === 'fake' ? 'Deepfake' : 'Uncertain';
        } else {
          state = score >= THRESHOLD ? 'real' : 'uncertain';
          displayLabel = state === 'real' ? 'Authentic' : 'Uncertain';
        }
        updateBadge(badge, scanline, state, displayLabel, score);
        chrome.runtime.sendMessage({
          type: 'DEEPSHIELD_RESULT',
          payload: { state, label: displayLabel, score, url: location.href },
        }).catch(() => {});
      } catch (e) { console.warn('[UTDAMS/Video]', e); }
    }

    function scanVideo(video) {
      if (!active || scannedVideos.has(video)) return;
      if (video.offsetWidth < MIN_VIDEO_WIDTH) return;
      const { badge, scanline } = injectBadge(video);
      scannedVideos.set(video, { badge, scanline });
      if (modelReady) {
        if (video.readyState >= 2) analyzeVideo(video, badge, scanline);
        else video.addEventListener('loadeddata', () => analyzeVideo(video, badge, scanline), { once: true });
      }
      const id = setInterval(() => {
        if (!active) { clearInterval(id); return; }
        if (!video.paused && !video.ended) analyzeVideo(video, badge, scanline);
      }, SCAN_INTERVAL_MS);
      scannedVideos.set(video, { badge, scanline, intervalId: id });
    }

    function start() {
      if (active) return;
      active = true;
      initModel();
      document.querySelectorAll('video').forEach(scanVideo);
      domObserver = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeName === 'VIDEO') scanVideo(n);
          if (n.querySelectorAll) n.querySelectorAll('video').forEach(scanVideo);
        }
      });
      domObserver.observe(document.body, { childList: true, subtree: true });
    }

    function stop() {
      active = false;
      if (domObserver) { domObserver.disconnect(); domObserver = null; }
      // remove badges
      document.querySelectorAll('.utdams-ds-badge, .utdams-ds-scanline').forEach(el => el.remove());
      document.querySelectorAll('.utdams-ds-wrapper').forEach(wrapper => {
        const video = wrapper.querySelector('video');
        if (video) wrapper.parentNode.insertBefore(video, wrapper);
        wrapper.remove();
      });
    }

    return { start, stop, get modelReady() { return modelReady; }, get videoCount() { return document.querySelectorAll('video').length; } };
  })();

  // ─────────────────────────────────────────────
  // MODULE: Phishing Email Detection
  // ─────────────────────────────────────────────
  const PH = (() => {
    let active = false;
    let lastHash = '';
    let running = false;
    let observer = null;

    const GMAIL = location.hostname.includes('mail.google.com');
    const OUTLOOK = location.hostname.includes('outlook.live.com') || location.hostname.includes('outlook.office.com');

    function extractLinks(text) {
      if (!text) return [];
      return Array.from(new Set((text.match(/(https?:\/\/[^\s"']+)/g) || [])));
    }

    function getLinkRisk(url) {
      try {
        const d = new URL(url).hostname.toLowerCase();
        if (/google\.|gmail\.|microsoft\.|outlook\.|apple\.|paypal\./.test(d)) return { risk: 'safe', color: '#7a9e8e' };
        if (d.length > 25 || /-verify|secure-|login-|auth-|\.ru|\.cn/.test(d)) return { risk: 'high', color: '#c17b8a' };
        return { risk: 'unknown', color: '#c4985a' };
      } catch { return { risk: 'unknown', color: '#9a8a7a' }; }
    }

    function getEmailFields() {
      let subject = '', sender = '', body = '';
      if (GMAIL) {
        subject = (document.querySelector('h2.hP, h2[role="heading"]') || {}).innerText?.trim() || '';
        const sEl = document.querySelector('.gD, .go, [email]');
        sender = sEl ? (sEl.getAttribute('email') || sEl.innerText.trim()) : '';
        body = (document.querySelector('div.a3s') || {}).innerText?.trim() || '';
      }
      return { subject, sender, body, links: extractLinks(body) };
    }

    function getBanner() {
      let b = document.getElementById('utdams-phish-banner');
      if (b) return b;
      b = document.createElement('div');
      b.id = 'utdams-phish-banner';
      b.className = 'utdams-phish-banner';
      b.innerHTML = `
        <button class="utdams-phish-close" onclick="this.parentElement.style.display='none'">×</button>
        <div class="utdams-phish-title" id="utdams-phish-title"></div>
        <div class="utdams-phish-expl" id="utdams-phish-expl"></div>
        <div class="utdams-phish-conf" id="utdams-phish-conf"></div>
        <button class="utdams-phish-more" id="utdams-phish-more">Details ▼</button>
        <div class="utdams-phish-details" id="utdams-phish-details" style="display:none"></div>
      `;
      b.querySelector('#utdams-phish-more').onclick = () => {
        const det = b.querySelector('#utdams-phish-details');
        const btn = b.querySelector('#utdams-phish-more');
        const open = det.style.display !== 'none';
        det.style.display = open ? 'none' : 'block';
        btn.textContent = open ? 'Details ▼' : 'Details ▲';
      };
      document.body.appendChild(b);
      return b;
    }

    function showBanner(label, confidence, explanation, payload) {
      if (!active) return;
      const b = getBanner();
      let display = label;
      if (confidence < 0.50) display = 'safe';
      else if (confidence < 0.85) display = 'suspicious';
      b.querySelector('#utdams-phish-title').textContent =
        display === 'phishing' ? '⚠ Phishing Email' :
        display === 'suspicious' ? '⚠ Suspicious Email' : '✓ Safe Email';
      b.className = 'utdams-phish-banner ' + display;
      b.querySelector('#utdams-phish-expl').textContent = explanation || '';
      b.querySelector('#utdams-phish-conf').textContent = `Confidence: ${Math.round(confidence * 100)}%`;
      const linkHtml = (payload.links || []).map(l => {
        const r = getLinkRisk(l);
        return `<div style="color:${r.color}">• ${l} (${r.risk})</div>`;
      }).join('');
      b.querySelector('#utdams-phish-details').innerHTML =
        `<b>Sender:</b> ${payload.sender || 'Unknown'}<br><b>Links:</b><br>${linkHtml || 'None'}`;
      b.style.display = 'block';
    }

    function hideBanner() {
      const b = document.getElementById('utdams-phish-banner');
      if (b) b.style.display = 'none';
    }

    function predict(payload) {
      chrome.runtime.sendMessage({ type: 'PREDICT_PHISHING', payload }, (res) => {
        if (!res) return;
        showBanner(res.label, res.confidence, res.explanation, payload);
      });
    }

    function waitForBody(cb) {
      let tries = 0;
      const iv = setInterval(() => {
        const body = document.querySelector('div.a3s');
        if (body && body.innerText.trim().length > 20) { clearInterval(iv); cb(); }
        if (++tries > 30) clearInterval(iv);
      }, 150);
    }

    function tryPredict() {
      if (!active || running) return;
      running = true;
      waitForBody(() => {
        const email = getEmailFields();
        if (!email.body && !email.subject) { hideBanner(); running = false; return; }
        const hash = btoa(unescape(encodeURIComponent(JSON.stringify({
          subject: email.subject, sender: email.sender, body: email.body.slice(0, 400),
        }))));
        if (hash !== lastHash) { lastHash = hash; predict(email); }
        running = false;
      });
    }

    function start() {
      if (active) return;
      if (!GMAIL && !OUTLOOK) return;
      active = true;
      observer = new MutationObserver(tryPredict);
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('click', () => setTimeout(tryPredict, 200));
      setTimeout(tryPredict, 800);
    }

    function stop() {
      active = false;
      if (observer) { observer.disconnect(); observer = null; }
      hideBanner();
    }

    return { start, stop };
  })();

  // ─────────────────────────────────────────────
  // MODULE: Deepfake Audio badge
  // ─────────────────────────────────────────────
  const AUD = (() => {
    let host = null;
    let badge = null;

    function inject() {
      if (document.getElementById('utdams-aud-root')) return;
      host = document.createElement('div');
      host.id = 'utdams-aud-root';
      host.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;top:0;left:0;width:0;height:0;';
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'closed' });

      badge = document.createElement('div');
      badge.className = 'utdams-aud-badge idle';
      badge.innerHTML = '<span>🛡</span>';
      badge.style.pointerEvents = 'auto';

      const style = document.createElement('style');
      style.textContent = `
        .utdams-aud-badge{position:fixed;bottom:24px;right:24px;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,0.2);backdrop-filter:blur(10px);border:1.5px solid rgba(255,255,255,0.15);transition:all .3s}
        .utdams-aud-badge.idle{background:rgba(154,138,122,0.2)}
        .utdams-aud-badge.safe{background:rgba(122,158,142,0.25);border-color:rgba(122,158,142,0.5);box-shadow:0 0 16px rgba(122,158,142,0.3)}
        .utdams-aud-badge.danger{background:rgba(193,123,138,0.25);border-color:rgba(193,123,138,0.5);box-shadow:0 0 16px rgba(193,123,138,0.4);animation:aud-pulse 1.5s ease-in-out infinite}
        .utdams-aud-badge.analyzing{background:rgba(196,152,90,0.2);border-color:rgba(196,152,90,0.4)}
        @keyframes aud-pulse{0%,100%{box-shadow:0 0 16px rgba(193,123,138,0.3)}50%{box-shadow:0 0 24px rgba(193,123,138,0.55)}}
      `;
      shadow.appendChild(style);
      shadow.appendChild(badge);
    }

    function update(status) {
      if (!badge) return;
      badge.className = 'utdams-aud-badge ' + (status || 'idle');
    }

    function start() { inject(); }
    function stop() {
      if (host) { host.remove(); host = null; badge = null; }
    }

    return { start, stop, update };
  })();

  // ─────────────────────────────────────────────
  // Routing: phishing prediction via background
  // ─────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'badge-update') {
      AUD.update(msg.status);
    }
    if (msg.type === 'PING') {
      sendResponse({
        alive: true,
        modelReady: DS.modelReady,
        videoCount: DS.videoCount,
      });
    }
    if (msg.type === 'RESCAN') {
      document.querySelectorAll('video').forEach(v => {
        // trigger re-analysis by dispatching loadeddata-equivalent
        v.dispatchEvent(new Event('loadeddata'));
      });
      sendResponse({ ok: true });
    }
    return true;
  });

  // ─────────────────────────────────────────────
  // Toggles
  // ─────────────────────────────────────────────
  function applyToggles() {
    if (settings.deepfakeVideoEnabled) DS.start(); else DS.stop();
    if (settings.phishingEnabled) PH.start(); else PH.stop();
    if (settings.deepfakeAudioEnabled) AUD.start(); else AUD.stop();
  }

  function onSettingsLoaded() {
    applyToggles();
  }

})();
