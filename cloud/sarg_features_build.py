# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""cffi builder — compiles the SHARED firmware feature transform (firmware/shared/
hover_sarg_features.h) into a Python-callable extension. The cloud trainer computes features by calling
this exact C, so the model trains on bit-identical features to what the drifter computes on-board. One
source of truth; zero re-implementation drift. Run: python sarg_features_build.py  (produces _sarg_cffi).
"""
import os
import cffi

HERE = os.path.dirname(os.path.abspath(__file__))
_HDR = "hover_sarg_features.h"


def _shared_dir():
    """Locate the shared firmware header. In this repo it's at ../firmware/shared (trainer + board
    compile the SAME C). On a stripped deploy that ships only cloud/sargassum, it's bundled next to this
    file. SARG_FEATURES_H_DIR overrides both."""
    env = os.environ.get("SARG_FEATURES_H_DIR")
    if env:
        return env
    repo = os.path.normpath(os.path.join(HERE, "..", "firmware", "shared"))
    if os.path.exists(os.path.join(repo, _HDR)):
        return repo
    if os.path.exists(os.path.join(HERE, _HDR)):  # deploy: setup-box bundles the header here
        return HERE
    return repo  # fall through so the compile error names the missing header clearly


SHARED = _shared_dir()

ffibuilder = cffi.FFI()

# sarg_state is opaque to Python (forward-declared) — we only ever hold a pointer to it, so cffi doesn't
# need its internals. The wrappers flatten the 4x3 RGB into a linear uint16 array for an easy Python call.
ffibuilder.cdef(
    """
    typedef struct sarg_state sarg_state;
    sarg_state *sarg_alloc_w(void);
    void        sarg_free_w(sarg_state *);
    void        sarg_reset_w(sarg_state *);
    int         sarg_update_w(sarg_state *, const uint16_t *rgb12, float *out);
    int         sarg_nfeat_w(void);
    int         sarg_saturated_w(const uint16_t *rgb12);
    """
)

ffibuilder.set_source(
    "_sarg_cffi",
    """
    #include <stdlib.h>
    #include "hover_sarg_features.h"
    sarg_state *sarg_alloc_w(void) { return (sarg_state *)malloc(sizeof(sarg_state)); }
    void        sarg_free_w(sarg_state *s) { free(s); }
    void        sarg_reset_w(sarg_state *s) { sarg_reset(s); }
    int sarg_update_w(sarg_state *s, const uint16_t *rgb12, float *out) {
        uint16_t r[4][3];
        for (int i = 0; i < 4; i++) for (int j = 0; j < 3; j++) r[i][j] = rgb12[i * 3 + j];
        return sarg_update(s, r, out);
    }
    int sarg_nfeat_w(void) { return SARG_N_FEATURES; }
    int sarg_saturated_w(const uint16_t *rgb12) {
        uint16_t r[4][3];
        for (int i = 0; i < 4; i++) for (int j = 0; j < 3; j++) r[i][j] = rgb12[i * 3 + j];
        return sarg_is_saturated(r);
    }
    """,
    include_dirs=[SHARED],
)

if __name__ == "__main__":
    ffibuilder.compile(verbose=True)
