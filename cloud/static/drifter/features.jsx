// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
/* ── ZONE 02 — Features (live): what the board computes from the sensors ──
   Ported visually from the Hover design project's features.jsx (FeatureTile/FeaturesZone), but the NUMBERS
   are the board's REAL 16-value feature vector (from the shared C header hover_sarg_features.h, the same
   computation the board runs), taken straight off the latest /api/detections `.features` array -- never
   recomputed in the UI. The design's own computeFeatures() was a plausible-looking approximation written
   without the real feature layout (it merges 4 sensors into one mean chromaticity, for example); this
   shows the actual per-sensor values instead, which is a superset, not a departure, of the design's intent. */

// Frozen feature index layout (must match SARG_F_* in hover_sarg_features.h exactly).
const R0 = 0, G0 = 4, MED_GB = 8, MED_GRB = 9, SPREAD_R = 10, SPREAD_G = 11,
      DARK_RATIO = 12, MED_BRIGHT = 13, FLICKER = 14, DIVERGENT = 15;

const clamp01 = v => Math.max(0, Math.min(1, v));

// `frac` only sizes the little progress bar (a presentation-only visual scale) -- `value` always shows the
// exact real number regardless of how the bar is scaled.
function realFeatureGroups(features, saturated) {
  if (!features || features.length < 16) return [];
  const f = features;
  return [
    { group: 'Color · per-sensor green (the primary mat signal)', tiles: [0, 1, 2, 3].map(i => ({
      key: 'g' + i, name: `Sensor ${i + 1} green`, value: f[G0 + i].toFixed(3), frac: clamp01(f[G0 + i]),
      caption: `How much of sensor ${i + 1}'s light is green. Sargassum lifts this; open water keeps it low.`,
    })) },
    { group: 'Color · per-sensor red (corroborating)', tiles: [0, 1, 2, 3].map(i => ({
      key: 'r' + i, name: `Sensor ${i + 1} red`, value: f[R0 + i].toFixed(3), frac: clamp01(f[R0 + i]),
      caption: `How much of sensor ${i + 1}'s light is red. Brown fronds lift this alongside green.`,
    })) },
    { group: 'Consensus color ratio', tiles: [
      { key: 'med_gb', name: 'Median G/B', value: f[MED_GB].toFixed(2), frac: clamp01(f[MED_GB] / 16),
        caption: 'Median green÷blue across the 4 sensors. High = mat-like; low = open water (blue-dominant).' },
      { key: 'med_grb', name: 'Median (G+R)/B', value: f[MED_GRB].toFixed(2), frac: clamp01(f[MED_GRB] / 16),
        caption: 'Median (green+red)÷blue. Sharpens the same brown/green-vs-blue axis, more robust than G/B alone.' },
    ] },
    { group: 'Cross-sensor · are the 4 agreeing?', tiles: [
      { key: 'spread_r', name: 'Spread (red)', value: f[SPREAD_R].toFixed(3), frac: clamp01(f[SPREAD_R] / 0.3),
        caption: 'How much the 4 sensors disagree on red. High = a patchy mat edge, not a uniform scene.' },
      { key: 'spread_g', name: 'Spread (green)', value: f[SPREAD_G].toFixed(3), frac: clamp01(f[SPREAD_G] / 0.3),
        caption: 'How much the 4 sensors disagree on green. High = a patchy mat edge, not a uniform scene.' },
    ] },
    { group: 'Brightness', tiles: [
      { key: 'dark_ratio', name: 'Dark ratio', value: f[DARK_RATIO].toFixed(2), frac: clamp01(f[DARK_RATIO]),
        caption: 'Dimmest sensor ÷ brightest. A mat physically shades some sensors, so this drops below 1.' },
      { key: 'med_bright', name: 'Median brightness', value: f[MED_BRIGHT].toFixed(2), frac: clamp01(f[MED_BRIGHT]),
        caption: 'Overall light level across sensors. A weak corroborating cue only — color matters more than darkness.' },
    ] },
    { group: 'Temporal · recent window', tiles: [
      { key: 'flicker', name: 'Flicker', value: f[FLICKER].toFixed(3), frac: clamp01(f[FLICKER] / 0.5),
        caption: 'How fast one sensor’s brightness flutters. Fronds swaying through the view spike this.' },
      { key: 'divergent', name: 'Divergent sensors', value: String(Math.round(f[DIVERGENT])), frac: clamp01(f[DIVERGENT] / 4),
        caption: 'Count of sensors stuck reading differently from the other three — flags a lodged frond so it can’t flip the verdict alone.' },
    ] },
    { group: 'Health', tiles: [
      { key: 'sat', name: 'Saturation', value: saturated ? 'RAILED' : 'clear', frac: saturated ? 1 : 0, alert: saturated,
        caption: 'Did any channel rail out (sun glint)? Saturated samples are flagged and kept out of training.' },
    ] },
  ];
}

function FeatureTile({ tile }) {
  const alert = !!tile.alert;
  return (
    <div style={{
      background: alert ? 'var(--wine-bg2)' : 'var(--bg-1)',
      border: '1px solid ' + (alert ? 'var(--wine-border)' : 'var(--hair-1)'),
      borderRadius: 6, padding: '10px 12px 11px',
      display: 'flex', flexDirection: 'column', gap: 5,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: alert ? 'var(--wine-text)' : 'var(--t-2)' }}>{tile.name}</span>
        <span className="mono" style={{ fontSize: 'var(--text-xl)', fontWeight: 500, color: alert ? 'var(--wine-text)' : 'var(--t-1)', whiteSpace: 'nowrap' }}>{tile.value}</span>
      </div>
      <div style={{ height: 2, borderRadius: 2, background: 'var(--bg-3)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: (tile.frac * 100).toFixed(1) + '%',
          background: alert ? 'var(--wine)' : 'var(--olive-dim)',
          transition: 'width .5s ease',
        }} />
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--t-3)', lineHeight: 1.45 }}>{tile.caption}</div>
    </div>
  );
}

function FeaturesZone({ features, saturated }) {
  const groups = realFeatureGroups(features, saturated);
  if (!groups.length) {
    return (
      <div className="card" style={{ textAlign: 'center', color: 'var(--t-3)', fontSize: 'var(--text-sm)', padding: '20px' }}>
        Waiting for the board's first detection…
      </div>
    );
  }
  return (
    <div className="card">
      {groups.map((g, gi) => (
        <div key={g.group} style={{ marginTop: gi === 0 ? 0 : 16 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>{g.group}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
            {g.tiles.map(t => <FeatureTile key={t.key} tile={t} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { realFeatureGroups, FeatureTile, FeaturesZone });
