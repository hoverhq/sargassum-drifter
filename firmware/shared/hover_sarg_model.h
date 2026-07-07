// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
#pragma once
#include <stdint.h>
#include <string.h>

// hover_sarg_model — parse + evaluate the sargassum Random Forest the drifter OTA-pulls from the cloud.
// The cloud (cloud/sargassum/model_serialize.py) emits the 'SGF3' artifact; this mirrors its eval_forest
// EXACTLY (float thresholds, per-class soft-proba leaves, argmax tie-to-lowest-index) so the board's
// verdict == the trainer's.
//
// N-CLASS (open-water=0 / in-mat=1 / out-of-water=2): each leaf stores the FULL per-class probability
// vector (n_classes floats); prediction is argmax of the tree-averaged vector. N=2 is just a 2-class
// instance of the same path, so a binary field model still parses + predicts correctly through the change.
//
// ZERO-COPY: the model just POINTS into the pulled blob bytes (no allocation, no parsing into structs), so
// hot-swap is: pull a new blob into an idle buffer, parse it (fills a second sarg_model), then atomically
// swap the active `sarg_model*` the inference loop reads. Inference never sees a half-written model.
//
// Artifact (little-endian): 'SGF3' | u16 n_features | u16 n_classes | u32 n_nodes |
// n_nodes x { i16 feature, f32 threshold, i16 left, i16 right } (10 bytes) | u32 n_roots | n_roots x i32 |
// u32 n_leaves | n_leaves x (n_classes x f32).  A NEGATIVE child = a leaf: its per-class proba vector
// starts at leaf[(-child-1) * n_classes]. Prediction = argmax(mean per-class proba over trees), ties to
// the lowest class index. The magic is version-bumped from SGF2, so a stale board hard-rejects a
// mismatched-format blob (keeps its prior model) rather than misreading the doubled leaf array.

#define SARG_NODE_BYTES 10
#define SARG_MODEL_MAX_CLASSES 4   // bounds the caller's on-stack proba array; parse rejects a larger blob

typedef struct {
  const uint8_t *nodes;   // n_nodes * 10 bytes
  const uint8_t *roots;   // n_roots * 4 bytes (i32)
  const uint8_t *leaves;  // n_leaves * n_classes * 4 bytes (f32)
  uint16_t n_features;
  uint16_t n_classes;
  uint32_t n_nodes;
  uint32_t n_roots;
  uint32_t n_leaves;
} sarg_model;

// little-endian readers (portable; ESP32-S3 is LE but read byte-wise so the host test is exact too)
static inline int16_t sarg__i16(const uint8_t *p) { return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8)); }
static inline int32_t sarg__i32(const uint8_t *p) {
  return (int32_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24));
}
static inline float sarg__f32(const uint8_t *p) { float f; memcpy(&f, p, 4); return f; }
static inline uint32_t sarg__u32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// Parse a SGF3 blob (validates magic + bounds + class count). Returns 1 on success, 0 on a malformed/short
// blob OR a wrong-version (e.g. old SGF2) blob (the caller then keeps the previous model — a bad OTA pull
// must NOT brick inference).
static inline int sarg_model_parse(sarg_model *m, const uint8_t *blob, uint32_t len) {
  if (len < 4 + 4 + 4 || memcmp(blob, "SGF3", 4) != 0) return 0;
  uint32_t off = 4;
  m->n_features = (uint16_t)(blob[off] | (blob[off + 1] << 8));
  m->n_classes = (uint16_t)(blob[off + 2] | (blob[off + 3] << 8));
  off += 4;
  m->n_nodes = sarg__u32(blob + off); off += 4;
  m->nodes = blob + off; off += m->n_nodes * SARG_NODE_BYTES;
  if (off + 4 > len) return 0;
  m->n_roots = sarg__u32(blob + off); off += 4;
  m->roots = blob + off; off += m->n_roots * 4;
  if (off + 4 > len) return 0;
  m->n_leaves = sarg__u32(blob + off); off += 4;
  m->leaves = blob + off; off += (uint32_t)m->n_leaves * m->n_classes * 4;
  if (off > len || m->n_roots == 0) return 0;
  if (m->n_classes < 2 || m->n_classes > SARG_MODEL_MAX_CLASSES) return 0;
  return 1;
}

// Mean per-class probability across trees for a feature vector -> proba_out[n_classes]. The caller sizes
// proba_out to at least SARG_MODEL_MAX_CLASSES (parse guarantees n_classes fits). Mirrors
// model_serialize.forest_proba.
static inline void sarg_model_proba(const sarg_model *m, const float *feat, float *proba_out) {
  for (uint16_t c = 0; c < m->n_classes; c++) proba_out[c] = 0.0f;
  for (uint32_t t = 0; t < m->n_roots; t++) {
    int32_t node = sarg__i32(m->roots + t * 4);
    while (node >= 0) {
      const uint8_t *nd = m->nodes + (uint32_t)node * SARG_NODE_BYTES;
      int16_t f = sarg__i16(nd);
      float thr = sarg__f32(nd + 2);
      node = (feat[f] <= thr) ? sarg__i16(nd + 6) : sarg__i16(nd + 8);
    }
    uint32_t leaf = (uint32_t)(-node - 1);
    const uint8_t *lp = m->leaves + (uint32_t)leaf * m->n_classes * 4;
    for (uint16_t c = 0; c < m->n_classes; c++) proba_out[c] += sarg__f32(lp + c * 4);
  }
  float inv = 1.0f / (float)m->n_roots;
  for (uint16_t c = 0; c < m->n_classes; c++) proba_out[c] *= inv;
}

// Predicted class 0..n_classes-1: argmax of the tree-averaged per-class proba. Ties resolve to the LOWEST
// index (strict '>'), matching numpy.argmax / eval_forest. For a binary model this is exactly the old
// P(in-mat) > 0.5 rule.
static inline int sarg_model_predict(const sarg_model *m, const float *feat) {
  float p[SARG_MODEL_MAX_CLASSES];
  sarg_model_proba(m, feat, p);
  int best = 0;
  for (uint16_t c = 1; c < m->n_classes; c++)
    if (p[c] > p[best]) best = (int)c;
  return best;
}
