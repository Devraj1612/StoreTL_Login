'use strict';

async function api(url, { method = 'GET', body } = {}) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: r.status });
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Face recognition wrapper (face-api.js runs in the browser; the server only compares 128-number vectors)
const Face = {
  MODEL_URL: 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/',
  _ready: null,
  streams: new Map(),

  load() {
    if (!this._ready) {
      this._ready = (async () => {
        await faceapi.nets.tinyFaceDetector.loadFromUri(this.MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(this.MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(this.MODEL_URL);
      })();
    }
    return this._ready;
  },

  async startCamera(video) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera needs a secure (https) connection.');
    if (!video) return null;

    const existing = this.streams.get(video);
    if (existing) {
      video.srcObject = existing;
      video.muted = true;
      video.playsInline = true;
      try { await video.play(); } catch { /* ignore autoplay restrictions until the user interacts */ }
      return existing;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    this.streams.set(video, stream);
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    try { await video.play(); } catch { /* ignore autoplay restrictions until the user interacts */ }
    return stream;
  },

  stopCamera(video) {
    if (!video) return;
    const stream = this.streams.get(video);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      this.streams.delete(video);
    }
    video.srcObject = null;
  },

  capturePhoto(video) {
    if (!video?.videoWidth || !video?.videoHeight) throw new Error('Camera image is not ready. Try capturing again.');
    const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process the camera image. Try again.');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.76);
  },

  // One reading; tries a few times so a blink or movement doesn't fail it.
  async describe(video, tries = 6) {
    await this.load();
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    for (let i = 0; i < tries; i++) {
      const r = await faceapi.detectSingleFace(video, opts).withFaceLandmarks().withFaceDescriptor();
      if (r) return Array.from(r.descriptor);
      await new Promise((res) => setTimeout(res, 300));
    }
    return null;
  },

  // Average of several readings (used at enrolment for a steadier template)
  async enrol(video, samples = 4) {
    const got = [];
    for (let i = 0; i < samples; i++) {
      const d = await this.describe(video);
      if (d) got.push(d);
      await new Promise((res) => setTimeout(res, 350));
    }
    if (got.length < 3) return null;
    return got[0].map((_, i) => got.reduce((s, d) => s + d[i], 0) / got.length);
  },
};

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser has no location support.'));
    navigator.geolocation.getCurrentPosition(resolve, (e) => {
      reject(new Error(e.code === 1 ? 'Location is blocked. Allow location for this site in browser settings.' : 'Could not read your location. Turn on GPS and retry.'));
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
