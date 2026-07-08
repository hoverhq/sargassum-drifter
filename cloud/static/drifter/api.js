// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
/* ── Drifter Field Console — API client against the real FastAPI+SQLite rig ──
   TOKEN is a global const baked into the page by app.py's dashboard() route (see the inline <script> in
   dashboard.html, loaded before this file). Every call is bearer-authed against the same rig the board
   POSTs to; there is no separate backend for the console. */
const API = (() => {
  const authHeaders = () => ({ Authorization: 'Bearer ' + TOKEN });
  const jsonHeaders = () => ({ ...authHeaders(), 'Content-Type': 'application/json' });
  const qs = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  async function getReadings(drifter) {
    const r = await fetch(`/api/readings?${qs({ drifter })}`, { headers: authHeaders() });
    return r.ok ? r.json() : [];
  }
  async function getDetections(drifter) {
    const r = await fetch(`/api/detections?${qs({ drifter })}`, { headers: authHeaders() });
    return r.ok ? r.json() : [];
  }
  async function getLabels(drifter) {
    const r = await fetch(`/api/labels?${qs({ drifter })}`, { headers: authHeaders() });
    return r.ok ? r.json() : [];
  }
  async function postLabel(drifter, tStart, tEnd, label) {
    const r = await fetch('/labels', {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ drifter, t_start: tStart, t_end: tEnd, label }),
    });
    return r.ok;
  }
  async function deleteLabel(drifter, id) {
    const r = await fetch(`/api/labels/${id}?${qs({ drifter })}`, { method: 'DELETE', headers: authHeaders() });
    return r.ok;
  }
  async function clearLabels(drifter) {
    const r = await fetch(`/api/labels?${qs({ drifter })}`, { method: 'DELETE', headers: authHeaders() });
    return r.ok ? r.json() : { deleted: 0 };
  }
  async function postTrain(drifter) {
    const r = await fetch(`/train?${qs({ drifter })}`, { method: 'POST', headers: authHeaders() });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...j };
  }
  async function postPush(drifter, version) {
    const r = await fetch(`/push?${qs({ drifter, version })}`, { method: 'POST', headers: authHeaders() });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...j };
  }
  async function getModels(drifter) {
    const r = await fetch(`/api/models?${qs({ drifter })}`, { headers: authHeaders() });
    return r.ok ? r.json() : { live_version: null, models: [] };
  }
  async function patchModelNote(drifter, version, note) {
    const r = await fetch(`/api/models/${version}?${qs({ drifter })}`, {
      method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ note }),
    });
    return r.ok;
  }
  async function postCaptureRequest(drifter, res) {
    const r = await fetch(`/capture-request?${qs({ drifter })}`, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ res }),
    });
    return r.json();
  }
  async function getPhotos(drifter) {
    const r = await fetch(`/api/photos?${qs({ drifter })}`, { headers: authHeaders() });
    return r.ok ? r.json() : [];
  }

  return {
    getReadings, getDetections, getLabels, postLabel, deleteLabel, clearLabels,
    postTrain, postPush, getModels, patchModelNote, postCaptureRequest, getPhotos,
  };
})();

Object.assign(window, { API });
