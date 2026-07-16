# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Lean sargassum cloud — ONE FastAPI process on ONE disposable EC2 (per the operator guardrail: local
SQLite, on-box CPU train, caddy/LE TLS in front, NO managed AWS). Bearer-token API the drifter POSTs to +
serves the static dashboard. Torn down after the beach test.

Endpoints: POST /readings (single or batch) · POST /labels · POST /train (in-threadpool CPU RF) ·
GET /model (ETag=version, 304 poll-if-newer) · POST /detections · GET / (dashboard) · GET /api/*.
Wave-tank telemetry (bench rig): WS /ws/board (bench board pushes readings) · WS /ws/ui (dashboard
fan-out) · GET /api/wave-readings · GET /api/wave-runs · POST /api/wave-run (+/stop) ·
POST /api/wave-command.
Run: SARG_TOKEN=... uvicorn app:app --host 0.0.0.0 --port 8000
"""
import io
import json
import os
import time

from fastapi import FastAPI, Header, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
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


# ── wave-tank WS hub: single-process, module-level, all access on the event loop -- unlike Store, no
# lock is needed here (every hub method only ever runs on the one asyncio event loop, never a worker
# thread). Board connections push readings; UI connections receive the fan-out. Commands queue in
# `pending` while a drifter's board is offline and flush the moment it (re)connects. ──
class WaveHub:
    def __init__(self):
        self.boards: dict[str, WebSocket] = {}
        self.uis: dict[str, set[WebSocket]] = {}
        self.pending: dict[str, list[str]] = {}   # commands queued while board offline

    async def to_ui(self, drifter: str, text: str):
        for ws in list(self.uis.get(drifter, ())):
            try:
                await ws.send_text(text)
            except Exception:
                self.uis[drifter].discard(ws)

    async def send_cmd(self, drifter: str, cmd: str) -> bool:
        board = self.boards.get(drifter)
        payload = json.dumps({"type": "cmd", "cmd": cmd})
        if board is not None:
            try:
                await board.send_text(payload)
                return True
            except Exception:
                self.boards.pop(drifter, None)
        self.pending.setdefault(drifter, []).append(cmd)
        await self.to_ui(drifter, json.dumps({"type": "pending", "count": len(self.pending[drifter])}))
        return False


hub = WaveHub()


async def _register_board(websocket, drifter):
    # Register a board socket under its drifter name: track it, tell the UIs it's live (the normal
    # sequence is dashboard-open-first / board-powers-on-later, so a late connect must broadcast),
    # and flush any commands queued while it was offline.
    hub.boards[drifter] = websocket
    await hub.to_ui(drifter, json.dumps({"type": "board", "connected": True}))
    for cmd in hub.pending.pop(drifter, []):
        try:
            await websocket.send_text(json.dumps({"type": "cmd", "cmd": cmd}))
        except Exception:
            break


@app.websocket("/ws/board")
async def ws_board(websocket: WebSocket, drifter: str = None):
    if websocket.headers.get("authorization") != f"Bearer {TOKEN}":
        await websocket.close(code=4401)  # reject before accept -- no socket ever gets registered
        return
    await websocket.accept()
    # A board identifies itself by ?drifter= on the URL if it can; a board that can't (its frames
    # already carry a "drifter" field) is registered lazily from the first reading. `registered`
    # holds the name this socket is bound to -- None until we learn it.
    registered = None
    if drifter:
        registered = drifter
        await _register_board(websocket, drifter)
    try:
        while True:
            text = await websocket.receive_text()
            try:
                msg = json.loads(text)
            except ValueError:
                continue  # not JSON -- ignore rather than kill the connection over one bad frame
            if registered is None:
                d = msg.get("drifter")
                if not d:
                    continue  # no query param and no drifter field -- nothing to route on yet
                registered = d
                await _register_board(websocket, d)
            if msg.get("type") == "reading":
                ts = store.add_wave_reading(registered, msg["hs_mm"], msg["tp_ds"], text)
                # forward with the SERVER receipt ts, never the board's own (untrusted) clock
                await hub.to_ui(registered, json.dumps({**msg, "ts": ts}))
                # A mainline beacon's wave-tank frame ALSO carries the raw RGB sample its sarg verdict
                # was computed from (see WaveTankFrame.rgb in the firmware) -- feed it into the SAME
                # readings/detections tables the standalone drifter's Console tab already reads, so
                # that tab lights up for this board too with zero UI changes. Only write a detection
                # once the feature window is stable (sarg.s); the "warming up" sentinel (sarg.c==255)
                # is not a real class and would corrupt SARG.byLabel lookups downstream.
                rgb = msg.get("rgb")
                if rgb:
                    store.add_reading(registered, ts, rgb)
                    sarg = msg.get("sarg") or {}
                    if sarg.get("s") and sarg.get("c") is not None and sarg["c"] != 255:
                        store.add_detection(registered, ts, sarg["c"], sarg.get("p", 0) / 100.0,
                                             [], False, None, msg.get("batt_mv"))
            else:
                await hub.to_ui(registered, text)  # ack (and anything else) forwarded verbatim
    except WebSocketDisconnect:
        pass
    finally:
        if registered is not None:
            if hub.boards.get(registered) is websocket:
                hub.boards.pop(registered, None)
            await hub.to_ui(registered, json.dumps({"type": "board", "connected": False}))


@app.websocket("/ws/ui")
async def ws_ui(websocket: WebSocket, drifter: str, token: str = None):
    if token != TOKEN:  # a browser WebSocket can't set headers -- auth rides the query string instead
        await websocket.close(code=4401)
        return
    await websocket.accept()
    hub.uis.setdefault(drifter, set()).add(websocket)
    await websocket.send_text(json.dumps({"type": "board", "connected": drifter in hub.boards}))
    try:
        while True:
            await websocket.receive_text()  # UI is receive-only; inbound frames are ignored
    except WebSocketDisconnect:
        pass
    finally:
        hub.uis.get(drifter, set()).discard(websocket)


@app.get("/api/wave-readings")
def api_wave_readings(drifter: str, since: float = 0.0, limit: int = 7200,
                      authorization: str = Header(None)):
    _auth(authorization)
    # limit is caller-tunable so the dashboard can load wide historical windows (a 4h custom range
    # at 2Hz is ~28800 rows); clamped so a bad value can't dump the whole table.
    limit = max(1, min(int(limit), 50000))
    return JSONResponse(store.recent_wave_readings(drifter, since=since, limit=limit))


@app.get("/api/wave-runs")
def api_wave_runs(drifter: str, authorization: str = Header(None)):
    _auth(authorization)
    return JSONResponse(store.list_wave_runs(drifter))


@app.post("/api/wave-run")
async def api_wave_run_start(req: Request, authorization: str = Header(None)):
    _auth(authorization)
    b = await req.json()
    drifter, h_mm, t_ds = b["drifter"], int(b["h_mm"]), int(b["t_ds"])
    rid = store.start_wave_run(drifter, h_mm, t_ds, b.get("note", ""))
    # Deliberately NOT forwarded to the board (operator call, 2026-07-16 tank session): the board's
    # start-run handler resets its FFT window, blanking Hs for a full refill at every bracket. A run
    # is a server-side annotation — scoring/overlays key on this row's timestamps — so the board can
    # keep estimating continuously and transitions get filtered in data processing instead. (Cost:
    # frames' run_id and the SD run-log no longer track cloud brackets; both already diverged and
    # neither is load-bearing for the cloud workflow.)
    return {"ok": True, "id": rid}


@app.post("/api/wave-run/stop")
async def api_wave_run_stop(req: Request, authorization: str = Header(None)):
    _auth(authorization)
    b = await req.json()
    drifter = b["drifter"]
    stopped = store.stop_wave_run(drifter)
    # Not forwarded to the board — see api_wave_run_start.
    return {"ok": True, "stopped": stopped}


@app.post("/api/wave-command")
async def api_wave_command(req: Request, authorization: str = Header(None)):
    _auth(authorization)
    b = await req.json()
    drifter, cmd = b["drifter"], b["cmd"]
    sent = await hub.send_cmd(drifter, cmd)
    return {"ok": True, "sent": sent, "pending": len(hub.pending.get(drifter, []))}


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


@app.get("/api/drifters")
def api_drifters(authorization: str = Header(None)):
    _auth(authorization)
    # The dashboard's board switcher lists every drifter the rig knows: those with rows in the store UNION
    # any board live on the WS hub right now (a board that just connected but hasn't stored a row yet must
    # still appear, else you couldn't select the board you just powered on).
    names = set(store.distinct_drifters()) | set(hub.boards.keys())
    return JSONResponse(sorted(names))


# ── remote shutter ──────────────────────────────────────────────────────────
@app.post("/capture-request")
async def post_capture_request(drifter: str, req: Request, authorization: str = Header(None)):
    _auth(authorization)
    b = await req.json()
    res = str(b.get("res", "5MP"))
    # set_pending_capture is the LEGACY delivery: an HTTP-polling board picks it up on its next poll.
    # The wave-tank WS-uplink beacon never polls that flag -- it only listens on the live command
    # channel -- so also push the command over the hub, the same delivery /api/wave-command uses. Both
    # paths are safe to run: a WS board ignores the pending flag; a poll board isn't on the hub, so
    # send_cmd just queues (which it also polls). No double-capture for either.
    store.set_pending_capture(drifter, res)
    sent = await hub.send_cmd(drifter, f"capture {res}")
    return {"ok": True, "sent": sent}


@app.post("/photos")
async def post_photo(req: Request, authorization: str = Header(None)):
    _auth(authorization)
    drifter = req.headers.get("X-Drifter", "drifter1")
    # Server-stamps ts at receipt when the poster carries no clock (the beacon sends no X-Ts; board
    # clocks are untrusted anyway, same policy as wave_readings). Also keeps the filename stem unique --
    # the old fallback stem was the byte-length, which collides across same-sized JPEGs.
    ts = float(req.headers.get("X-Ts", "0") or 0) or time.time()
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
