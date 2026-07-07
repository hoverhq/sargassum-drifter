# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Physics-realistic synthetic RGB generator for the sargassum pipeline testbench.

Generated from the brief's PHYSICS, INDEPENDENTLY of the feature math (so passing the testbench validates
the CODE — feature wiring, inference==training, smoothing, edge handling — not 'you detect what you
synthesized'). It does NOT claim RGB separates real sargassum; only the beach proves model-vs-reality.

Physics (brief-5):
  - OPEN WATER: bright, BLUE-dominant (B > G > R). Sky/water scatter blue.
  - IN-MAT: darker (canopy absorbs), GREEN/BROWN — G and R elevated vs B (chlorophyll + brown pigment).
  - The class signal lives in CHROMATICITY (color balance), not absolute brightness.
  - AMBIENT (time-of-day / cloud) scales ALL sensors' brightness EQUALLY -> must NOT look like a state
    change to a chromaticity detector. This is the load-bearing negative control.
  - EDGE: some of the 4 sensors over mat, some over water (cross-sensor disagreement).
  - SATURATION: sun-glint rails a channel to full-scale on a sensor.
  - FROND-FLICKER: in-mat, a frond intermittently dips a sensor darker (temporal fluctuation = in-mat cue).
  - LODGED-FROND: one sensor persistently dark while neighbors fluctuate (must NOT flip the verdict).
"""
import numpy as np

FULL = 65535
SAT = 64200  # matches SARG_SAT_LEVEL in hover_sarg_features.h

# Per-class base color FRACTIONS (chromaticity) + base brightness at ambient=1.0. Physics, not features.
WATER = {"frac": np.array([0.22, 0.31, 0.47]), "bright": 0.42}  # blue-dominant, bright
MAT = {"frac": np.array([0.36, 0.43, 0.21]), "bright": 0.20}    # green/brown, darker
# OUT-OF-WATER (drifter on deck / being handled): sensors face air, not the water column. Optically very
# different -- much BRIGHTER (no water-column attenuation) and near-neutral daylight chromaticity (none of
# water's selective red-absorption blue bias). This is what makes it the easiest of the 3 to separate:
# high brightness + balanced color, vs submerged dark-green mat or blue open-water.
AIR = {"frac": np.array([0.35, 0.34, 0.31]), "bright": 0.90}   # bright, near-neutral (daylight)
_PROFILES = {"mat": MAT, "water": WATER, "air": AIR}


def _sensor_rgb(cls, ambient, rng, snr=25.0, dim=1.0):
    """One sensor's RGB for class ('mat'|'water'|'air') at a given ambient scale. dim<1 = extra local
    shading (frond). Noise ~ multiplicative Gaussian (SNR in dB-ish -> fractional sigma)."""
    base = _PROFILES[cls]
    level = base["bright"] * ambient * dim
    rgb = base["frac"] * level * FULL
    sigma = rgb / max(snr, 1e-3)
    rgb = rgb + rng.normal(0.0, 1.0, 3) * sigma
    return np.clip(rgb, 0, FULL)


def sample(classes, ambient=1.0, rng=None, snr=25.0, dims=None, sat_sensor=None, sat_chan=0):
    """One 4x3 sample. classes: list of 4 'mat'/'water'. dims: optional per-sensor dim factors.
    sat_sensor: if set, rail sat_chan of that sensor to full-scale (sun-glint)."""
    rng = rng or np.random.RandomState()
    dims = dims or [1.0, 1.0, 1.0, 1.0]
    out = np.zeros((4, 3))
    for s in range(4):
        out[s] = _sensor_rgb(classes[s], ambient, rng, snr, dims[s])
    if sat_sensor is not None:
        out[sat_sensor][sat_chan] = FULL
    return out.round().astype(int)


def ambient_curve(n, rng, base=1.0, drift=0.5):
    """Slow brightness baseline (time-of-day): a smooth random walk in [~0.4, ~1.6]. Same for all sensors
    at a given instant (ambient is global) -> the chromaticity detector must ignore it."""
    steps = rng.normal(0, drift / n, n).cumsum()
    return np.clip(base + steps, 0.35, 1.7)


def stream(scenario, n=200, seed=0, snr=25.0, drift=0.5):
    """Yield a time-ordered list of (rgb 4x3, label) for a scenario. label: 1=in-mat, 0=open-water,
    None=ambiguous/edge (excluded from strict asserts). Scenarios generate from physics; labels are the
    GROUND TRUTH we synthesized, used to check the pipeline recovers them."""
    rng = np.random.RandomState(seed)
    amb = ambient_curve(n, rng, drift=drift)
    seq = []
    if scenario in ("in", "out"):
        cls = "mat" if scenario == "in" else "water"
        for i in range(n):
            seq.append((sample([cls] * 4, amb[i], rng, snr), 1 if cls == "mat" else 0))
    elif scenario in ("air", "out_of_water"):
        # drifter lifted out of the water (on deck / handled): all 4 sensors see bright neutral air. label 2.
        for i in range(n):
            seq.append((sample(["air"] * 4, amb[i], rng, snr), 2))
    elif scenario == "ambient_drift_water":
        # open water the WHOLE time, but ambient swings hard -> label stays 0 (must not flip to in)
        for i in range(n):
            seq.append((sample(["water"] * 4, amb[i], rng, snr), 0))
    elif scenario == "edge":
        # 2 sensors mat, 2 water: cross-sensor disagreement; ambiguous overall (label None)
        for i in range(n):
            seq.append((sample(["mat", "mat", "water", "water"], amb[i], rng, snr), None))
    elif scenario == "saturation":
        # in-mat but sun-glint rails sensor 1's red every few samples -> those excluded
        for i in range(n):
            sat = 1 if (i % 5 == 0) else None
            seq.append((sample(["mat"] * 4, amb[i], rng, snr, sat_sensor=sat, sat_chan=0), 1))
    elif scenario == "frond_flicker":
        # in-mat; a frond intermittently dips sensor 0 darker (temporal fluctuation cue), still in-mat
        for i in range(n):
            dims = [0.4 if (i % 7 < 2) else 1.0, 1, 1, 1]
            seq.append((sample(["mat"] * 4, amb[i], rng, snr, dims=dims), 1))
    elif scenario == "lodged_frond_water":
        # OPEN WATER, but sensor 3 has a frond lodged on it (persistently dark) -> one sensor looks mat-ish;
        # consensus must keep the verdict at 0 (out). label 0.
        for i in range(n):
            dims = [1, 1, 1, 0.25]
            classes = ["water", "water", "water", "mat"]  # the lodged sensor sees mat-like dark/green
            seq.append((sample(classes, amb[i], rng, snr, dims=dims), 0))
    elif scenario == "field_session":
        # in -> edge -> out -> tear-loose(out): the e2e sequence a drifter experiences
        segs = [("in", n // 4), ("edge", n // 4), ("out", n // 4), ("out", n - 3 * (n // 4))]
        for name, ln in segs:
            for _ in range(ln):
                i = len(seq)
                a = amb[min(i, n - 1)]
                if name == "in":
                    seq.append((sample(["mat"] * 4, a, rng, snr), 1))
                elif name == "edge":
                    seq.append((sample(["mat", "mat", "water", "water"], a, rng, snr), None))
                else:
                    seq.append((sample(["water"] * 4, a, rng, snr), 0))
    else:
        raise ValueError("unknown scenario " + scenario)
    return seq


def labeled_set(seed=0, n_per=300, snr=25.0):
    """A balanced labeled training set (in + out, with ambient drift + noise) for training-pipeline tests."""
    ins = [s for s in stream("in", n_per, seed, snr) ]
    outs = [s for s in stream("out", n_per, seed + 1, snr)]
    drift = [s for s in stream("ambient_drift_water", n_per, seed + 2, snr, drift=0.9)]
    return ins + outs + drift


def labeled_set_3class(seed=0, n_per=300, snr=25.0):
    """A balanced 3-class training set (in-mat / open-water / out-of-water), for the multiclass pipeline."""
    return labeled_set(seed, n_per, snr) + [s for s in stream("air", n_per, seed + 3, snr)]
