// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
/* ── Drifter Field Console — app orchestration ──
   Real API wiring against the FastAPI+SQLite rig (api.js). No simulation, no design-review scaffolding
   (the tweaks panel / scenario switcher were review-only and are gone). Everything here polls the SAME
   endpoints the board itself uses. Zones (matching the approved design, prompt-10/11/12): 01 Live now,
   02 Features (live, collapsible), 03 Label, 04 Dataset, 05 Train & push, 06 Models (registry).

   BOARD CLOCK, not wall-clock: every reading is timestamped by the board in seconds-since-boot (`ts`),
   which RESETS on every reboot. Labels are matched to readings by that same clock, so `boardTs` (the
   latest polled reading's ts) is what start/end a label span, NEVER `Date.now()` — using wall-clock here
   was a real bug earlier in this project (labels landed with 0 matching readings).

   Field shape adapters: the approved design's presentational components (ResultPanel, ModelRow, ...) use
   names like `result.val` / `m.dataset.{spans,inSamples,outSamples}` / `m.trainedAt` (invented by the design
   agent's throwaway sim.jsx). The REAL backend returns flat fields (`val_acc`, `n_spans`, `n_in`, `n_out`,
   `created`). adaptTrainResult()/adaptModels() below do that one translation, so the ported components stay
   visually + structurally faithful to the approved design while the numbers are 100% real. */
const { useState, useEffect, useRef, useCallback } = React;

const POLL_MS = 1500;
const MIN_LIVE_SAMPLES = 3; // below this, "tap again" is treated as a misfire, not a real span

function drifterFromUrl() {
  const p = new URLSearchParams(location.search).get('drifter');
  return p && p.trim() ? p.trim() : 'drifter1';
}

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, color = 'var(--olive)') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, { id, text, color }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2800);
  }, []);
  return [toasts, push];
}

// Per-class sample tallies keyed by label int (0/1/2), so a 3rd class (out-of-water) is counted correctly
// instead of silently folding into "open water" the way a binary in/out split would. `classes` counts how
// many DISTINCT classes have any samples -- training needs at least 2 of them.
function datasetStats(spans) {
  const counts = {};   // label int -> sample count
  for (const s of spans) {
    const c = SARG.byLabel(s.label);          // tolerates legacy string labels ('IN'/'OUT')
    const lbl = c ? c.label : s.label;
    counts[lbl] = (counts[lbl] || 0) + s.samples;
  }
  const values = Object.values(counts);
  const total = values.reduce((a, b) => a + b, 0);
  return {
    spans: spans.length, counts, total,
    classes: values.length,
    minorityFrac: total && values.length ? Math.min(...values) / total : 0,
  };
}

// Timestamp-align a reading to the board's OWN verdict at that instant -- a pure lookup against the
// board's immutable detection history (latest detection with ts <= this reading's ts), NEVER a
// re-classification of the raw RGB. Single source of truth stays the board: this only asks "what did the
// model output the last time it ran, at or before this reading was captured" -- the answer for a given
// (reading, detection-history) pair never changes, so recomputing it on each poll is safe, not "drifting
// against a newer model." Returns the class key ('OUT' | 'IN' | 'DRY') or null (no detection at/before it).
function alignModelCall(readingTs, dets) {
  let best = null;
  for (const d of dets) {
    if (d.ts <= readingTs && (best === null || d.ts > best.ts)) best = d;
  }
  if (!best) return null;
  const c = SARG.byLabel(best.state);
  return c ? c.key : null;
}

function adaptTrainResult(r) {
  return {
    version: r.version, val: r.val_acc, separability: r.separability,
    tone: r.tone, headline: r.headline, detail: r.detail,
    dataset: { spans: r.n_spans, counts: r.counts || {} },
  };
}

function adaptModels(raw) {
  // Tolerant of LEGACY rows trained before the model-registry rework (meta lacked tone/headline/n_spans/
  // counts) -- show a neutral placeholder rather than a raw `undefined`, don't crash the registry.
  return {
    liveVersion: raw.live_version,
    models: (raw.models || []).map(m => ({
      version: m.version, trainedAt: m.created * 1000, val: m.val_acc, separability: m.separability,
      tone: m.tone || 'good', headline: m.headline || '(trained before the registry — no verdict recorded)',
      detail: m.detail || '',
      dataset: { spans: m.n_spans ?? '—', counts: m.counts || {} },
      note: m.note || '',
    })),
  };
}

const EMPTY_SENSORS = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];

function App() {
  const drifter = useRef(drifterFromUrl()).current;

  const [buffer, setBuffer] = useState([]);           // recent readings {sensors:[4x3], ts} board-clock
  const [sensors, setSensors] = useState(EMPTY_SENSORS);
  const [present, setPresent] = useState([false, false, false, false]);
  const [verdict, setVerdict] = useState(null);
  const [liveFeatures, setLiveFeatures] = useState(null);
  const [saturated, setSaturated] = useState(false);
  const [battery, setBattery] = useState(null);       // {pct, mv} from the latest detection (null until reported)
  const [tab, setTab] = useState('console');          // 'console' (the training zones) | 'camera'
  const [showFeatures, setShowFeatures] = useState(false);   // hidden by default -- a cleaner console on
                                                              // landing; expand via the "Show live features" button

  const [spans, setSpans] = useState([]);
  const [registry, setRegistry] = useState({ liveVersion: null, models: [] });
  const [result, setResult] = useState(null);         // most recent train() response (client-local only)
  const [training, setTraining] = useState(false);

  const [activeLabel, setActiveLabel] = useState(null);
  const [recCount, setRecCount] = useState(0);
  const [sel, setSel] = useState(null);
  const [newSpanId, setNewSpanId] = useState(null);

  const [toasts, toast] = useToasts();

  const recordStartRef = useRef(null);   // board ts at which the current live-label recording started
  const boardTsRef = useRef(null);

  const refreshLabels = useCallback(async () => {
    setSpans(await API.getLabels(drifter));
  }, [drifter]);
  const refreshRegistry = useCallback(async () => {
    setRegistry(adaptModels(await API.getModels(drifter)));
  }, [drifter]);

  // ── poll loop: readings + detections drive Zones 1/2; labels + models refresh on their own actions
  // too, but are also polled so a second tab / the board's own state stays visible. ──
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const [readings, dets] = await Promise.all([API.getReadings(drifter), API.getDetections(drifter)]);
      if (stop) return;
      if (readings.length) {
        // normalize the API shape ({ts, rgb, wall}) to what Timeline/LiveNow expect, plus the timestamp-
        // aligned model call (what the board's OWN verdict was at this reading's instant -- see
        // alignModelCall's comment for why recomputing this every poll is safe, not "recompute drift").
        const buf = readings.slice(-60).map(r => ({
          ts: r.ts, sensors: r.rgb, wall: r.wall, modelCall: alignModelCall(r.ts, dets),
        }));
        setBuffer(buf);
        const last = buf[buf.length - 1];
        setSensors(last.sensors);
        setPresent(last.sensors.map(s => s[0] + s[1] + s[2] > 0));
        boardTsRef.current = last.ts;
        if (activeLabel && recordStartRef.current != null) {
          setRecCount(buf.filter(r => r.ts >= recordStartRef.current).length);
        }
      }
      if (dets.length) {
        const d = dets[dets.length - 1];
        // board posts state = predicted class int + proba = that winning class's probability (the board's
        // own confidence). Map to the class key for the verdict card; no binary in/out assumption.
        const c = SARG.byLabel(d.state);
        setVerdict({ label: c ? c.key : null, conf: d.proba != null ? d.proba : null });
        setLiveFeatures(d.features || null);
        setSaturated(!!d.saturated);
        setBattery({ pct: d.battery, mv: d.battery_mv });
      }
    };
    tick();
    const iv = setInterval(tick, POLL_MS);
    return () => { stop = true; clearInterval(iv); };
  }, [drifter, activeLabel]);

  useEffect(() => { refreshLabels(); refreshRegistry(); }, [refreshLabels, refreshRegistry]);

  const stats = datasetStats(spans);

  // ── labeling: tap to start recording (board-clock start), tap again to commit the span ──
  const setLabel = async (lbl) => {
    if (lbl === null) {
      const startTs = recordStartRef.current;
      const endTs = boardTsRef.current;
      const count = recCount;
      recordStartRef.current = null;
      setActiveLabel(null);
      if (startTs != null && endTs != null && count >= MIN_LIVE_SAMPLES) {
        const c = SARG.byKey(activeLabel);
        const ok = await API.postLabel(drifter, startTs, endTs, c.label);
        if (ok) {
          setResult(null);
          await refreshLabels();
          toast(`+ span added (${c.name})`, `var(${c.cvar})`);
        } else {
          toast('Could not save the span — try again', 'var(--wine)');
        }
      } else if (startTs != null) {
        toast('Too short — hold the label a moment longer', 'var(--amber)');
      }
      setRecCount(0);
    } else {
      recordStartRef.current = boardTsRef.current;
      setRecCount(0);
      setActiveLabel(lbl);
    }
  };

  const labelSelection = async (label, lo, hi) => {
    if (hi - lo + 1 < MIN_LIVE_SAMPLES) { toast('Select a longer range', 'var(--amber)'); return; }
    const tStart = buffer[lo].ts, tEnd = buffer[hi].ts;
    const c = SARG.byKey(label);
    const ok = await API.postLabel(drifter, tStart, tEnd, c.label);
    if (ok) { setResult(null); await refreshLabels(); toast(`+ span added (${c.name})`, `var(${c.cvar})`); }
    setSel(null);
  };

  const deleteSpan = async (id) => {
    await API.deleteLabel(drifter, id);
    setResult(null);
    await refreshLabels();
  };
  const clearDataset = async () => {
    await API.clearLabels(drifter);
    setResult(null);
    await refreshLabels();
    toast('Dataset cleared', 'var(--wine)');
  };

  // ── train / push (separate steps — see the field brief: don't auto-push a model mid-test) ──
  const doTrain = async () => {
    setTraining(true);
    const r = await API.postTrain(drifter);
    setTraining(false);
    if (!r.ok) { toast(r.detail || 'Train failed', 'var(--amber)'); return; }
    setResult(adaptTrainResult(r));
    await refreshRegistry();
    toast(r.tone === 'good' ? `Trained v${r.version} — ${r.val_acc.toFixed(2)} val` : `Trained v${r.version} — ${r.headline.toLowerCase()}`,
          r.tone === 'good' ? 'var(--sage)' : 'var(--amber)');
  };

  const doPush = async (version) => {
    const r = await API.postPush(drifter, version);
    if (!r.ok) { toast(r.detail || 'Push failed', 'var(--wine)'); return; }
    await refreshRegistry();
    toast(`Pushed model v${version} to board`, 'var(--olive)');
  };

  const doNote = async (version, note) => {
    await API.patchModelNote(drifter, version, note);
    await refreshRegistry();
  };

  return (
    <>
      {/* header */}
      <header className="hdr">
        <span className="hov-mark" />
        <span className="hdr__title">Hover<i>·</i>Drifter Field Console</span>
        <span className="hdr__id mono">{drifter}</span>
        <span className="hdr__spacer" />
        <BatteryPill battery={battery} />
        <nav style={{ display: 'flex', gap: 6, marginLeft: 14 }}>
          {[['console', 'Console'], ['camera', 'Camera']].map(([id, label]) => (
            <button key={id} className={`btn btn--sm ${tab === id ? 'btn--primary' : 'btn--ghost'}`}
                    onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
      </header>

      {tab === 'camera' && <CameraTab drifter={drifter} />}

      {tab === 'console' && (<>
      {/* ZONE 1 — live now */}
      <section className="zone">
        <div className="zone__head">
          <span className="zone__idx">01</span>
          <span className="zone__title">Live now</span>
          <span className="zone__sub">what the board sees this second</span>
        </div>
        <LiveNow sensors={sensors} present={present} verdict={verdict} modelVersion={registry.liveVersion} />
      </section>

      {/* ZONE 2 — live features */}
      {showFeatures ? (
        <section className="zone">
          <div className="zone__head">
            <span className="zone__idx">02</span>
            <span className="zone__title">Features (live)</span>
            <span className="zone__sub">what the board computes from the sensors each cycle</span>
            <span style={{ flex: 1 }} />
            <button className="btn btn--sm btn--ghost" onClick={() => setShowFeatures(false)}>Hide</button>
          </div>
          <FeaturesZone features={liveFeatures} saturated={saturated} />
        </section>
      ) : (
        <div style={{ marginTop: 14 }}>
          <button className="btn btn--sm btn--ghost" onClick={() => setShowFeatures(true)}>
            Show live features ↓
          </button>
        </div>
      )}

      {/* ZONE 3 — label */}
      <section className="zone">
        <div className="zone__head">
          <span className="zone__idx">03</span>
          <span className="zone__title">Label</span>
          <span className="zone__sub">attach ground truth to readings</span>
        </div>
        <div className="card">
          <LabelToggle active={activeLabel} recCount={recCount} onSet={setLabel} />
          <div style={{ height: 1, background: 'var(--hair-1)', margin: '16px 0' }} />
          <Timeline buffer={buffer} sel={sel} onSelChange={setSel} onLabel={labelSelection} />
        </div>
      </section>

      {/* ZONE 4 — dataset */}
      <section className="zone">
        <div className="zone__head">
          <span className="zone__idx">04</span>
          <span className="zone__title">Dataset</span>
          <span className="zone__sub">everything Train will learn from</span>
        </div>
        <DatasetZone spans={spans} stats={stats} newSpanId={newSpanId} onDelete={deleteSpan} onClear={clearDataset} />
      </section>

      {/* ZONE 5 — train & push */}
      <section className="zone">
        <div className="zone__head">
          <span className="zone__idx">05</span>
          <span className="zone__title">Train &amp; push</span>
          <span className="zone__sub">see the result before it hits the board</span>
        </div>
        <TrainPushZone stats={stats} result={result} training={training} liveVersion={registry.liveVersion}
                       onTrain={doTrain} onPush={doPush} />
      </section>

      {/* ZONE 6 — model registry */}
      <section className="zone">
        <div className="zone__head">
          <span className="zone__idx">06</span>
          <span className="zone__title">Models</span>
          <span className="zone__sub">every training run — push any of them</span>
        </div>
        <ModelsZone models={registry.models} liveVersion={registry.liveVersion} onPush={doPush} onNote={doNote} />
      </section>
      </>)}

      {/* toasts */}
      <div className="toast-wrap">
        {toasts.map(t2 => (
          <div key={t2.id} className="toast">
            <span className="dot" style={{ background: t2.color }} />
            {t2.text}
          </div>
        ))}
      </div>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
