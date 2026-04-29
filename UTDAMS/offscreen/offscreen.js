/**
 * Offscreen Document - Audio Capture & Processing Engine
 * =======================================================
 * 
 * Runs in a hidden DOM context with full MediaStream API access.
 * Captures tab audio, chunks it, and sends to backend via WebSocket.
 * Keeps audio audible to the user (passthrough).
 */

// ─── State ───
let audioContext = null;
let mediaStream = null;
let processorNode = null;
let sourceNode = null;
let wsClient = null;
let isCapturing = false;
let captureConfig = null;

// Audio chunking config (matching backend)
const SAMPLE_RATE = 16000;
const CHUNK_DURATION = 2.5;  // seconds
const OVERLAP_DURATION = 0.5; // seconds
const CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_DURATION;  // 40000
const OVERLAP_SAMPLES = SAMPLE_RATE * OVERLAP_DURATION; // 8000
const HOP_SAMPLES = CHUNK_SAMPLES - OVERLAP_SAMPLES;   // 32000

// Audio buffer for chunking
let audioBuffer = new Float32Array(0);
let audioLevelBuffer = [];

// ─── Message Handler ───
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target && message.target !== 'offscreen') return;

  switch (message.action) {
    case 'start-capture':
      startCapture(message.data);
      break;
    case 'stop-capture':
      stopCapture();
      break;
  }
});

// ─── Start Capture ───
async function startCapture(config) {
  if (isCapturing) {
    console.warn('[Offscreen] Already capturing');
    return;
  }

  captureConfig = config;
  console.log('[Offscreen] Starting capture with config:', config);

  try {
    // 1. Get the media stream from the tab
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: config.streamId,
        },
      },
      video: false,
    });

    // 2. Create AudioContext
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    sourceNode = audioContext.createMediaStreamSource(mediaStream);

    // 3. Keep audio audible (passthrough to speakers)
    sourceNode.connect(audioContext.destination);

    // 4. Create processor for chunking
    // Using ScriptProcessorNode (deprecated but widely supported)
    // Buffer size 4096 at 16kHz = ~256ms per callback
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);

    processorNode.onaudioprocess = (event) => {
      if (!isCapturing) return;

      const inputData = event.inputBuffer.getChannelData(0);

      // Compute audio level for waveform visualization
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sum / inputData.length);
      audioLevelBuffer.push(rms);

      // Send audio levels periodically for waveform display
      if (audioLevelBuffer.length >= 8) {
        chrome.runtime.sendMessage({
          target: 'service-worker',
          action: 'audio-level',
          data: audioLevelBuffer.slice(),
        });
        audioLevelBuffer = [];
      }

      // Accumulate audio data
      const newBuffer = new Float32Array(audioBuffer.length + inputData.length);
      newBuffer.set(audioBuffer);
      newBuffer.set(inputData, audioBuffer.length);
      audioBuffer = newBuffer;

      // Check if we have enough data for a chunk
      while (audioBuffer.length >= CHUNK_SAMPLES) {
        const chunk = audioBuffer.slice(0, CHUNK_SAMPLES);

        // Send chunk for processing
        sendChunkToBackend(chunk);

        // Advance buffer by hop size (keeping overlap)
        audioBuffer = audioBuffer.slice(HOP_SAMPLES);
      }
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    // 5. Connect WebSocket to backend
    if (config.mode === 'backend') {
      connectWebSocket(config.backendWsUrl);
    }

    isCapturing = true;
    audioBuffer = new Float32Array(0);
    console.log('[Offscreen] Capture started successfully');

  } catch (err) {
    console.error('[Offscreen] Failed to start capture:', err);
    chrome.runtime.sendMessage({
      target: 'service-worker',
      action: 'detection-result',
      data: {
        detectorId: 'audio',
        probability: 0.5,
        label: 'ERROR',
        confidence: 0,
        error: err.message,
      },
    });
  }
}

// ─── Stop Capture ───
function stopCapture() {
  isCapturing = false;

  // Disconnect processor
  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  // Close audio context
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  // Stop media stream tracks
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  // Close WebSocket
  if (wsClient) {
    wsClient.close();
    wsClient = null;
  }

  audioBuffer = new Float32Array(0);
  audioLevelBuffer = [];
  console.log('[Offscreen] Capture stopped');
}

// ─── WebSocket Communication ───
function connectWebSocket(url) {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) return;

  wsClient = new WebSocket(url);

  wsClient.onopen = () => {
    console.log('[Offscreen] WebSocket connected to backend');
  };

  wsClient.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'prediction' || data.type === 'batch_prediction') {
        // Forward prediction to service worker
        const result = {
          detectorId: 'audio',
          probability: data.probability,
          smoothedProbability: data.smoothed_probability || data.probability,
          label: data.label === 'spoof' || data.label === 'FAKE' ? 'FAKE' : 'REAL',
          confidence: data.confidence || Math.abs((data.probability || 0.5) - 0.5) * 2,
          latency_ms: data.latency_ms || 0,
          chunkNumber: data.chunk_number || 0,
          timestamp: Date.now(),
        };

        chrome.runtime.sendMessage({
          target: 'service-worker',
          action: 'detection-result',
          data: result,
        });
      }
    } catch (e) {
      console.error('[Offscreen] Failed to parse WS message:', e);
    }
  };

  wsClient.onerror = (err) => {
    console.error('[Offscreen] WebSocket error:', err);
  };

  wsClient.onclose = () => {
    console.log('[Offscreen] WebSocket closed');
    // Auto-reconnect if still capturing
    if (isCapturing) {
      setTimeout(() => {
        if (isCapturing && captureConfig) {
          connectWebSocket(captureConfig.backendWsUrl);
        }
      }, 2000);
    }
  };
}

function sendChunkToBackend(chunk) {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    // Send as raw binary float32
    wsClient.send(chunk.buffer);
  }
}
