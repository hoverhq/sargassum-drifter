# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Cross-language conformance: the Python trainer (this cffi wrapper of hover_sarg_features.h) must
reproduce the SAME golden vector the firmware host-test asserts (test-native
test_sarg_features_uniform_golden). Same C source both sides => bit-identical features => the board can't
drift from what the RF trained on. This is the guard the PLAN promised.
"""
import math
from features import SargFeatures, N_FEATURES, saturated

# Frozen index layout (matches enum in hover_sarg_features.h)
R0, G0 = 0, 4
MED_GB, MED_GRB, SPREAD_R, SPREAD_G, DARK_RATIO, MED_BRIGHT, FLICKER, DIVERGENT = range(8, 16)


def test_n_features():
    assert N_FEATURES == 16


def test_uniform_golden():
    # Same input + expected values as the firmware C test (all 4 sensors R=100 G=300 B=100).
    f, sat = SargFeatures().update([[100, 300, 100]] * 4)
    assert sat is False
    for s in range(4):
        assert math.isclose(f[R0 + s], 0.2, abs_tol=1e-4)
        assert math.isclose(f[G0 + s], 0.6, abs_tol=1e-4)
    assert math.isclose(f[MED_GB], 3.0, abs_tol=1e-4)
    assert math.isclose(f[MED_GRB], 4.0, abs_tol=1e-4)
    assert math.isclose(f[SPREAD_R], 0.0, abs_tol=1e-5)
    assert math.isclose(f[SPREAD_G], 0.0, abs_tol=1e-5)
    assert math.isclose(f[DARK_RATIO], 1.0, abs_tol=1e-4)
    assert math.isclose(f[MED_BRIGHT], 500.0 / 65535.0, abs_tol=1e-6)   # sum/full-scale, clamped to 1
    assert math.isclose(f[FLICKER], 0.0, abs_tol=1e-6)
    assert math.isclose(f[DIVERGENT], 0.0, abs_tol=1e-6)


def test_saturation():
    assert saturated([[100, 300, 100], [65000, 10, 10], [100, 300, 100], [100, 300, 100]]) is True
    assert saturated([[100, 300, 100]] * 4) is False


def test_divergent_consensus():
    fx = SargFeatures()
    f = None
    for _ in range(16):  # fill the window; sensor 3 persistently off
        f, _ = fx.update([[100, 300, 100], [100, 300, 100], [100, 300, 100], [300, 100, 100]])
    assert f[DIVERGENT] >= 1.0
    assert math.isclose(f[G0], 0.6, abs_tol=1e-4)      # the agreeing sensors unaffected
    assert math.isclose(f[MED_GB], 3.0, abs_tol=1e-4)  # median ratio robust to the one outlier
