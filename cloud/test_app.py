# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Transport close-gate (hardware-free): the full loop over the real API via
TestClient — ingest readings + labels, one-click train yields a servable model, ETag poll-if-newer, ingest
detections, dashboard data. Uses synthetic streams so the loop is exercised end to end without the board.
"""
import os
import tempfile

os.environ["SARG_DB"] = tempfile.mktemp(suffix=".db")
os.environ["SARG_TOKEN"] = "testtok"

from fastapi.testclient import TestClient  # noqa: E402
import app as appmod  # noqa: E402
from synthetic import stream  # noqa: E402

client = TestClient(appmod.app)
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


def test_dashboard_bakes_token():
    body = client.get("/").text
    assert '"__SARG_TOKEN__"' not in body   # placeholder is replaced server-side
    assert '"testtok"' in body              # real bearer baked in as a safe JS string literal


def test_train_too_few_labels_422():
    client.post("/readings", json={"drifter": "sparse", "ts": 1, "rgb": [[100, 300, 100]] * 4}, headers=H)
    r = client.post("/train?drifter=sparse", headers=H)
    assert r.status_code == 422 and "few" in r.json()["detail"].lower()
