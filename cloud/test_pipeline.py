# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Synthetic testbench: drive the FULL pipeline (shared features -> train -> inference ->
smoothing) with physics-generated RGB and assert the CODE is correct. Physics is generated independently
of the feature math (synthetic.py), so green here = the software loop works, NOT that RGB separates real
sargassum (only the beach proves that). Passing this suite green-lights the field trip.
"""
import numpy as np

from features import SargFeatures
from synthetic import stream, labeled_set, labeled_set_3class
from train import train, features_from_readings, TrainError
from model_serialize import eval_forest
from smoothing import Smoother

# frozen feature indices (hover_sarg_features.h)
R0, G0 = 0, 4
SPREAD_R, SPREAD_G, DARK_RATIO, MED_BRIGHT, FLICKER, DIVERGENT = 10, 11, 12, 13, 14, 15


def _mean_feats(readings):
    fx = SargFeatures()
    acc = [f for f, sat in (fx.update(rgb) for rgb, _ in readings) if not sat]
    return np.mean(acc, axis=0)


# --- feature behavior vs the synthesized physics (validates the feature math reflects the physics) ---
def test_features_reflect_in_vs_out_physics():
    fin = _mean_feats(stream("in", 150, 1))
    fout = _mean_feats(stream("out", 150, 2))
    # mat is greener + less blue -> green chromaticity up, and darker overall
    assert fin[G0] > fout[G0], "in-mat should have higher green chromaticity"
    assert fin[MED_BRIGHT] < fout[MED_BRIGHT], "in-mat should be darker"


def test_edge_spikes_cross_sensor_spread():
    fedge = _mean_feats(stream("edge", 150, 3))
    fin = _mean_feats(stream("in", 150, 3))
    assert fedge[SPREAD_G] > fin[SPREAD_G], "cross-sensor spread should spike at a mat/water edge"


def test_flicker_raises_temporal_feature():
    fflk = _mean_feats(stream("frond_flicker", 200, 4))
    fin = _mean_feats(stream("in", 200, 4))
    assert fflk[FLICKER] > fin[FLICKER], "frond-flicker should raise the rolling temporal fluctuation"


def test_saturation_samples_excluded():
    X, y = features_from_readings(stream("saturation", 100, 5))
    assert len(X) < 100, "saturated (sun-glint) samples must be dropped from training"


# --- training pipeline ---
def test_train_separates_synthetic():
    r = train(labeled_set(seed=0))
    assert r["separability"] >= 0.8, r
    assert r["val_acc"] >= 0.9, r
    # overfit watch: train and val shouldn't diverge wildly
    assert r["train_acc"] - r["val_acc"] < 0.15, r


def test_inference_matches_training_on_fresh_in():
    forest = train(labeled_set(seed=0))["forest"]
    X, _ = features_from_readings(stream("in", 150, 9))
    assert np.mean([eval_forest(forest, X[i]) for i in range(len(X))]) > 0.9


def test_too_few_labels_errors():
    import pytest
    with pytest.raises(TrainError):
        train(stream("in", 12, 0))  # tiny + single-class


def test_train_three_classes_separates_and_counts():
    # Adding out-of-water (label 2) trains a 3-class model on the same pipeline; the result reports
    # per-label counts (not a binary n_in/n_out) and the three optically-distinct classes separate.
    r = train(labeled_set_3class(seed=0), n_spans=6)
    assert set(r["counts"].keys()) == {0, 1, 2}, r["counts"]
    assert r["counts"][2] > 0, "out-of-water samples must be counted"
    assert sum(r["counts"].values()) == r["n_samples"], r["counts"]
    assert r["separability"] >= 0.9, r
    assert r["val_acc"] >= 0.9, r


def test_inference_distinguishes_out_of_water():
    # The board's evaluator must call fresh air readings out-of-water (2), not fall back to in/out.
    forest = train(labeled_set_3class(seed=0), n_spans=6)["forest"]
    X, _ = features_from_readings(stream("air", 150, 21))
    assert np.mean([eval_forest(forest, X[i]) == 2 for i in range(len(X))]) > 0.9


# --- negative controls (the load-bearing physics: chromaticity + consensus) ---
def test_ambient_drift_does_not_flip():
    forest = train(labeled_set(seed=0))["forest"]
    X, _ = features_from_readings(stream("ambient_drift_water", 250, 11, drift=1.2))
    sm = Smoother(n=5, initial=0)
    states = [sm.update(eval_forest(forest, X[i])) for i in range(len(X))]
    assert max(states) == 0, "heavy ambient (brightness) drift on open water must NOT read as in-mat"


def test_lodged_frond_does_not_flip():
    forest = train(labeled_set(seed=0))["forest"]
    X, _ = features_from_readings(stream("lodged_frond_water", 250, 13))
    sm = Smoother(n=5, initial=0)
    states = [sm.update(eval_forest(forest, X[i])) for i in range(len(X))]
    assert max(states) == 0, "one persistently-dark (lodged-frond) sensor must NOT flip the consensus"


# --- end-to-end synthetic field session ---
def test_field_session_sequence():
    forest = train(labeled_set(seed=0))["forest"]
    readings = stream("field_session", 240, 7)
    fx = SargFeatures()
    sm = Smoother(n=5, initial=0)
    states = []
    for rgb, _ in readings:
        f, sat = fx.update(rgb)
        if sat:
            continue
        states.append(sm.update(eval_forest(forest, f)))
    assert states[len(states) // 8] == 1, "early segment (in-mat) should smooth to in"
    assert states[-1] == 0, "after tear-loose the drifter should smooth to out"
