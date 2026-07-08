# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Lean sargassum cloud — ONE FastAPI process on ONE disposable EC2 (per the operator guardrail: local
SQLite, on-box CPU train, caddy/LE TLS in front, NO managed AWS). Bearer-token API the drifter POSTs to +
serves the static dashboard. Torn down after the beach test.

Endpoints: POST /readings (single or batch) · POST /labels · POST /train (in-threadpool CPU RF) ·
GET /model (ETag=version, 304 poll-if-newer) · POST /detections · GET / (dashboard) · GET /api/*.
Run: SARG_TOKEN=... uvicorn app:app --host 0.0.0.0 --port 8000
"""
import io
import json
import os

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

import train as trainmod
from store import Store

PHOTO_DIR = os.environ.get(
    "SARG_PHOTO_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "photos"))

TOKEN = os.environ.get("SARG_TOKEN")
if not TOKEN:  # fail loud: no shipped default, so a public build can never run with a usable token
    raise RuntimeError("SARG_TOKEN is required (no default). Export a bearer token before starting.")
store = Store(os.environ.get("SARG_DB", "sargassum.db"))
app = FastAPI(title="sargassum-rig")
# the console's drifter/*.jsx (React components, loaded via <script type="text/babel"> -- no build step)
app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")),
          name="static")


def _auth(authorization):
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="bad or missing bearer token")


@app.post("/readings")
async def post_readings(req: Request, authorization: str = Header(None)):
    _auth(authorization)
    body = await req.json()
    items = body if isinstance(body, list) else [body]
    for it in items:
        store.add_reading(it["drifter"], float(it["ts"]), it["rgb"], it.get("extra"))
    return {"ok": True, "n": len(items)}


@app.post("/labels")
async def post_labels(req: Request, authorization: str = Header(None)):
    _auth(authorization)
    b = await req.json()
    store.add_label(b["drifter"], float(b["t_start"]), float(b["t_end"]), int(b["label"]))
    return {"ok": True}


_TRAIN_META_KEYS = ("separability", "train_acc", "val_acc", "n_samples", "n_features",
                    "n_spans", "counts", "thin", "lopsided", "memorized", "tone", "headline", "detail")


@app.post("/train")
def post_train(drifter: str, authorization: str = Header(None)):
    _auth(authorization)  # sync def -> FastAPI runs it in the threadpool (the on-box CPU train)
    # Every successful train is PERSISTED (a new model-registry row) but does NOT touch the board -- the
    # operator reviews the result, then a separate POST /push moves the live pointer. This also means any
    # past trained model stays pushable later, not just the newest (revert-to-a-better-one).
    readings = store.labeled_readings(drifter)
    n_spans = store.count_labels(drifter)
    try:
        r = trainmod.train(readings, n_spans)
    except trainmod.TrainError as e:
        raise HTTPException(status_code=422, detail=str(e))  # clear error, not a bad model
    meta = {k: r[k] for k in _TRAIN_META_KEYS}
    version = store.add_model(drifter, r["blob"], meta)
    return {"ok": True, "version": version, **meta}


@app.post("/push")
def post_push(drifter: str, version: int, authorization: str = Header(None)):
    _auth(authorization)
    if store.get_model_blob(drifter, version) is None:
        raise HTTPException(status_code=404, detail=f"model v{version} not found")
    store.set_live(drifter, version)
    return {"ok": True, "live_version": version}


@app.get("/api/models")
def api_models(drifter: str, authorization: str = Header(None)):
    _auth(authorization)
    return JSONResponse({"live_version": store.get_live_version(drifter), "models": store.list_models(drifter)})


@app.patch("/api/models/{version}")
async def api_patch_model(version: int, drifter: str, req: Request, authorization: str = Header(None)):
    _auth(authorization)
    b = await req.json()
    if not store.set_model_note(drifter, version, str(b.get("note", ""))[:2000]):
        raise HTTPException(status_code=404, detail=f"model v{version} not found")
    return {"ok": True}


@app.get("/api/labels")
def api_labels(drifter: str, authorization: str = Header(None)):
    _auth(authorization)
    return JSONResponse(store.list_labels(drifter))


@app.delete("/api/labels/{label_id}")
def api_delete_label(label_id: int, drifter: str, authorization: str = Header(None)):
    _auth(authorization)
    store.delete_label(drifter, label_id)
    return {"ok": True}


@app.delete("/api/labels")
def api_clear_labels(drifter: str, authorization: str = Header(None)):
    _auth(authorization)
    return {"ok": True, "deleted": store.clear_labels(drifter)}


@app.get("/model")
def get_model(drifter: str, authorization: str = Header(None), if_none_match: str = Header(None)):
    _auth(authorization)
    version = store.get_live_version(drifter)
    if version is None:
        raise HTTPException(status_code=404, detail="no model live yet")
    etag = str(version)
    if if_none_match == etag:
        return Response(status_code=304)  # board polls with If-None-Match: only pulls if newer
    blob = store.get_model_blob(drifter, version)
    return Response(content=blob, media_type="application/octet-stream", headers={"ETag": etag})


@app.post("/detections")
async def post_detections(req: Request, authorization: str = Header(None)):
    _auth(authorization)
    b = await req.json()
    store.add_detection(b["drifter"], float(b["ts"]), int(b["state"]), b.get("proba"),
                        b.get("features", []), b.get("saturated", False),
                        b.get("battery"), b.get("battery_mv"))
    res = store.pop_pending_capture(b["drifter"])   # one-shot remote-shutter command rides the response
    return {"ok": True, "capture": ({"res": res} if res else None)}


@app.get("/api/readings")
def api_readings(drifter: str, authorization: str = Header(None)):
    _auth(authorization)  # bearer-gate the data reads too (the dashboard sends the token)
    return JSONResponse(store.recent_readings(drifter))


@app.get("/api/detections")
def api_detections(drifter: str, authorization: str = Header(None)):
    _auth(authorization)
    return JSONResponse(store.recent_detections(drifter))


# ── remote shutter ──────────────────────────────────────────────────────────
@app.post("/capture-request")
async def post_capture_request(drifter: str, req: Request, authorization: str = Header(None)):
    _auth(authorization)
    b = await req.json()
    store.set_pending_capture(drifter, str(b.get("res", "5MP")))
    return {"ok": True}


@app.post("/photos")
async def post_photo(req: Request, authorization: str = Header(None)):
    _auth(authorization)
    drifter = req.headers.get("X-Drifter", "drifter1")
    ts = float(req.headers.get("X-Ts", "0") or 0)
    res = req.headers.get("X-Res", "")
    if req.headers.get("X-Capture-Error"):
        store.add_photo(drifter, ts, res, 0, 0, 0, False, None, None)
        return {"ok": True, "captured": False}
    data = await req.body()
    d = os.path.join(PHOTO_DIR, drifter)
    os.makedirs(d, exist_ok=True)
    stem = str(int(ts)) if ts else str(len(data))
    path = os.path.join(d, stem + ".jpg")
    thumb_path = os.path.join(d, stem + ".thumb.jpg")
    with open(path, "wb") as f:
        f.write(data)
    width = height = 0
    try:
        im = Image.open(io.BytesIO(data))
        width, height = im.size
        im.thumbnail((240, 240))
        im.convert("RGB").save(thumb_path, "JPEG", quality=70)
    except Exception:
        thumb_path = path  # unreadable image: serve the original as its own thumb
    store.add_photo(drifter, ts, res, width, height, len(data), True, path, thumb_path)
    return {"ok": True, "captured": True, "bytes": len(data)}


@app.get("/api/photos")
def api_photos(drifter: str, authorization: str = Header(None)):
    _auth(authorization)
    return JSONResponse(store.list_photos(drifter))


# Image GET routes are UNAUTHENTICATED on purpose: a browser <img> can't send an Authorization header, and
# the disposable rig already serves GET / unauthenticated (no real data). Keeps the film-strip simple.
@app.get("/photos/{pid}/thumb")
def photo_thumb(pid: int):
    p = store.get_photo(pid)
    if not p or not p["thumb_path"]:
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(p["thumb_path"], media_type="image/jpeg")


@app.get("/photos/{pid}/full")
def photo_full(pid: int):
    p = store.get_photo(pid)
    if not p or not p["path"]:
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(p["path"], media_type="image/jpeg")


@app.get("/", response_class=HTMLResponse)
def dashboard():
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "dashboard.html")) as f:
        html = f.read()
    # Bake the real throwaway bearer into the served page so the naked URL works with no token in the URL.
    # json.dumps yields a safe JS string literal regardless of token bytes (Python str.replace is literal —
    # no $-pattern expansion). GET / is unauthenticated, so this exposes the throwaway token to anyone who
    # loads the page — acceptable ONLY for this disposable rig (no real data, torn down after the test).
    return html.replace('"__SARG_TOKEN__"', json.dumps(TOKEN))
