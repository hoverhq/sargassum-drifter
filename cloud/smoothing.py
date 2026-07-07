# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Sargassum Training Kit Authors
"""Temporal smoothing — declare an in/out state change only after N consecutive raw predictions agree
(debounces edge-flicker). The drifter firmware runs the identical state machine, so a synthetic run here
predicts the board's smoothed output. Pure logic; no deps."""


class Smoother:
    def __init__(self, n=5, initial=0):
        self.n = n
        self.state = initial
        self._cand = initial
        self._count = 0

    def update(self, raw):
        """Feed one raw (0/1) prediction; return the current smoothed state."""
        if raw == self.state:
            self._count = 0
            self._cand = self.state
        elif raw == self._cand:
            self._count += 1
            if self._count >= self.n:
                self.state = raw
                self._count = 0
        else:
            self._cand = raw
            self._count = 1
        return self.state
