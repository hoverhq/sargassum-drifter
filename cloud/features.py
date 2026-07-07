# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Python front-end to the shared C sargassum feature transform (via the _sarg_cffi extension built from
firmware/shared/hover_sarg_features.h). The trainer replays stored readings IN TIME ORDER through
SargFeatures so the per-instant feature vectors match what the drifter computed on-board bit-for-bit.
"""
from _sarg_cffi import ffi, lib

N_FEATURES = lib.sarg_nfeat_w()


class SargFeatures:
    """Streaming feature computer mirroring the on-board state machine. Feed readings in time order."""

    def __init__(self):
        self._st = lib.sarg_alloc_w()
        lib.sarg_reset_w(self._st)
        self._out = ffi.new("float[]", N_FEATURES)

    def reset(self):
        lib.sarg_reset_w(self._st)

    def update(self, rgb):
        """rgb: 4x3 (sensor x [R,G,B]) uint16. Returns (features:list[float], saturated:bool)."""
        flat = [int(rgb[s][c]) for s in range(4) for c in range(3)]
        buf = ffi.new("uint16_t[]", flat)
        sat = lib.sarg_update_w(self._st, buf, self._out)
        return [self._out[i] for i in range(N_FEATURES)], bool(sat)

    def __del__(self):
        try:
            lib.sarg_free_w(self._st)
        except Exception:
            pass


def saturated(rgb):
    flat = [int(rgb[s][c]) for s in range(4) for c in range(3)]
    return bool(lib.sarg_saturated_w(ffi.new("uint16_t[]", flat)))
