// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
#pragma once
#include <stdint.h>
#include <math.h>

// hover_sarg_features — the SHARED sargassum-mat feature transform, computed IDENTICALLY on the drifter
// (on-board inference) and in the cloud trainer (via a cffi wrapper of this same file). ONE source of
// truth so the board's live features can never drift from what the Random Forest trained on. Pure C,
// no hardware / no allocation / no libc beyond <math.h>, so it compiles into the ESP32 firmware AND a
// host shared-lib. Header-only static-inline, so the one source links into both builds unchanged.
//
// Physics (operator field brief): normalize brightness OUT (chromaticity, not raw RGB); weight
// color-balance over darkness (sargassum is brown/green -> G,R elevated vs B); read the 4 sensors as a
// CONSENSUS/quorum, not per-channel variance, so ONE lodged frond over a single sensor cannot flip the
// verdict; frond-flicker (temporal fluctuation) is itself an in-mat signal; flag saturation; daytime.
//
// STREAMING: two features are temporal (rolling window), so this is stateful. Call sarg_reset() once,
// then sarg_update() per sample IN TIME ORDER. The trainer replays stored readings through the same
// calls to reproduce the board's per-instant feature vector at each label.

#define SARG_N_SENSORS   4
#define SARG_N_FEATURES  16   // FROZEN layout (see sarg_feature_names) — cloud + board must agree
#define SARG_WINDOW      16   // rolling-window length for temporal features (~ a few seconds at 4-5 Hz)

// ISL29125 16-bit ADC: treat a channel at/above this as saturated (clipped) — excluded from training,
// flagged live. ~98% of full-scale leaves headroom for sensor-to-sensor gain spread.
#define SARG_SAT_LEVEL   64200

// Frozen feature index layout. Keep in lockstep with the computation in sarg_update().
enum {
  SARG_F_R0 = 0, SARG_F_R1, SARG_F_R2, SARG_F_R3,   // per-sensor red chromaticity  r_s = R/(R+G+B)
  SARG_F_G0,     SARG_F_G1, SARG_F_G2, SARG_F_G3,   // per-sensor green chromaticity g_s = G/(R+G+B)
  SARG_F_MED_GB,        // quorum ratio: median over sensors of G/B
  SARG_F_MED_GRB,       // quorum ratio: median over sensors of (G+R)/B
  SARG_F_SPREAD_R,      // cross-sensor spread (max-min) of r_s  (consensus vs disagreement)
  SARG_F_SPREAD_G,      // cross-sensor spread (max-min) of g_s
  SARG_F_DARK_RATIO,    // ambient proxy: min_s(brightness)/max_s(brightness)  (a mat shades some sensors)
  SARG_F_MED_BRIGHT,    // total brightness (corroborating): median_s(R+G+B), normalized to [0,1] of full-scale
  SARG_F_FLICKER,       // temporal fluctuation: rolling stdev of median-g over the window (frond-flicker)
  SARG_F_DIVERGENT      // persistently-divergent count: # sensors persistently far from the g-quorum (lodged-frond)
};

typedef struct {
  // ring buffer of recent samples for the temporal features
  float br_s[SARG_WINDOW][SARG_N_SENSORS];  // per-sensor brightness (R+G+B) — for frond light/shadow flicker
  float g_s[SARG_WINDOW][SARG_N_SENSORS];   // per-sensor green-chromaticity — for persistent divergence
  uint8_t count;                   // valid samples in the window (<= SARG_WINDOW)
  uint8_t head;                    // next write index
} sarg_state;

static inline void sarg_reset(sarg_state *st) {
  st->count = 0;
  st->head = 0;
}

// True if any channel of any sensor is saturated (clipped) — caller excludes from training + flags live.
static inline int sarg_is_saturated(const uint16_t rgb[SARG_N_SENSORS][3]) {
  for (int s = 0; s < SARG_N_SENSORS; s++)
    for (int c = 0; c < 3; c++)
      if (rgb[s][c] >= SARG_SAT_LEVEL) return 1;
  return 0;
}

// --- small numeric helpers (branch-simple, MCU-friendly) ---
static inline float sarg__median4(float a, float b, float c, float d) {
  float v[4] = {a, b, c, d};
  for (int i = 0; i < 4; i++)          // tiny insertion sort (n=4)
    for (int j = i + 1; j < 4; j++)
      if (v[j] < v[i]) { float t = v[i]; v[i] = v[j]; v[j] = t; }
  return 0.5f * (v[1] + v[2]);
}
static inline float sarg__safe_div(float num, float den) {
  return (den > 1e-6f) ? (num / den) : 0.0f;   // dark sensor -> 0, never NaN/Inf
}
// Ratio features (G/B, (G+R)/B) are unbounded — a near-dark-blue sensor (B~1) yields a huge, noisy value
// that destabilizes the logreg separability gate and can skew tree splits. Clamp to a physical max: a
// ratio above this means "essentially no blue" (deep in-mat), so the exact magnitude past it is noise.
#define SARG_RATIO_MAX 16.0f
static inline float sarg__ratio(float num, float den) {
  float v = sarg__safe_div(num, den);
  return (v > SARG_RATIO_MAX) ? SARG_RATIO_MAX : v;
}

// Push one sample (raw 4x RGB) and compute the feature vector at this instant. Returns 1 if the sample
// was saturated (still windowed for continuity, but the caller should exclude it from training). `out`
// is always fully written. Time-order the calls; the trainer replays stored readings the same way.
static inline int sarg_update(sarg_state *st, const uint16_t rgb[SARG_N_SENSORS][3],
                              float out[SARG_N_FEATURES]) {
  float r[SARG_N_SENSORS], g[SARG_N_SENSORS], bright[SARG_N_SENSORS];
  float gb[SARG_N_SENSORS], grb[SARG_N_SENSORS];
  float rmin = 1e9f, rmax = -1e9f, gmin = 1e9f, gmax = -1e9f;
  float bmin = 1e9f, bmax = -1e9f;
  for (int s = 0; s < SARG_N_SENSORS; s++) {
    float R = (float)rgb[s][0], G = (float)rgb[s][1], B = (float)rgb[s][2];
    float sum = R + G + B;
    r[s] = sarg__safe_div(R, sum);
    g[s] = sarg__safe_div(G, sum);
    gb[s]  = sarg__ratio(G, B);
    grb[s] = sarg__ratio(G + R, B);
    bright[s] = sum;
    if (r[s] < rmin) rmin = r[s];  if (r[s] > rmax) rmax = r[s];
    if (g[s] < gmin) gmin = g[s];  if (g[s] > gmax) gmax = g[s];
    if (sum < bmin) bmin = sum;    if (sum > bmax) bmax = sum;
    out[SARG_F_R0 + s] = r[s];
    out[SARG_F_G0 + s] = g[s];
  }
  float med_g = sarg__median4(g[0], g[1], g[2], g[3]);
  out[SARG_F_MED_GB]     = sarg__median4(gb[0], gb[1], gb[2], gb[3]);
  out[SARG_F_MED_GRB]    = sarg__median4(grb[0], grb[1], grb[2], grb[3]);
  out[SARG_F_SPREAD_R]   = rmax - rmin;
  out[SARG_F_SPREAD_G]   = gmax - gmin;
  out[SARG_F_DARK_RATIO] = sarg__safe_div(bmin, bmax);
  // median total brightness / single-channel full-scale, clamped to 1. Reaches ~1 under bright light; the
  // old /(3*full-scale) reference is theoretical pure white, which unequal real spectra never all reach.
  float med_bright = sarg__median4(bright[0], bright[1], bright[2], bright[3]) / 65535.0f;
  out[SARG_F_MED_BRIGHT] = (med_bright > 1.0f) ? 1.0f : med_bright;

  (void)med_g;
  // push into the ring buffer
  uint8_t h = st->head;
  for (int s = 0; s < SARG_N_SENSORS; s++) { st->br_s[h][s] = bright[s]; st->g_s[h][s] = g[s]; }
  st->head = (uint8_t)((h + 1) % SARG_WINDOW);
  if (st->count < SARG_WINDOW) st->count++;

  // FLICKER: fronds flutter light/shadow over a sensor -> that sensor's BRIGHTNESS fluctuates fast. Take
  // the MAX over sensors of the windowed coefficient-of-variation (stdev/mean) of brightness. Using CV
  // (not raw stdev) makes it invariant to the global ambient scale — a slow whole-scene brightness drift
  // moves every sensor's mean AND stdev together, so CV stays low, while a single flickering sensor spikes.
  float flick = 0.0f;
  for (int s = 0; s < SARG_N_SENSORS; s++) {
    float mean = 0.0f;
    for (int i = 0; i < st->count; i++) mean += st->br_s[i][s];
    mean /= (float)st->count;
    float var = 0.0f;
    for (int i = 0; i < st->count; i++) { float d = st->br_s[i][s] - mean; var += d * d; }
    float cv = (mean > 1e-3f) ? (sqrtf(var / (float)st->count) / mean) : 0.0f;
    if (cv > flick) flick = cv;
  }
  out[SARG_F_FLICKER] = flick;

  // DIVERGENT: count sensors whose windowed-mean g stays > 0.05 from the cross-sensor quorum mean
  // (a lodged frond sits persistently off the others -> down-weight, don't let it flip the verdict).
  float smean[SARG_N_SENSORS] = {0, 0, 0, 0};
  for (int s = 0; s < SARG_N_SENSORS; s++) {
    for (int i = 0; i < st->count; i++) smean[s] += st->g_s[i][s];
    smean[s] /= (float)st->count;
  }
  float quorum = sarg__median4(smean[0], smean[1], smean[2], smean[3]);
  int divergent = 0;
  for (int s = 0; s < SARG_N_SENSORS; s++) if (fabsf(smean[s] - quorum) > 0.05f) divergent++;
  out[SARG_F_DIVERGENT] = (float)divergent;

  return sarg_is_saturated(rgb);
}

// Human-readable feature names (index-aligned) — for the dashboard debug view + trainer reporting.
static inline const char *sarg_feature_name(int i) {
  static const char *n[SARG_N_FEATURES] = {
    "r0", "r1", "r2", "r3", "g0", "g1", "g2", "g3",
    "med_GB", "med_GRB", "spread_r", "spread_g", "dark_ratio", "med_bright", "flicker", "divergent"};
  return (i >= 0 && i < SARG_N_FEATURES) ? n[i] : "?";
}
