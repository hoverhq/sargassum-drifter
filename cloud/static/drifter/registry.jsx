// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
/* ── ZONE 06 — Models: registry of every training run ──
   Ported from the Hover design project. Every train() call persists a new model server-side (never
   overwritten); push only moves which version the board pulls, so any past model (even one never
   previously live) can be re-pushed -- e.g. reverting to a model that tested better in the field. */

function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h + ' h ago';
}

function ModelNote({ note, onSave }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(note || '');
  const save = () => { onSave(draft.trim()); setEditing(false); };
  if (editing) {
    return (
      <input
        autoFocus type="text" value={draft} placeholder="why this model? how did it do?"
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setDraft(note || ''); setEditing(false); } }}
        style={{
          width: '100%', background: 'var(--bg-0)', border: '1px solid var(--olive)',
          borderRadius: 4, padding: '4px 8px', color: 'var(--t-1)',
          fontSize: 'var(--text-sm)', outline: 'none',
          boxShadow: '0 0 0 3px rgba(184,176,106,0.10)',
        }}
      />
    );
  }
  return note ? (
    <button
      onClick={() => { setDraft(note); setEditing(true); }}
      title="Edit note"
      style={{
        background: 'transparent', border: 0, padding: 0, textAlign: 'left',
        fontSize: 'var(--text-sm)', color: 'var(--t-2)', fontStyle: 'italic',
        display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
      }}>
      <span style={{ color: 'var(--olive-dim)', flex: 'none', fontStyle: 'normal' }}>✎</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>“{note}”</span>
    </button>
  ) : (
    <button
      onClick={() => { setDraft(''); setEditing(true); }}
      style={{
        background: 'transparent', border: 0, padding: 0,
        fontSize: 'var(--text-xs)', color: 'var(--t-4)',
        display: 'inline-flex', alignItems: 'center', gap: 5,
      }}
      onMouseEnter={e => e.currentTarget.style.color = 'var(--olive-text)'}
      onMouseLeave={e => e.currentTarget.style.color = 'var(--t-4)'}>
      <span>✎</span> add note
    </button>
  );
}

function ModelRow({ m, isLive, onPush, onNote }) {
  const good = m.tone === 'good';
  return (
    <div className="model-row" style={{
      padding: '11px 12px',
      borderRadius: 6,
      border: '1px solid ' + (isLive ? 'rgba(184,176,106,0.30)' : 'var(--hair-1)'),
      background: isLive ? 'rgba(184,176,106,0.05)' : 'transparent',
      marginBottom: 8,
    }}>
      {/* version + when */}
      <div>
        <div className="mono" style={{ fontSize: 'var(--text-lg)', fontWeight: 500, color: isLive ? 'var(--olive)' : 'var(--t-1)' }}>v{m.version}</div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--t-4)' }}>{relTime(m.trainedAt)}</div>
      </div>
      {/* val + separability */}
      <div className="mono">
        <div style={{ fontSize: 'var(--text-lg)', color: 'var(--t-1)' }}>{m.val.toFixed(2)} <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--t-4)', letterSpacing: '0.1em' }}>VAL</span></div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--t-3)' }}>sep {m.separability.toFixed(2)}</div>
      </div>
      {/* tone chip */}
      <span className="pill" style={good
        ? { background: '#132018', color: 'var(--sage)', justifySelf: 'start' }
        : { background: 'rgba(179,135,61,0.10)', color: 'var(--amber-text)', border: '1px solid rgba(179,135,61,0.3)', justifySelf: 'start' }}>
        <span className="dot" style={{ background: good ? 'var(--green)' : 'var(--amber)' }} />
        {good ? 'good' : 'flagged'}
      </span>
      {/* dataset + note */}
      <div style={{ minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-3)' }}>
          {m.dataset.spans} spans
          {SARG.classes.filter(c => ((m.dataset.counts || {})[c.label] || 0) > 0).map(c => (
            <React.Fragment key={c.key}> · <span style={{ color: `var(${c.cvar})` }}>{m.dataset.counts[c.label]} {c.short}</span></React.Fragment>
          ))}
        </div>
        <div style={{ marginTop: 3 }}>
          <ModelNote note={m.note} onSave={txt => onNote(m.version, txt)} />
        </div>
      </div>
      {/* action */}
      {isLive ? (
        <span className="pill green"><span className="dot" style={{ animation: 'pulseDot 1.6s infinite' }} />live on board</span>
      ) : (
        <button className="btn btn--sm" onClick={() => onPush(m.version)}>Push to board</button>
      )}
    </div>
  );
}

function ModelsZone({ models, liveVersion, onPush, onNote }) {
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <span className="eyebrow">Model registry</span>
        {models.length > 0 && (
          <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-4)' }}>{models.length} trained</span>
        )}
      </div>
      {models.length === 0 ? (
        <div style={{
          borderRadius: 8, border: '1px dashed var(--hair-3)', background: 'var(--bg-1)',
          padding: '26px 20px', textAlign: 'center',
          fontSize: 'var(--text-base)', color: 'var(--t-3)',
        }}>
          No models yet — train one above to start the registry.
        </div>
      ) : (
        <div>
          {[...models].sort((a, b) => b.version - a.version).map(m => (
            <ModelRow key={m.version} m={m} isLive={m.version === liveVersion} onPush={onPush} onNote={onNote} />
          ))}
          <div style={{ marginTop: 6, fontSize: 'var(--text-sm)', color: 'var(--t-3)' }}>
            Every training run is kept. Push any of them — the board just re-points, so you can fall back to an older model if a new one disappoints.
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { relTime, ModelNote, ModelRow, ModelsZone });
