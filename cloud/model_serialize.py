# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Serialize a trained sklearn RandomForest (N-class: open-water / in-mat / out-of-water) to a compact
binary the drifter OTA-pulls + parses into RAM, plus a reference evaluator the board's C mirrors EXACTLY.
The board<->trainer PREDICTION contract, twin of the shared feature contract.

WHY straight from sklearn (not emlearn's loadable): emlearn's loadable inference is int16-quantized-only,
which collapses our [0,1]-range chromaticity/ratio thresholds toward 0 (emlearn's own predict scored ~0.44
vs sklearn). We extract sklearn's EXACT float thresholds + each leaf's per-class probabilities and average
across trees (sklearn.predict_proba's actual rule) -> 100% fidelity to the trained model, hot-swappable as
data, no emlearn C on the board. (emlearn stays available for a future inline/quantized build.)

N-CLASS: each leaf carries the FULL per-class probability vector (length n_classes), and prediction is
argmax of the tree-averaged vector (ties -> lowest class index, matching numpy.argmax / sklearn). This
generalizes the old binary format rather than forking it: N=2 is just a 2-class instance of the same code
path, so a binary field model keeps working unchanged while N=3 (adding out-of-water) rides the same wire.

Per-tree class REMAP: a bootstrap sample can miss a class, so a sub-tree's `tree_.value` counts only the
classes THAT tree saw (est.classes_). We map each sub-tree's local class positions onto the forest's global
class order before accumulating -> correct even when a tree never saw out-of-water.

Forest = (nodes, roots, leaf_p, n_classes); node = [feature:int, threshold:float, left, right]; a NEGATIVE
child is a leaf, its per-class proba = leaf_p[-child-1] (a length-n_classes list). Split follows sklearn:
x[feature] <= threshold -> left. Prediction = argmax(mean(leaf_p over trees)).
Artifact (LE): 'SGF3' | u16 n_features | u16 n_classes | u32 n_nodes |
n_nodes x {i16 feature, f32 threshold, i16 left, i16 right} | u32 n_roots | n_roots x i32 |
u32 n_leaves | n_leaves x (n_classes x f32).
"""
import struct

MAGIC = b"SGF3"


def forest_from_sklearn(rf):
    """Flatten a fitted RandomForestClassifier (any n_classes) into (nodes, roots, leaf_p, n_classes) with
    EXACT float thresholds; each leaf carries the length-n_classes probability vector over the forest's
    global class order (rf.classes_)."""
    n_classes = int(rf.n_classes_)
    global_order = list(rf.classes_)
    nodes, roots, leaf_p = [], [], []
    for est in rf.estimators_:
        t = est.tree_
        # this sub-tree's value columns are ordered by est.classes_ (a subset if a bootstrap missed a class);
        # map each local column onto the forest's global class index so accumulation stays aligned.
        local_to_global = [global_order.index(c) for c in est.classes_]
        internal = [i for i in range(t.node_count) if t.children_left[i] != -1]
        code = {}
        for gi, i in enumerate(internal):
            code[i] = len(nodes) + gi
        for i in range(t.node_count):
            if t.children_left[i] == -1:  # leaf
                v = t.value[i][0]                      # per-class weighted counts (len == len(est.classes_))
                total = float(v.sum())
                probs = [0.0] * n_classes
                if total > 0:
                    for local, g in enumerate(local_to_global):
                        probs[g] = float(v[local]) / total
                code[i] = -(len(leaf_p) + 1)
                leaf_p.append(probs)
        roots.append(code[0])
        for i in internal:
            nodes.append([int(t.feature[i]), float(t.threshold[i]),
                          code[t.children_left[i]], code[t.children_right[i]]])
    return (nodes, roots, leaf_p, n_classes)


def forest_proba(forest, x):
    """Mean per-class probability vector across trees for one feature vector x. Board C mirrors this."""
    nodes, roots, leaf_p, n_classes = forest
    total = [0.0] * n_classes
    for root in roots:
        node = root
        while node >= 0:
            feat, thr, left, right = nodes[node]
            node = left if x[int(feat)] <= thr else right
        probs = leaf_p[-node - 1]
        for c in range(n_classes):
            total[c] += probs[c]
    n = len(roots)
    return [t / n for t in total]


def eval_forest(forest, x):
    """Predicted class: argmax of the tree-averaged per-class proba. Ties resolve to the LOWEST class index
    (strict '>'), matching numpy.argmax and sklearn's argmax tie-break. The board C uses the same rule."""
    probs = forest_proba(forest, x)
    best = 0
    for c in range(1, len(probs)):
        if probs[c] > probs[best]:
            best = c
    return best


def serialize_forest(forest, n_features):
    nodes, roots, leaf_p, n_classes = forest
    buf = bytearray(MAGIC)
    buf += struct.pack("<HH", n_features, n_classes)
    buf += struct.pack("<I", len(nodes))
    for feat, thr, left, right in nodes:
        buf += struct.pack("<hfhh", int(feat), float(thr), int(left), int(right))
    buf += struct.pack("<I", len(roots))
    for r in roots:
        buf += struct.pack("<i", int(r))
    buf += struct.pack("<I", len(leaf_p))
    for probs in leaf_p:
        for p in probs:
            buf += struct.pack("<f", float(p))
    return bytes(buf)
