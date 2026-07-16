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
  state INTEGER NOT NULL, proba REAL, features TEXT, saturated INTEGER,
  battery INTEGER, battery_mv INTEGER, created REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_detections ON detections(drifter, ts);
CREATE TABLE IF NOT EXISTS models (
  version INTEGER PRIMARY KEY AUTOINCREMENT, drifter TEXT NOT NULL,
  blob BLOB NOT NULL, meta TEXT, note TEXT DEFAULT '', created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS live_model (
  drifter TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_capture (
  drifter TEXT PRIMARY KEY, res TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, drifter TEXT NOT NULL, ts REAL NOT NULL,
  res TEXT, width INTEGER, height INTEGER, bytes INTEGER, ok INTEGER NOT NULL,
  path TEXT, thumb_path TEXT, created REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_photos ON photos(drifter, id);
CREATE TABLE IF NOT EXISTS wave_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, drifter TEXT NOT NULL, ts REAL NOT NULL,
  hs_mm INTEGER, tp_ds INTEGER, raw TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_wave_readings ON wave_readings(drifter, ts);
CREATE TABLE IF NOT EXISTS wave_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, drifter TEXT NOT NULL,
  h_mm INTEGER NOT NULL, t_ds INTEGER NOT NULL, note TEXT DEFAULT '',
  started_ts REAL NOT NULL, stopped_ts REAL, board_ack TEXT DEFAULT '');
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
        for _col in ("battery", "battery_mv"):  # migration: battery telemetry on a pre-battery detections table
            try:
                self.db.execute(f"ALTER TABLE detections ADD COLUMN {_col} INTEGER")
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

    def add_detection(self, drifter, ts, state, proba, features, saturated, battery=None, battery_mv=None):
        with self._lock:
            self.db.execute(
                "INSERT INTO detections(drifter,ts,state,proba,features,saturated,battery,battery_mv,created) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (drifter, ts, int(state), proba, json.dumps(features), int(bool(saturated)),
                 (int(battery) if battery is not None else None),
                 (int(battery_mv) if battery_mv is not None else None), time.time()))
            self.db.commit()

    # ── remote-shutter: a one-shot capture command per drifter, popped by the board's next detection POST ──
    def set_pending_capture(self, drifter, res):
        with self._lock:
            self.db.execute("INSERT INTO pending_capture(drifter,res,created) VALUES(?,?,?) "
                            "ON CONFLICT(drifter) DO UPDATE SET res=excluded.res, created=excluded.created",
                            (drifter, res, time.time()))
            self.db.commit()

    def pop_pending_capture(self, drifter):
        with self._lock:
            row = self.db.execute("SELECT res FROM pending_capture WHERE drifter=?", (drifter,)).fetchone()
            if row:
                self.db.execute("DELETE FROM pending_capture WHERE drifter=?", (drifter,))
                self.db.commit()
            return row[0] if row else None

    # ── remote-shutter: uploaded photos (JPEG on disk + a Pillow thumbnail) ──
    def add_photo(self, drifter, ts, res, width, height, nbytes, ok, path, thumb_path):
        with self._lock:
            cur = self.db.execute(
                "INSERT INTO photos(drifter,ts,res,width,height,bytes,ok,path,thumb_path,created) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (drifter, ts, res, width, height, nbytes, int(bool(ok)), path, thumb_path, time.time()))
            self.db.commit()
            return cur.lastrowid

    def list_photos(self, drifter, limit=200):
        with self._lock:
            rows = self.db.execute(
                "SELECT id,ts,res,width,height,bytes,ok FROM photos WHERE drifter=? ORDER BY id DESC LIMIT ?",
                (drifter, limit)).fetchall()
        return [{"id": i, "ts": ts, "res": r, "width": w, "height": h, "bytes": b, "ok": bool(ok)}
                for i, ts, r, w, h, b, ok in rows]

    def get_photo(self, pid):
        with self._lock:
            row = self.db.execute("SELECT path,thumb_path FROM photos WHERE id=?", (pid,)).fetchone()
        return {"path": row[0], "thumb_path": row[1]} if row else None

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
                "SELECT ts,state,proba,features,saturated,battery,battery_mv FROM detections "
                "WHERE drifter=? ORDER BY rowid DESC LIMIT ?",
                (drifter, limit)).fetchall()
        return [{"ts": ts, "state": st, "proba": p, "features": json.loads(f or "[]"),
                 "saturated": bool(sat), "battery": batt, "battery_mv": bmv}
                for ts, st, p, f, sat, batt, bmv in reversed(rows)]

    def distinct_drifters(self):
        """Every drifter name the store has ever recorded, across all data tables, sorted. Union so a
        board that has rows in only ONE table (e.g. wave-tank readings but no old-style /readings yet)
        still shows up in the dashboard's board switcher. Table names are a fixed literal whitelist --
        they never come from a request -- so interpolating them into the query is safe (values are still
        never interpolated; there are none to bind here)."""
        _tables = ("readings", "labels", "detections", "photos", "wave_readings", "wave_runs", "models")
        with self._lock:
            names = set()
            for t in _tables:
                for (d,) in self.db.execute(f"SELECT DISTINCT drifter FROM {t}"):
                    if d:
                        names.add(d)
        return sorted(names)

    # ── wave-tank telemetry: a bench rig drives a physical wave maker at a set height/period and the
    # board reports back significant-wave-height/period readings; runs bracket a bench session so the
    # dashboard can align readings against the commanded target. ──
    def add_wave_reading(self, drifter, hs_mm, tp_ds, raw_json):
        with self._lock:
            ts = time.time()
            self.db.execute(
                "INSERT INTO wave_readings(drifter,ts,hs_mm,tp_ds,raw) VALUES(?,?,?,?,?)",
                (drifter, ts, hs_mm, tp_ds, raw_json))
            self.db.commit()
            return ts

    def recent_wave_readings(self, drifter, since=0.0, limit=7200):
        # Take the NEWEST rows in the window (DESC + reverse), not the oldest: with ASC, a window
        # holding more rows than `limit` returned its oldest chunk — a dashboard asking for "the last
        # hour" got the hour's first 15 minutes and nothing current (charts looked empty-since-reload).
        with self._lock:
            rows = self.db.execute(
                "SELECT ts,hs_mm,tp_ds,raw FROM wave_readings WHERE drifter=? AND ts>? "
                "ORDER BY rowid DESC LIMIT ?", (drifter, since, limit)).fetchall()
        return [{"ts": ts, "hs_mm": hs_mm, "tp_ds": tp_ds, "raw": json.loads(raw)}
                for ts, hs_mm, tp_ds, raw in reversed(rows)]

    def start_wave_run(self, drifter, h_mm, t_ds, note=""):
        with self._lock:
            cur = self.db.execute(
                "INSERT INTO wave_runs(drifter,h_mm,t_ds,note,started_ts) VALUES(?,?,?,?,?)",
                (drifter, h_mm, t_ds, note, time.time()))
            self.db.commit()
            return cur.lastrowid

    def stop_wave_run(self, drifter):
        with self._lock:
            row = self.db.execute(
                "SELECT id FROM wave_runs WHERE drifter=? AND stopped_ts IS NULL "
                "ORDER BY id DESC LIMIT 1", (drifter,)).fetchone()
            if not row:
                return False
            self.db.execute("UPDATE wave_runs SET stopped_ts=? WHERE id=?", (time.time(), row[0]))
            self.db.commit()
            return True

    def list_wave_runs(self, drifter):
        with self._lock:
            rows = self.db.execute(
                "SELECT id,h_mm,t_ds,note,started_ts,stopped_ts,board_ack FROM wave_runs "
                "WHERE drifter=? ORDER BY id DESC", (drifter,)).fetchall()
        return [{"id": i, "h_mm": h, "t_ds": t, "note": note, "started_ts": started,
                 "stopped_ts": stopped, "board_ack": ack}
                for i, h, t, note, started, stopped, ack in rows]
