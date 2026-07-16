# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Transport close-gate (hardware-free): the full loop over the real API via
TestClient — ingest readings + labels, one-click train yields a servable model, ETag poll-if-newer, ingest
detections, dashboard data. Uses synthetic streams so the loop is exercised end to end without the board.
"""
import io
import json
import os
import tempfile
import time

import pytest

os.environ["SARG_DB"] = tempfile.mktemp(suffix=".db")
os.environ["SARG_PHOTO_DIR"] = tempfile.mkdtemp(prefix="sargphotos-")
os.environ["SARG_TOKEN"] = "testtok"

from fastapi import WebSocketDisconnect  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
import app as appmod  # noqa: E402
from store import Store  # noqa: E402
from synthetic import stream  # noqa: E402

client = TestClient(appmod.app)
# Enter the client's context so every websocket_connect() shares ONE portal/event loop instead of each
# spinning up its own thread. The wave-tank hub is documented as module-level/single-loop (no locks) --
# without this, two concurrently-open test sockets (board + ui) run on different loops and a message
# handed from one to the other races the receiving loop's wakeup, hanging intermittently.
client.__enter__()
H = {"Authorization": "Bearer testtok"}


def _post_stream(drifter, scenario, start, seed):
    rs = stream(scenario, 300, seed)
    batch = [{"drifter": drifter, "ts": start + i, "rgb": rs[i][0].tolist()} for i in range(len(rs))]
    assert client.post("/readings", json=batch, headers=H).status_code == 200
    return start + len(rs)


def test_auth_required():
    r = client.post("/readings", json={"drifter": "d", "ts": 1, "rgb": [[1, 1, 1]] * 4})
    assert r.status_code == 401


def test_full_loop_train_push_serve_detect():
    d = "loop"
    t0 = 1000.0
    t1 = _post_stream(d, "in", t0, 1)
    t2 = _post_stream(d, "out", t1, 2)
    t3 = _post_stream(d, "ambient_drift_water", t2, 3)
    client.post("/labels", json={"drifter": d, "t_start": t0, "t_end": t1, "label": 1}, headers=H)
    client.post("/labels", json={"drifter": d, "t_start": t1, "t_end": t2, "label": 0}, headers=H)
    client.post("/labels", json={"drifter": d, "t_start": t2, "t_end": t3, "label": 0}, headers=H)

    # /train persists a model but does NOT touch the board yet (train/push split)
    r = client.post("/train?drifter=" + d, headers=H)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["version"] == 1 and j["val_acc"] > 0.9, j
    # counts is a per-label dict; this loop labels 2 classes (in/out), each with samples. (JSON turns the
    # int label keys into strings, so assert on the values, not on specific key types.)
    assert j["n_spans"] == 3 and len(j["counts"]) == 2 and all(v > 0 for v in j["counts"].values())

    assert client.get("/model?drifter=" + d, headers=H).status_code == 404  # nothing pushed yet

    # push moves the live pointer; board can now pull it
    p = client.post(f"/push?drifter={d}&version=1", headers=H)
    assert p.status_code == 200 and p.json()["live_version"] == 1

    m = client.get("/model?drifter=" + d, headers=H)
    assert m.status_code == 200 and m.content[:4] == b"SGF3"
    etag = m.headers["etag"]
    m2 = client.get("/model?drifter=" + d, headers={**H, "If-None-Match": etag})
    assert m2.status_code == 304  # poll-if-newer: board doesn't re-pull an unchanged model

    client.post("/detections", json={"drifter": d, "ts": t3, "state": 1, "proba": 0.82,
                                     "features": [0.1] * 16, "saturated": False}, headers=H)
    dets = client.get("/api/detections?drifter=" + d, headers=H).json()
    assert dets[-1]["state"] == 1 and dets[-1]["proba"] == 0.82
    assert len(client.get("/api/readings?drifter=" + d, headers=H).json()) > 0
    assert client.get("/api/readings?drifter=" + d).status_code == 401  # reads are bearer-gated now
    assert client.get("/").status_code == 200  # dashboard UI serves (no data without the token)


def test_detection_battery_telemetry():
    d = "batt"
    # a detection carrying the board's battery telemetry round-trips through /detections -> /api/detections
    client.post("/detections", json={"drifter": d, "ts": 10.0, "state": 2, "proba": 0.9,
                                     "features": [0.0] * 16, "saturated": False,
                                     "battery": 87, "battery_mv": 4021}, headers=H)
    # a detection from an OLD board (no battery field) still ingests -> null battery (graceful pre-update)
    client.post("/detections", json={"drifter": d, "ts": 11.0, "state": 1, "proba": 0.5,
                                     "features": [0.0] * 16, "saturated": False}, headers=H)
    dets = client.get("/api/detections?drifter=" + d, headers=H).json()  # oldest-first
    assert dets[0]["battery"] == 87 and dets[0]["battery_mv"] == 4021
    assert dets[1]["battery"] is None and dets[1]["battery_mv"] is None


def test_capture_request_also_pushes_over_ws_to_a_connected_board():
    # The Camera-tab shutter POSTs /capture-request. A WS-uplink beacon never polls the legacy
    # pending-capture flag, so the endpoint must ALSO push the command over the live hub channel --
    # otherwise the shutter is a silent no-op for the wave-tank firmware.
    d = "wscap"
    with client.websocket_connect(f"/ws/board?drifter={d}", headers=H) as board_ws:
        r = client.post("/capture-request?drifter=" + d, json={"res": "HD"}, headers=H)
        assert r.status_code == 200 and r.json()["sent"] is True
        cmd = board_ws.receive_json()
        assert cmd == {"type": "cmd", "cmd": "capture HD"}


def test_capture_command_is_one_shot():
    d = "camcmd"
    # no command pending -> detection response carries no capture
    r = client.post("/detections", json={"drifter": d, "ts": 1.0, "state": 0, "proba": 0.5,
                                         "features": [0.0] * 16, "saturated": False}, headers=H)
    assert r.json().get("capture") in (None, False)
    # arm a capture at 5MP
    assert client.post("/capture-request?drifter=" + d, json={"res": "5MP"}, headers=H).status_code == 200
    # the next detection POST carries the command exactly once, then it clears
    r = client.post("/detections", json={"drifter": d, "ts": 2.0, "state": 0, "proba": 0.5,
                                         "features": [0.0] * 16, "saturated": False}, headers=H)
    assert r.json()["capture"] == {"res": "5MP"}
    r = client.post("/detections", json={"drifter": d, "ts": 3.0, "state": 0, "proba": 0.5,
                                         "features": [0.0] * 16, "saturated": False}, headers=H)
    assert r.json().get("capture") in (None, False)


def _tiny_jpeg():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (10, 120, 30)).save(buf, "JPEG")
    return buf.getvalue()


def test_photo_upload_thumbnail_and_serve():
    d = "camphoto"
    jpg = _tiny_jpeg()
    r = client.post("/photos", content=jpg, headers={**H, "Content-Type": "image/jpeg",
                    "X-Drifter": d, "X-Ts": "100.0", "X-Res": "VGA"})
    assert r.status_code == 200, r.text
    lst = client.get("/api/photos?drifter=" + d, headers=H).json()
    assert len(lst) == 1 and lst[0]["ok"] and lst[0]["res"] == "VGA" and lst[0]["bytes"] == len(jpg)
    pid = lst[0]["id"]
    full = client.get(f"/photos/{pid}/full")          # image routes are unauthenticated (for <img> tags)
    assert full.status_code == 200 and full.content[:2] == b"\xff\xd8"    # JPEG SOI
    thumb = client.get(f"/photos/{pid}/thumb")
    assert thumb.status_code == 200 and thumb.content[:2] == b"\xff\xd8"


def test_photo_without_ts_gets_server_stamped():
    # The beacon posts no X-Ts (its clock is untrusted); the server must stamp receipt time so the
    # Camera tab sorts it as new instead of epoch-0, and the filename stem stays unique.
    import time as _t
    d = "camnots"
    before = _t.time()
    r = client.post("/photos", content=_tiny_jpeg(), headers={**H, "Content-Type": "image/jpeg",
                    "X-Drifter": d, "X-Res": "5MP"})
    assert r.status_code == 200, r.text
    lst = client.get("/api/photos?drifter=" + d, headers=H).json()
    assert len(lst) == 1 and lst[0]["ok"]
    assert before - 1 <= lst[0]["ts"] <= _t.time() + 1


def test_capture_error_marks_failed_row():
    d = "camerr"
    r = client.post("/photos", content=b"", headers={**H, "X-Drifter": d, "X-Ts": "5.0",
                    "X-Res": "5MP", "X-Capture-Error": "1"})
    assert r.status_code == 200 and r.json()["captured"] is False
    lst = client.get("/api/photos?drifter=" + d, headers=H).json()
    assert len(lst) == 1 and lst[0]["ok"] is False


def test_push_unknown_version_404():
    d = "loop"
    assert client.post(f"/push?drifter={d}&version=999", headers=H).status_code == 404


def test_model_registry_list_and_notes():
    d = "registry"
    t0 = 2000.0
    t1 = _post_stream(d, "in", t0, 1)
    t2 = _post_stream(d, "out", t1, 2)
    client.post("/labels", json={"drifter": d, "t_start": t0, "t_end": t1, "label": 1}, headers=H)
    client.post("/labels", json={"drifter": d, "t_start": t1, "t_end": t2, "label": 0}, headers=H)
    v1 = client.post("/train?drifter=" + d, headers=H).json()["version"]

    reg = client.get("/api/models?drifter=" + d, headers=H).json()
    assert reg["live_version"] is None and len(reg["models"]) == 1
    assert reg["models"][0]["version"] == v1 and reg["models"][0]["note"] == ""

    note_r = client.patch(f"/api/models/{v1}?drifter={d}", json={"note": "clear afternoon light"}, headers=H)
    assert note_r.status_code == 200
    reg2 = client.get("/api/models?drifter=" + d, headers=H).json()
    assert reg2["models"][0]["note"] == "clear afternoon light"

    assert client.patch(f"/api/models/999?drifter={d}", json={"note": "x"}, headers=H).status_code == 404

    # push an (only) older version -- push-any, not just-latest
    client.post(f"/push?drifter={d}&version={v1}", headers=H)
    reg3 = client.get("/api/models?drifter=" + d, headers=H).json()
    assert reg3["live_version"] == v1


def test_label_span_crud():
    d = "spans"
    t0 = 3000.0
    t1 = _post_stream(d, "in", t0, 1)
    lr = client.post("/labels", json={"drifter": d, "t_start": t0, "t_end": t1, "label": 1}, headers=H)
    assert lr.status_code == 200

    spans = client.get("/api/labels?drifter=" + d, headers=H).json()
    assert len(spans) == 1 and spans[0]["label"] == 1 and spans[0]["samples"] > 0
    assert len(spans[0]["rgb"]) == 3
    span_id = spans[0]["id"]

    client.delete(f"/api/labels/{span_id}?drifter={d}", headers=H)
    assert client.get("/api/labels?drifter=" + d, headers=H).json() == []

    t2 = _post_stream(d, "out", t1, 2)
    client.post("/labels", json={"drifter": d, "t_start": t1, "t_end": t2, "label": 0}, headers=H)
    client.post("/labels", json={"drifter": d, "t_start": t0, "t_end": t1, "label": 1}, headers=H)
    assert len(client.get("/api/labels?drifter=" + d, headers=H).json()) == 2
    clr = client.delete("/api/labels?drifter=" + d, headers=H)
    assert clr.status_code == 200 and clr.json()["deleted"] == 2
    assert client.get("/api/labels?drifter=" + d, headers=H).json() == []


def test_drifters_list_unions_stored_and_live_boards():
    # unknown/missing token is rejected like every other /api route
    assert client.get("/api/drifters").status_code == 401
    # two drifters with stored data (one via /readings, one via /detections) both appear, sorted
    client.post("/readings", json={"drifter": "zdrift", "ts": 1, "rgb": [[1, 1, 1]] * 4}, headers=H)
    client.post("/detections", json={"drifter": "adrift", "ts": 1.0, "state": 0, "proba": 0.5,
                                     "features": [0.0] * 16, "saturated": False}, headers=H)
    lst = client.get("/api/drifters", headers=H).json()
    assert "adrift" in lst and "zdrift" in lst
    assert lst == sorted(lst)  # returned sorted
    # a board live on the WS hub with no stored rows yet is also listed (union covers a just-connected board)
    with client.websocket_connect("/ws/board?drifter=livedrift", headers=H):
        live = client.get("/api/drifters", headers=H).json()
        assert "livedrift" in live and live == sorted(live)


def test_dashboard_bakes_token():
    body = client.get("/").text
    assert '"__SARG_TOKEN__"' not in body   # placeholder is replaced server-side
    assert '"testtok"' in body              # real bearer baked in as a safe JS string literal


def test_train_too_few_labels_422():
    client.post("/readings", json={"drifter": "sparse", "ts": 1, "rgb": [[100, 300, 100]] * 4}, headers=H)
    r = client.post("/train?drifter=sparse", headers=H)
    assert r.status_code == 422 and "few" in r.json()["detail"].lower()


# ── wave-tank store: readings + run lifecycle, exercised against a fresh, isolated Store (not the
# shared app-level one) so it doesn't collide with the drifter names used by the API tests above. ──
def test_wave_store_readings_ascending_and_since_filter():
    s = Store(tempfile.mktemp(suffix=".db"))
    d = "wavetest"
    ts1 = s.add_wave_reading(d, 120, 45, json.dumps({"sample": 1}))
    time.sleep(0.001)
    ts2 = s.add_wave_reading(d, 130, 46, json.dumps({"sample": 2}))
    time.sleep(0.001)
    ts3 = s.add_wave_reading(d, 140, 47, json.dumps({"sample": 3}))

    rows = s.recent_wave_readings(d)
    assert [r["ts"] for r in rows] == [ts1, ts2, ts3]  # ascending
    assert rows[0]["hs_mm"] == 120 and rows[0]["tp_ds"] == 45 and rows[0]["raw"] == {"sample": 1}

    since_rows = s.recent_wave_readings(d, since=ts1)
    assert [r["ts"] for r in since_rows] == [ts2, ts3]  # ts1 itself excluded


def test_wave_store_run_lifecycle():
    s = Store(tempfile.mktemp(suffix=".db"))
    d = "wavetest"
    rid = s.start_wave_run(d, 150, 60, note="calibration")
    runs = s.list_wave_runs(d)
    assert len(runs) == 1 and runs[0]["id"] == rid and runs[0]["stopped_ts"] is None

    assert s.stop_wave_run(d) is True
    runs2 = s.list_wave_runs(d)
    assert runs2[0]["stopped_ts"] is not None

    assert s.stop_wave_run(d) is False  # no open run left


# ── wave-tank WS hub: /ws/board (bench rig) + /ws/ui (dashboard fan-out) exercised over the real app
# via TestClient's WebSocket support, plus the REST run/command routes that talk to the hub. ──
def test_wave_ws_board_rejects_bad_token():
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/ws/board?drifter=wsauth",
                                       headers={"Authorization": "Bearer wrongtoken"}):
            pass
    assert exc_info.value.code == 4401


def test_wave_readings_limit_keeps_newest_rows():
    # A window holding more rows than `limit` must return the NEWEST rows (still ascending) — with
    # the old ASC+LIMIT the dashboard's "last hour" seed got the hour's OLDEST 15 minutes, so charts
    # looked empty-since-reload. Exercised through the endpoint so the limit param is covered too.
    d = "wavelim"
    s = appmod.store
    for i in range(10):
        s.add_wave_reading(d, 100 + i, 20, json.dumps({"hs_mm": 100 + i}))
    got = client.get(f"/api/wave-readings?drifter={d}&limit=3", headers=H).json()
    assert [r["hs_mm"] for r in got] == [107, 108, 109], got  # newest 3, ascending
    assert client.get(f"/api/wave-readings?drifter={d}", headers=H).json()[0]["hs_mm"] == 100


def test_wave_ws_reading_stored_and_fanned_with_server_ts():
    d = "wavefan"
    with client.websocket_connect(f"/ws/ui?drifter={d}&token=testtok") as ui_ws:
        snap = ui_ws.receive_json()
        assert snap == {"type": "board", "connected": False}  # no board yet

        with client.websocket_connect(f"/ws/board?drifter={d}", headers=H) as board_ws:
            presence_on = ui_ws.receive_json()  # board connect broadcasts presence:true to open UI sockets
            assert presence_on == {"type": "board", "connected": True}

            board_ws.send_text(json.dumps({"type": "reading", "drifter": d, "hs_mm": 120, "tp_ds": 45}))
            fwd = ui_ws.receive_json()
            assert fwd["type"] == "reading" and fwd["hs_mm"] == 120 and fwd["tp_ds"] == 45
            assert isinstance(fwd["ts"], (int, float))  # server-injected receipt time, not the board's clock

        presence = ui_ws.receive_json()  # board disconnect broadcasts presence:false to open UI sockets
        assert presence == {"type": "board", "connected": False}

    readings = client.get(f"/api/wave-readings?drifter={d}", headers=H).json()
    assert len(readings) == 1 and readings[0]["hs_mm"] == 120 and readings[0]["tp_ds"] == 45


def test_wave_ws_reading_with_rgb_also_feeds_console_readings_and_detections():
    # A mainline beacon's wave-tank frame can carry the raw RGB sample its sarg verdict was computed
    # from. That must ALSO land in the readings/detections tables the standalone-drifter Console tab
    # reads (getReadings/getDetections) -- zero Console-side changes, same tables, same shapes.
    d = "wavergb"
    rgb = [[100, 200, 300], [0, 0, 0], [4000, 5000, 6000], [10, 20, 30]]
    # Sync point: the store write happens BEFORE the fan-out in the server's code order, so waiting on
    # the UI socket's forward (same pattern as test_wave_ws_reading_stored_and_fanned_with_server_ts)
    # guarantees the REST reads below see the write -- there is nothing sent back to the BOARD socket
    # itself for a plain reading, so waiting on it would hang forever.
    with client.websocket_connect(f"/ws/ui?drifter={d}&token=testtok") as ui_ws:
        with client.websocket_connect(f"/ws/board?drifter={d}", headers=H) as board_ws:
            ui_ws.receive_json()  # presence:true
            board_ws.send_text(json.dumps({
                "type": "reading", "drifter": d, "hs_mm": 50, "tp_ds": 30,
                "rgb_mask": 13, "rgb": rgb, "batt_mv": 3980,
                "sarg": {"c": 1, "p": 77, "s": 1},
            }))
            ui_ws.receive_json()  # the forwarded reading

    readings = client.get(f"/api/readings?drifter={d}", headers=H).json()
    assert len(readings) == 1 and readings[0]["rgb"] == rgb

    dets = client.get(f"/api/detections?drifter={d}", headers=H).json()
    assert len(dets) == 1
    assert dets[0]["state"] == 1
    assert abs(dets[0]["proba"] - 0.77) < 1e-9   # sarg.p is 0-100 percent; store expects a 0-1 fraction
    assert dets[0]["battery_mv"] == 3980


def test_wave_ws_reading_with_rgb_but_warming_up_skips_detection():
    # sarg.c == 255 ("warming up", not a real class) must NOT be written as a detection state -- only
    # the raw reading (rgb) should land; there is nothing yet to plot on the verdict card.
    d = "wavergbwarm"
    rgb = [[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4]]
    with client.websocket_connect(f"/ws/ui?drifter={d}&token=testtok") as ui_ws:
        with client.websocket_connect(f"/ws/board?drifter={d}", headers=H) as board_ws:
            ui_ws.receive_json()  # presence:true
            board_ws.send_text(json.dumps({
                "type": "reading", "drifter": d, "hs_mm": 0, "tp_ds": 0,
                "rgb_mask": 15, "rgb": rgb, "sarg": {"c": 255, "p": 0, "s": 0},
            }))
            ui_ws.receive_json()  # the forwarded reading

    readings = client.get(f"/api/readings?drifter={d}", headers=H).json()
    assert len(readings) == 1 and readings[0]["rgb"] == rgb

    dets = client.get(f"/api/detections?drifter={d}", headers=H).json()
    assert len(dets) == 0


def test_wave_ws_board_without_query_param_registers_from_first_frame():
    # The firmware connects to bare /ws/board (no ?drifter=) and identifies itself by the "drifter"
    # field in its frames. The server must register it lazily from the first reading and route/store
    # under that name -- and NOT reject the handshake for a missing query param.
    d = "wavelazy"
    with client.websocket_connect(f"/ws/ui?drifter={d}&token=testtok") as ui_ws:
        assert ui_ws.receive_json() == {"type": "board", "connected": False}
        with client.websocket_connect("/ws/board", headers=H) as board_ws:  # NO ?drifter=
            board_ws.send_text(json.dumps({"type": "reading", "drifter": d, "hs_mm": 88, "tp_ds": 62}))
            presence_on = ui_ws.receive_json()  # registration happens on the first frame -> presence:true
            assert presence_on == {"type": "board", "connected": True}
            fwd = ui_ws.receive_json()
            assert fwd["type"] == "reading" and fwd["hs_mm"] == 88 and isinstance(fwd["ts"], (int, float))
        assert ui_ws.receive_json() == {"type": "board", "connected": False}
    readings = client.get(f"/api/wave-readings?drifter={d}", headers=H).json()
    assert len(readings) == 1 and readings[0]["hs_mm"] == 88 and readings[0]["tp_ds"] == 62


def test_wave_ws_server_ts_overrides_board_ts():
    d = "wavespoof"
    with client.websocket_connect(f"/ws/ui?drifter={d}&token=testtok") as ui_ws:
        snap = ui_ws.receive_json()
        assert snap == {"type": "board", "connected": False}  # no board yet

        with client.websocket_connect(f"/ws/board?drifter={d}", headers=H) as board_ws:
            presence_on = ui_ws.receive_json()
            assert presence_on == {"type": "board", "connected": True}

            # board sends a reading with a bogus, deliberately-wrong ts -- the untrusted board clock
            # must never be plotted; only the server's own receipt time should reach the UI
            board_ws.send_text(json.dumps({"type": "reading", "drifter": d, "hs_mm": 100, "tp_ds": 40,
                                            "ts": 1.0}))
            fwd = ui_ws.receive_json()
            assert fwd["type"] == "reading" and fwd["hs_mm"] == 100 and fwd["tp_ds"] == 40
            assert fwd["ts"] != 1.0     # server value won, not the board-supplied one
            assert fwd["ts"] > 1e9      # a real epoch, not the spoofed value

        presence = ui_ws.receive_json()  # board disconnect broadcasts presence:false to open UI sockets
        assert presence == {"type": "board", "connected": False}


def test_wave_ws_command_pends_then_flushes_on_board_connect():
    d = "wavecmd"
    r = client.post("/api/wave-command", json={"drifter": d, "cmd": "ping"}, headers=H)
    assert r.status_code == 200
    j = r.json()
    assert j["sent"] is False and j["pending"] == 1  # no board connected -> queued, not delivered

    with client.websocket_connect(f"/ws/board?drifter={d}", headers=H) as board_ws:
        flushed = board_ws.receive_json()  # queued command flushed on (re)connect
        assert flushed == {"type": "cmd", "cmd": "ping"}


def test_wave_run_start_stop_writes_rows_and_sends_commands():
    d = "waverun"
    with client.websocket_connect(f"/ws/board?drifter={d}", headers=H) as board_ws:
        r = client.post("/api/wave-run", json={"drifter": d, "h_mm": 150, "t_ds": 60, "note": "bench"}, headers=H)
        assert r.status_code == 200, r.text
        rid = r.json()["id"]
        assert board_ws.receive_json() == {"type": "cmd", "cmd": "start-run 150 60"}

        runs = client.get(f"/api/wave-runs?drifter={d}", headers=H).json()
        assert len(runs) == 1
        assert runs[0]["id"] == rid and runs[0]["stopped_ts"] is None and runs[0]["note"] == "bench"

        r2 = client.post("/api/wave-run/stop", json={"drifter": d}, headers=H)
        assert r2.status_code == 200 and r2.json()["stopped"] is True
        assert board_ws.receive_json() == {"type": "cmd", "cmd": "stop-run"}

        runs2 = client.get(f"/api/wave-runs?drifter={d}", headers=H).json()
        assert runs2[0]["stopped_ts"] is not None
