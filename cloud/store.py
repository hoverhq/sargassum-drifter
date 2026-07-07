# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Local SQLite store for the disposable sargassum rig (per the operator guardrail: local file, NOT RDS).
Readings, labels (in/out/dry time-spans), detections (the board's smoothed output), and published models.
Single-file, single-process; torn down with the box after the beach test.

THREAD SAFETY: one shared connection (check_same_thread=False) is reused across uvicorn's request
threadpool, so every DB access is serialized under a single lock. Without it, two overlapping requests
(the dashboard polls /api/readings + /api/detections + /api/labels + /api/models in parallel every tick)
execute on the same sqlite3 Connection concurrently -- undefined behavior that segfaults inside libsqlite3.
"""
import json
import sqlite3
import threading
import time

_SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, drifter TEXT NOT NULL, ts REAL NOT NULL,
  rgb TEXT NOT NULL, extra TEXT, created REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_readings ON readings(drifter, ts);
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, drifter TEXT NOT NULL,
  t_start REAL NOT NULL, t_end REAL NOT NULL, label INTEGER NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS detections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, drifter TEXT NOT NULL, ts REAL NOT NULL,
  state INTEGER NOT NULL, proba REAL, features TEXT, saturated INTEGER, created REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_detections ON detections(drifter, ts);
CREATE TABLE IF NOT EXISTS models (
  version INTEGER PRIMARY KEY AUTOINCREMENT, drifter TEXT NOT NULL,
  blob BLOB NOT NULL, meta TEXT, note TEXT DEFAULT '', created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS live_model (
  drifter TEXT PRIMARY KEY, version INTEGER NOT NULL);
"""


class Store:
    def __init__(self, path="sargassum.db"):
        # RLock (not Lock): a few methods call sibling methods; a re-entrant lock lets one thread hold it
        # across the nested call instead of self-deadlocking.
        self._lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(_SCHEMA)
        try:  # migration for a pre-registry DB (models table existed without `note`)
            self.db.execute("ALTER TABLE models ADD COLUMN note TEXT DEFAULT ''")
        except sqlite3.OperationalError:
            pass  # column already present
        # One-time backfill: a pre-registry DB always served the HIGHEST version as the live model (no
        # explicit push step existed). Grandfather that in as the live pointer so a board that already
        # pulled + is running that model in RAM doesn't 404 on its next poll after this migration -- from
        # here on, only an explicit /push moves the pointer.
        self.db.execute("""
            INSERT INTO live_model(drifter, version)
            SELECT drifter, MAX(version) FROM models
            WHERE drifter NOT IN (SELECT drifter FROM live_model)
            GROUP BY drifter
        """)
        self.db.commit()

    def add_reading(self, drifter, ts, rgb, extra=None):
        with self._lock:
            self.db.execute("INSERT INTO readings(drifter,ts,rgb,extra,created) VALUES(?,?,?,?,?)",
                            (drifter, ts, json.dumps(rgb), json.dumps(extra or {}), time.time()))
            self.db.commit()

    def add_label(self, drifter, t_start, t_end, label):
        with self._lock:
            self.db.execute("INSERT INTO labels(drifter,t_start,t_end,label,created) VALUES(?,?,?,?,?)",
                            (drifter, t_start, t_end, int(label), time.time()))
            self.db.commit()

    def add_detection(self, drifter, ts, state, proba, features, saturated):
        with self._lock:
            self.db.execute(
                "INSERT INTO detections(drifter,ts,state,proba,features,saturated,created) VALUES(?,?,?,?,?,?,?)",
                (drifter, ts, int(state), proba, json.dumps(features), int(bool(saturated)), time.time()))
            self.db.commit()

    def labeled_readings(self, drifter):
        """Time-ordered [(rgb 4x3, label|None)]: each reading gets the label of the span it falls in."""
        with self._lock:
            rows = self.db.execute("SELECT ts,rgb FROM readings WHERE drifter=? ORDER BY ts", (drifter,)).fetchall()
            spans = self.db.execute("SELECT t_start,t_end,label FROM labels WHERE drifter=?", (drifter,)).fetchall()
        out = []
        for ts, rgb in rows:
            label = None
            for a, b, lb in spans:
                if a <= ts <= b:
                    label = lb
                    break
            out.append((json.loads(rgb), label))
        return out

    # ── model registry: every successful train is kept (not just the pushed one). "Push" only moves the
    # live pointer -- it never re-trains or re-uploads a blob, so pushing an OLDER version is just as valid
    # as pushing the newest (operator can revert to a model that tested better in the field). ──
    def add_model(self, drifter, blob, meta):
        with self._lock:
            cur = self.db.execute("INSERT INTO models(drifter,blob,meta,note,created) VALUES(?,?,?,?,?)",
                                  (drifter, blob, json.dumps(meta), "", time.time()))
            self.db.commit()
            return cur.lastrowid  # the version

    def set_live(self, drifter, version):
        with self._lock:
            self.db.execute(
                "INSERT INTO live_model(drifter,version) VALUES(?,?) "
                "ON CONFLICT(drifter) DO UPDATE SET version=excluded.version", (drifter, version))
            self.db.commit()

    def get_live_version(self, drifter):
        with self._lock:
            r = self.db.execute("SELECT version FROM live_model WHERE drifter=?", (drifter,)).fetchone()
        return r[0] if r else None

    def get_model_blob(self, drifter, version):
        with self._lock:
            r = self.db.execute("SELECT blob FROM models WHERE drifter=? AND version=?",
                                (drifter, version)).fetchone()
        return r[0] if r else None

    def list_models(self, drifter):
        with self._lock:
            rows = self.db.execute("SELECT version,meta,note,created FROM models WHERE drifter=? ORDER BY version DESC",
                                   (drifter,)).fetchall()
        return [{"version": v, **json.loads(meta or "{}"), "note": note or "", "created": created}
                for v, meta, note, created in rows]

    def set_model_note(self, drifter, version, note):
        with self._lock:
            cur = self.db.execute("UPDATE models SET note=? WHERE drifter=? AND version=?",
                                  (note, drifter, version))
            self.db.commit()
            return cur.rowcount > 0

    # ── label spans: CRUD for the dataset panel (list with per-span sample count + avg RGB, delete, clear) ──
    def count_labels(self, drifter):
        with self._lock:
            return self.db.execute("SELECT COUNT(*) FROM labels WHERE drifter=?", (drifter,)).fetchone()[0]

    def list_labels(self, drifter):
        with self._lock:
            rows = self.db.execute("SELECT id,t_start,t_end,label FROM labels WHERE drifter=? ORDER BY t_start",
                                   (drifter,)).fetchall()
            out = []
            for id_, t_start, t_end, label in rows:
                # t_start/t_end are BOARD time (seconds-since-boot) -- the only clock readings are stamped
                # with, needed to match spans to readings. `created` (cloud wall-clock receipt time) is looked
                # up separately, for the UI's human "ended at HH:MM:SS" -- display only, never for matching.
                rgb_rows = self.db.execute(
                    "SELECT rgb,created FROM readings WHERE drifter=? AND ts BETWEEN ? AND ?",
                    (drifter, t_start, t_end)).fetchall()
                n = len(rgb_rows)
                if n:
                    sums = [0.0, 0.0, 0.0]
                    t_end_wall = 0.0
                    for rgb_json, created in rgb_rows:
                        sensors = json.loads(rgb_json)  # 4x3
                        for ch in range(3):
                            sums[ch] += sum(s[ch] for s in sensors) / len(sensors)
                        t_end_wall = max(t_end_wall, created)
                    avg_rgb = [round(s / n) for s in sums]
                else:
                    avg_rgb, t_end_wall = [0, 0, 0], 0.0
                out.append({"id": id_, "label": label, "t_start": t_start, "t_end": t_end, "t_end_wall": t_end_wall,
                            "duration_sec": max(1, round(t_end - t_start)), "samples": n, "rgb": avg_rgb})
            return out

    def delete_label(self, drifter, label_id):
        with self._lock:
            self.db.execute("DELETE FROM labels WHERE drifter=? AND id=?", (drifter, label_id))
            self.db.commit()

    def clear_labels(self, drifter):
        with self._lock:
            cur = self.db.execute("DELETE FROM labels WHERE drifter=?", (drifter,))
            self.db.commit()
            return cur.rowcount

    def recent_readings(self, drifter, limit=200):
        # order by rowid (insertion order), NOT ts: the board's ts is seconds-since-boot and RESETS on reboot,
        # so ts-ordering would hide a fresh boot's low-ts rows behind the previous boot's high-ts rows.
        # `wall` (cloud receipt wall-clock) is for DISPLAY only (axis labels, hover tooltips) -- alignment
        # against detections uses `ts` (the shared board clock), never wall-clock.
        with self._lock:
            rows = self.db.execute("SELECT ts,rgb,created FROM readings WHERE drifter=? ORDER BY rowid DESC LIMIT ?",
                                  (drifter, limit)).fetchall()
        return [{"ts": ts, "rgb": json.loads(rgb), "wall": created} for ts, rgb, created in reversed(rows)]

    def recent_detections(self, drifter, limit=200):
        with self._lock:
            rows = self.db.execute(
                "SELECT ts,state,proba,features,saturated FROM detections WHERE drifter=? ORDER BY rowid DESC LIMIT ?",
                (drifter, limit)).fetchall()
        return [{"ts": ts, "state": st, "proba": p, "features": json.loads(f or "[]"), "saturated": bool(sat)}
                for ts, st, p, f, sat in reversed(rows)]
