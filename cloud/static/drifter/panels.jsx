// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
/* ── Dataset + Train/Push + Model Registry panels ──
   Ported from the Hover design project, extended for a full
   model registry (every trained version kept, push ANY of them, not just the newest) with per-model notes. */
const { useState } = React;

// ─────────────────────────────────────────────────────────────
// ZONE 4 — DATASET
// ─────────────────────────────────────────────────────────────
function ClassBalanceBar({ stats }) {
  const { counts, total, minorityFrac } = stats;
  const warn = total > 0 && stats.classes >= 2 && minorityFrac < 0.30;
  // the smallest class that actually has samples -> the one to nudge more of
  const present = SARG.classes.filter(c => (counts[c.label] || 0) > 0);
  const smallest = present.reduce((a, c) => ((counts[c.label] || 0) < (counts[a.label] || 0) ? c : a),
                                   present[0] || SARG.classes[0]);
  return (
    <div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 7 }}>
        {SARG.classes.map(c => (
          <span key={c.key} style={{ fontSize: 'var(--text-md)', color: `var(${c.cvar})`, fontWeight: 500 }}>
            <span className="mono">{counts[c.label] || 0}</span> {c.name}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', background: 'var(--bg-1)', border: '1px solid var(--hair-2)' }}>
        {total === 0 ? (
          <div style={{ flex: 1, background: 'repeating-linear-gradient(45deg,#131318 0 6px,#0e0e12 6px 12px)' }} />
        ) : (
          SARG.classes.map(c => {
            const w = ((counts[c.label] || 0) / total) * 100;
            return w > 0
              ? <div key={c.key} style={{ width: w + '%', background: `var(${c.cvar})`, transition: 'width .35s ease' }} />
              : null;
          })
        )}
      </div>
      {warn && (
        <div style={{ marginTop: 7, fontSize: 'var(--text-sm)', color: 'var(--amber-text)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--amber)' }}>▲</span>
          Lopsided — add more {smallest.name} samples for a fair model.
        </div>
      )}
    </div>
  );
}

function SpanRow({ span, isNew, onDelete }) {
  const cls = SARG.byLabel(span.label) || SARG.classes[0];
  const hasWall = span.t_end_wall > 0;
  let hh = '--', mm = '--', ss = '--';
  if (hasWall) {
    const t = new Date(span.t_end_wall * 1000);
    hh = String(t.getHours()).padStart(2, '0');
    mm = String(t.getMinutes()).padStart(2, '0');
    ss = String(t.getSeconds()).padStart(2, '0');
  }
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '96px 1fr auto auto 22px 26px',
      alignItems: 'center', gap: 10,
      padding: '8px 4px', borderBottom: '1px solid var(--hair-1)',
      animation: isNew ? 'rowIn 1.1s ease' : 'none',
    }}>
      <span className="pill" style={{
        justifySelf: 'start',
        background: cls.tintA,
        color: `var(${cls.cvar})`,
        border: '1px solid ' + cls.tintB,
      }}>
        <span className="dot" style={{ background: `var(${cls.cvar})` }} />
        {cls.short}
      </span>
      <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-3)' }}>
        {hh}:{mm}:{ss}
      </span>
      <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-3)', textAlign: 'right' }}>
        {span.duration_sec}s
      </span>
      <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-2)', textAlign: 'right' }}>
        {span.samples} smp
      </span>
      <span title="average color of this span" style={{
        width: 22, height: 22, borderRadius: 4,
        background: SARG.cssRgb(span.rgb),   // normalize 16-bit raw -> 0..255 for the color
        border: '1px solid var(--hair-2)', justifySelf: 'center',
      }} />
      <button className="iconbtn" title="Delete span" onClick={() => onDelete(span.id)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M7 7l1 12a1 1 0 001 1h6a1 1 0 001-1l1-12" />
        </svg>
      </button>
    </div>
  );
}

function DatasetZone({ spans, stats, newSpanId, onDelete, onClear }) {
  const [confirmClear, setConfirmClear] = useState(false);
  const empty = spans.length === 0;
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <span className="eyebrow">Accumulated dataset</span>
          <div style={{ marginTop: 3, fontSize: 'var(--text-sm)', color: 'var(--t-3)' }}>
            {empty ? 'nothing recorded yet' : (
              <><span className="mono" style={{ color: 'var(--t-2)' }}>{stats.spans}</span> spans · <span className="mono" style={{ color: 'var(--t-2)' }}>{stats.total}</span> samples</>
            )}
          </div>
        </div>
        {!empty && (
          confirmClear ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--wine-text)' }}>Delete all {stats.spans} spans?</span>
              <button className="btn btn--sm btn--danger" onClick={() => { onClear(); setConfirmClear(false); }}>Clear all</button>
              <button className="btn btn--sm btn--ghost" onClick={() => setConfirmClear(false)}>Cancel</button>
            </div>
          ) : (
            <button className="btn btn--sm btn--ghost" onClick={() => setConfirmClear(true)}>Clear dataset</button>
          )
        )}
      </div>

      {empty ? (
        <div style={{
          borderRadius: 8, border: '1px dashed var(--hair-3)', background: 'var(--bg-1)',
          padding: '34px 20px', textAlign: 'center',
        }}>
          <div style={{ width: 40, height: 40, margin: '0 auto 12px', borderRadius: 999, border: '1px solid var(--hair-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at 50% 35%, rgba(184,176,106,0.12), transparent 70%)' }}>
            <span style={{ width: 12, height: 12, borderRadius: 999, border: '1.5px solid var(--olive)', display: 'block', position: 'relative' }} />
          </div>
          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 600, color: 'var(--t-1)' }}>Label some readings to build a dataset</div>
          <div style={{ marginTop: 6, fontSize: 'var(--text-base)', color: 'var(--t-3)', maxWidth: 460, margin: '6px auto 0' }}>
            Hold the drifter inside a mat and tap <b style={{ color: 'var(--olive)' }}>IN-MAT</b>, in clear water and tap <b style={{ color: 'var(--out)' }}>OPEN WATER</b>, and lift it into the air for <b style={{ color: 'var(--dry-text)' }}>OUT OF WATER</b>. Each label appends a span here.
          </div>
        </div>
      ) : (
        <>
          <ClassBalanceBar stats={stats} />
          <div style={{
            marginTop: 14, display: 'grid',
            gridTemplateColumns: '96px 1fr auto auto 22px 26px',
            gap: 10, padding: '0 4px 6px',
            fontSize: 'var(--text-2xs)', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t-4)',
            borderBottom: '1px solid var(--hair-2)',
          }}>
            <span>Label</span><span>Ended</span><span style={{ textAlign: 'right' }}>Dur</span>
            <span style={{ textAlign: 'right' }}>Samples</span><span style={{ textAlign: 'center' }}>Avg</span><span></span>
          </div>
          <div style={{ maxHeight: 250, overflowY: 'auto' }}>
            {[...spans].reverse().map(s => (
              <SpanRow key={s.id} span={s} isNew={s.id === newSpanId} onDelete={onDelete} />
            ))}
          </div>
          <div style={{ marginTop: 12, fontSize: 'var(--text-sm)', color: 'var(--t-3)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--olive-dim)' }}>↻</span>
            <span><b style={{ color: 'var(--t-2)', fontWeight: 500 }}>Train uses all {stats.spans} spans.</b> It retrains from scratch on everything above — not just the last one you labeled.</span>
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ZONE 5 — TRAIN + PUSH (the model registry itself is its own zone -- see registry.jsx)
// ─────────────────────────────────────────────────────────────
function ResultPanel({ result, liveVersion, onPush }) {
  const good = result.tone === 'good';
  const accent = good ? 'var(--sage)' : 'var(--amber)';
  const bg = good ? 'rgba(122,166,146,0.08)' : 'rgba(179,135,61,0.09)';
  const border = good ? 'rgba(122,166,146,0.3)' : 'rgba(179,135,61,0.35)';
  const st = result.dataset;
  const alreadyPushed = liveVersion > 0 && result.version === liveVersion;
  return (
    <div style={{ borderRadius: 8, border: '1px solid ' + border, background: bg, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        {/* val accuracy */}
        <div style={{ minWidth: 120 }}>
          <div className="eyebrow" style={{ color: accent }}>Validation accuracy · v{result.version}</div>
          <div className="mono" style={{ fontSize: 34, fontWeight: 500, color: 'var(--t-1)', lineHeight: 1.1, marginTop: 4 }}>
            {result.val.toFixed(2)}
          </div>
          <div className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-3)', marginTop: 2 }}>
            separability {result.separability.toFixed(2)}
          </div>
        </div>
        {/* read */}
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 'var(--text-lg)', fontWeight: 600, color: good ? 'var(--sage-text)' : 'var(--amber-text)' }}>
            <span>{good ? '✓' : '▲'}</span> {result.headline}
          </div>
          <div style={{ marginTop: 5, fontSize: 'var(--text-sm)', color: 'var(--t-2)', lineHeight: 1.5 }}>{result.detail}</div>
          <div style={{ marginTop: 9, display: 'flex', gap: 14, fontSize: 'var(--text-xs)' }} className="mono">
            {SARG.classes.filter(c => ((st.counts || {})[c.label] || 0) > 0).map(c => (
              <span key={c.key} style={{ color: `var(${c.cvar})` }}>{st.counts[c.label]} {c.short}</span>
            ))}
            <span style={{ color: 'var(--t-3)' }}>{st.spans} spans</span>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid ' + border, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {alreadyPushed ? (
          <span className="pill green"><span className="dot" />Pushed to board as model v{liveVersion}</span>
        ) : (
          <>
            <button className="btn btn--primary" onClick={() => onPush(result.version)}>
              Push to board {good ? '' : '(flagged)'} →
            </button>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--t-3)' }}>
              {good
                ? 'The board keeps running its current model until you push.'
                : 'You can still push, but this model is flagged — watch the live verdict closely.'}
            </span>
          </>
        )}
      </div>
      {alreadyPushed && (
        // Post-push loop-closer nudge (design carry-over, prompt-11): val accuracy is noisy on small field
        // datasets -- the live board verdict, watched by hand, is the real ground truth.
        <div style={{ marginTop: 12, fontSize: 'var(--text-sm)', color: 'var(--sage-text)', display: 'flex', gap: 8 }}>
          <span>↻</span>
          <span>Now move the drifter in and out of the mat, and watch the Board verdict up top — that live test is the real ground truth.</span>
        </div>
      )}
    </div>
  );
}

function TrainPushZone({ stats, result, training, liveVersion, onTrain, onPush }) {
  const canTrain = stats.classes >= 2 && stats.total > 0;   // at least 2 of the (up to 3) classes present
  const presentNames = SARG.classes.filter(c => (stats.counts[c.label] || 0) > 0).map(c => c.name);
  return (
    <div className="card">
      <span className="eyebrow">Train &amp; push</span>
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <button className="btn btn--primary btn--lg" disabled={!canTrain || training} onClick={onTrain} aria-disabled={!canTrain || training}>
          {training ? 'Training…' : 'Train'}
        </button>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--t-2)' }}>
          {canTrain ? (
            <>Will train on <b style={{ color: 'var(--t-1)', fontWeight: 600 }}>{stats.spans} spans</b> · {SARG.classes.filter(c => (stats.counts[c.label] || 0) > 0).map((c, i) => (
              <React.Fragment key={c.key}>{i > 0 && ' / '}<span className="mono" style={{ color: `var(${c.cvar})` }}>{stats.counts[c.label]} {c.short}</span></React.Fragment>
            ))}</>
          ) : stats.total === 0 ? (
            <span style={{ color: 'var(--t-3)' }}>Label some readings first — nothing to train on yet.</span>
          ) : (
            <span style={{ color: 'var(--amber-text)' }}>Need at least 2 classes. You only have {presentNames.join(', ')} — add another (open water, in-mat, or out of water).</span>
          )}
        </div>
      </div>
      {result && (
        <div style={{ marginTop: 16 }}>
          <ResultPanel result={result} liveVersion={liveVersion} onPush={onPush} />
        </div>
      )}
    </div>
  );
}

Object.assign(window, { ClassBalanceBar, SpanRow, DatasetZone, ResultPanel, TrainPushZone });
