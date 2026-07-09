# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""One-click TRAIN pipeline (cloud-side, CPU). readings -> shared-C features (drop saturated) ->
separability gate (logistic-reg, strict) -> small Random Forest -> serialized loadable artifact + an
accuracy report computed with the DEPLOYED evaluator (what the board runs, so the reported number == the
board's number). Clear errors (not a bad model) on too-few-labels / non-separable — the field-iterate need.
"""
from collections import Counter

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from features import SargFeatures
from model_serialize import forest_from_sklearn, eval_forest, serialize_forest

# Label int -> display name. The classifier is multiclass: open-water / in-mat / out-of-water (the 3rd class
# added so the board knows when it is NOT deployed). Kept here as the ONE place the trainer names a class.
CLASS_NAMES = {0: "OPEN-WATER", 1: "IN-MAT", 2: "OUT-OF-WATER"}


def _class_name(label):
    return CLASS_NAMES.get(label, f"class {label}")

MIN_LABELS = 40          # total labeled, non-saturated samples -- hard floor, below this we refuse to train
MIN_SEPARABILITY = 0.75  # logistic-reg validation accuracy gate (features must actually separate) -- hard floor

# Soft "trust this" thresholds, shown as a warning on an otherwise-successful train (not a hard refusal).
# ONE place these live -- the console UI reflects this verdict, it does not carry its own copy of the numbers.
MIN_SAMPLES = 140        # below this, a good score usually means memorized, not learned
MIN_SPANS = 4            # below this, too few distinct conditions were sampled to trust the result
GOOD_SEPARABILITY = 0.85 # soft "solidly separates" bar, above the hard MIN_SEPARABILITY gate
LOPSIDED_FRAC = 0.30     # minority-class fraction below which the dataset is lopsided


class TrainError(Exception):
    """Raised for un-trainable label sets — surfaced to the dashboard as a clear message, not a bad model."""


def features_from_readings(readings):
    """readings: time-ordered [(rgb 4x3, label)]. Replay through the STREAMING shared-C features (so the
    rolling-window features match the board), dropping only unlabeled/ambiguous (label None).

    SATURATED samples are KEPT: saturation is itself a class signal, not noise. In direct sun (field,
    2026-07-09) 100% of open-water AND out-of-water readings rail a channel -- dropping them collapsed the
    dataset to one class and left the board verdict-blind in bright light. Clipped readings still carry
    systematically class-informative features (out-of-water pegs everything -> BRIGHT ~= 1, ratios ~= 1;
    open water pegs green but keeps blue moderate; in-mat stays dark/unclipped)."""
    fx = SargFeatures()
    X, y = [], []
    for rgb, label in readings:
        feats, _sat = fx.update(rgb)
        if label is None:
            continue
        X.append(feats)
        y.append(int(label))
    return np.array(X, dtype=float), np.array(y, dtype=int)


def train(readings, n_spans=None, n_estimators=15, max_depth=6):
    """n_spans: count of labeled spans that fed `readings` (the operator's dataset panel unit) -- passed in
    rather than inferred, since `readings` here is already flattened to per-sample (rgb, label) pairs. None
    (the science tests that call train() directly on a raw stream, no span concept) skips the spans check --
    the sample-count thin check still applies."""
    X, y = features_from_readings(readings)
    if len(X) < MIN_LABELS:   # say WHICH gate fired -- a combined message misleads (field, 2026-07-09)
        raise TrainError(f"too few labeled samples ({len(X)}; need >= {MIN_LABELS}) -- label more spans")
    if len(set(y.tolist())) < 2:
        raise TrainError(f"all {len(X)} labeled samples are a single class {set(y.tolist())} "
                         f"-- label spans of at least one other class")
    Xtr, Xva, ytr, yva = train_test_split(X, y, test_size=0.3, random_state=0, stratify=y)

    # separability gate: standardize (logreg is scale-sensitive; the RF below is not) then score held-out
    sep = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000)).fit(Xtr, ytr).score(Xva, yva)
    if sep < MIN_SEPARABILITY:
        raise TrainError(
            f"features do not separate in/out (logreg val acc {sep:.2f} < {MIN_SEPARABILITY}) "
            f"-- collect more/cleaner labels; RGB may not separate here (the beach will tell)")

    rf = RandomForestClassifier(n_estimators=n_estimators, max_depth=max_depth, random_state=0).fit(Xtr, ytr)
    forest = forest_from_sklearn(rf)
    tr_acc = float(np.mean([eval_forest(forest, Xtr[i]) == ytr[i] for i in range(len(Xtr))]))
    va_acc = float(np.mean([eval_forest(forest, Xva[i]) == yva[i] for i in range(len(Xva))]))

    # Per-label sample counts (keyed by the label int). Generalizes the old binary n_in/n_out so however
    # many classes are present (2 today, 3 once out-of-water spans exist) are each counted; the balance
    # checks below are over min(count)/total across all present classes.
    counts = {int(k): int(v) for k, v in Counter(int(v) for v in y.tolist()).items()}
    total = sum(counts.values())
    minority = min(counts, key=counts.get)          # the smallest class
    minority_frac = counts[minority] / total if total else 0.0
    thin = total < MIN_SAMPLES or (n_spans is not None and n_spans < MIN_SPANS)
    lopsided = minority_frac < LOPSIDED_FRAC
    memorized = thin and va_acc > 0.85   # a flattering score on too-little data usually means it memorized

    if memorized or thin:
        tone, headline = "warn", "Model may have memorized"
        detail = (f"Only {n_spans} spans — too few distinct conditions to trust this. Label more, in varied light."
                  if n_spans is not None and n_spans < MIN_SPANS else
                  f"Only {total} samples. A high score on this little data usually means it memorized, not learned.")
    elif lopsided:
        tone, headline = "warn", "Lopsided dataset"
        detail = (f"{round(minority_frac * 100)}% in the smallest class ({_class_name(minority)}). "
                  f"It will lean toward the bigger classes. Add more {_class_name(minority)} spans.")
    elif sep < GOOD_SEPARABILITY:
        tone, headline = "warn", "Classes overlap"
        detail = "Some classes' colors sit close together. Re-check your labels or wait for clearer conditions."
    else:
        tone, headline = "good", "Separates well"
        detail = "The classes form distinct color clusters. This should hold up on the board."

    return {
        "forest": forest,
        "blob": serialize_forest(forest, X.shape[1]),
        "separability": sep,
        "train_acc": tr_acc,        # overfit watch: compare train vs val
        "val_acc": va_acc,
        "n_samples": len(X),
        "n_features": int(X.shape[1]),
        "n_spans": n_spans,
        "counts": counts,           # {label_int: sample_count} across all present classes
        "thin": thin, "lopsided": lopsided, "memorized": memorized,
        "tone": tone, "headline": headline, "detail": detail,
    }
