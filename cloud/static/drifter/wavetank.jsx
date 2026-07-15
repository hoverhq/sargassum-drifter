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
   preserveAspectRatio="none", so no element measurement / ResizeObserver is needed. */
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
  const closedRef = useRef(false);

  const appendReading = useCallback((r) => {
    setReadings(prev => ringPush(prev, r, READINGS_CAP));
    if (Array.isArray(r.heave) && r.heave.length) {
      setHeave(prev => ringExtend(prev, r.heave, HEAVE_CAP));
    }
  }, []);

  useEffect(() => {
    closedRef.current = false;

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
      if (closedRef.current) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws/ui?drifter=${encodeURIComponent(drifter)}&token=${encodeURIComponent(TOKEN)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onmessage = (ev) => dispatch(ev.data);
      ws.onclose = () => {
        if (closedRef.current) return;
        setConnected(false);
        setTimeout(connect, RECONNECT_MS);   // no-op if unmounted (closedRef guards connect)
      };
      ws.onerror = () => { try { ws.close(); } catch (e) { /* onclose handles reconnect */ } };
    };

    // seed history first, THEN open the live socket so the initial replace can't clobber a live frame
    (async () => {
      const [rows, r] = await Promise.all([
        API.getWaveReadings(drifter, Date.now() / 1000 - 3600),
        API.getWaveRuns(drifter),
      ]);
      if (closedRef.current) return;
      const norm = rows.map(normReading);
      setReadings(norm.slice(-READINGS_CAP));
      const flat = [];
      for (const rr of norm) if (Array.isArray(rr.heave)) for (const h of rr.heave) flat.push(h);
      setHeave(flat.slice(-HEAVE_CAP));
      setRuns(r);
      connect();
    })();

    return () => {
      closedRef.current = true;
      if (wsRef.current) { try { wsRef.current.close(); } catch (e) { /* unmounting */ } }
    };
  }, [drifter, appendReading]);

  // refetch runs after a start/stop so the badge + chart overlay reflect it immediately (the server owns
  // run rows; the board only echoes the start-run command).
  const refreshRuns = useCallback(async () => {
    setRuns(await API.getWaveRuns(drifter));
  }, [drifter]);

  return { readings, heave, runs, connected, pending, acks, refreshRuns };
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
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="eyebrow">Heave · raw vertical accel (10 Hz)</span>
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
const CHART_W = 1000, CHART_PADL = 46, CHART_PADR = 12;

function fmtElapsed(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// One panel: y-gridded frame, run-span shading, an optional gapped series polyline, and a stepped
// ground-truth overlay. `series` is the board estimate {points:[{ts,v}], gapAtZero}; `truth` is the
// commanded value per run.
function ChartPanel({ label, unit, readings, runs, tMin, tMax, now, valueOf, truthOf, color, yMinFloor }) {
  const H = 150, padT = 12, padB = 22;
  const xOf = (ts) => CHART_PADL + (tMax > tMin ? (ts - tMin) / (tMax - tMin) : 0) * (CHART_W - CHART_PADL - CHART_PADR);

  // y-domain over both the board series and the commanded truth so neither clips.
  let vMax = yMinFloor;
  for (const r of readings) { const v = valueOf(r); if (v != null && v > vMax) vMax = v; }
  for (const run of runs) { const v = truthOf(run); if (v != null && v > vMax) vMax = v; }
  vMax = vMax * 1.15 || 1;
  const yOf = (v) => (H - padB) - (v / vMax) * (H - padT - padB);

  // board series, broken into segments wherever valueOf() returns null (Tp==0 = "no period gated", a GAP
  // — NOT a plunge to zero).
  const segs = [];
  let cur = [];
  for (const r of readings) {
    const v = valueOf(r);
    if (v == null) { if (cur.length) { segs.push(cur); cur = []; } continue; }
    cur.push(`${xOf(r.ts).toFixed(1)},${yOf(v).toFixed(1)}`);
  }
  if (cur.length) segs.push(cur);

  const yTicks = [0, vMax / 2, vMax];
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span className="eyebrow">{label}</span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--t-4)' }}>{unit}</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-2xs)', color: 'var(--t-3)' }}>
          <span style={{ width: 14, height: 2, background: color, display: 'inline-block' }} /> board estimate
          <span style={{ width: 14, height: 0, borderTop: '2px dashed var(--olive)', display: 'inline-block', marginLeft: 8 }} /> commanded
        </span>
      </div>
      <svg viewBox={`0 0 ${CHART_W} ${H}`} preserveAspectRatio="none"
           style={{ width: '100%', height: 150, display: 'block' }}>
        {/* y gridlines + labels */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={CHART_PADL} y1={yOf(t)} x2={CHART_W - CHART_PADR} y2={yOf(t)}
                  stroke="var(--hair-1)" strokeWidth="1" />
            <text x={CHART_PADL - 6} y={yOf(t) + 3} textAnchor="end" fill="var(--t-4)" fontSize="11"
                  fontFamily="'JetBrains Mono', monospace">{t.toFixed(t < 10 ? 1 : 0)}</text>
          </g>
        ))}
        {/* run-span shading */}
        {runs.map(run => {
          const x0 = xOf(run.started_ts);
          const x1 = xOf(run.stopped_ts != null ? run.stopped_ts : now);
          return <rect key={run.id} x={x0} y={padT} width={Math.max(0, x1 - x0)} height={H - padT - padB}
                       fill="var(--olive)" opacity="0.06" />;
        })}
        {/* commanded ground-truth: flat across each run's [started, stopped||now] span */}
        {runs.map(run => {
          const v = truthOf(run);
          if (v == null) return null;
          const x0 = xOf(run.started_ts);
          const x1 = xOf(run.stopped_ts != null ? run.stopped_ts : now);
          return <line key={run.id} x1={x0} y1={yOf(v)} x2={x1} y2={yOf(v)} stroke="var(--olive)"
                       strokeWidth="1.5" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />;
        })}
        {/* board estimate, gapped */}
        {segs.map((seg, i) => seg.length >= 2
          ? <polyline key={i} points={seg.join(' ')} fill="none" stroke={color} strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          : <circle key={i} cx={seg[0].split(',')[0]} cy={seg[0].split(',')[1]} r="1.6" fill={color} />)}
        {/* x-axis ticks (session time) — labelled on this panel; both panels share the mapping */}
        {[0, 0.5, 1].map((f, i) => {
          const ts = tMin + f * (tMax - tMin);
          const x = xOf(ts);
          return (
            <text key={i} x={x} y={H - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
                  fill="var(--t-4)" fontSize="11" fontFamily="'JetBrains Mono', monospace">
              {fmtElapsed(ts - tMin)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function HsTpChart({ readings, runs, now }) {
  const sortedRuns = useMemo(() => [...runs].sort((a, b) => a.started_ts - b.started_ts), [runs]);
  if (!readings.length) {
    return (
      <div className="card" style={{ textAlign: 'center', color: 'var(--t-3)', fontSize: 'var(--text-sm)', padding: '28px' }}>
        Waiting for wave telemetry… start the bench rig and its board.
      </div>
    );
  }
  const tMin = Math.min(readings[0].ts, sortedRuns.length ? sortedRuns[0].started_ts : readings[0].ts);
  const tMax = Math.max(readings[readings.length - 1].ts, now,
    ...sortedRuns.map(r => (r.stopped_ts != null ? r.stopped_ts : now)));
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <ChartPanel label="Significant wave height (Hs)" unit="mm" readings={readings} runs={sortedRuns}
                  tMin={tMin} tMax={tMax} now={now} color="var(--sage)" yMinFloor={10}
                  valueOf={r => (typeof r.hs_mm === 'number' ? r.hs_mm : null)}
                  truthOf={run => run.h_mm} />
      <div style={{ height: 1, background: 'var(--hair-1)', margin: '10px 0' }} />
      <ChartPanel label="Peak period (Tp)" unit="s" readings={readings} runs={sortedRuns}
                  tMin={tMin} tMax={tMax} now={now} color="var(--teal)" yMinFloor={1}
                  valueOf={r => (r.tp_ds > 0 ? r.tp_ds / 10 : null)}
                  truthOf={run => (run.t_ds > 0 ? run.t_ds / 10 : null)} />
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

  const inputStyle = {
    width: 76, background: 'var(--bg-1)', color: 'var(--t-1)', border: '1px solid var(--hair-2)',
    borderRadius: 'var(--r-2)', padding: '7px 9px', fontFamily: "'JetBrains Mono', monospace",
    fontSize: 'var(--text-base)',
  };
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span className="eyebrow">Bench run</span>
        {active
          ? <span className="pill green"><span className="dot" style={{ animation: 'pulseDot 1.4s infinite' }} />
              running · {active.h_mm} mm / {(active.t_ds / 10).toFixed(1)} s</span>
          : <span className="pill neutral"><span className="dot" />idle</span>}
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--t-3)' }}>Height H (mm)</span>
          <input type="number" min="1" value={hMm} onChange={e => setHMm(e.target.value)}
                 disabled={!!active} style={inputStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--t-3)' }}>Period T (s)</span>
          <input type="number" min="0.1" step="0.1" value={tSec} onChange={e => setTSec(e.target.value)}
                 disabled={!!active} style={inputStyle} />
        </label>
        {active
          ? <button className="btn btn--danger" disabled={busy} onClick={stop}>{busy ? 'Stopping…' : 'Stop run'}</button>
          : <button className="btn btn--primary" disabled={busy} onClick={start}>{busy ? 'Starting…' : 'Start run'}</button>}
      </div>
      <div style={{ marginTop: 10, fontSize: 'var(--text-xs)', color: 'var(--t-4)' }}>
        Start commands the maker (<span className="mono">start-run H T</span>) and brackets this session so the
        charts can overlay the board's estimate against what you commanded.
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

function ParamRow({ label, keyName, current, control, pending, onSet }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center',
                  padding: '8px 0', borderBottom: '1px solid var(--hair-1)' }}>
      <div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--t-2)' }}>{label}</div>
        <div className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--t-4)' }}>
          board: {current == null ? '—' : current}
        </div>
      </div>
      {control}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {pending && <span className="pill neutral"><span className="dot" style={{ animation: 'pulseDot 1.2s infinite' }} />pending</span>}
        <button className="btn btn--sm" onClick={onSet}>Set</button>
      </div>
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

  const selStyle = {
    background: 'var(--bg-1)', color: 'var(--t-1)', border: '1px solid var(--hair-2)',
    borderRadius: 'var(--r-2)', padding: '6px 8px', fontFamily: "'JetBrains Mono', monospace",
    fontSize: 'var(--text-sm)',
  };
  const numStyle = { ...selStyle, width: 82 };

  const recent = acks.slice(-8).reverse();
  return (
    <div className="card">
      <span className="eyebrow">Board params · retune the on-board estimator live</span>
      <div style={{ marginTop: 10 }}>
        <ParamRow label="FFT window (wave_n)" keyName="wave_n" current={cur.wave_n}
                  pending={!!pending.wave_n} onSet={() => doSet('wave_n', waveN)}
                  control={<select value={waveN} onChange={e => setWaveN(+e.target.value)} style={selStyle}>
                    {WAVE_N_OPTS.map(n => <option key={n} value={n}>{n}</option>)}</select>} />
        <ParamRow label="Tp median taps (tp_n)" keyName="tp_n" current={cur.tp_n}
                  pending={!!pending.tp_n} onSet={() => doSet('tp_n', tpN)}
                  control={<select value={tpN} onChange={e => setTpN(+e.target.value)} style={selStyle}>
                    {TP_N_OPTS.map(n => <option key={n} value={n}>{n}</option>)}</select>} />
        <ParamRow label="Min prominence (prom_min)" keyName="prom_min" current={cur.prom_min}
                  pending={!!pending.prom_min} onSet={() => doSet('prom_min', promMin)}
                  control={<input type="number" step="0.01" placeholder={cur.prom_min != null ? String(cur.prom_min) : ''}
                    value={promMin} onChange={e => setPromMin(e.target.value)} style={numStyle} />} />
        <ParamRow label="Band low (flo, Hz)" keyName="flo" current={cur.flo}
                  pending={!!pending.flo} onSet={() => doSet('flo', flo)}
                  control={<input type="number" step="0.01" placeholder={cur.flo != null ? String(cur.flo) : ''}
                    value={flo} onChange={e => setFlo(e.target.value)} style={numStyle} />} />
        <ParamRow label="Band high (fhi, Hz)" keyName="fhi" current={cur.fhi}
                  pending={!!pending.fhi} onSet={() => doSet('fhi', fhi)}
                  control={<input type="number" step="0.01" placeholder={cur.fhi != null ? String(cur.fhi) : ''}
                    value={fhi} onChange={e => setFhi(e.target.value)} style={numStyle} />} />
      </div>
      <div style={{ marginTop: 12 }}>
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
// HEALTH STRIP — board presence + link/power/estimator health
// ─────────────────────────────────────────────────────────────
function HealthTile({ label, value, tone }) {
  return (
    <div style={{ flex: '1 1 90px', minWidth: 90, background: 'var(--bg-1)', border: '1px solid var(--hair-1)',
                  borderRadius: 6, padding: '9px 11px' }}>
      <div style={{ fontSize: 'var(--text-2xs)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t-4)' }}>{label}</div>
      <div className="mono" style={{ fontSize: 'var(--text-lg)', color: tone || 'var(--t-1)', marginTop: 3, whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

function HealthStrip({ reading, connected, lastTs, now }) {
  const r = reading || {};
  const age = lastTs ? Math.max(0, now - lastTs) : null;
  const promLow = typeof r.prom === 'number' && typeof r.prom_min === 'number' && r.prom < r.prom_min;
  const verdict = SARG_VERDICT[r.sarg ? r.sarg.c : undefined] || { label: '—', cls: 'neutral' };
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span className={`pill ${connected ? 'green' : 'wine'}`}>
          <span className="dot" style={connected ? { animation: 'pulseDot 1.6s infinite' } : {}} />
          board {connected ? 'connected' : 'offline'}
        </span>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--t-3)' }}>
          {age == null ? 'no frame yet' : `last frame ${age.toFixed(0)}s ago`}
        </span>
        <span style={{ flex: 1 }} />
        <span className={`pill ${verdict.cls}`}><span className="dot" />{verdict.label}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <HealthTile label="Fill" value={r.fill != null ? `${(r.fill * 100).toFixed(0)}%` : '—'} />
        <HealthTile label="Prominence" tone={promLow ? 'var(--wine-text)' : undefined}
                    value={r.prom != null ? `${r.prom.toFixed(2)} / ${r.prom_min != null ? r.prom_min : '—'}` : '—'} />
        <HealthTile label="RSSI" value={r.rssi != null ? `${r.rssi} dBm` : '—'} />
        <HealthTile label="Heap" value={r.heap != null ? `${(r.heap / 1024).toFixed(0)}k` : '—'} />
        <HealthTile label="Battery" value={r.batt_mv != null ? `${(r.batt_mv / 1000).toFixed(2)}V` : '—'} />
      </div>
      {promLow && (
        <div style={{ marginTop: 9, fontSize: 'var(--text-xs)', color: 'var(--wine-text)', display: 'flex', gap: 6 }}>
          <span style={{ color: 'var(--wine)' }}>▲</span>
          Prominence is below the gate — the peak is too weak to lock a period, so Tp reads 0 (gapped above).
        </div>
      )}
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
      <HealthStrip reading={latest} connected={connected} lastTs={lastTs} now={now} />
      <HeaveStrip samples={heave} />
      <HsTpChart readings={readings} runs={runs} now={now} />
      <div className="grid-2">
        <RunPanel drifter={drifter} runs={runs} onChanged={refreshRuns} />
        <ParamPanel drifter={drifter} reading={latest} acks={acks} />
      </div>
    </section>
  );
}

window.WaveTankTab = WaveTankTab;
