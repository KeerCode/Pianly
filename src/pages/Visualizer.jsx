import { useState, useRef, useEffect, useCallback } from 'react'
import { parseNoteTimeline, noteNameToMidi, tickToSec as tempoMapTickToSec } from '../parsers/parseTimeline'
import { parseMidiFile } from '../parsers/parseMidi'
import { DEMO_PIECES, loadDemoScore } from '../data/demoScores'
import { getSavedFolder, pickFolder, listScores, loadScore } from '../lib/scoreFolder'
import { SplendidGrandPiano } from 'smplr'
import { enableMidi } from '../input/midiInput'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import Background from '../Background'
import { useTheme } from '../ThemeContext'

// ---------------------------------------------------------------------------
// Piano keyboard layout
// ---------------------------------------------------------------------------
const FIRST_MIDI = 21  // A0
const LAST_MIDI = 108  // C8
const BLACK_KEY_SET = new Set([1, 3, 6, 8, 10])
const WHITE_KEY_H_RATIO = 0.22
const BLACK_KEY_H_RATIO = 0.6

function isBlackKey(midi) {
  return BLACK_KEY_SET.has(midi % 12)
}

let WHITE_KEY_COUNT = 0
for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) {
  if (!isBlackKey(m)) WHITE_KEY_COUNT++
}

function buildKeyLayout(canvasWidth) {
  const whiteW = canvasWidth / WHITE_KEY_COUNT
  const blackW = whiteW * 0.65
  const layout = {}
  let wi = 0
  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    if (!isBlackKey(midi)) { layout[midi] = { x: wi * whiteW, width: whiteW, black: false }; wi++ }
  }
  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    if (isBlackKey(midi)) {
      const prev = layout[midi - 1]
      if (prev) layout[midi] = { x: prev.x + prev.width - blackW / 2, width: blackW, black: true }
    }
  }
  return layout
}

function darkenColor(hex, factor) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `#${Math.round(r*factor).toString(16).padStart(2,'0')}${Math.round(g*factor).toString(16).padStart(2,'0')}${Math.round(b*factor).toString(16).padStart(2,'0')}`
}

// ---------------------------------------------------------------------------
// Note name helper
// ---------------------------------------------------------------------------
const NOTE_NAMES_DISPLAY = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B']
function midiToNoteName(midi) {
  return NOTE_NAMES_DISPLAY[midi % 12] + (Math.floor(midi / 12) - 2)
}

// ---------------------------------------------------------------------------
// Synth
// ---------------------------------------------------------------------------
function createSynth() {
  let audioCtx = null
  let piano = null
  let loadPromise = null

  function ensureCtx() {
    if (!audioCtx) audioCtx = new AudioContext()
    return audioCtx
  }

  // Returns a Promise that resolves once the AudioContext is running
  async function ensureReady() {
    ensureCtx()
    if (audioCtx.state === 'suspended') await audioCtx.resume()
  }

  function ensurePiano() {
    if (piano) return loadPromise
    ensureCtx()
    piano = new SplendidGrandPiano(audioCtx, { decayTime: 8 })
    loadPromise = piano.load
      .then(() => piano)
      .catch((err) => { console.error('[Visualizer] Piano load failed:', err); return null })
    return loadPromise
  }

  function noteOn(midi) {
    ensurePiano().then((p) => {
      if (!p) return
      // Schedule at the current audio clock time for tight sync
      p.start({ note: midi, velocity: 100, time: audioCtx.currentTime })
    })
  }

  function stopAll() { if (piano) piano.stop() }

  function close() {
    stopAll()
    if (audioCtx) { audioCtx.close(); audioCtx = null }
    piano = null; loadPromise = null
  }

  function getCtx() { return audioCtx }

  return { noteOn, stopAll, close, ensurePiano, ensureReady, getCtx }
}

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------
const DEFAULT_RIGHT_COLOR = '#3b82f6'
const DEFAULT_LEFT_COLOR  = '#22c55e'
const DEFAULT_PLAYBACK_SPEED = 1.0
const FALL_PX_PER_SEC = 200
const GRACE_MS = 150       // ms before practice pause triggers
const CHORD_TICK_WINDOW = 15  // ticks — entries within this range are one chord

// ---------------------------------------------------------------------------
// Visualizer component
// ---------------------------------------------------------------------------
export default function Visualizer() {
  const { theme } = useTheme()

  // ── Watch mode state ───────────────────────────────────────────────────────
  const [musicXml, setMusicXml] = useState(null)
  const [filename, setFilename] = useState('')
  const [timeline, setTimeline] = useState([])
  const [tempo, setTempo] = useState(120)
  const [tempoMap, setTempoMap] = useState([{ tick: 0, bpm: 120 }])
  const [playing, setPlaying] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showDemoModal, setShowDemoModal] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(DEFAULT_PLAYBACK_SPEED)
  const [rightColor, setRightColor] = useState(DEFAULT_RIGHT_COLOR)
  const [leftColor, setLeftColor] = useState(DEFAULT_LEFT_COLOR)
  const [showNoteNames, setShowNoteNames] = useState(true)
  const [showKeyLabels, setShowKeyLabels] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(true)

  // ── Practice mode state ───────────────────────────────────────────────────
  const [practiceMode, setPracticeMode] = useState(false)
  const [practiceWaiting, setPracticeWaiting] = useState(false) // true = waiting for first keypress to start
  const [practiceStatus, setPracticeStatus] = useState('playing') // 'playing' | 'waiting'
  const [targetNoteNames, setTargetNoteNames] = useState([])     // e.g. ['C4', 'E4']
  const [midiDevices, setMidiDevices] = useState([])
  const [selectedDeviceId, setSelectedDeviceId] = useState(null)

  // ── Library state ─────────────────────────────────────────────────────────
  const [showLibrary, setShowLibrary] = useState(false)
  const [libraryTab, setLibraryTab] = useState('mysongs') // 'mysongs' | 'demos'
  const [folderPath, setFolderPath] = useState(() => getSavedFolder())
  const [folderScores, setFolderScores] = useState([])
  const [folderLoading, setFolderLoading] = useState(false)

  // ── Refs ──────────────────────────────────────────────────────────────────
  const canvasRef      = useRef(null)
  const fileInputRef   = useRef(null)
  const animRef        = useRef(null)
  const synthRef       = useRef(null)
  const playedNotesRef = useRef(new Set())
  const playStateRef   = useRef({ playing: false, startTime: 0, elapsed: 0, pausedAt: 0, audioStartTime: null })
  const settingsRef    = useRef({ playbackSpeed: DEFAULT_PLAYBACK_SPEED, rightColor: DEFAULT_RIGHT_COLOR, leftColor: DEFAULT_LEFT_COLOR, showNoteNames: true, showKeyLabels: true, soundEnabled: true })

  // Practice refs (read inside draw loop — must be refs not state)
  const heldMidiRef       = useRef(new Set())   // MIDI notes currently held by user
  const practiceModeRef   = useRef(false)        // mirror of practiceMode state
  const practicePausedRef = useRef(false)        // true when practice auto-paused
  const targetMidiRef     = useRef(new Set())    // notes user must press to resume
  const confirmedTickRef  = useRef(-1)           // highest musical tick confirmed so far
  const graceStartRef     = useRef(null)         // rAF timestamp when grace window opened
  const midiStopRef       = useRef(null)         // MIDI unlisten/disconnect fn
  const lastStatusRef     = useRef('playing')    // gate setPracticeStatus to avoid thrash
  const practiceWaitingRef = useRef(false)       // mirror of practiceWaiting for use inside MIDI handler
  const handlePlayRef     = useRef(null)         // ref to handlePlay for use inside MIDI handler

  // ── Sync settings ref ─────────────────────────────────────────────────────
  useEffect(() => {
    settingsRef.current = { playbackSpeed, rightColor, leftColor, showNoteNames, showKeyLabels, soundEnabled }
  }, [playbackSpeed, rightColor, leftColor, showNoteNames, showKeyLabels, soundEnabled])

  // ── Sync practiceMode ref ─────────────────────────────────────────────────
  useEffect(() => { practiceModeRef.current = practiceMode }, [practiceMode])
  useEffect(() => { practiceWaitingRef.current = practiceWaiting }, [practiceWaiting])

  // ── File parse ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!musicXml) { setTimeline([]); return }
    if (musicXml instanceof ArrayBuffer) {
      const header = new Uint8Array(musicXml, 0, 4)
      const isMidi = header[0] === 0x4D && header[1] === 0x54 && header[2] === 0x68 && header[3] === 0x64
      if (isMidi) {
        try {
          const result = parseMidiFile(musicXml)
          setTimeline(result.timeline); setTempo(result.tempo); setTempoMap(result.tempoMap)
        } catch (err) { console.error('[Visualizer] MIDI parse error:', err) }
        return
      }
      try {
        const xmlStr = new TextDecoder().decode(musicXml)
        const result = parseNoteTimeline(xmlStr)
        setTimeline(result.timeline); setTempo(result.tempo); setTempoMap(result.tempoMap)
      } catch {}
      return
    }
    if (typeof musicXml === 'string') {
      const result = parseNoteTimeline(musicXml)
      setTimeline(result.timeline); setTempo(result.tempo); setTempoMap(result.tempoMap)
    }
  }, [musicXml])

  // ── Reset practice tracking when file changes ─────────────────────────────
  useEffect(() => {
    confirmedTickRef.current = -1
    practicePausedRef.current = false
    targetMidiRef.current = new Set()
    graceStartRef.current = null
    lastStatusRef.current = 'playing'
    setPracticeStatus('playing')
    setTargetNoteNames([])
  }, [timeline])

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      synthRef.current?.close()
      if (midiStopRef.current) { midiStopRef.current(); midiStopRef.current = null }
    }
  }, [])

  // ── Pick up song passed via sessionStorage (from home screen Library) ──────
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('nf-vis-song')
      if (!raw) return
      sessionStorage.removeItem('nf-vis-song')
      const { name, type, data } = JSON.parse(raw)
      setFilename(name)
      if (type === 'binary') {
        const bin = atob(data)
        const buf = new ArrayBuffer(bin.length)
        const view = new Uint8Array(buf)
        for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
        setMusicXml(buf)
      } else {
        setMusicXml(data)
      }
    } catch (e) {
      console.error('[Visualizer] sessionStorage handoff failed:', e)
    }
  }, [])

  // ── Always-on MIDI listening — direct Tauri, no shared singleton ──────────
  useEffect(() => {
    let cancelled = false
    let unlistenOn = null
    let unlistenOff = null

    async function setup() {
      console.log('[Visualizer] MIDI setup start')

      // Step 1: query devices
      let inputs = []
      try {
        const result = await enableMidi()
        inputs = result.inputs
        console.log(`[Visualizer] Devices found: ${JSON.stringify(inputs)}`)
      } catch (err) {
        console.error('[Visualizer] enableMidi failed:', err)
        return
      }

      if (inputs.length === 0) {
        console.warn('[Visualizer] No MIDI devices — cannot listen')
        return
      }
      if (cancelled) return

      const deviceId = Number(inputs[0].id)
      setMidiDevices(inputs)
      setSelectedDeviceId(inputs[0].id)
      console.log(`[Visualizer] Using device id=${deviceId}`)

      // Step 2: disconnect any previous MIDI session
      try {
        await invoke('disconnect_midi')
        console.log('[Visualizer] disconnect_midi OK')
      } catch (err) {
        console.warn('[Visualizer] disconnect_midi warn (may not have been connected):', err)
      }
      if (cancelled) return

      // Step 3: register raw Tauri event listeners (own refs, not shared singleton)
      try {
        unlistenOn = await listen('midi-note', (event) => {
          const noteName = event.payload?.note ?? event.payload
          console.log(`[Visualizer] RAW midi-note event payload:`, event.payload, '→ noteName:', noteName)
          const midi = noteNameToMidi(String(noteName))
          if (midi != null) {
            heldMidiRef.current.add(midi)
            console.log(`[Visualizer] NOTE ON  "${noteName}" midi=${midi} held=[${[...heldMidiRef.current].map(m => `${m}(${midiToNoteName(m)})`).join(', ')}]`)
            // If waiting for first keypress to start practice mode, begin now
            if (practiceWaitingRef.current) {
              practiceWaitingRef.current = false
              setPracticeWaiting(false)
              handlePlayRef.current?.()
            }
          } else {
            console.warn(`[Visualizer] NOTE ON  "${noteName}" → noteNameToMidi returned null`)
          }
        })
        console.log('[Visualizer] listen(midi-note) registered')
      } catch (err) {
        console.error('[Visualizer] listen(midi-note) FAILED:', err)
        return
      }
      if (cancelled) { unlistenOn?.(); return }

      try {
        unlistenOff = await listen('midi-note-off', (event) => {
          const noteName = event.payload?.note ?? event.payload
          const midi = noteNameToMidi(String(noteName))
          if (midi != null) {
            heldMidiRef.current.delete(midi)
            console.log(`[Visualizer] NOTE OFF "${noteName}" midi=${midi} held=[${[...heldMidiRef.current].map(m => `${m}(${midiToNoteName(m)})`).join(', ')}]`)
          }
        })
        console.log('[Visualizer] listen(midi-note-off) registered')
      } catch (err) {
        console.error('[Visualizer] listen(midi-note-off) FAILED:', err)
      }
      if (cancelled) { unlistenOn?.(); unlistenOff?.(); return }

      // Step 4: connect MIDI device
      try {
        const portName = await invoke('connect_midi', { deviceId })
        console.log(`[Visualizer] connect_midi OK — port: "${portName}" — ready for notes`)
      } catch (err) {
        console.error('[Visualizer] connect_midi FAILED:', err)
        unlistenOn?.(); unlistenOff?.()
        unlistenOn = null; unlistenOff = null
      }
    }

    setup()

    return () => {
      cancelled = true
      console.log('[Visualizer] MIDI cleanup')
      unlistenOn?.(); unlistenOff?.()
      invoke('disconnect_midi').catch(() => {})
      heldMidiRef.current.clear()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Practice mode teardown (clear practice state when toggled off) ────────
  useEffect(() => {
    if (!practiceMode) {
      heldMidiRef.current.clear()
      practicePausedRef.current = false
      targetMidiRef.current = new Set()
      graceStartRef.current = null
      if (lastStatusRef.current !== 'playing') {
        lastStatusRef.current = 'playing'
        setPracticeStatus('playing')
        setTargetNoteNames([])
      }
    }
  }, [practiceMode])

  function connectMidiDevice(deviceId) {
    // No-op in Visualizer — MIDI is set up once on mount via the direct Tauri effect above.
    // This function is kept for the settings panel device-switcher only.
    console.log(`[Visualizer] connectMidiDevice(${deviceId}) — device switching not yet wired to direct listener`)
  }

  // ---------------------------------------------------------------------------
  // Canvas draw loop
  // ---------------------------------------------------------------------------
  const draw = useCallback((timestamp) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1

    const rect = canvas.parentElement.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px'
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const { playbackSpeed: speed, rightColor: rColor, leftColor: lColor, showNoteNames: showNames, showKeyLabels: showLabels, soundEnabled: sound } = settingsRef.current
    const ps = playStateRef.current

    if (ps.playing) {
      const audioCtx = synthRef.current?.getCtx?.()
      if (audioCtx && ps.audioStartTime != null) {
        // Use audio clock as the single source of truth — visuals and audio stay locked
        ps.elapsed = (audioCtx.currentTime - ps.audioStartTime) + ps.pausedAt
      } else {
        // Fallback when sound is off: use rAF timestamps
        if (ps.startTime === 0) ps.startTime = timestamp
        ps.elapsed = (timestamp - ps.startTime) / 1000 + ps.pausedAt
      }
    }
    const currentTimeSec = ps.elapsed

    const whiteKeyH = Math.max(h * WHITE_KEY_H_RATIO, 60)
    const blackKeyH = whiteKeyH * BLACK_KEY_H_RATIO
    const layout = buildKeyLayout(w)
    const keyboardTop = h - whiteKeyH
    const leadInSec = keyboardTop / FALL_PX_PER_SEC

    const rColorDark = darkenColor(rColor, 0.5)
    const lColorDark = darkenColor(lColor, 0.5)

    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(0, 0, w, h)

    const tMap = ps.tempoMap || [{ tick: 0, bpm: ps.tempo || 120 }]
    const tickToSec = (tick) => tempoMapTickToSec(tick, tMap) / speed

    const activeKeys = {}

    if (ps.timeline && ps.timeline.length > 0) {
      for (let ei = 0; ei < ps.timeline.length; ei++) {
        const entry = ps.timeline[ei]
        const noteStartSec = tickToSec(entry.tick) + leadInSec
        const noteDurSec = entry.durationSec != null
          ? entry.durationSec / speed
          : tickToSec(entry.tick + entry.duration) - tickToSec(entry.tick)
        const timeUntilLand = noteStartSec - currentTimeSec
        const barBottom = keyboardTop - timeUntilLand * FALL_PX_PER_SEC
        const barH = Math.max(noteDurSec * FALL_PX_PER_SEC, 6)
        const barTop = barBottom - barH

        if (barBottom < -barH) continue
        if (barTop > keyboardTop + 10) continue

        const isRight = entry.hand === 'right'
        const color = isRight ? rColor : lColor
        const colorDark = isRight ? rColorDark : lColorDark

        if (sound && ps.playing && timeUntilLand <= 0.02 && timeUntilLand > -0.1) {
          const noteKey = `${ei}`
          if (!playedNotesRef.current.has(noteKey)) {
            playedNotesRef.current.add(noteKey)
            if (!synthRef.current) synthRef.current = createSynth()
            for (const noteName of entry.notes) {
              const midi = noteNameToMidi(noteName)
              if (midi != null) synthRef.current.noteOn(midi)
            }
          }
        }

        for (const noteName of entry.notes) {
          const midi = noteNameToMidi(noteName)
          if (midi == null || !layout[midi]) continue
          const key = layout[midi]
          const barX = key.x + 1
          const barW = key.width - 2
          const drawTop = Math.max(0, barTop)
          const drawBottom = Math.min(keyboardTop, barBottom)
          const drawH = drawBottom - drawTop
          if (drawH <= 0) continue

          ctx.fillStyle = key.black ? colorDark : color
          ctx.beginPath(); ctx.roundRect(barX, drawTop, barW, drawH, 3); ctx.fill()

          if (showNames && drawH > 16) {
            ctx.fillStyle = '#ffffff'
            ctx.font = `bold ${Math.min(Math.floor(barW * 0.45), 11)}px system-ui, sans-serif`
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
            ctx.fillText(noteName, barX + barW / 2, drawTop + Math.min(drawH / 2, 14))
          }

          if (barBottom >= keyboardTop - 2 && barTop < keyboardTop) {
            activeKeys[midi] = { color, dark: colorDark }
          }
        }
      }
    }

    // ── Practice mode logic ─────────────────────────────────────────────────
    const practMode = practiceModeRef.current
    const heldMidi = heldMidiRef.current
    const practicePaused = practicePausedRef.current
    const targetMidi = targetMidiRef.current
    let requiredMidi = new Set()

    if (practMode && ps.timeline && ps.timeline.length > 0) {
      // Find the first unconfirmed tick that has landed
      let firstUnconfirmedTick = Infinity
      for (const entry of ps.timeline) {
        if (entry.tick <= confirmedTickRef.current) continue
        const noteStartSec = tickToSec(entry.tick) + leadInSec
        if (noteStartSec <= currentTimeSec + 0.02) {
          firstUnconfirmedTick = entry.tick
          break // timeline sorted by tick — first match is earliest
        }
      }

      // Collect all MIDI notes in this chord group (within CHORD_TICK_WINDOW)
      if (firstUnconfirmedTick < Infinity) {
        for (const entry of ps.timeline) {
          if (entry.tick < firstUnconfirmedTick - 5) continue
          if (entry.tick > firstUnconfirmedTick + CHORD_TICK_WINDOW) break
          const noteStartSec = tickToSec(entry.tick) + leadInSec
          if (noteStartSec <= currentTimeSec + 0.02) {
            for (const n of entry.notes) {
              const m = noteNameToMidi(n)
              if (m != null) requiredMidi.add(m)
            }
          }
        }
      }

      const allHeld  = requiredMidi.size === 0 || [...requiredMidi].every(m => heldMidi.has(m))
      // true if every held note is a valid target (user is building the chord correctly)
      const noExtras = [...heldMidi].every(m => requiredMidi.has(m))

      if (requiredMidi.size > 0) {
        const targetKey = [...requiredMidi].sort().join(',')
        const heldKey   = [...heldMidi].sort().join(',')
        const logKey    = `${targetKey}|${heldKey}`
        if (ps._lastPracticeLogKey !== logKey) {
          ps._lastPracticeLogKey = logKey
          const targetNames = [...requiredMidi].map(midiToNoteName)
          const heldNames   = [...heldMidi].map(midiToNoteName)
          console.log(`[Visualizer] TARGET=[${targetNames.join(', ')}]  HELD=[${heldNames.join(', ')}]  allHeld=${allHeld}  noExtras=${noExtras}`)
        }
      }

      if (allHeld && noExtras && requiredMidi.size > 0) {
        // All required notes held and no extras — confirm chord
        confirmedTickRef.current = firstUnconfirmedTick + CHORD_TICK_WINDOW
        graceStartRef.current = null
        if (practicePaused) {
          practicePausedRef.current = false
          targetMidiRef.current = new Set()
          ps.playing = true
          ps.startTime = 0
          if (lastStatusRef.current !== 'playing') {
            lastStatusRef.current = 'playing'
            setPracticeStatus('playing')
            setTargetNoteNames([])
          }
        }
      } else if (!allHeld && noExtras && heldMidi.size > 0 && requiredMidi.size > 0) {
        // User is building the chord correctly (all held notes are valid targets,
        // just not all pressed yet). Reset grace timer — don't penalise.
        graceStartRef.current = null
      } else if (requiredMidi.size > 0 && ps.playing) {
        // Wrong/extra key held, no keys held, or missing notes with extras — grace timer then pause
        if (graceStartRef.current === null) {
          graceStartRef.current = timestamp
        } else if (timestamp - graceStartRef.current > GRACE_MS) {
          graceStartRef.current = null
          ps.playing = false
          ps.pausedAt = ps.elapsed
          practicePausedRef.current = true
          targetMidiRef.current = new Set(requiredMidi)
          synthRef.current?.stopAll()
          if (lastStatusRef.current !== 'waiting') {
            lastStatusRef.current = 'waiting'
            setPracticeStatus('waiting')
            setTargetNoteNames([...requiredMidi].map(midiToNoteName))
          }
        }
      } else {
        graceStartRef.current = null
      }
    }

    // Divider
    ctx.fillStyle = '#333'
    ctx.fillRect(0, keyboardTop - 1, w, 1)

    // ── White keys ──────────────────────────────────────────────────────────
    const whiteW = w / WHITE_KEY_COUNT
    for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
      const key = layout[midi]
      if (!key || key.black) continue

      const active = activeKeys[midi]
      let keyFill = active ? active.color : '#f5f5f5'

      if (practMode) {
        const held = heldMidi.has(midi)
        const isTarget = practicePaused ? targetMidi.has(midi) : requiredMidi.has(midi)
        if (held) keyFill = isTarget ? '#22c55e' : '#ef4444'
        else if (!held && active) keyFill = active.color
      } else if (heldMidi.has(midi)) {
        keyFill = '#eab308' // yellow for user-held keys in watch mode
      }

      ctx.fillStyle = keyFill
      ctx.fillRect(key.x, keyboardTop, key.width - 1, whiteKeyH)
      ctx.strokeStyle = '#999'; ctx.lineWidth = 0.5
      ctx.strokeRect(key.x, keyboardTop, key.width - 1, whiteKeyH)

      // Pulsing target outline
      if (practMode && practicePaused && targetMidi.has(midi) && !heldMidi.has(midi)) {
        const pulse = 0.5 + 0.5 * Math.sin(timestamp / 250)
        ctx.strokeStyle = `rgba(212,160,83,${0.55 + pulse * 0.45})`
        ctx.lineWidth = 3
        ctx.strokeRect(key.x + 1.5, keyboardTop + 1.5, key.width - 3.5, whiteKeyH - 3)
      }

      if (showLabels && midi % 12 === 0) {
        const octave = Math.floor(midi / 12) - 2
        ctx.fillStyle = active ? '#ffffffaa' : '#666'
        ctx.font = `${Math.min(Math.floor(whiteW * 0.5), 11)}px system-ui, sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
        ctx.fillText(`C${octave}`, key.x + key.width / 2, keyboardTop + whiteKeyH - 4)
      }
    }

    // ── Black keys ──────────────────────────────────────────────────────────
    for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
      const key = layout[midi]
      if (!key || !key.black) continue

      const active = activeKeys[midi]
      let keyFill = active ? active.dark : '#1a1a1a'

      if (practMode) {
        const held = heldMidi.has(midi)
        const isTarget = practicePaused ? targetMidi.has(midi) : requiredMidi.has(midi)
        if (held) keyFill = isTarget ? '#16a34a' : '#b91c1c'
      } else if (heldMidi.has(midi)) {
        keyFill = '#a16207' // dark yellow for black keys
      }

      ctx.fillStyle = keyFill
      ctx.fillRect(key.x, keyboardTop, key.width, blackKeyH)
      ctx.strokeStyle = '#444'; ctx.lineWidth = 0.5
      ctx.strokeRect(key.x, keyboardTop, key.width, blackKeyH)

      if (practMode && practicePaused && targetMidi.has(midi) && !heldMidi.has(midi)) {
        const pulse = 0.5 + 0.5 * Math.sin(timestamp / 250)
        ctx.strokeStyle = `rgba(212,160,83,${0.55 + pulse * 0.45})`
        ctx.lineWidth = 2.5
        ctx.strokeRect(key.x + 1.25, keyboardTop + 1.25, key.width - 2.5, blackKeyH - 2.5)
      }
    }

    animRef.current = requestAnimationFrame(draw)
  }, [])

  // ── Animation loop lifecycle ───────────────────────────────────────────────
  useEffect(() => {
    if (timeline.length === 0) return
    playStateRef.current.timeline = timeline
    playStateRef.current.tempo = tempo
    playStateRef.current.tempoMap = tempoMap
    animRef.current = requestAnimationFrame(draw)
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current) }
  }, [timeline, tempo, tempoMap, draw])

  useEffect(() => {
    if (timeline.length > 0 && !playStateRef.current.playing) {
      if (animRef.current) cancelAnimationFrame(animRef.current)
      animRef.current = requestAnimationFrame(draw)
    }
  }, [playbackSpeed, rightColor, leftColor, showNoteNames, showKeyLabels, draw, timeline])

  // ── Playback handlers ─────────────────────────────────────────────────────
  function resetPracticeState() {
    practicePausedRef.current = false
    targetMidiRef.current = new Set()
    confirmedTickRef.current = -1
    graceStartRef.current = null
    if (lastStatusRef.current !== 'playing') {
      lastStatusRef.current = 'playing'
      setPracticeStatus('playing')
      setTargetNoteNames([])
    }
  }

  async function handlePlay() {
    const ps = playStateRef.current
    if (ps.playing) return
    practiceWaitingRef.current = false
    setPracticeWaiting(false)
    if (soundEnabled && !synthRef.current) {
      synthRef.current = createSynth()
    }
    // Ensure AudioContext is running BEFORE the visual clock starts,
    // so both clocks are aligned from the same moment.
    if (soundEnabled && synthRef.current) {
      await synthRef.current.ensurePiano()
      await synthRef.current.ensureReady()
    }

    if (practiceModeRef.current && ps.timeline && ps.timeline.length > 0) {
      // Compute keyboard geometry to get leadInSec
      const canvas = canvasRef.current
      const h = canvas ? canvas.parentElement.getBoundingClientRect().height : 600
      const whiteKeyH = Math.max(h * WHITE_KEY_H_RATIO, 60)
      const keyboardTop = h - whiteKeyH
      const leadInSec = keyboardTop / FALL_PX_PER_SEC
      const speed = settingsRef.current.playbackSpeed
      const tMap = ps.tempoMap || [{ tick: 0, bpm: ps.tempo || 120 }]
      const tts = (tick) => tempoMapTickToSec(tick, tMap) / speed

      // Find the first unconfirmed note that has already landed (or is landing)
      // at the current paused position
      let rewindTick = null
      for (const entry of ps.timeline) {
        if (entry.tick <= confirmedTickRef.current) continue
        const landTime = tts(entry.tick) + leadInSec
        if (landTime <= ps.elapsed + 0.05) {
          rewindTick = entry.tick
          break
        }
      }

      if (rewindTick !== null) {
        // Rewind 1.5s before that note so bars come back down
        const newElapsed = Math.max(0, tts(rewindTick) + leadInSec - 1.5)
        ps.pausedAt = newElapsed
        // Un-confirm that note and everything after it
        confirmedTickRef.current = rewindTick - 1
        // Clear played-audio tracking for everything at/after the rewind point
        for (let i = 0; i < ps.timeline.length; i++) {
          if (ps.timeline[i].tick >= rewindTick - CHORD_TICK_WINDOW) {
            playedNotesRef.current.delete(`${i}`)
          }
        }
        synthRef.current?.stopAll()
      }

      // Clear any lingering practice-pause state
      practicePausedRef.current = false
      targetMidiRef.current = new Set()
      graceStartRef.current = null
      if (lastStatusRef.current !== 'playing') {
        lastStatusRef.current = 'playing'
        setPracticeStatus('playing')
        setTargetNoteNames([])
      }
    } else {
      resetPracticeState()
    }

    ps.playing = true; ps.startTime = 0
    ps.audioStartTime = synthRef.current?.getCtx?.()?.currentTime ?? null
    setPlaying(true)
    if (animRef.current) cancelAnimationFrame(animRef.current)
    animRef.current = requestAnimationFrame(draw)
  }

  function handlePause() {
    const ps = playStateRef.current
    ps.playing = false; ps.pausedAt = ps.elapsed; ps.audioStartTime = null
    practicePausedRef.current = false
    graceStartRef.current = null
    setPlaying(false)
    synthRef.current?.stopAll()
  }

  function handleStop() {
    const ps = playStateRef.current
    ps.playing = false; ps.startTime = 0; ps.elapsed = 0; ps.pausedAt = 0; ps.audioStartTime = null
    setPlaying(false)
    playedNotesRef.current.clear()
    synthRef.current?.stopAll()
    resetPracticeState()
    practiceWaitingRef.current = false
    setPracticeWaiting(false)
    if (canvasRef.current && timeline.length > 0) {
      if (animRef.current) cancelAnimationFrame(animRef.current)
      animRef.current = requestAnimationFrame(draw)
    }
  }

  function handleBack() {
    handleStop()
    synthRef.current?.close(); synthRef.current = null
    setMusicXml(null); setFilename(''); setTimeline([])
  }

  // ── Practice toggle ───────────────────────────────────────────────────────
  function handlePracticeToggle() {
    if (playing) handleStop()
    const turningOn = !practiceModeRef.current
    setPracticeMode(turningOn)
    if (turningOn && timeline.length > 0) {
      setPracticeWaiting(true)
    } else {
      setPracticeWaiting(false)
    }
  }

  // ── File handlers ─────────────────────────────────────────────────────────
  function handleUploadClick() { fileInputRef.current?.click() }

  function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name); handleStop()
    const reader = new FileReader()
    reader.onload = (evt) => setMusicXml(evt.target.result)
    if (file.name.endsWith('.mid') || file.name.endsWith('.midi') || file.name.endsWith('.mxl')) {
      reader.readAsArrayBuffer(file)
    } else {
      reader.readAsText(file)
    }
    e.target.value = ''
  }

  async function handleSelectDemo(piece) {
    setShowDemoModal(false); setFilename(piece.title); handleStop()
    const data = await loadDemoScore(piece)
    setMusicXml(data)
  }

  // ── Library handlers ──────────────────────────────────────────────────────
  async function refreshFolder(path) {
    if (!path) return
    setFolderLoading(true)
    try {
      const scores = await listScores(path)
      setFolderScores(scores)
    } catch (e) {
      console.error('[Library] listScores failed:', e)
      setFolderScores([])
    } finally {
      setFolderLoading(false)
    }
  }

  async function openLibrary() {
    setShowLibrary(true)
    if (folderPath) await refreshFolder(folderPath)
  }

  async function handlePickFolder() {
    const picked = await pickFolder()
    if (!picked) return
    setFolderPath(picked)
    await refreshFolder(picked)
  }

  async function handleChangeFolder() {
    const picked = await pickFolder()
    if (!picked) return
    setFolderPath(picked)
    await refreshFolder(picked)
  }

  async function handleLoadFolderScore(score) {
    setShowLibrary(false)
    try {
      const data = await loadScore(score)
      handleStop()
      setFilename(score.name.replace(/\.[^.]+$/, ''))
      setMusicXml(data)
    } catch (e) {
      console.error('[Library] loadScore failed:', e)
    }
  }

  // Keep handlePlayRef current so the MIDI handler (captured in a closure) can call it
  handlePlayRef.current = handlePlay

  // ---------------------------------------------------------------------------
  // JSX
  // ---------------------------------------------------------------------------
  return (
    <div className="h-screen flex flex-col overflow-hidden relative" style={{ background: 'var(--bg)', color: 'var(--ink)', fontFamily: "'Sora', sans-serif" }}>
      <Background />
      <main className="flex-1 flex flex-col min-h-0 relative z-10">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 shrink-0" style={{borderBottom:'1px solid var(--border)'}}>
          <div className="flex items-center gap-3">
            <a href="#/" className="transition-colors" style={{color:'var(--sub)'}} aria-label="Home">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </a>
            <svg width="28" height="28" viewBox="0 0 72 72" fill="none" aria-label="Pianly logo">
              <rect x="8" y="20" width="10" height="36" rx="2" fill="white"/>
              <rect x="20" y="20" width="10" height="36" rx="2" fill="white"/>
              <rect x="32" y="20" width="10" height="36" rx="2" fill="white"/>
              <rect x="44" y="20" width="10" height="36" rx="2" fill="white"/>
              <rect x="56" y="20" width="10" height="36" rx="2" fill="white"/>
              <rect x="15" y="20" width="8" height="22" rx="1.5" fill="oklch(0.12 0.025 270)"/>
              <rect x="27" y="20" width="8" height="22" rx="1.5" fill="oklch(0.12 0.025 270)"/>
              <rect x="47" y="20" width="8" height="22" rx="1.5" fill="oklch(0.12 0.025 270)"/>
              <rect x="59" y="20" width="8" height="22" rx="1.5" fill="oklch(0.12 0.025 270)"/>
              <circle cx="58" cy="14" r="4" fill="oklch(0.7 0.2 160)"/>
              <rect x="62" y="4" width="2.5" height="12" rx="1" fill="oklch(0.7 0.2 160)"/>
              <path d="M64.5 4 C64.5 4 70 6 70 9" stroke="oklch(0.7 0.2 160)" strokeWidth="2.5" strokeLinecap="round"/>
            </svg>
            <span className="text-lg font-bold" style={{color:'var(--ink)'}}>Visualizer</span>
            {filename && (
              <span className="text-sm hidden sm:inline" style={{color:'var(--sub)'}}>— {filename}</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Practice / Watch toggle */}
            {timeline.length > 0 && (
              <button
                onClick={handlePracticeToggle}
                className="hidden sm:flex items-center gap-1.5 px-3 h-9 rounded-lg text-xs font-bold transition-all cursor-pointer"
                style={practiceMode
                  ? {background:'var(--accent)',color:'#000',boxShadow:'0 4px 16px rgba(0,255,200,0.25)'}
                  : {border:'1px solid var(--border)',color:'var(--sub)'}}
                title={practiceMode ? 'Switch to Watch Mode' : 'Switch to Practice Mode'}
              >
                {practiceMode ? (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 100 20A10 10 0 0012 2zm-1 14.5v-9l7 4.5-7 4.5z"/></svg>
                    Practice
                  </>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="3"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/></svg>
                    Watch
                  </>
                )}
              </button>
            )}

            {timeline.length > 0 && (
              <>
                {/* Sound toggle */}
                <button
                  onClick={() => setSoundEnabled(v => !v)}
                  className="w-9 h-9 flex items-center justify-center rounded-lg transition-colors cursor-pointer"
                  style={soundEnabled
                    ? {border:'1px solid var(--accent)',color:'var(--accent)'}
                    : {border:'1px solid var(--border)',color:'var(--sub)'}}
                  aria-label={soundEnabled ? 'Mute' : 'Unmute'}
                >
                  {soundEnabled ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
                    </svg>
                  )}
                </button>

                {!playing ? (
                  <button
                    onClick={handlePlay}
                    className="w-9 h-9 flex items-center justify-center rounded-lg cursor-pointer"
                    style={{background:'var(--accent)',color:'#000'}}
                    aria-label="Play"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  </button>
                ) : (
                  <button
                    onClick={handlePause}
                    className="w-9 h-9 flex items-center justify-center rounded-lg transition-colors cursor-pointer"
                    style={{border:'1px solid var(--border)',color:'var(--sub)'}}
                    aria-label="Pause"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
                    </svg>
                  </button>
                )}

                <button
                  onClick={handleStop}
                  className="w-9 h-9 flex items-center justify-center rounded-lg transition-colors cursor-pointer"
                  style={{border:'1px solid var(--border)',color:'var(--sub)'}}
                  aria-label="Stop"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                </button>
              </>
            )}

            <button
              onClick={() => setShowSettings(v => !v)}
              className="w-9 h-9 flex items-center justify-center rounded-lg transition-colors cursor-pointer"
              style={{border:'1px solid var(--border)',color:'var(--sub)'}}
              aria-label="Settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
              </svg>
            </button>
          </div>
        </div>

        {/* ── Practice status bar ─────────────────────────────────────────── */}
        {practiceMode && musicXml && playing && (
          <div className="px-4 py-1.5 shrink-0 text-center transition-colors"
            style={practiceStatus === 'waiting'
              ? {background:'rgba(0,255,200,0.06)',borderBottom:'1px solid rgba(0,255,200,0.25)'}
              : {background:'var(--panel)',borderBottom:'1px solid var(--border)'}}>
            {practiceStatus === 'waiting' ? (
              <span className="text-xs font-semibold" style={{color:'var(--ink)',opacity:.85}}>
                Waiting for: {targetNoteNames.join(' + ')}
              </span>
            ) : (
              <span className="text-xs font-medium" style={{color:'var(--ink)',opacity:.85}}>Playing</span>
            )}
          </div>
        )}

        {/* ── Settings panel ──────────────────────────────────────────────── */}
        {showSettings && (
          <div className="px-4 sm:px-6 py-4 shrink-0" style={{borderBottom:'1px solid var(--border)',background:'oklch(0.12 0.025 270 / 0.8)'}}>
            <div className="max-w-2xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <label className="text-[10px] uppercase tracking-wider font-medium mb-1.5 block" style={{color:'var(--sub)'}}>
                  Speed: {Math.round(playbackSpeed * 100)}%
                </label>
                <input type="range" min="0.25" max="2" step="0.05" value={playbackSpeed}
                  onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                  className="w-full"
                  style={{ accentColor: 'var(--accent)' }}
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-medium mb-1.5 block" style={{color:'var(--sub)'}}>Right Hand</label>
                <input type="color" value={rightColor} onChange={(e) => setRightColor(e.target.value)}
                  className="w-full h-8 rounded bg-transparent cursor-pointer" style={{border:'1px solid var(--border)'}}
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-medium mb-1.5 block" style={{color:'var(--sub)'}}>Left Hand</label>
                <input type="color" value={leftColor} onChange={(e) => setLeftColor(e.target.value)}
                  className="w-full h-8 rounded bg-transparent cursor-pointer" style={{border:'1px solid var(--border)'}}
                />
              </div>
              <div className="flex flex-col gap-2">
                <button onClick={() => setShowNoteNames(v => !v)}
                  className="text-xs px-3 py-1.5 rounded-lg cursor-pointer transition-colors"
                  style={showNoteNames ? {border:'1px solid var(--accent)',color:'var(--accent)'} : {border:'1px solid var(--border)',color:'var(--sub)'}}>
                  Note Names {showNoteNames ? 'ON' : 'OFF'}
                </button>
                <button onClick={() => setShowKeyLabels(v => !v)}
                  className="text-xs px-3 py-1.5 rounded-lg cursor-pointer transition-colors"
                  style={showKeyLabels ? {border:'1px solid var(--accent)',color:'var(--accent)'} : {border:'1px solid var(--border)',color:'var(--sub)'}}>
                  Key Labels {showKeyLabels ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>

            {/* Practice mode MIDI device selector */}
            {practiceMode && midiDevices.length > 1 && (
              <div className="max-w-2xl mx-auto mt-4 pt-4" style={{borderTop:'1px solid var(--border)'}}>
                <label className="text-[10px] uppercase tracking-wider font-medium mb-1.5 block" style={{color:'var(--sub)'}}>
                  Practice Input Device
                </label>
                <select
                  value={selectedDeviceId ?? ''}
                  onChange={(e) => { setSelectedDeviceId(e.target.value); connectMidiDevice(e.target.value) }}
                  className="text-xs rounded-lg px-3 py-2 cursor-pointer"
                  style={{background:'var(--bg)',border:'1px solid var(--border)',color:'var(--ink)'}}
                >
                  {midiDevices.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}
            {practiceMode && midiDevices.length === 0 && (
              <div className="max-w-2xl mx-auto mt-4 pt-4" style={{borderTop:'1px solid var(--border)'}}>
                <p className="text-xs" style={{color:'var(--sub)'}}>No MIDI devices detected. Connect a MIDI keyboard to use Practice Mode.</p>
              </div>
            )}
          </div>
        )}

        {/* ── Main content ────────────────────────────────────────────────── */}
        {!musicXml ? (
          <div className="flex-1 flex flex-col items-center justify-center px-4">
            <h2 className="text-3xl sm:text-4xl font-bold mb-3" style={{color:'var(--ink)'}}>Visualizer</h2>
            <p className="text-sm mb-8 text-center" style={{color:'var(--sub)'}}>
              Watch notes fall onto a piano keyboard. Upload a MusicXML file to get started.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
              <button onClick={handleUploadClick}
                className="px-8 py-3 rounded-lg font-bold text-base cursor-pointer"
                style={{background:'var(--accent)',color:'#000',boxShadow:'0 8px 24px rgba(0,255,200,0.25)'}}>
                Upload MIDI / MusicXML
              </button>
              <button onClick={() => setShowDemoModal(true)}
                className="px-8 py-3 rounded-lg font-bold text-base cursor-pointer"
                style={{border:'1.5px solid var(--accent)',color:'var(--accent)'}}>
                Try a Demo Piece
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 relative min-h-0">
            <canvas ref={canvasRef} className="w-full h-full block" />
            {timeline.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center" style={{color:'var(--sub)'}}>
                No notes found in this file.
              </div>
            )}
            {practiceWaiting && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="rounded-2xl px-8 py-6 text-center backdrop-blur-sm" style={{background:'rgba(0,0,0,0.7)',border:'1px solid var(--border)'}}>
                  <div className="text-4xl mb-3">🎹</div>
                  <p className="font-bold text-lg" style={{color:'var(--ink)'}}>Play any key to begin</p>
                  <p className="text-sm mt-1" style={{color:'var(--sub)'}}>Practice mode is ready</p>
                </div>
              </div>
            )}
            {/* Mobile practice toggle overlay */}
            {timeline.length > 0 && (
              <button
                onClick={handlePracticeToggle}
                className="sm:hidden absolute top-3 right-3 flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-bold transition-all cursor-pointer"
                style={practiceMode
                  ? {background:'var(--accent)',color:'#000'}
                  : {border:'1px solid var(--border)',color:'var(--sub)',background:'rgba(0,0,0,0.6)',backdropFilter:'blur(8px)'}}
              >
                {practiceMode ? 'Practice' : 'Watch'}
              </button>
            )}
          </div>
        )}
      </main>

      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" accept=".xml,.musicxml,.mxl,.mid,.midi" onChange={handleFileChange} className="hidden" />

      {/* Demo picker modal */}
      {showDemoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowDemoModal(false) }}>
          <div className="rounded-2xl w-full max-w-lg p-5 sm:p-6" style={{ background: 'var(--panel)', border: '1px solid var(--border)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
            <div className="flex items-center justify-between mb-5 sm:mb-6">
              <h2 className="text-lg sm:text-xl font-bold" style={{color:'var(--ink)'}}>Choose a Demo Piece</h2>
              <button onClick={() => setShowDemoModal(false)} className="hover:text-white transition-colors cursor-pointer" style={{color:'var(--sub)'}} aria-label="Close">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </div>
            <div className="flex flex-col gap-3">
              {DEMO_PIECES.map((piece) => (
                <button key={piece.id} onClick={() => handleSelectDemo(piece)}
                  className="flex items-center justify-between p-4 rounded-xl transition-all cursor-pointer text-left"
                  style={{border:'1px solid var(--border)'}}>
                  <div className="min-w-0 mr-3">
                    <div className="font-semibold truncate" style={{color:'var(--ink)'}}>{piece.title}</div>
                    <div className="text-sm mt-0.5" style={{color:'var(--sub)'}}>{piece.composer}</div>
                  </div>
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap shrink-0" style={{background:'rgba(0,255,200,0.1)',color:'var(--ink)',border:'1px solid var(--border)'}}>{piece.difficulty}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Library modal ─────────────────────────────────────────────────── */}
      {showLibrary && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowLibrary(false) }}>
          <div className="rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col p-5 sm:p-6"
            style={{ background: 'var(--panel)', border: '1px solid var(--border)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>

            {/* Header */}
            <div className="flex items-center justify-between mb-4 shrink-0">
              <h2 className="text-lg font-bold" style={{color:'var(--ink)'}}>Song Library</h2>
              <button onClick={() => setShowLibrary(false)} className="hover:text-white transition-colors cursor-pointer" style={{color:'var(--sub)'}} aria-label="Close">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mb-4 shrink-0 rounded-lg p-1" style={{background:'rgba(0,255,200,0.04)'}}>
              {[['mysongs', 'My Scores'], ['demos', 'Demo Pieces']].map(([tab, label]) => (
                <button key={tab} onClick={() => setLibraryTab(tab)}
                  className="flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer"
                  style={libraryTab === tab ? {background:'var(--accent)',color:'#000'} : {color:'var(--sub)'}}>
                  {label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto min-h-0">
              {libraryTab === 'mysongs' && (
                <div className="flex flex-col gap-2">
                  {!folderPath ? (
                    <div className="flex flex-col items-center gap-3 py-10 text-center">
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{color:'var(--sub)'}}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                      <p className="text-sm" style={{color:'var(--sub)'}}>No scores folder set.<br/>Pick a folder containing your MusicXML files.</p>
                      <button onClick={handlePickFolder}
                        className="px-5 py-2.5 rounded-xl text-sm font-bold cursor-pointer"
                        style={{background:'var(--accent)',color:'#000'}}>
                        Choose Scores Folder
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <p className="text-xs truncate flex-1" style={{color:'var(--sub)'}} title={folderPath}>{folderPath}</p>
                        <div className="flex gap-1 shrink-0">
                          <button onClick={() => refreshFolder(folderPath)} title="Refresh"
                            className="w-7 h-7 flex items-center justify-center rounded-lg hover:text-white hover:bg-white/10 transition-colors cursor-pointer" style={{color:'var(--sub)'}}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
                          </button>
                          <button onClick={handleChangeFolder}
                            className="px-2.5 py-1 rounded-lg text-xs hover:text-white transition-colors cursor-pointer"
                            style={{border:'1px solid var(--border)',color:'var(--sub)'}}>
                            Change
                          </button>
                        </div>
                      </div>
                      {folderLoading ? (
                        <p className="text-sm text-center py-8" style={{color:'var(--sub)'}}>Scanning folder…</p>
                      ) : folderScores.length === 0 ? (
                        <p className="text-sm text-center py-8" style={{color:'var(--sub)'}}>No valid score files found (.xml, .musicxml, .mxl, .mid).</p>
                      ) : folderScores.map(score => (
                        <div key={score.path} className="flex items-center justify-between p-3 rounded-xl transition-colors" style={{border:'1px solid var(--border)'}}>
                          <div className="min-w-0 mr-3">
                            <div className="font-medium text-sm truncate" style={{color:'var(--ink)'}}>{score.name.replace(/\.[^.]+$/, '')}</div>
                            <div className="text-xs mt-0.5" style={{color:'var(--sub)'}}>{score.name.split('.').pop().toUpperCase()}</div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button onClick={() => handleLoadFolderScore(score)}
                              className="px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer"
                              style={{background:'var(--accent)',color:'#000'}}>
                              Load
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}

              {libraryTab === 'demos' && (
                <div className="flex flex-col gap-2">
                  {DEMO_PIECES.map(piece => (
                    <div key={piece.id} className="flex items-center justify-between p-3 rounded-xl transition-colors" style={{border:'1px solid var(--border)'}}>
                      <div className="min-w-0 mr-3">
                        <div className="font-semibold text-sm truncate" style={{color:'var(--ink)'}}>{piece.title}</div>
                        <div className="text-xs mt-0.5" style={{color:'var(--sub)'}}>{piece.composer}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{background:'rgba(0,255,200,0.1)',color:'var(--ink)',border:'1px solid var(--border)'}}>
                          {piece.difficulty}
                        </span>
                        <button onClick={() => { setShowLibrary(false); handleSelectDemo(piece) }}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer"
                          style={{background:'var(--accent)',color:'#000'}}>
                          Load
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
