# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""The board<->trainer PREDICTION contract: the reference forest evaluator (which the board C mirrors)
must equal sklearn.predict EXACTLY, and the serialized artifact must round-trip its header."""
import struct
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from model_serialize import forest_from_sklearn, forest_proba, eval_forest, serialize_forest, MAGIC


def _three_class_y(X):
    """Three well-populated regions in feature space -> a genuine 3-class problem (0/1/2)."""
    score = X[:, 8] + 0.5 * X[:, 10] - X[:, 3]  # ~[-1, 1.5]
    return np.select([score < 0.1, score < 0.5], [0, 1], default=2)


def test_eval_matches_sklearn_3class():
    # 3-class RF: the board evaluator (argmax over per-class proba) must equal sklearn.predict EXACTLY.
    for seed in range(5):
        rng = np.random.RandomState(seed)
        X = rng.rand(360, 16)
        y = _three_class_y(X)
        assert set(y.tolist()) == {0, 1, 2}, f"seed {seed}: fixture must exercise all 3 classes"
        rf = RandomForestClassifier(n_estimators=13, max_depth=6, random_state=seed).fit(X, y)
        forest = forest_from_sklearn(rf)
        Xt = rng.rand(500, 16)
        mine = np.array([eval_forest(forest, Xt[i]) for i in range(len(Xt))])
        assert (rf.predict(Xt) == mine).all(), f"seed {seed}: board evaluator != sklearn (3-class)"


def test_forest_proba_matches_sklearn_3class():
    # Per-class mean proba must equal sklearn.predict_proba exactly (proves the per-tree class remap).
    rng = np.random.RandomState(1)
    X = rng.rand(360, 16)
    y = _three_class_y(X)
    rf = RandomForestClassifier(n_estimators=11, max_depth=5, random_state=1).fit(X, y)
    forest = forest_from_sklearn(rf)
    Xt = rng.rand(120, 16)
    for i in range(len(Xt)):
        mine = forest_proba(forest, Xt[i])            # per-class vector
        ref = rf.predict_proba(Xt[i:i + 1])[0]
        assert np.allclose(mine, ref, atol=1e-6), f"row {i}: {mine} != {ref}"


def test_artifact_encodes_n_classes_and_leaf_stride():
    rng = np.random.RandomState(0)
    X = rng.rand(300, 16)
    y = _three_class_y(X)
    rf = RandomForestClassifier(n_estimators=7, max_depth=4, random_state=0).fit(X, y)
    forest = forest_from_sklearn(rf)
    nodes, roots, leaf_p, n_classes = forest
    assert n_classes == 3
    blob = serialize_forest(forest, 16)
    assert blob[:4] == MAGIC
    n_features, n_cls = struct.unpack_from("<HH", blob, 4)
    assert n_features == 16 and n_cls == 3
    for probs in leaf_p:                              # each leaf now carries a length-n_classes proba vector
        assert len(probs) == 3
        assert abs(sum(probs) - 1.0) < 1e-6


def test_eval_matches_sklearn_exactly():
    for seed in range(5):
        rng = np.random.RandomState(seed)
        X = rng.rand(240, 16)
        y = (X[:, 8] + 0.5 * X[:, 10] - X[:, 3] > 0.3).astype(int)
        rf = RandomForestClassifier(n_estimators=13, max_depth=6, random_state=seed).fit(X, y)
        forest = forest_from_sklearn(rf)
        Xt = rng.rand(500, 16)
        mine = np.array([eval_forest(forest, Xt[i]) for i in range(len(Xt))])
        assert (rf.predict(Xt) == mine).all(), f"seed {seed}: board evaluator != sklearn"


def test_artifact_header_roundtrips():
    # Binary case is a 2-class instance of the generic N-class path (header field 2 is now n_classes).
    rng = np.random.RandomState(0)
    X = rng.rand(120, 16); y = (X[:, 0] > 0.5).astype(int)
    rf = RandomForestClassifier(n_estimators=7, max_depth=4, random_state=0).fit(X, y)
    forest = forest_from_sklearn(rf)
    nodes, roots, leaf_p, n_classes = forest
    assert n_classes == 2
    blob = serialize_forest(forest, 16)
    assert blob[:4] == MAGIC
    n_features, n_cls = struct.unpack_from("<HH", blob, 4)
    assert n_features == 16 and n_cls == 2
    assert len(roots) == 7  # trees are derivable from the roots array, not the header
