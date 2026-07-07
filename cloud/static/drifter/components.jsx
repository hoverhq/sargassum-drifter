// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
/* ── Presentational components for the Drifter Field Console ──
   Ported from the Hover design project (Sargassum Drifter Console, prompt-10/11/12). sim.jsx's throwaway
   simulation is gone -- these components are now driven entirely by real API data from app.jsx. The live
   features panel lives in its own features.jsx (matching the design's zone/file split). */
const { useState, useEffect, useRef } = React;

// One canonical class table drives EVERY 3-way surface (label buttons, board verdict, timeline model-call
// track, dataset balance bar, span chips, registry counts). label ints match the trainer/board
// (open-water=0, in-mat=1, out-of-water=2); adding a class is one row here. `key` is the short string the
// label UI round-trips through onSet; `cvar` is the CSS color var; tintA/tintB are the fill/border tints.
const SARG_CLASSES = [
  { label: 0, key: 'OUT', name: 'OPEN WATER',   short: 'OPEN',   cvar: '--out', tintA: 'rgba(90,138,156,0.14)',  tintB: 'rgba(90,138,156,0.30)' },
  { label: 1, key: 'IN',  name: 'IN-MAT',       short: 'IN-MAT', cvar: '--in',  tintA: 'rgba(184,176,106,0.14)', tintB: 'rgba(184,176,106,0.28)' },
  { label: 2, key: 'DRY', name: 'OUT OF WATER', short: 'DRY',    cvar: '--dry', tintA: 'rgba(238,240,244,0.12)', tintB: 'rgba(238,240,244,0.34)' },
];
const SARG = {
  classes: SARG_CLASSES,
  byKey: (k) => SARG_CLASSES.find(c => c.key === k) || null,
  // legacy spans stored a string label ('IN'/'OUT'); tolerate both int and string here.
  byLabel: (l) => SARG_CLASSES.find(c => c.label === l || c.key === l) || null,
  _resolve: (ref) => (typeof ref === 'number' ? SARG.byLabel(ref) : (SARG.byKey(ref) || SARG.byLabel(ref))),
  color: (ref) => { const c = SARG._resolve(ref); return c ? `var(${c.cvar})` : 'var(--t-3)'; },
  name:  (ref) => { const c = SARG._resolve(ref); return c ? c.name : String(ref); },
  // Sensor swatch color: ISL29125 raw values are 16-bit (10k-lux range, 0..65535 full scale). CSS rgb()
  // clamps >255 to white, so real board data (thousands) renders every swatch white. Normalize to 0..255
  // for the COLOR only -- numeric readouts keep the raw values. A linear /65535 is physically correct but
  // maps real underwater readings (~1000-6000, well under the sun-clip ceiling) near-black, defeating the
  // see-the-color glance. A sqrt (gamma ~2) perceptual curve lifts those dim readings into a visible,
  // hue-distinguishable range while bright out-of-water readings still approach white.
  rgb255: (rgb) => rgb.map(v => Math.max(0, Math.min(255, Math.round(255 * Math.sqrt(Math.max(0, v) / 65535))))),
  cssRgb: (rgb) => { const [r, g, b] = SARG.rgb255(rgb); return `rgb(${r}, ${g}, ${b})`; },
};

// ─────────────────────────────────────────────────────────────
// ZONE 1 — LIVE NOW
// ─────────────────────────────────────────────────────────────
function SensorSwatch({ idx, sensor, present }) {
  if (!present) {
    return (
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          height: 54, borderRadius: 6, border: '1px dashed var(--wine-border)',
          background: 'var(--wine-bg2)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: 'var(--wine-text)', fontSize: 'var(--text-xs)',
        }} className="mono">no signal</div>
        <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--text-2xs)', letterSpacing: '0.12em', color: 'var(--wine-text)' }}>S{idx + 1}</span>
          <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-4)' }}>—/—/—</span>
        </div>
      </div>
    );
  }
  const [r, g, b] = sensor;
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{
        height: 54, borderRadius: 6, border: '1px solid var(--hair-2)',
        background: SARG.cssRgb([r, g, b]),   // normalize 16-bit raw -> 0..255 for the color (readout stays raw)
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.25)',
      }} />
      <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 'var(--text-2xs)', letterSpacing: '0.12em', color: 'var(--t-3)' }}>S{idx + 1}</span>
        <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-2)' }}>
          {r | 0}/{g | 0}/{b | 0}
        </span>
      </div>
    </div>
  );
}

function LiveNow({ sensors, present, verdict, modelVersion }) {
  const nPresent = present.filter(Boolean).length;
  const healthy = nPresent === 4;
  return (
    <div className="grid-2">
      {/* sensors */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span className="eyebrow">4× RGB sensor · live</span>
          <span className={'pill ' + (healthy ? 'green' : 'wine')}>
            <span className="dot" style={healthy ? { animation: 'pulseDot 1.6s infinite' } : {}} />
            {healthy ? `${nPresent}/4 sensors present` : `${nPresent}/4 — ${4 - nPresent} offline`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {sensors.map((s, i) => (
            <SensorSwatch key={i} idx={i} sensor={s} present={present[i]} />
          ))}
        </div>
        {!healthy && (
          <div style={{ marginTop: 12, fontSize: 'var(--text-sm)', color: 'var(--wine-text)' }}>
            A dead sensor reads as a bad label — pause labeling until it recovers.
          </div>
        )}
      </div>

      {/* board verdict */}
      <VerdictCard verdict={verdict} modelVersion={modelVersion} />
    </div>
  );
}

function VerdictCard({ verdict, modelVersion }) {
  const hasModel = modelVersion != null;
  const cls = verdict ? SARG.byKey(verdict.label) : null;   // null while waiting for the first detection
  const color = !hasModel || !cls ? 'var(--t-3)' : `var(${cls.cvar})`;
  const bg = !hasModel || !cls ? 'var(--bg-1)' : cls.tintA;
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span className="eyebrow">Board verdict</span>
        <span className="pill neutral mono" style={{ fontSize: 'var(--text-xs)' }}>
          {hasModel ? 'model v' + modelVersion : 'no model'}
        </span>
      </div>
      {hasModel ? (
        <div style={{
          flex: 1, borderRadius: 8, background: bg, border: '1px solid ' + (cls ? cls.tintB : 'var(--hair-3)'),
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '18px 12px', gap: 8,
        }}>
          <span className="dot" style={{ width: 9, height: 9, borderRadius: 9, background: color, animation: 'pulseDot 1.4s infinite', display: 'block' }} />
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.01em', color }}>
            {cls ? cls.name : 'waiting…'}
          </div>
          <div className="mono" style={{ fontSize: 'var(--text-lg)', color: 'var(--t-2)' }}>
            confidence {verdict && verdict.conf != null ? verdict.conf.toFixed(2) : '—'}
          </div>
        </div>
      ) : (
        <div style={{
          flex: 1, borderRadius: 8, background: 'var(--bg-1)', border: '1px dashed var(--hair-3)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '18px 16px', gap: 6, textAlign: 'center',
        }}>
          <div style={{ fontSize: 'var(--text-lg)', color: 'var(--t-2)', fontWeight: 500 }}>Board is not classifying</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--t-3)', maxWidth: 240 }}>
            Train a model and push it to the board to see a live IN-MAT / OPEN-WATER verdict here.
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ZONE 3 — LABEL
// ─────────────────────────────────────────────────────────────
// UI button order (label ints are OUT=0/IN=1/DRY=2, but in-mat reads first, then open water, then dry).
const LABEL_ORDER = ['IN', 'OUT', 'DRY'];
function LabelToggle({ active, recCount, onSet }) {
  const activeCls = active ? SARG.byKey(active) : null;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        {LABEL_ORDER.map(key => {
          const c = SARG.byKey(key);
          const on = active === key;
          return (
            <button
              key={key}
              onClick={() => onSet(on ? null : key)}
              style={{
                flex: 1, padding: '18px 8px', borderRadius: 8, cursor: 'pointer',
                border: '1px solid ' + (on ? `var(${c.cvar})` : 'var(--hair-2)'),
                background: on ? c.tintA : 'var(--bg-3)',
                color: on ? `var(${c.cvar})` : 'var(--t-2)',
                fontWeight: 700, fontSize: 'var(--text-lg)', letterSpacing: '-0.01em',
                boxShadow: on ? `0 0 0 3px ${c.tintA}` : 'none',
                transition: 'all .12s',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                {on && <span className="dot" style={{ width: 8, height: 8, borderRadius: 8, background: `var(${c.cvar})`, animation: 'pulseDot 1s infinite' }} />}
                {c.name}
              </div>
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 10, minHeight: 18, fontSize: 'var(--text-sm)', color: active ? 'var(--t-2)' : 'var(--t-3)' }}>
        {activeCls ? (
          <span>
            <span className="mono" style={{ color: `var(${activeCls.cvar})` }}>● recording</span>
            {' '}— tagging live readings as <b style={{ color: 'var(--t-1)', fontWeight: 600 }}>{activeCls.name}</b>. <span className="mono">{recCount}</span> samples captured. Tap again to append the span.
          </span>
        ) : (
          <span>Hold the drifter in position, tap a label to start recording, tap again to append it to the dataset.</span>
        )}
      </div>
    </div>
  );
}

// Rolling timeline with drag-to-select spans of past readings. `buffer` entries are {sensors, ts} where ts
// is the BOARD's clock (seconds-since-boot) -- the same clock every span/label is matched against.
function Timeline({ buffer, sel, onSelChange, onLabel }) {
  const ref = useRef(null);
  const dragging = useRef(false);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });

  const idxFromEvent = (e) => {
    const el = ref.current; if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const i = Math.floor((x / rect.width) * buffer.length);
    return Math.max(0, Math.min(buffer.length - 1, i));
  };
  const down = (e) => { const i = idxFromEvent(e); if (i == null) return; dragging.current = true; onSelChange({ a: i, b: i }); };
  const move = (e) => {
    const i = idxFromEvent(e);
    if (i != null) {
      setHoverIdx(i);
      setHoverPos({ x: e.clientX, y: e.clientY });
    }
    if (dragging.current && i != null) onSelChange(s => ({ a: s.a, b: i }));
  };
  const leave = () => setHoverIdx(null);
  const up = () => { dragging.current = false; };
  useEffect(() => {
    window.addEventListener('mouseup', up); window.addEventListener('touchend', up);
    return () => { window.removeEventListener('mouseup', up); window.removeEventListener('touchend', up); };
  }, []);

  const lo = sel ? Math.min(sel.a, sel.b) : -1;
  const hi = sel ? Math.max(sel.a, sel.b) : -1;
  const hasSel = sel && hi > lo;
  const selCount = hasSel ? hi - lo + 1 : 0;

  const rgbMean = (sensors) => {
    const m = sensors.reduce((a, s) => [a[0] + s[0], a[1] + s[1], a[2] + s[2]], [0, 0, 0]);
    return [(m[0] / sensors.length) | 0, (m[1] / sensors.length) | 0, (m[2] / sensors.length) | 0];
  };
  const rgbCss = (sensors) => SARG.cssRgb(rgbMean(sensors));   // normalized for the tick color; tooltip keeps raw
  const modelCallColor = (call) => { const c = SARG.byKey(call); return c ? `var(${c.cvar})` : 'var(--bg-3)'; };
  const hhmmss = (wallSec) => {
    if (!wallSec) return null;
    const d = new Date(wallSec * 1000);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  };
  // sparse x-axis labels: roughly every 8-10th tick, always including the last (rightmost/most-recent) one
  const AXIS_STRIDE = 9;
  const hovered = hoverIdx != null ? buffer[hoverIdx] : null;

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="eyebrow">Recent readings · drag to select a range</span>
        <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-4)' }}>{buffer.length} readings buffered</span>
      </div>
      <div
        ref={ref}
        onMouseDown={down} onMouseMove={move} onMouseLeave={leave}
        onTouchStart={down} onTouchMove={move}
        style={{
          background: 'var(--bg-1)', borderRadius: 6, padding: 3,
          border: '1px solid var(--hair-2)', cursor: 'crosshair', userSelect: 'none',
        }}>
        {/* row 1: reading color (per-sensor mean RGB) */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--t-4)', width: 62, flex: 'none' }}>reading</span>
          <div style={{ display: 'flex', gap: 1, height: 32, flex: 1, alignItems: 'stretch' }}>
            {buffer.map((f, i) => {
              const inSel = i >= lo && i <= hi;
              return (
                <div key={i} style={{
                  flex: 1, borderRadius: 1, background: rgbCss(f.sensors),
                  opacity: hasSel ? (inSel ? 1 : 0.32) : 0.92,
                  outline: inSel ? '1px solid rgba(236,236,239,0.5)' : (i === hoverIdx ? '1px solid rgba(236,236,239,0.35)' : 'none'),
                  transition: 'opacity .1s',
                }} />
              );
            })}
            {buffer.length === 0 && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-4)', fontSize: 'var(--text-xs)' }} className="mono">
                waiting for readings…
              </div>
            )}
          </div>
        </div>
        {/* row 2: the board's OWN model call at each reading's instant (timestamp-aligned, not reclassified) */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--t-4)', width: 62, flex: 'none' }}>model call</span>
          <div style={{ display: 'flex', gap: 1, height: 10, flex: 1, alignItems: 'stretch' }}>
            {buffer.map((f, i) => {
              const inSel = i >= lo && i <= hi;
              return (
                <div key={i} style={{
                  flex: 1, borderRadius: 1, background: modelCallColor(f.modelCall),
                  opacity: hasSel ? (inSel ? 1 : 0.32) : 0.85,
                }} />
              );
            })}
          </div>
        </div>
        {/* sparse x-axis: capture time (wall-clock), every ~AXIS_STRIDE-th tick */}
        {buffer.length > 0 && (
          <div style={{ display: 'flex', gap: 1, marginTop: 3 }}>
            <span style={{ width: 62, flex: 'none' }} />
            {buffer.map((f, i) => {
              const showLabel = i === buffer.length - 1 || i % AXIS_STRIDE === 0;
              return (
                <div key={i} style={{ flex: 1, textAlign: i === buffer.length - 1 ? 'right' : 'left' }}>
                  {showLabel && (
                    <span className="mono" style={{ fontSize: 'var(--text-2xs)', color: 'var(--t-4)' }}>
                      {hhmmss(f.wall) || ''}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* hover tooltip: precise capture time + reading value + the board's own model call, all at once */}
      {hovered && (
        <div style={{
          position: 'fixed', left: hoverPos.x + 14, top: hoverPos.y + 14, zIndex: 50,
          background: 'var(--bg-3)', border: '1px solid var(--hair-3)', borderRadius: 6,
          padding: '7px 10px', fontSize: 'var(--text-xs)', color: 'var(--t-1)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', pointerEvents: 'none', whiteSpace: 'nowrap',
        }} className="mono">
          <div>{hhmmss(hovered.wall) || 'time unknown'}</div>
          <div style={{ color: 'var(--t-2)' }}>rgb {rgbMean(hovered.sensors).join(', ')}</div>
          <div style={{ color: modelCallColor(hovered.modelCall) }}>
            model: {(SARG.byKey(hovered.modelCall) || {}).name || 'no model yet'}
          </div>
        </div>
      )}

      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, minHeight: 30 }}>
        {hasSel ? (
          <>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--t-2)' }}>
              <span className="mono" style={{ color: 'var(--t-1)' }}>{selCount}</span> readings selected — label as
            </span>
            {LABEL_ORDER.map(key => {
              const c = SARG.byKey(key);
              return (
                <button key={key} className="btn btn--sm" style={{ borderColor: `var(${c.cvar})`, color: `var(${c.cvar})` }}
                        onClick={() => onLabel(key, lo, hi)}>{c.name}</button>
              );
            })}
            <button className="btn btn--sm btn--ghost" onClick={() => onSelChange(null)}>Clear</button>
          </>
        ) : (
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--t-3)' }}>Clean up a transition after the fact — drag across the ticks to pick a past range.</span>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { SARG, SensorSwatch, LiveNow, VerdictCard, LabelToggle, Timeline });
