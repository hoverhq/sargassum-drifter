// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
/* ── Wave-tank tab: live bench calibration ──
   A bench rig drives a physical wave maker at a commanded height/period; the board reports back its own
   significant-wave-height (Hs) and peak-period (Tp) estimates over a WebSocket. This tab overlays the
   board's live estimates against the operator's commanded ground truth so the on-board estimator can be
   tuned in the loop.

   TWO CLOCKS collapse to one here: every telemetry frame is stamped with the SERVER receipt time (the
   board's own clock is untrusted and resets on reboot — the server injects `ts` on the /ws/board hop), so
   the whole tab plots that single server `ts`. Live frames arrive on /ws/ui; history is seeded once on
   mount from /api/wave-readings so the charts are populated before the socket's first frame.

   Charts are hand-rolled inline SVG (no chart lib): a fixed 1000-wide viewBox scaled to the container via
   preserveAspectRatio="none", so no element measurement / ResizeObserver is needed. The presentation —
   info tooltips, the stat grid, the hover cursor/tooltip on the charts, and the param rows — is the
   cleaned-up console styling; the numbers behind it are all real board telemetry. */
const { useState, useEffect, useRef, useCallback, useMemo } = React;

const READINGS_CAP = 7200;   // ~1 h at 2 Hz
const HEAVE_CAP = 1200;      // ~2 min at 10 Hz (5 heave samples per 2 Hz frame)
const HEAVE_WINDOW = 600;    // last ~60 s drawn in the heave strip
const RECONNECT_MS = 2000;
const ACK_KEEP = 40;         // ack ring; the log renders the last 8

// sarg verdict codes reported in every frame's `sarg.c`.
const SARG_VERDICT = {
  0: { label: 'OPEN WATER', cls: 'neutral' },
  1: { label: 'IN MAT', cls: 'green' },
  2: { label: 'OUT OF WATER', cls: 'wine' },
  255: { label: 'WARMING UP', cls: 'neutral' },
};

// Normalize a seeded REST row ({ts, hs_mm, tp_ds, raw:{…board fields}}) into the same flat shape a live WS
// `reading` frame carries, keyed on the SERVER ts so seeded + live frames plot on one timeline.
function normReading(row) {
  return { ...(row.raw || {}), ts: row.ts, hs_mm: row.hs_mm, tp_ds: row.tp_ds };
}

function ringPush(arr, item, cap) {
  const next = arr.concat([item]);
  return next.length > cap ? next.slice(next.length - cap) : next;
}
function ringExtend(arr, items, cap) {
  const next = arr.concat(items);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

// ── live socket: seed history, then open /ws/ui and append. Auto-reconnects on close. ──
function useWaveSocket(drifter) {
  const [readings, setReadings] = useState([]);
  const [heave, setHeave] = useState([]);
  const [runs, setRuns] = useState([]);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(0);
  const [acks, setAcks] = useState([]);
  const wsRef = useRef(null);

  const appendReading = useCallback((r) => {
    setReadings(prev => ringPush(prev, r, READINGS_CAP));
    if (Array.isArray(r.heave) && r.heave.length) {
      setHeave(prev => ringExtend(prev, r.heave, HEAVE_CAP));
    }
  }, []);

  useEffect(() => {
    let closed = false;

    const dispatch = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      switch (msg.type) {
        case 'reading': appendReading(msg); break;
        case 'ack':
          setAcks(prev => ringPush(prev, { ...msg, at: Date.now() }, ACK_KEEP));
          break;
        case 'board': setConnected(!!msg.connected); break;
        case 'pending': setPending(msg.count || 0); break;
        default: break;
      }
    };

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws/ui?drifter=${encodeURIComponent(drifter)}&token=${encodeURIComponent(TOKEN)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onmessage = (ev) => dispatch(ev.data);
      ws.onclose = () => {
        if (closed) return;
        setConnected(false);
        setTimeout(connect, RECONNECT_MS);   // no-op if unmounted (closed guard prevents duplicate connect)
      };
      ws.onerror = () => { try { ws.close(); } catch (e) { /* onclose handles reconnect */ } };
    };

    // seed history first, THEN open the live socket so the initial replace can't clobber a live frame
    (async () => {
      const [rows, r] = await Promise.all([
        API.getWaveReadings(drifter, Date.now() / 1000 - 3600),
        API.getWaveRuns(drifter),
      ]);
      if (closed) return;
      const norm = rows.map(normReading);
      setReadings(norm.slice(-READINGS_CAP));
      const flat = [];
      for (const rr of norm) if (Array.isArray(rr.heave)) for (const h of rr.heave) flat.push(h);
      setHeave(flat.slice(-HEAVE_CAP));
      setRuns(r);
      connect();
    })();

    return () => {
      closed = true;
      if (wsRef.current) { try { wsRef.current.close(); } catch (e) { /* unmounting */ } }
    };
  }, [drifter, appendReading]);

  // Poll the run list so runs started/stopped OUTSIDE this page (the wave-command API, another
  // browser tab) show up without a reload — the live WS carries readings/acks but has no
  // run-change event, so without this the badge + ground-truth overlay go stale-until-reload.
  useEffect(() => {
    const t = setInterval(() => {
      API.getWaveRuns(drifter).then(setRuns).catch(() => { /* transient; next tick retries */ });
    }, 8000);
    return () => clearInterval(t);
  }, [drifter]);

  // refetch runs after a start/stop so the badge + chart overlay reflect it immediately (the server owns
  // run rows; the board only echoes the start-run command).
  const refreshRuns = useCallback(async () => {
    setRuns(await API.getWaveRuns(drifter));
  }, [drifter]);

  return { readings, heave, runs, connected, pending, acks, refreshRuns };
}

// ─────────────────────────────────────────────────────────────
// INFO BADGE — explanatory tooltip on hover/focus
// ─────────────────────────────────────────────────────────────
function WtInfo({ tip }) {
  return (
    <span className="wt-info" tabIndex={0} role="img" aria-label={tip}>
      i<span className="wt-info__pop">{tip}</span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// HEAVE STRIP — last ~60 s of raw 10 Hz vertical accel
// ─────────────────────────────────────────────────────────────
function HeaveStrip({ samples }) {
  const W = 1000, H = 120, padT = 8, padB = 8;
  const win = samples.slice(-HEAVE_WINDOW);
  // ±0.5 m/s² minimum half-span so a calm sea doesn't blow the scale up to noise.
  let maxAbs = 0;
  for (const v of win) { const a = Math.abs(v); if (a > maxAbs) maxAbs = a; }
  const half = Math.max(0.5, maxAbs);
  const yOf = (v) => {
    const mid = (H - padT - padB) / 2 + padT;
    return mid - (v / half) * ((H - padT - padB) / 2);
  };
  const xOf = (i) => win.length <= 1 ? 0 : (i / (win.length - 1)) * W;
  const pts = win.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
  const zeroY = yOf(0).toFixed(1);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
        <span className="eyebrow">Heave · raw vertical accel (10 Hz)</span>
        <WtInfo tip="Raw vertical acceleration sampled at 10 Hz — the signal everything else is derived from. The board band-passes and integrates this into the wave spectrum used for Hs and Tp." />
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-4)' }}>±{half.toFixed(2)} m/s²</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
           style={{ width: '100%', height: 96, display: 'block' }}>
        <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="var(--hair-3)" strokeWidth="1" />
        {win.length > 1 && (
          <polyline points={pts} fill="none" stroke="var(--sage)" strokeWidth="1.4"
                    vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        )}
        {win.length <= 1 && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fill="var(--t-4)" fontSize="13"
                fontFamily="'JetBrains Mono', monospace">waiting for heave…</text>
        )}
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Hs / Tp CHART — two stacked panels on a shared session-time x-axis
// ─────────────────────────────────────────────────────────────
const CHART_W = 1000;
const RANGES = [['10m', 10], ['30m', 30], ['1h', 60]];

// Relative x-axis label for a "minutes back from now" tick (e.g. -30m). Integers render clean; a custom
// fractional window keeps one decimal.
function fmtRange(min) {
  if (min <= 0) return 'now';
  const m = min >= 10 ? Math.round(min) : Math.round(min * 10) / 10;
  return `-${m}m`;
}

// Relative hover label from a reading's age in seconds: "now" at the leading edge, "-m:ss ago" behind it.
function fmtAgo(secAgo) {
  secAgo = Math.max(0, Math.round(secAgo));
  if (secAgo === 0) return 'now';
  const m = Math.floor(secAgo / 60), s = secAgo % 60;
  return `-${m}:${String(s).padStart(2, '0')} ago`;
}

// One panel: an off-SVG y-axis column + a hover-tracked plot with faint y-grid, run-span shading, a
// dashed commanded ground-truth overlay held flat across each run's [started, stopped||now] span, and the
// board estimate as a gapped polyline (valueOf() returns null wherever there is no value — Tp==0 gated =
// a GAP, NOT a plunge to zero). The x-axis maps the real server `ts`; hover snaps to the nearest reading
// and reports both the board estimate and the commanded value at that instant.
function ChartPanel({ label, unit, tip, readings, runs, tMin, tMax, now, windowMin, valueOf, truthOf, fmt, yMinFloor }) {
  const H = 180, padT = 12, padB = 10;
  const [hover, setHover] = useState(null);

  const span = tMax > tMin ? tMax - tMin : 1;
  const xOf = (ts) => ((ts - tMin) / span) * CHART_W;
  const cx = (x) => Math.max(0, Math.min(CHART_W, x));   // clamp run overlay to the visible window

  // y-domain over both the board series and the commanded truth so neither clips.
  let vMax = yMinFloor;
  for (const r of readings) { const v = valueOf(r); if (v != null && v > vMax) vMax = v; }
  for (const run of runs) { const v = truthOf(run); if (v != null && v > vMax) vMax = v; }
  vMax = vMax * 1.15 || 1;
  const yOf = (v) => (H - padB) - (v / vMax) * (H - padT - padB);

  // board series, broken into segments wherever valueOf() returns null.
  const segs = [];
  let cur = [];
  for (const r of readings) {
    const v = valueOf(r);
    if (v == null) { if (cur.length) { segs.push(cur); cur = []; } continue; }
    cur.push(`${xOf(r.ts).toFixed(1)},${yOf(v).toFixed(1)}`);
  }
  if (cur.length) segs.push(cur);

  // commanded value active at a given server ts (the run whose span brackets it), or null.
  const commandedAt = (ts) => {
    let v = null;
    for (const run of runs) {
      const s = run.started_ts, e = run.stopped_ts != null ? run.stopped_ts : now;
      if (ts >= s && ts <= e) { const tv = truthOf(run); if (tv != null) v = tv; }
    }
    return v;
  };

  const onMove = (e) => {
    if (!readings.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const tsHover = tMin + f * span;
    // snap to the nearest reading so the cursor + dot land on real data
    let best = readings[0], bd = Math.abs(readings[0].ts - tsHover);
    for (const r of readings) { const d = Math.abs(r.ts - tsHover); if (d < bd) { bd = d; best = r; } }
    const estVal = valueOf(best);
    setHover({
      xPct: (xOf(best.ts) / CHART_W) * 100,
      agoLabel: fmtAgo(now - best.ts),
      estVal,
      estYPct: estVal != null ? (yOf(estVal) / H) * 100 : null,
      cmdVal: commandedAt(best.ts),
    });
  };

  const yTicks = [vMax, vMax / 2, 0];
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="eyebrow">{label}</span>
        <span className="mono" style={{ fontSize: 'var(--text-2xs)', color: 'var(--t-4)' }}>{unit}</span>
        {tip && <WtInfo tip={tip} />}
        <span style={{ flex: 1 }} />
        <span className="wt-legend"><i className="wt-li wt-li--est" /> board estimate</span>
        <span className="wt-legend"><i className="wt-li wt-li--cmd" /> commanded</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr', gap: 8, marginTop: 8 }}>
        <div className="mono wt-axis" style={{ height: H }}>
          {yTicks.map((t, i) => <span key={i}>{fmt(t)}</span>)}
        </div>
        <div className="wt-plot" style={{ height: H }}
             onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${CHART_W} ${H}`} preserveAspectRatio="none"
               style={{ width: '100%', height: H, display: 'block' }}>
            {/* y gridlines */}
            {yTicks.map((t, i) => (
              <line key={i} x1="0" y1={yOf(t)} x2={CHART_W} y2={yOf(t)} stroke="var(--hair-1)" strokeWidth="1" />
            ))}
            {/* run-span shading (clamped to the visible window) */}
            {runs.map(run => {
              const x0 = cx(xOf(run.started_ts));
              const x1 = cx(xOf(run.stopped_ts != null ? run.stopped_ts : now));
              if (x1 <= x0) return null;
              return <rect key={run.id} x={x0} y={padT} width={x1 - x0} height={H - padT - padB}
                           fill="var(--olive)" opacity="0.06" />;
            })}
            {/* commanded ground-truth: flat dashed across each run's [started, stopped||now] span */}
            {runs.map(run => {
              const v = truthOf(run);
              if (v == null) return null;
              const x0 = cx(xOf(run.started_ts));
              const x1 = cx(xOf(run.stopped_ts != null ? run.stopped_ts : now));
              if (x1 <= x0) return null;
              return <line key={run.id} x1={x0} y1={yOf(v)} x2={x1} y2={yOf(v)} stroke="var(--olive)"
                           strokeWidth="1.4" strokeDasharray="7 6" vectorEffect="non-scaling-stroke" />;
            })}
            {/* board estimate, gapped */}
            {segs.map((seg, i) => seg.length >= 2
              ? <polyline key={i} points={seg.join(' ')} fill="none" stroke="var(--sage)" strokeWidth="1.6"
                          vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              : <circle key={i} cx={seg[0].split(',')[0]} cy={seg[0].split(',')[1]} r="1.8" fill="var(--sage)" />)}
          </svg>
          {hover && (
            <>
              <div className="wt-cursor" style={{ left: `${hover.xPct}%` }} />
              {hover.estYPct != null && (
                <div className="wt-dot" style={{ left: `${hover.xPct}%`, top: `${hover.estYPct}%` }} />
              )}
              <div className="wt-tip" style={{ left: `${hover.xPct}%`,
                   transform: `translate(${hover.xPct > 60 ? 'calc(-100% - 12px)' : '12px'}, -50%)`,
                   top: `${hover.estYPct != null ? hover.estYPct : 50}%` }}>
                <div className="wt-tip__t mono">{hover.agoLabel}</div>
                <div className="wt-tip__row"><i className="wt-li wt-li--est" /><span>estimate</span>
                  <b className="mono">{hover.estVal != null ? `${fmt(hover.estVal)} ${unit}` : '—'}</b></div>
                <div className="wt-tip__row"><i className="wt-li wt-li--cmd" /><span>commanded</span>
                  <b className="mono">{hover.cmdVal != null ? `${fmt(hover.cmdVal)} ${unit}` : '—'}</b></div>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="mono wt-xaxis" style={{ marginLeft: 60 }}>
        <span>{fmtRange(windowMin)}</span>
        <span>{fmtRange(windowMin / 2)}</span>
        <span>now</span>
      </div>
    </div>
  );
}

function HsTpChart({ readings, runs, now }) {
  const [range, setRange] = useState('30m');
  const [customMin, setCustomMin] = useState('45');
  const sortedRuns = useMemo(() => [...runs].sort((a, b) => a.started_ts - b.started_ts), [runs]);
  // Commanded (yellow) overlay + run-span shading show ONLY while a bench run is actively running —
  // a run with no stopped_ts. Once you Stop the run, the ground-truth line clears. (Only one run is
  // ever active at a time.)
  const activeRuns = useMemo(() => sortedRuns.filter(r => r.stopped_ts == null), [sortedRuns]);
  const cm = parseFloat(customMin);
  const rangeMin = range === 'custom'
    ? (cm >= 1 ? cm : 30)                                  // guard: <1 or NaN → default 30
    : ({ '10m': 10, '30m': 30, '1h': 60 })[range];
  if (!readings.length) {
    return (
      <div className="card" style={{ textAlign: 'center', color: 'var(--t-3)', fontSize: 'var(--text-sm)', padding: '28px', marginBottom: 14 }}>
        Waiting for wave telemetry… start the bench rig and its board.
      </div>
    );
  }
  // window the plotted data by REAL server ts (not sample count): the visible domain is the last
  // `rangeMin` minutes, so the relative x-axis labels (-Nm … now) stay honest as cadence varies or gaps.
  const tMax = now;
  const tMin = now - rangeMin * 60;
  const visible = readings.filter(r => r.ts >= tMin);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="wt-rangebar">
        <span className="eyebrow">Time range</span>
        <span className="scn" role="tablist">
          {RANGES.map(([k]) => (
            <button key={k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{k}</button>
          ))}
          <button className={range === 'custom' ? 'on' : ''} onClick={() => setRange('custom')}>Custom</button>
        </span>
        {range === 'custom' && (
          <label className="wt-custom mono">
            <input type="text" inputMode="decimal" value={customMin}
                   onChange={e => setCustomMin(e.target.value)} />
            <span>min</span>
          </label>
        )}
      </div>
      <ChartPanel label="Significant wave height (Hs)" unit="mm"
                  tip="The board's estimate of significant wave height, in millimetres. Solid line is what the board reports; the dashed line is the height you commanded from the maker. Watch how fast the estimate settles onto the commanded value."
                  readings={visible} runs={activeRuns} tMin={tMin} tMax={tMax} now={now} windowMin={rangeMin}
                  yMinFloor={10} fmt={v => v.toFixed(0)}
                  valueOf={r => (typeof r.hs_mm === 'number' ? r.hs_mm : null)}
                  truthOf={run => run.h_mm} />
      <div style={{ height: 1, background: 'var(--hair-1)', margin: '16px 0' }} />
      <ChartPanel label="Peak period (Tp)" unit="s"
                  tip="The dominant wave period the board locks onto, in seconds. It reads 0 (a gap) whenever the spectral peak is below the prominence gate — no confident period to report."
                  readings={visible} runs={activeRuns} tMin={tMin} tMax={tMax} now={now} windowMin={rangeMin}
                  yMinFloor={1} fmt={v => v.toFixed(1)}
                  valueOf={r => (r.tp_ds > 0 ? r.tp_ds / 10 : null)}
                  truthOf={run => (run.t_ds > 0 ? run.t_ds / 10 : null)} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// STATUS + STATS — board presence + link/power/estimator health
// ─────────────────────────────────────────────────────────────
function WtStat({ label, children, tone }) {
  return (
    <div className="wt-stat" data-tone={tone || ''}>
      <span className="eyebrow">{label}</span>
      <span className="mono wt-stat__v">{children}</span>
    </div>
  );
}

function StatusHealth({ reading, connected, lastTs, now }) {
  const r = reading || {};
  const age = lastTs ? Math.max(0, now - lastTs) : null;
  const promLow = typeof r.prom === 'number' && typeof r.prom_min === 'number' && r.prom < r.prom_min;
  const verdict = SARG_VERDICT[r.sarg ? r.sarg.c : undefined] || { label: '—', cls: 'neutral' };
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {connected
          ? <span className="pill green"><span className="dot" style={{ animation: 'pulseDot 1.6s infinite' }} />board online</span>
          : <span className="pill wine"><span className="dot" />board offline</span>}
        <span style={{ color: 'var(--t-3)', fontSize: 'var(--text-md)' }}>
          {age == null ? 'no frame yet' : `last frame ${age.toFixed(0)}s ago`}
        </span>
        <span style={{ flex: 1 }} />
        <span className={`pill ${verdict.cls}`}><span className="dot" />{verdict.label}</span>
      </div>
      <div className="wt-stats">
        <WtStat label="Fill">{r.fill != null && r.wave_n ? `${Math.min(100, Math.round((r.fill / r.wave_n) * 100))}%` : '—'}</WtStat>
        <WtStat label="Prominence" tone={promLow ? 'warn' : ''}>
          {r.prom != null ? `${r.prom.toFixed(2)} / ${r.prom_min != null ? r.prom_min : '—'}` : '—'}
        </WtStat>
        <WtStat label="RSSI">{r.rssi != null ? `${r.rssi} dBm` : '—'}</WtStat>
        <WtStat label="Heap">{r.heap != null ? `${(r.heap / 1024).toFixed(0)}k` : '—'}</WtStat>
        <WtStat label="Battery">{r.batt_mv != null ? `${(r.batt_mv / 1000).toFixed(2)}V` : '—'}</WtStat>
      </div>
      {promLow && (
        <div className="wt-warn">
          <span style={{ color: 'var(--wine)' }}>▲</span>
          Prominence is below the gate — the peak is too weak to lock a period, so Tp reads 0 (gapped above).
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// RUN PANEL — bracket a bench session at a commanded height/period
// ─────────────────────────────────────────────────────────────
function RunPanel({ drifter, runs, onChanged }) {
  const [hMm, setHMm] = useState('120');
  const [tSec, setTSec] = useState('1.5');
  const [busy, setBusy] = useState(false);
  const active = runs.find(r => r.stopped_ts == null);

  const start = async () => {
    const h = parseInt(hMm, 10);
    const tDs = Math.round(parseFloat(tSec) * 10);   // seconds → deciseconds for the wire/board
    if (!(h > 0) || !(tDs > 0)) return;
    setBusy(true);
    await API.startWaveRun(drifter, h, tDs);
    await onChanged();
    setBusy(false);
  };
  const stop = async () => {
    setBusy(true);
    await API.stopWaveRun(drifter);
    await onChanged();
    setBusy(false);
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span className="eyebrow">Bench run</span>
        <span style={{ flex: 1 }} />
        {active
          ? <span className="pill green"><span className="dot" style={{ animation: 'pulseDot 1.4s infinite' }} />
              running · {active.h_mm} mm / {(active.t_ds / 10).toFixed(1)} s</span>
          : <span className="pill neutral"><span className="dot" />idle</span>}
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
        <label className="wt-field">
          <span>Height H (mm) <WtInfo tip="Wave height to command from the maker, in millimetres. This becomes the dashed ground-truth line on the Hs chart." /></span>
          <input className="mono" type="text" inputMode="decimal" value={hMm}
                 onChange={e => setHMm(e.target.value)} disabled={!!active} />
        </label>
        <label className="wt-field">
          <span>Period T (s) <WtInfo tip="Wave period to command from the maker, in seconds. This becomes the dashed ground-truth line on the Tp chart." /></span>
          <input className="mono" type="text" inputMode="decimal" value={tSec}
                 onChange={e => setTSec(e.target.value)} disabled={!!active} />
        </label>
        {active
          ? <button className="btn btn--danger" disabled={busy} onClick={stop}>{busy ? 'Stopping…' : 'Stop run'}</button>
          : <button className="btn btn--primary" disabled={busy} onClick={start}>{busy ? 'Starting…' : 'Start run'}</button>}
      </div>
      <p style={{ fontSize: 'var(--text-md)', color: 'var(--t-3)', marginTop: 16, marginBottom: 0 }}>
        Start commands the maker (<span className="mono">start-run H T</span>) and brackets this session so
        the charts can overlay the board's estimate against what you commanded.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16, borderTop: '1px solid var(--hair-1)', paddingTop: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--text-md)', color: 'var(--t-2)' }}>
          Board screen <WtInfo tip="Turn this board's OLED panel on or off over WiFi. The setting persists across reboots — a board set off comes back up dark." />
        </span>
        <button className="btn btn--sm" onClick={() => API.sendWaveCommand(drifter, 'oled on')}>On</button>
        <button className="btn btn--sm" onClick={() => API.sendWaveCommand(drifter, 'oled off')}>Off</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PARAM PANEL — remote-tune the board's on-board wave estimator
// ─────────────────────────────────────────────────────────────
const WAVE_N_OPTS = [1024, 2048, 4096];
const TP_N_OPTS = [5, 9, 15];

function ackMatches(ack, key, cmd) {
  const c = ack && ack.cmd;
  if (!c) return false;
  return c === cmd || (c.indexOf('set-param') !== -1 && c.indexOf(key) !== -1);
}

function WtParam({ label, keyname, boardVal, control, pending, onSet, tip }) {
  return (
    <div className="wt-param">
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-base)', color: 'var(--t-1)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>{label} <span className="mono" style={{ color: 'var(--t-4)', fontSize: 'var(--text-xs)' }}>({keyname})</span></span>
          {tip && <WtInfo tip={tip} />}
        </div>
        <div className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-3)', marginTop: 2 }}>
          board: <span style={{ color: 'var(--t-2)' }}>{boardVal == null ? '—' : boardVal}</span>
        </div>
      </div>
      <span style={{ flex: 1 }} />
      {control}
      {pending && <span className="pill neutral"><span className="dot" style={{ animation: 'pulseDot 1.2s infinite' }} />pending</span>}
      <button className="btn btn--sm" onClick={onSet}>Set</button>
    </div>
  );
}

function ParamPanel({ drifter, reading, acks }) {
  const cur = reading || {};
  const [waveN, setWaveN] = useState(2048);
  const [tpN, setTpN] = useState(9);
  const [promMin, setPromMin] = useState('');
  const [flo, setFlo] = useState('');
  const [fhi, setFhi] = useState('');
  const [pending, setPending] = useState({});   // key -> sent cmd string
  const lastAckAt = useRef(0);

  // clear a pending badge when a matching ack lands (each ack arrives once; only inspect the newest).
  useEffect(() => {
    const last = acks[acks.length - 1];
    if (!last || last.at === lastAckAt.current) return;
    lastAckAt.current = last.at;
    setPending(p => {
      const next = { ...p };
      let changed = false;
      for (const key of Object.keys(next)) {
        if (ackMatches(last, key, next[key])) { delete next[key]; changed = true; }
      }
      return changed ? next : p;
    });
  }, [acks]);

  const doSet = async (key, value) => {
    if (value === '' || value == null) return;
    const cmd = `set-param ${key} ${value}`;
    setPending(p => ({ ...p, [key]: cmd }));
    await API.sendWaveCommand(drifter, cmd);
  };

  const recent = acks.slice(-8).reverse();
  return (
    <div className="card">
      <span className="eyebrow">Board params · retune the on-board estimator live</span>
      <div style={{ marginTop: 8 }}>
        <WtParam label="FFT window" keyname="wave_n" boardVal={cur.wave_n}
          pending={!!pending.wave_n} onSet={() => doSet('wave_n', waveN)}
          tip="Number of samples per FFT. Larger windows give finer frequency (period) resolution but respond more slowly to change."
          control={
            <select className="cam-res mono" value={waveN} onChange={e => setWaveN(+e.target.value)}>
              {WAVE_N_OPTS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>} />
        <WtParam label="Tp median taps" keyname="tp_n" boardVal={cur.tp_n}
          pending={!!pending.tp_n} onSet={() => doSet('tp_n', tpN)}
          tip="Length of the median filter smoothing the peak-period output. More taps steadies Tp but adds lag."
          control={
            <select className="cam-res mono" value={tpN} onChange={e => setTpN(+e.target.value)}>
              {TP_N_OPTS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>} />
        <WtParam label="Min prominence" keyname="prom_min" boardVal={cur.prom_min}
          pending={!!pending.prom_min} onSet={() => doSet('prom_min', promMin)}
          tip="Gate on spectral peak strength. A peak weaker than this is ignored and Tp reads 0 — raise it to reject noise, lower it to lock onto faint swell."
          control={<input className="wt-num mono" type="text" inputMode="decimal"
                          placeholder={cur.prom_min != null ? String(cur.prom_min) : ''}
                          value={promMin} onChange={e => setPromMin(e.target.value)} />} />
        <WtParam label="Band low" keyname="flo, Hz" boardVal={cur.flo}
          pending={!!pending.flo} onSet={() => doSet('flo', flo)}
          tip="Low edge of the band-pass, in hertz. Frequencies below this are discarded — trims drift and slow tilt."
          control={<input className="wt-num mono" type="text" inputMode="decimal"
                          placeholder={cur.flo != null ? String(cur.flo) : ''}
                          value={flo} onChange={e => setFlo(e.target.value)} />} />
        <WtParam label="Band high" keyname="fhi, Hz" boardVal={cur.fhi}
          pending={!!pending.fhi} onSet={() => doSet('fhi', fhi)}
          tip="High edge of the band-pass, in hertz. Frequencies above this are discarded — rejects chop and sensor noise."
          control={<input className="wt-num mono" type="text" inputMode="decimal"
                          placeholder={cur.fhi != null ? String(cur.fhi) : ''}
                          value={fhi} onChange={e => setFhi(e.target.value)} />} />
      </div>
      <div style={{ marginTop: 18 }}>
        <span className="eyebrow">Ack log</span>
        <div style={{ marginTop: 6, maxHeight: 132, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {recent.length === 0
            ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--t-4)' }}>no acks yet</span>
            : recent.map((a, i) => (
                <div key={i} className="mono" style={{ fontSize: 'var(--text-2xs)', color: 'var(--t-3)',
                     display: 'flex', gap: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span style={{ color: 'var(--olive-text)' }}>{a.cmd || '?'}</span>
                  <span style={{ color: 'var(--t-2)' }}>→ {a.reply != null ? String(a.reply) : 'ok'}</span>
                </div>
              ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// TAB
// ─────────────────────────────────────────────────────────────
function WaveTankTab({ drifter }) {
  const { readings, heave, runs, connected, pending, acks, refreshRuns } = useWaveSocket(drifter);
  const [now, setNow] = useState(Date.now() / 1000);

  useEffect(() => {   // 1 s clock: run spans extend to "now" and the last-frame age counts up
    const iv = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(iv);
  }, []);

  const latest = readings.length ? readings[readings.length - 1] : null;
  const lastTs = latest ? latest.ts : null;

  return (
    <section className="zone">
      <div className="zone__head">
        <span className="zone__idx">08</span>
        <span className="zone__title">Wave tank</span>
        <span className="zone__sub">live bench calibration — estimate vs commanded ground truth</span>
        {pending > 0 && (
          <span className="pill neutral" style={{ marginLeft: 8 }}>
            <span className="dot" />{pending} cmd{pending === 1 ? '' : 's'} queued (board offline)
          </span>
        )}
      </div>
      <StatusHealth reading={latest} connected={connected} lastTs={lastTs} now={now} />
      <HeaveStrip samples={heave} />
      <HsTpChart readings={readings} runs={runs} now={now} />
      <div className="grid-2" style={{ gridTemplateColumns: '0.9fr 1.1fr' }}>
        <RunPanel drifter={drifter} runs={runs} onChanged={refreshRuns} />
        <ParamPanel drifter={drifter} reading={latest} acks={acks} />
      </div>
    </section>
  );
}

window.WaveTankTab = WaveTankTab;
