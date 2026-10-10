import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { startPredictiveDetection } from './input/predictiveDetector'
import { CalibrationSession } from './input/calibrationSession'
import {
  SETUP_PRESETS, saveStore, addProfile, updateProfile,
  upsertNote, clearProfile, deleteProfile, setActive, noteLabel,
} from './input/micCalibration'
import { useMicCalibration } from './useMicCalibration'

/**
 * Mic setup. Saved once per piano (localStorage), reused by every practice
 * session; switching pianos = pick/add another profile and calibrate it.
 */

// ---- small keyboard strip highlighting the requested key ---------------------
const WHITE = [0, 2, 4, 5, 7, 9, 11]
function KeyboardStrip({ target, done }) {
  // Show the two octaves around the target, aligned to C.
  const baseC = Math.floor(target / 12) * 12 - 12
  const whites = []
  for (let o = 0; o < 4; o++) for (const pc of WHITE) whites.push(baseC + o * 12 + pc)
  const w = 22, h = 74
  const blackAfter = { 0: 1, 2: 3, 5: 6, 7: 8, 9: 10 }
  return (
    <svg viewBox={`0 0 ${whites.length * w} ${h}`} className="w-full" style={{ maxHeight: 84 }} aria-hidden="true">
      {whites.map((m, i) => {
        const isT = m === target
        const isDone = done.has(m)
        return (
          <g key={m}>
            <rect x={i * w + 0.5} y="0.5" width={w - 1} height={h - 1} rx="2"
              fill={isT ? 'var(--accent)' : isDone ? 'rgba(0,255,200,0.18)' : 'rgba(255,255,255,0.88)'}
              stroke="rgba(0,0,0,0.35)" />
            {m % 12 === 0 && (
              <text x={i * w + w / 2} y={h - 6} textAnchor="middle" fontSize="8" fill={isT ? '#000' : '#444'}>
                {noteLabel(m)}
              </text>
            )}
          </g>
        )
      })}
      {whites.map((m, i) => {
        const bm = blackAfter[m % 12] != null ? m + 1 : null
        if (bm == null || i === whites.length - 1) return null
        const isT = bm === target
        const isDone = done.has(bm)
        return (
          <rect key={bm} x={i * w + w * 0.68} y="0" width={w * 0.62} height={h * 0.6} rx="2"
            fill={isT ? 'var(--accent)' : isDone ? 'rgba(0,255,200,0.55)' : '#15151c'} stroke="rgba(0,0,0,0.6)" />
        )
      })}
    </svg>
  )
}

const TONE = { info: 'var(--ink)', ok: '#4ade80', warn: '#f59e0b' }

/**
 * @param {object} props
 * @param {() => void} props.onClose
 * @param {number[]|null} [props.midis]       force this exact note list (no presets)
 * @param {number[]|null} [props.pieceMidis]  lower notes of the octave pairs in the
 *   piece being practised — offered as a "This piece" preset, since those are the
 *   only notes calibration changes anything for.
 */
export default function MicSetup({ onClose, midis: midisProp = null, pieceMidis = null }) {
  const { store, profile, noteCount } = useMicCalibration()
  const hasPiece = !!(pieceMidis && pieceMidis.length)
  const [presetKey, setPresetKey] = useState(hasPiece ? 'piece' : 'essential')
  const [running, setRunning] = useState(false)
  const [view, setView] = useState(null)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState(null)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const sessionRef = useRef(null)
  const stopRef = useRef(null)
  const storeRef = useRef(store)
  const profileIdRef = useRef(profile?.id ?? null)
  useEffect(() => { storeRef.current = store; profileIdRef.current = profile?.id ?? null }, [store, profile])

  const presets = useMemo(() => ({
    ...(hasPiece ? { piece: { label: `This piece · ${pieceMidis.length} octave-pair note${pieceMidis.length === 1 ? '' : 's'}`, midis: pieceMidis } } : {}),
    ...SETUP_PRESETS,
  }), [hasPiece, pieceMidis])
  const setupNotes = useMemo(() => midisProp ?? (presets[presetKey] ?? presets.essential).midis, [midisProp, presets, presetKey])
  const calibrated = useMemo(() => new Set(Object.keys(profile?.notes ?? {}).map(Number)), [profile])
  const missing = useMemo(() => setupNotes.filter((m) => !calibrated.has(m)), [setupNotes, calibrated])

  const stop = useCallback(() => {
    try { stopRef.current?.() } catch { /* already stopped */ }
    stopRef.current = null
    sessionRef.current = null
    setRunning(false)
  }, [])
  useEffect(() => stop, [stop])

  // Persist through the store so progress survives quitting mid-setup.
  const commit = useCallback((fn) => {
    const next = fn(storeRef.current)
    storeRef.current = next
    saveStore(next)
  }, [])

  const begin = useCallback(async (list, { fresh = false } = {}) => {
    if (!list.length) return
    setError(null)
    let id = profileIdRef.current
    if (!id) {
      commit((s) => addProfile(s, 'My piano'))
      id = storeRef.current.activeId
      profileIdRef.current = id
    }
    if (fresh) commit((s) => clearProfile(s, id))

    try {
      const det = await startPredictiveDetection({
        onNotes: () => {},
        expected: [],
        calibration: null, // setup must hear the raw engine, never a previous profile
        onFrame: (f) => {
          const sess = sessionRef.current
          if (!sess) return
          sess.feed({ t: f.t, rms: f.rms, silent: f.silent, heldMidi: f.heldMidi })
          setLevel(Math.min(1, f.rms * 8))
        },
      })
      stopRef.current = det.stop
      const sess = new CalibrationSession({
        engine: det.engine,
        midis: list,
        room: true,
        onEntry: (entry) => commit((s) => upsertNote(s, id, entry)),
        onRoom: (roomRms) => commit((s) => updateProfile(s, id, { roomRms, sampleRate: det.engine.sr })),
        onChange: () => setView({ ...sess.view }),
      })
      sessionRef.current = sess
      setView({ ...sess.view })
      setRunning(true)
    } catch (err) {
      const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
      setError(denied ? 'Microphone access was blocked. Allow it and try again.' : `Could not start the microphone: ${err?.message || 'unknown error'}`)
      stop()
    }
  }, [commit, stop])

  // Auto-stop the mic once the session reports finished.
  useEffect(() => {
    if (running && view?.phase === 'finished') {
      const id = setTimeout(stop, 600)
      return () => clearTimeout(id)
    }
  }, [running, view, stop])

  const btn = 'px-4 py-2 rounded-lg text-sm font-medium transition-all border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'
  const ghost = { borderColor: 'var(--border)', color: 'var(--sub)', background: 'transparent' }
  const primary = { borderColor: 'var(--accent)', color: '#000', background: 'var(--accent)' }

  const closeModal = () => { stop(); onClose?.() }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-md px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !running) closeModal() }}
    >
      <div className="rounded-2xl w-full max-w-lg p-5 sm:p-6 shadow-2xl max-h-[92vh] overflow-y-auto" style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold" style={{ color: 'var(--ink)' }}>Mic setup</h2>
          <button onClick={closeModal} className="cursor-pointer" style={{ color: 'var(--sub)' }} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>

        {/* ───────── running wizard ───────── */}
        {running && view ? (
          <div>
            <div className="h-1.5 rounded-full overflow-hidden mb-3" style={{ background: 'rgba(255,255,255,0.08)' }}>
              <div className="h-full transition-all" style={{ width: `${Math.round(view.progress * 100)}%`, background: 'var(--accent)' }} />
            </div>
            <div className="flex items-center justify-between text-xs mb-3" style={{ color: 'var(--sub)' }}>
              <span>{view.phase === 'room' ? 'Step 1 — room tone' : view.phase === 'finished' ? 'Done' : `Note ${Math.min(view.index + 1, view.total)} of ${view.total}`}</span>
              <span className="flex items-center gap-2">
                mic
                <span className="inline-block h-1.5 w-16 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                  <span className="block h-full" style={{ width: `${Math.round(level * 100)}%`, background: '#4ade80', transition: 'width 80ms' }} />
                </span>
              </span>
            </div>

            {view.phase !== 'room' && view.phase !== 'finished' && view.midi != null && (
              <>
                <div className="text-center mb-1">
                  <div className="text-5xl font-bold tracking-tight" style={{ color: 'var(--ink)' }}>{view.name}</div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--sub)', opacity: 0.7 }}>Middle C is C3 in Pianly</div>
                </div>
                <div className="my-3"><KeyboardStrip target={view.midi} done={new Set(view.done)} /></div>
              </>
            )}

            <p className="text-center text-base min-h-[1.75rem] mb-1" style={{ color: TONE[view.tone] || 'var(--ink)' }} aria-live="polite">
              {view.message}
            </p>
            {view.phase !== 'room' && view.heard.length > 0 && (
              <p className="text-center text-xs mb-1" style={{ color: 'var(--sub)' }}>hearing: {view.heard.map(noteLabel).join(' · ')}</p>
            )}
            <p className="text-center text-[11px] mb-5" style={{ color: 'var(--sub)', opacity: 0.6 }}>
              Play it once at a normal, comfortable strength and hold it for about a second and a half, then let go. No pedal.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-2">
              <button className={btn} style={ghost} disabled={view.index === 0 || view.phase === 'room'} onClick={() => sessionRef.current?.back()}>Redo previous</button>
              <button className={btn} style={ghost} disabled={view.phase === 'room' || view.phase === 'finished'} onClick={() => sessionRef.current?.skip()}>Skip this note</button>
              <button className={btn} style={primary} onClick={stop}>
                {view.phase === 'finished' ? 'Done' : 'Stop & save'}
              </button>
            </div>
          </div>
        ) : (
          /* ───────── overview ───────── */
          <div>
            <p className="text-sm leading-relaxed mb-4" style={{ color: 'var(--sub)' }}>
              Play a handful of notes once and Pianly learns what <em>your</em> piano and microphone sound like,
              so it can tell a single note from an octave pair. It is saved on this device — you only
              need to redo it when you change pianos or move the mic.
            </p>

            {/* piano profile */}
            <label className="text-xs uppercase tracking-wider font-medium mb-2 block" style={{ color: 'var(--sub)' }}>Piano</label>
            {store.profiles.length > 0 ? (
              <div className="flex items-center gap-2 mb-2">
                {renaming ? (
                  <>
                    <input
                      autoFocus value={renameVal} onChange={(e) => setRenameVal(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && profile) { commit((s) => updateProfile(s, profile.id, { name: renameVal.trim() || profile.name })); setRenaming(false) } if (e.key === 'Escape') setRenaming(false) }}
                      className="flex-1 px-3 py-2 rounded-lg text-sm bg-transparent" style={{ border: '1px solid var(--border)', color: 'var(--ink)' }}
                    />
                    <button className={btn} style={primary} onClick={() => { if (profile) commit((s) => updateProfile(s, profile.id, { name: renameVal.trim() || profile.name })); setRenaming(false) }}>Save</button>
                  </>
                ) : (
                  <>
                    <select
                      value={profile?.id ?? ''} onChange={(e) => commit((s) => setActive(s, e.target.value))}
                      className="flex-1 px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--ink)' }}
                    >
                      {store.profiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.name} — {Object.keys(p.notes).length} notes</option>
                      ))}
                    </select>
                    <button className={btn} style={ghost} onClick={() => { setRenameVal(profile?.name ?? ''); setRenaming(true) }} disabled={!profile}>Rename</button>
                  </>
                )}
              </div>
            ) : (
              <p className="text-sm mb-2" style={{ color: 'var(--sub)', opacity: 0.8 }}>No piano set up yet.</p>
            )}
            <div className="flex items-center gap-2 mb-5">
              <input
                value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Add another piano (e.g. Yamaha P-45)"
                className="flex-1 px-3 py-2 rounded-lg text-sm bg-transparent" style={{ border: '1px solid var(--border)', color: 'var(--ink)' }}
              />
              <button className={btn} style={ghost} disabled={!newName.trim()}
                onClick={() => { commit((s) => addProfile(s, newName)); setNewName('') }}>Add</button>
            </div>

            {/* what to calibrate */}
            {!midisProp && (
              <>
                <label className="text-xs uppercase tracking-wider font-medium mb-2 block" style={{ color: 'var(--sub)' }}>Notes to set up</label>
                <div className="flex flex-col rounded-lg overflow-hidden text-sm font-medium mb-3" style={{ border: '1px solid var(--border)' }}>
                  {Object.entries(presets).map(([k, p]) => (
                    <button key={k} onClick={() => setPresetKey(k)} className="px-3 py-2 text-left cursor-pointer"
                      style={presetKey === k ? { background: 'rgba(0,255,200,0.1)', color: 'var(--ink)' } : { color: 'var(--sub)' }}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="flex flex-wrap gap-1 mb-2">
              {setupNotes.map((m) => (
                <span key={m} className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                  style={calibrated.has(m)
                    ? { background: 'rgba(0,255,200,0.14)', color: 'var(--accent)', border: '1px solid var(--border)' }
                    : { color: 'var(--sub)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  {noteLabel(m)}
                </span>
              ))}
            </div>
            <p className="text-xs mb-5" style={{ color: 'var(--sub)', opacity: 0.8 }}>
              {setupNotes.length - missing.length} of {setupNotes.length} set up
              {profile?.roomRms != null ? ` · room tone ${profile.roomRms.toFixed(4)}` : ''}.
              Notes you haven&apos;t set up still work — they just use the standard detector.
            </p>

            {error && <p className="text-sm mb-3" style={{ color: '#f87171' }}>{error}</p>}

            <div className="flex flex-wrap gap-2">
              <button className={btn} style={primary}
                onClick={() => begin(missing.length ? missing : setupNotes)}>
                {noteCount === 0 ? 'Start setup' : missing.length ? `Set up ${missing.length} missing note${missing.length === 1 ? '' : 's'}` : 'Redo these notes'}
              </button>
              {noteCount > 0 && (
                <button className={btn} style={ghost} onClick={() => begin(setupNotes, { fresh: true })}>
                  New piano? Recalibrate from scratch
                </button>
              )}
              {profile && store.profiles.length > 0 && (
                <button className={btn} style={{ ...ghost, color: '#f87171' }}
                  onClick={() => { if (window.confirm(`Delete "${profile.name}" and its calibration?`)) commit((s) => deleteProfile(s, profile.id)) }}>
                  Delete
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
