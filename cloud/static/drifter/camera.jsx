// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Sargassum Training Kit Authors
// Camera tab: resolution dropdown + remote shutter + film-strip of thumbnails (click -> full image).
// The shutter POSTs a one-shot capture request; the board picks it up on its next detection POST, captures,
// and uploads the JPEG. The strip polls /api/photos; image routes are unauthenticated so <img> tags work.
const CAM_RES = ['QVGA', 'VGA', 'HD', 'UXGA', 'FHD', '5MP'];

function CameraTab({ drifter }) {
  const { useState, useEffect, useRef } = React;
  const [res, setRes] = useState('5MP');
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(null);        // photo id opened in the lightbox
  const lastCount = useRef(0);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const p = await API.getPhotos(drifter);
      if (stop) return;
      setPhotos(p);
      if (busy && p.length > lastCount.current) setBusy(false);   // our shot landed
      lastCount.current = p.length;
    };
    tick();
    const iv = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(iv); };
  }, [drifter, busy]);

  const shoot = async () => {
    setBusy(true);
    lastCount.current = photos.length;
    await API.postCaptureRequest(drifter, res);
    setTimeout(() => setBusy(false), 20000);      // safety re-enable if no photo arrives
  };

  return (
    <section className="zone">
      <div className="zone__head">
        <span className="zone__idx">07</span>
        <span className="zone__title">Camera</span>
        <span className="zone__sub">remote shutter — capture over WiFi</span>
      </div>
      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14 }}>
        <select className="mono" value={res} onChange={e => setRes(e.target.value)}
                style={{ background: 'var(--bg-3)', color: 'var(--t-1)', border: '1px solid var(--hair-2)',
                         borderRadius: 'var(--r-2)', padding: '8px 10px' }}>
          {CAM_RES.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <button className="btn btn--primary" disabled={busy} onClick={shoot}>
          {busy ? 'Capturing…' : '● Shutter'}
        </button>
        <span className="hdr__spacer" />
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--t-3)' }}>{photos.length} frame(s)</span>
      </div>
      {photos.length === 0
        ? <div className="card" style={{ color: 'var(--t-3)', fontSize: 'var(--text-sm)' }}>
            No frames yet — hit the shutter. The board captures on its next ~1 s poll, then uploads.
          </div>
        : <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8 }}>
            {photos.map(p => (
              <div key={p.id} onClick={() => p.ok && setFull(p.id)}
                   style={{ flex: 'none', cursor: p.ok ? 'pointer' : 'default', textAlign: 'center' }}>
                {p.ok
                  ? <img src={`/photos/${p.id}/thumb`} alt=""
                         style={{ height: 120, borderRadius: 'var(--r-2)', border: '1px solid var(--hair-2)',
                                  display: 'block' }} />
                  : <div className="mono" style={{ height: 120, width: 160, display: 'flex',
                         alignItems: 'center', justifyContent: 'center', color: 'var(--wine-text)',
                         border: '1px solid var(--wine-border)', borderRadius: 'var(--r-2)' }}>capture failed</div>}
                <div className="mono" style={{ fontSize: 'var(--text-2xs)', color: 'var(--t-4)', marginTop: 3 }}>
                  {p.res || '—'}
                </div>
              </div>
            ))}
          </div>}
      {full != null && (
        <div onClick={() => setFull(null)}
             style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 80, display: 'flex',
                      alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}>
          <img src={`/photos/${full}/full`} alt="" style={{ maxWidth: '92%', maxHeight: '92%' }} />
        </div>
      )}
    </section>
  );
}
window.CameraTab = CameraTab;
