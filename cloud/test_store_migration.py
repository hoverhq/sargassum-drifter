# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Migration safety: a pre-registry DB always served the HIGHEST model version as live (no
explicit push step existed). Store's one-time backfill must grandfather that in as the live pointer, so a
board that already pulled + is running that model in RAM doesn't 404 on its next poll after the upgrade.
"""
import json
import sqlite3
import tempfile

from store import Store


def _seed_pre_registry_db(path, drifter, versions):
    """Build a DB matching the OLD schema (models table with no `note` column, no `live_model` table) --
    exactly what a box migrated from before this rework looks like."""
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE models (
          version INTEGER PRIMARY KEY AUTOINCREMENT, drifter TEXT NOT NULL,
          blob BLOB NOT NULL, meta TEXT, created REAL NOT NULL);
    """)
    for _ in range(versions):
        db.execute("INSERT INTO models(drifter,blob,meta,created) VALUES(?,?,?,?)",
                  (drifter, b"SGF2fake", json.dumps({"val_acc": 0.9}), 1000.0))
    db.commit()
    db.close()


def test_backfill_promotes_highest_legacy_version_to_live():
    path = tempfile.mktemp(suffix=".db")
    _seed_pre_registry_db(path, "driftA", versions=4)
    store = Store(path)  # migration runs in __init__
    assert store.get_live_version("driftA") == 4
    # note column exists + is readable/writable post-migration
    assert store.list_models("driftA")[0]["note"] == ""
    assert store.set_model_note("driftA", 4, "backfilled ok")


def test_backfill_is_a_noop_for_a_fresh_db():
    path = tempfile.mktemp(suffix=".db")
    store = Store(path)  # no pre-existing models -- nothing to backfill
    assert store.get_live_version("fresh") is None


def test_backfill_does_not_override_an_explicit_live_pointer():
    path = tempfile.mktemp(suffix=".db")
    _seed_pre_registry_db(path, "driftB", versions=3)
    store1 = Store(path)
    store1.set_live("driftB", 2)  # operator explicitly pushed an older version
    store2 = Store(path)  # simulate a service restart -- migration must not clobber the explicit choice
    assert store2.get_live_version("driftB") == 2
