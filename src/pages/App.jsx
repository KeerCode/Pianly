import { useState, useRef, useEffect, useCallback } from 'react'
import DOMPurify from 'dompurify'
import createVerovioModule from 'verovio/wasm'
import { VerovioToolkit } from 'verovio/esm'
import * as Tone from 'tone'
import { SplendidGrandPiano } from 'smplr'
import { DEMO_PIECES, loadDemoScore } from '../data/demoScores'
import { getSavedFolder, pickFolder, listScores, loadScore } from '../lib/scoreFolder'
import { enableMidi, listenToDevice, notesMatch, onDevicesChanged } from '../input/midiInput'
import { startBasicPitchDetection, loadBasicPitchModel, isBasicPitchReady } from '../input/pitchDetector'
import { parseNoteTimelineOSMD } from '../parsers/osmdParser'
import { tickToSec } from '../parsers/parseTimeline'
import Background from '../Background'
import { useTheme } from '../ThemeContext'

/**
 * Inject <print new-system="yes"/> at every time-signature change in the first part.
 * This forces Verovio to start a new visual system at each meter change, preventing
 * measures from being split across line breaks (which breaks timemap continuity).
 */
function injectSystemBreaksAtTimeSigChange(xmlStr) {
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlStr, 'text/xml')
    if (doc.querySelector('parsererror')) return xmlStr

    const part = doc.querySelector('part')
    if (!part) return xmlStr

    let firstTimeSigSeen = false
    for (const measure of part.querySelectorAll('measure')) {
      if (!measure.querySelector('attributes > time')) continue
      if (!firstTimeSigSeen) { firstTimeSigSeen = true; continue }
      if (!measure.querySelector('print[new-system]')) {
        const printEl = doc.createElement('print')
        printEl.setAttribute('new-system', 'yes')
        measure.insertBefore(printEl, measure.firstChild)
      }
    }

    return new XMLSerializer().serializeToString(doc)
  } catch {
    return xmlStr
  }
}

const ADVANCE_COOLDOWN_MS = 150
const HINT_DELAY_MS = 3000
const MAX_WRONG_ATTEMPTS = 3

const INTERVAL_NAMES = [
  'Unison', 'Minor 2nd', 'Major 2nd', 'Minor 3rd', 'Major 3rd',
  'Perfect 4th', 'Tritone', 'Perfect 5th', 'Minor 6th', 'Major 6th',
  'Minor 7th', 'Major 7th', 'Octave',
]

/** Convert note name like "C#3" to a MIDI-like number for interval math */
function noteToMidi(name) {
  const m = name.match(/^([A-G])(#|b)?(\d+)$/)
  if (!m) return null
  const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  let semi = BASE[m[1]]
  if (semi == null) return null
  if (m[2] === '#') semi++
  else if (m[2] === 'b') semi--
  return semi + (parseInt(m[3]) + 2) * 12 // +2 to match MIDI convention
}


/** Get interval name between two note names (uses lowest note of each entry) */
function getInterval(prevNotes, curNotes) {
  if (!prevNotes?.length || !curNotes?.length) return null
  const a = noteToMidi(prevNotes[0])
  const b = noteToMidi(curNotes[0])
  if (a == null || b == null) return null
  const diff = Math.abs(b - a)
  if (diff > 12) return `${INTERVAL_NAMES[diff % 12]} +${Math.floor(diff / 12)}oct`
  return INTERVAL_NAMES[diff] ?? `${diff} semitones`
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

function App() {
  const [musicXml, setMusicXml] = useState(null)
  const [filename, setFilename] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('idle') // 'idle' | 'listen' | 'practice'
  const [currentNoteIndex, setCurrentNoteIndex] = useState(0)
  const [noteTimeline, setNoteTimeline] = useState([])
  const [detectedNote, setDetectedNote] = useState(null)
  const [completed, setCompleted] = useState(false)
  const [paused, setPaused] = useState(false)
  const [showDemoModal, setShowDemoModal] = useState(false)
  const [showSheetPicker, setShowSheetPicker] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showHomeSettings, setShowHomeSettings] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const [libraryTab, setLibraryTab] = useState('mysongs')
  const [folderPath, setFolderPath] = useState(() => getSavedFolder())
  const [folderScores, setFolderScores] = useState([])
  const [folderLoading, setFolderLoading] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [bpm, setBpm] = useState(null)
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0)
  const [playerProgress, setPlayerProgress] = useState(0)
  const [inputError, setInputError] = useState(null)
  const [micPermission, setMicPermission] = useState(null)
  const [showMicPrompt, setShowMicPrompt] = useState(false)

  // Input state
  const [midiSupported, setMidiSupported] = useState(null)
  const [midiDevices, setMidiDevices] = useState([])
  const [selectedDeviceId, setSelectedDeviceId] = useState(null)
  const [anyOctave, setAnyOctave] = useState(false)
  const [inputMode, setInputMode] = useState(() => localStorage.getItem('nf-input') || 'midi')
  const [autoscroll, setAutoscroll] = useState(true)
  const [modelLoading, setModelLoading] = useState(false)
  const [modelReady, setModelReady] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [debugLog, setDebugLog] = useState([])

  const fileInputRef = useRef(null)
  const svgContainerRef = useRef(null)   // Verovio SVG output container
  const vrvRef = useRef(null)            // VerovioToolkit instance
  const vrvModuleRef = useRef(null)      // Verovio WASM module
  const tempoMapRef = useRef([{ tick: 0, bpm: 120 }]) // from OSMD parse

  const toneSamplerRef = useRef(null)
  const tonePartRef = useRef(null)
  const toneListenRafRef = useRef(null)
  const listenEndWallSecRef = useRef(0)  // total wall-clock duration at current playback speed
  const listenTotalMusicalSecRef = useRef(0) // total musical duration (at original tempo)
  const vrvCursorScheduleRef = useRef(null) // [{tstampMs, ids[]}] — cursor highlight events

  const stopListenerRef = useRef(null)
  const stopMicRef = useRef(null)
  const advanceCooldownRef = useRef(false)
  const wrongTimerRef = useRef(null)

  const currentNoteIndexRef = useRef(0)
  const noteTimelineRef = useRef([])
  const completedRef = useRef(false)
  const pausedRef = useRef(false)
  const anyOctaveRef = useRef(false)
  const modeRef = useRef('idle')
  const heldNotesRef = useRef(new Set())
  const waitingForReleaseRef = useRef(false) // true = correct note played, waiting for release to advance
  const wrongCountRef = useRef(0) // counts wrong attempts for current note
  const lastTickSetRef = useRef(-1)
  const autoscrollRef = useRef(true)
  const playbackSpeedRef = useRef(1.0)

  useEffect(() => { currentNoteIndexRef.current = currentNoteIndex }, [currentNoteIndex])
  useEffect(() => { noteTimelineRef.current = noteTimeline }, [noteTimeline])
  useEffect(() => { completedRef.current = completed }, [completed])
  useEffect(() => { pausedRef.current = paused }, [paused])
  useEffect(() => { anyOctaveRef.current = anyOctave }, [anyOctave])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { autoscrollRef.current = autoscroll }, [autoscroll])
  useEffect(() => { playbackSpeedRef.current = playbackSpeed }, [playbackSpeed])
  useEffect(() => { localStorage.setItem('nf-input', inputMode) }, [inputMode])

  // Load song passed from FolderLibrary via sessionStorage
  useEffect(() => {
    const raw = sessionStorage.getItem('nf-practice-song')
    if (!raw) return
    sessionStorage.removeItem('nf-practice-song')
    try {
      const { name, type, data } = JSON.parse(raw)
      setFilename(name)
      if (type === 'binary') {
        const binary = atob(data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        setMusicXml(bytes.buffer)
      } else {
        setMusicXml(data)
      }
    } catch (e) { console.error('Failed to load practice song from sessionStorage', e) }
  }, [])

  // Reset hint on note change
  useEffect(() => {
    setShowHint(false)
    clearTimeout(wrongTimerRef.current)
    wrongTimerRef.current = null
  }, [currentNoteIndex])

  // Debug log helper
  const pushDebug = useCallback((type, data) => {
    const entry = { time: Date.now(), type, data }
    console.log(`[NF-DEBUG] ${type}:`, data)
    setDebugLog((prev) => [...prev.slice(-4), entry])
  }, [])

  // Toggle debug panel with "D" key
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
        setShowDebug((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Init SplendidGrandPiano — lazy-loading, no upfront wait required
  useEffect(() => {
    Tone.getTransport().PPQ = 960
    const audioCtx = Tone.getContext().rawContext
    const piano = new SplendidGrandPiano(audioCtx, { decayTime: 8 })
    toneSamplerRef.current = piano
    return () => {
      Tone.getTransport().stop()
      Tone.getTransport().cancel()
      tonePartRef.current?.dispose()
      tonePartRef.current = null
      piano.stop()
      toneSamplerRef.current = null
    }
  }, [])

  // Preload Verovio WASM module eagerly (so first render is fast)
  useEffect(() => {
    createVerovioModule()
      .then((mod) => { vrvModuleRef.current = mod })
      .catch((err) => console.error('[Verovio] WASM preload failed:', err))
    return () => {
      vrvRef.current?.destroy()
      vrvRef.current = null
    }
  }, [])

  // Preload Basic Pitch model when mic mode is selected
  useEffect(() => {
    if (inputMode !== 'mic') return
    if (isBasicPitchReady()) {
      setModelReady(true)
      return
    }
    setModelLoading(true)
    loadBasicPitchModel()
      .then(() => { setModelReady(true); setModelLoading(false) })
      .catch((err) => { console.error('[BasicPitch] Model load failed:', err); setModelLoading(false) })
  }, [inputMode])

  // Check microphone permission
  useEffect(() => {
    if (inputMode !== 'mic') return
    async function checkMicPermission() {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' })
        setMicPermission(status.state)
        // Only prompt if the browser explicitly says the user hasn't decided yet
        if (status.state === 'prompt') setShowMicPrompt(true)
        status.addEventListener('change', () => {
          setMicPermission(status.state)
          if (status.state === 'granted') setShowMicPrompt(false)
        })
      } catch {
        // navigator.permissions.query unsupported (Tauri WebView, Firefox, etc.)
        // Don't show the prompt — let getUserMedia surface the real error when needed
      }
    }
    checkMicPermission()
  }, [inputMode])

  // Probe MIDI on mount
  useEffect(() => {
    enableMidi().then(({ supported, inputs }) => {
      setMidiSupported(supported)
      setMidiDevices(inputs)
      if (inputs.length > 0) {
        setSelectedDeviceId(inputs[0].id)
        setInputMode('midi')
      } else {
        setInputMode('mic')
      }
      const removeListener = onDevicesChanged((updatedInputs) => {
        setMidiDevices(updatedInputs)
        setSelectedDeviceId((prev) => {
          if (prev && updatedInputs.some((d) => d.id === prev)) return prev
          return updatedInputs.length > 0 ? updatedInputs[0].id : null
        })
        if (updatedInputs.length > 0) setInputMode('midi')
      })
      return removeListener
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Parse MusicXML timeline whenever musicXml changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!musicXml) {
      setNoteTimeline([])
      return
    }
    let xmlStr = musicXml
    if (musicXml instanceof ArrayBuffer || musicXml instanceof Uint8Array) {
      try {
        xmlStr = new TextDecoder().decode(musicXml)
      } catch {
        xmlStr = null
      }
    }
    if (xmlStr && typeof xmlStr === 'string') {
      let cancelled = false
      parseNoteTimelineOSMD(xmlStr)
        .then(({ timeline, tempoMap }) => {
          if (cancelled) return
          setNoteTimeline(timeline)
          setCurrentNoteIndex(0)
          tempoMapRef.current = tempoMap
          if (tempoMap && tempoMap.length > 0) setBpm(tempoMap[0].bpm)
          pushDebug('osmdParsed', {
            count: timeline.length,
            bpm: tempoMap?.[0]?.bpm,
            first3: timeline.slice(0, 3).map(e => ({ tick: e.tick, measure: e.measure, notes: e.notes })),
          })
        })
        .catch((err) => {
          console.error('[OSMD Parse]', err)
          if (!cancelled) setNoteTimeline([])
        })
      return () => { cancelled = true }
    }
  }, [musicXml, pushDebug])

  // ---------------------------------------------------------------------------
  // Verovio — render MusicXML to SVG
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!musicXml) {
      if (svgContainerRef.current) svgContainerRef.current.innerHTML = ''
      return
    }

    let cancelled = false
    let xmlStr = musicXml
    if (xmlStr instanceof ArrayBuffer || xmlStr instanceof Uint8Array) {
      try { xmlStr = new TextDecoder().decode(xmlStr) } catch { xmlStr = null }
    }
    if (!xmlStr || typeof xmlStr !== 'string') return

    setLoading(true)
    setError(null)

    async function render() {
      // Initialize WASM module if not already done
      if (!vrvModuleRef.current) {
        vrvModuleRef.current = await createVerovioModule()
      }
      if (cancelled) return

      // Create toolkit once and reuse
      if (!vrvRef.current) {
        vrvRef.current = new VerovioToolkit(vrvModuleRef.current)
      }

      const tk = vrvRef.current
      tk.setOptions({
        svgViewBox: true,
        adjustPageHeight: true,
        breaks: 'smart',  // respects injected <print new-system> breaks
        pageMarginTop: 25,
        pageMarginBottom: 25,
        pageMarginLeft: 50,
        pageMarginRight: 50,
      })

      // Inject system breaks at time-sig changes so measures never split across lines
      tk.loadData(injectSystemBreaksAtTimeSigChange(xmlStr))

      const pageCount = tk.getPageCount()
      let svgHtml = ''
      for (let p = 1; p <= pageCount; p++) {
        svgHtml += tk.renderToSVG(p)
      }

      if (cancelled || !svgContainerRef.current) return
      svgContainerRef.current.innerHTML = DOMPurify.sanitize(svgHtml, { USE_PROFILES: { svg: true, svgFilters: true } })

      // Build cursor schedule from Verovio's timemap (for visual highlighting only).
      // Audio pitches come from OSMD noteTimeline to ensure correct flat note MIDI values.
      try {
        tk.renderToMIDI()  // populates getMIDIValuesForElement data needed for cursor IDs
        const timemap = tk.renderToTimemap()
        const cursorEvents = []  // {tstampMs, ids[]} — bypasses getElementsAtTime for cursor
        for (const ev of timemap) {
          const tstampMs = ev.tstamp ?? 0
          const noteIds = []
          for (const id of (ev.on || [])) {
            try {
              const midi = tk.getMIDIValuesForElement(id)
              if (!midi || !(midi.pitch > 0)) continue
              noteIds.push(id)
            } catch {}
          }
          if (noteIds.length > 0) cursorEvents.push({ tstampMs, ids: noteIds })
        }
        cursorEvents.sort((a, b) => a.tstampMs - b.tstampMs)
        vrvCursorScheduleRef.current = cursorEvents.length > 0 ? cursorEvents : null
        pushDebug('vrvSchedule', {
          cursorCount: cursorEvents.length,
          timemapLen: timemap.length,
        })
      } catch (err) {
        console.warn('[Verovio] timemap failed:', err)
        pushDebug('vrvScheduleErr', { err: String(err) })
      }

      setLoading(false)
    }

    render().catch((err) => {
      console.error('[Verovio]', err)
      if (!cancelled) {
        setError('Failed to render sheet music. Check the file format.')
        setLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [musicXml])

  // (Speed is applied at listen-start time via timeSec scheduling; no mid-listen BPM change needed)

  // Sync Verovio cursor when note index changes (practice mode)
  useEffect(() => {
    if (mode !== 'practice') return

    const entry = noteTimeline[currentNoteIndex]
    if (!entry) return

    if (lastTickSetRef.current !== entry.tick) {
      lastTickSetRef.current = entry.tick
      const ms = entry.cursorSec != null
        ? entry.cursorSec * 1000
        : entry.timeSec != null
          ? entry.timeSec * 1000
          : tickToSec(entry.tick, tempoMapRef.current) * 1000
      highlightVerovioAtMs(ms, 'instant')
    }
  }, [mode, currentNoteIndex, noteTimeline])

  // ---------------------------------------------------------------------------
  // Verovio cursor helpers
  // ---------------------------------------------------------------------------
  function clearVerovioHighlights() {
    svgContainerRef.current?.querySelectorAll('.current-note').forEach((el) => {
      el.classList.remove('current-note')
    })
  }

  function highlightVerovioAtMs(ms, scrollBehavior = 'smooth') {
    const tk = vrvRef.current
    const container = svgContainerRef.current
    if (!tk || !container) return

    clearVerovioHighlights()

    try {
      const result = tk.getElementsAtTime(Math.round(ms))
      const ids = [...(result.notes || []), ...(result.chords || [])]
      for (const id of ids) {
        const el = container.querySelector(`#${id}`)
        if (el) el.classList.add('current-note')
      }

      if (autoscrollRef.current && ids.length > 0) {
        const firstEl = container.querySelector(`#${ids[0]}`)
        if (firstEl) {
          requestAnimationFrame(() => {
            const rect = firstEl.getBoundingClientRect()
            const viewportH = window.innerHeight
            if (rect.bottom > viewportH - 40 || rect.top < 80) {
              firstEl.scrollIntoView({ block: 'center', behavior: scrollBehavior })
            }
          })
        }
      }
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Practice mode: advance on correct input
  // ---------------------------------------------------------------------------

  // Advance to the next note, skipping any tied notes
  const doAdvance = useCallback(() => {
    advanceCooldownRef.current = true
    setTimeout(() => { advanceCooldownRef.current = false }, ADVANCE_COOLDOWN_MS)

    let nextIdx = currentNoteIndexRef.current + 1
    const tl = noteTimelineRef.current

    // Auto-skip tied notes (notes connected by curves)
    while (nextIdx < tl.length && nextIdx > 0 && tl[nextIdx - 1].isTied) {
      nextIdx++
    }

    if (nextIdx >= tl.length) {
      setCompleted(true)
    } else {
      wrongCountRef.current = 0
      setShowHint(false)
      clearTimeout(wrongTimerRef.current)
      wrongTimerRef.current = null

      // If there's a significant time gap before the next note (i.e. a measure rest),
      // wait that duration before advancing — cursor stays on the current note.
      const prevEntry = tl[currentNoteIndexRef.current]
      const nextEntry = tl[nextIdx]
      const prevEnd = (prevEntry?.timeSec ?? 0) + (prevEntry?.durationSec ?? 0)
      const gapMs = Math.max(0, ((nextEntry?.timeSec ?? 0) - prevEnd) * 1000)
      const REST_THRESHOLD_MS = 400 // gaps shorter than this are notation artifacts, not rests

      // Only wait if there is at least one completely empty measure between the two entries
      // (i.e. both hands rest for an entire bar). If the next note is in the immediately
      // following measure, the gap is just the tail of the current bar after its last note —
      // a whole rest on the other hand doesn't mean pause; advance immediately.
      const measuresSkipped = (nextEntry?.measure ?? 1) - (prevEntry?.measure ?? 1)
      if (gapMs >= REST_THRESHOLD_MS && measuresSkipped > 1) {
        setTimeout(() => setCurrentNoteIndex(nextIdx), gapMs)
      } else {
        setCurrentNoteIndex(nextIdx)
      }
    }
  }, [])

  // Play the target note(s) via SplendidGrandPiano as a hint
  const playTargetHint = useCallback(() => {
    const piano = toneSamplerRef.current
    const target = noteTimelineRef.current[currentNoteIndexRef.current]
    if (!piano || !target) return
    Tone.start().then(() => {
      const time = Tone.getContext().rawContext.currentTime
      for (const noteName of target.notes) {
        const midi = noteToMidi(noteName)
        if (midi !== null) piano.start({ note: midi, time, duration: 1.5 })
      }
    })
  }, [])

  // Called when notes are detected (MIDI noteOn or mic detection)
  const checkNotes = useCallback(() => {
    if (completedRef.current || pausedRef.current) return
    if (modeRef.current !== 'practice') return
    if (advanceCooldownRef.current) return

    const idx = currentNoteIndexRef.current
    const target = noteTimelineRef.current[idx]
    if (!target) return

    const targetNotes = target.notes
    const anyOct = anyOctaveRef.current
    const held = [...heldNotesRef.current]

    if (held.length === 0) return

    // Check: every target note is held
    const allTargetsHeld = targetNotes.every((tn) =>
      held.some((h) => notesMatch(h, tn, anyOct))
    )

    // Check: no extra notes beyond the target
    const noExtras = held.every((h) =>
      targetNotes.some((tn) => notesMatch(h, tn, anyOct))
    )

    console.log(`[SheetPractice] TARGET=[${targetNotes.join(', ')}]  HELD=[${held.join(', ')}]  allHeld=${allTargetsHeld}  noExtras=${noExtras}`)

    if (allTargetsHeld && noExtras) {
      // Correct — wait for release before advancing
      waitingForReleaseRef.current = true
      clearTimeout(wrongTimerRef.current)
      wrongTimerRef.current = null
      setShowHint(false)
      wrongCountRef.current = 0
    } else if (noExtras && !allTargetsHeld) {
      // User is still building the chord — all held notes are valid targets,
      // just not all of them pressed yet. Don't penalize, just wait.
    } else {
      // Wrong note(s) played — at least one held note is not in the target
      waitingForReleaseRef.current = false
      wrongCountRef.current++

      if (wrongCountRef.current >= MAX_WRONG_ATTEMPTS) {
        // Play the target note as a hint
        setShowHint(true)
        playTargetHint()
        wrongCountRef.current = 0
      } else if (!wrongTimerRef.current) {
        wrongTimerRef.current = setTimeout(() => {
          wrongTimerRef.current = null
          setShowHint(true)
        }, HINT_DELAY_MS)
      }
    }
  }, [playTargetHint])

  // Called when all notes are released
  const handleRelease = useCallback(() => {
    if (waitingForReleaseRef.current) {
      waitingForReleaseRef.current = false
      doAdvance()
    }
  }, [doAdvance])

  const handleNoteOff = useCallback((note) => {
    heldNotesRef.current.delete(note)
    if (heldNotesRef.current.size === 0) {
      setDetectedNote(null)
      handleRelease()
    } else {
      setDetectedNote([...heldNotesRef.current].join(' + '))
    }
  }, [handleRelease])

  // Auto-reconnect MIDI when device changes mid-practice
  useEffect(() => {
    if (mode !== 'practice' || inputMode !== 'midi' || !selectedDeviceId) return

    stopListenerRef.current?.()
    stopListenerRef.current = null

    let cancelled = false
    ;(async () => {
      const stop = await listenToDevice(
        selectedDeviceId,
        (note) => {
          heldNotesRef.current.add(note)
          setDetectedNote([...heldNotesRef.current].join(' + '))
          checkNotes()
        },
        handleNoteOff,
      )
      if (cancelled) { stop?.(); return }
      if (stop) {
        stopListenerRef.current = stop
        setInputError(null)
      }
    })()

    return () => { cancelled = true }
  }, [selectedDeviceId, mode, inputMode, checkNotes, handleNoteOff])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopListenerRef.current?.()
      stopMicRef.current?.()
      clearTimeout(wrongTimerRef.current)
    }
  }, [])

  function stopToneListenLoop() {
    if (toneListenRafRef.current) {
      cancelAnimationFrame(toneListenRafRef.current)
      toneListenRafRef.current = null
    }
  }

  function stopAllInputs() {
    stopListenerRef.current?.()
    stopListenerRef.current = null
    stopMicRef.current?.()
    stopMicRef.current = null
    clearTimeout(wrongTimerRef.current)
    wrongTimerRef.current = null
    heldNotesRef.current.clear()
    stopToneListenLoop()
    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    tonePartRef.current?.dispose()
    tonePartRef.current = null
    toneSamplerRef.current?.stop()
    clearVerovioHighlights()
  }

  // ---------------------------------------------------------------------------
  // File handling
  // ---------------------------------------------------------------------------
  function handleUploadClick() {
    fileInputRef.current?.click()
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setFilename(file.name)
    const reader = new FileReader()
    reader.onload = (evt) => setMusicXml(evt.target.result)
    if (file.name.endsWith('.mxl')) {
      reader.readAsArrayBuffer(file)
    } else {
      reader.readAsText(file)
    }
    e.target.value = ''
  }

  async function handleSelectDemo(piece) {
    setShowDemoModal(false)
    setFilename(piece.title)
    const data = await loadDemoScore(piece)
    setMusicXml(data)
  }

  // ── Library / folder handlers ────────────────────────────────────────────────
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
      setFilename(score.name.replace(/\.[^.]+$/, ''))
      setMusicXml(data)
    } catch (e) {
      console.error('[Library] loadScore failed:', e)
    }
  }

  async function handleOpenFolderScoreInVisualizer(score) {
    try {
      const data = await loadScore(score)
      openInVisualizer(data, score.name.replace(/\.[^.]+$/, ''))
    } catch (e) {
      console.error('[Library] loadScore for visualizer failed:', e)
    }
  }

  function openInVisualizer(data, name) {
    // Pass song to Visualizer via sessionStorage then navigate
    try {
      if (data instanceof ArrayBuffer) {
        // Store as base64 for ArrayBuffer
        const bytes = new Uint8Array(data)
        let bin = ''
        bytes.forEach(b => { bin += String.fromCharCode(b) })
        sessionStorage.setItem('nf-vis-song', JSON.stringify({ name, type: 'binary', data: btoa(bin) }))
      } else {
        sessionStorage.setItem('nf-vis-song', JSON.stringify({ name, type: 'text', data }))
      }
    } catch (e) {
      console.error('openInVisualizer: sessionStorage failed', e)
    }
    window.location.hash = '/visualizer'
  }

  function handleBack() {
    stopAllInputs()
    setMusicXml(null)
    setFilename('')
    setError(null)
    setNoteTimeline([])
    setMode('idle')
    setPaused(false)
    setCurrentNoteIndex(0)
    setDetectedNote(null)
    setInputError(null)
    setCompleted(false)
    setShowHint(false)
    setBpm(null)
    setPlayerProgress(0)
    if (svgContainerRef.current) {
      svgContainerRef.current.innerHTML = ''
    }
  }

  // ---------------------------------------------------------------------------
  // Tone.js cursor sync loop (rAF — reads transport.seconds, drives Verovio cursor)
  // ---------------------------------------------------------------------------
  function startToneListenLoop() {
    stopToneListenLoop()

    function frame() {
      // transport.bpm = 60, so transport.seconds ≈ wall-clock seconds elapsed
      const wallSec = Tone.getTransport().seconds
      const speed = playbackSpeedRef.current
      const musicalSec = wallSec * speed  // position in original-tempo seconds
      const totalWallSec = listenEndWallSecRef.current
      const totalMusicalSec = listenTotalMusicalSecRef.current

      // Find current note in OSMD timeline by audio time (timeSec = unfolded time).
      const tl = noteTimelineRef.current
      let best = 0
      for (let i = 0; i < tl.length; i++) {
        if ((tl[i].timeSec ?? 0) <= musicalSec) best = i
        else break
      }
      setCurrentNoteIndex(best)

      // Highlight current note in Verovio SVG.
      // Use cursorSec (original-score time) so cursor works correctly on repeat passes.
      const cs = vrvCursorScheduleRef.current
      if (cs?.length > 0) {
        const cursorMs = (tl[best]?.cursorSec ?? tl[best]?.timeSec ?? 0) * 1000
        let bestIdx = 0
        for (let i = 0; i < cs.length; i++) {
          if (cs[i].tstampMs <= cursorMs) bestIdx = i
          else break
        }
        clearVerovioHighlights()
        const { ids } = cs[bestIdx]
        const container = svgContainerRef.current
        if (container) {
          for (const id of ids) {
            const el = container.querySelector(`#${id}`)
            if (el) el.classList.add('current-note')
          }
          if (autoscrollRef.current && ids.length > 0) {
            const firstEl = container.querySelector(`#${ids[0]}`)
            if (firstEl) {
              requestAnimationFrame(() => {
                const rect = firstEl.getBoundingClientRect()
                const viewportH = window.innerHeight
                if (rect.bottom > viewportH - 40 || rect.top < 80)
                  firstEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
              })
            }
          }
        }
      } else {
        highlightVerovioAtMs((tl[best]?.cursorSec ?? musicalSec) * 1000)
      }

      // Progress bar
      if (totalMusicalSec > 0) setPlayerProgress(Math.min(1, musicalSec / totalMusicalSec))

      // Completion
      if (totalWallSec > 0 && wallSec >= totalWallSec) {
        toneListenRafRef.current = null
        Tone.getTransport().stop()
        Tone.getTransport().cancel()
        tonePartRef.current?.dispose()
        tonePartRef.current = null
        clearVerovioHighlights()
        setMode('idle')
        setCompleted(true)
        setPlayerProgress(1)
        return
      }

      toneListenRafRef.current = requestAnimationFrame(frame)
    }
    toneListenRafRef.current = requestAnimationFrame(frame)
  }

  // ---------------------------------------------------------------------------
  // Listen mode — Tone.js Transport + Sampler for audio, rAF loop for cursor
  // ---------------------------------------------------------------------------
  async function handleListen() {
    if (mode === 'listen') {
      stopToneListenLoop()
      Tone.getTransport().stop()
      Tone.getTransport().cancel()
      tonePartRef.current?.dispose()
      tonePartRef.current = null
      clearVerovioHighlights()
      setMode('idle')
      return
    }

    if (noteTimeline.length === 0) return

    const piano = toneSamplerRef.current
    if (!piano) return

    // Unlock AudioContext on user gesture
    await Tone.start()

    // Full reset before scheduling
    Tone.getTransport().stop()
    Tone.getTransport().cancel()
    tonePartRef.current?.dispose()
    tonePartRef.current = null

    // Set transport to BPM=60 so transport.seconds == wall-clock seconds.
    // Notes are scheduled in absolute seconds derived from OSMD's tempo-aware timeSec,
    // which correctly handles all mid-piece tempo and time-signature changes.
    const transport = Tone.getTransport()
    const speed = playbackSpeedRef.current
    transport.bpm.value = 60
    transport.position = 0

    // Use OSMD noteTimeline for audio — correct flat MIDI via getHalfTone()
    const events = noteTimeline.flatMap((entry) =>
      entry.notes.flatMap((name) => {
        const midi = noteToMidi(name)
        if (!midi) return []
        return [[
          (entry.timeSec ?? 0) / speed,
          { note: midi, durationSec: Math.max(entry.durationSec ?? 0.1, 0.05) / speed },
        ]]
      })
    )

    // Total musical duration for completion detection and progress bar
    const last = noteTimeline[noteTimeline.length - 1]
    const totalMusicalSec = last ? (last.timeSec ?? 0) + (last.durationSec ?? 0.1) : 0
    pushDebug('listenStart', { evCount: events.length, totalMusicalSec })
    listenTotalMusicalSecRef.current = totalMusicalSec
    listenEndWallSecRef.current = totalMusicalSec / speed

    // Schedule all notes via Tone.Part using AudioContext time
    const part = new Tone.Part((time, event) => {
      piano.start({ note: event.note, time, duration: event.durationSec })
    }, events)
    part.start(0)
    tonePartRef.current = part

    setMode('listen')
    setCurrentNoteIndex(0)
    setCompleted(false)
    setPaused(false)
    setPlayerProgress(0)
    lastTickSetRef.current = -1

    transport.start()
    startToneListenLoop()
  }

  function handleListenPause() {
    Tone.getTransport().pause()
    stopToneListenLoop()
    setPaused(true)
  }

  function handleListenResume() {
    Tone.getTransport().start()
    startToneListenLoop()
    setPaused(false)
  }

  // ---------------------------------------------------------------------------
  // Practice mode
  // ---------------------------------------------------------------------------
  async function handleStartPractice() {
    if (noteTimeline.length === 0) return

    setCurrentNoteIndex(0)
    setDetectedNote(null)
    setInputError(null)
    setCompleted(false)
    setPaused(false)
    setShowHint(false)
    setMode('practice')
    lastTickSetRef.current = -1

    if (inputMode === 'midi') {
      if (!selectedDeviceId) {
        setInputError(
          midiSupported === false
            ? 'MIDI requires Chrome or Edge. Switch to Microphone in settings.'
            : 'Connect a MIDI keyboard via USB to start.'
        )
        setMode('idle')
        return
      }
      const stop = await listenToDevice(
        selectedDeviceId,
        (note) => {
          heldNotesRef.current.add(note)
          setDetectedNote([...heldNotesRef.current].join(' + '))
          checkNotes()
        },
        handleNoteOff,
      )
      if (stop) {
        stopListenerRef.current = stop
      } else {
        setInputError('Failed to connect to MIDI device. Try reconnecting.')
        setMode('idle')
      }
    } else {
      try {
        const onNotes = (notes) => {
          if (notes && notes.length > 0) {
            heldNotesRef.current.clear()
            for (const n of notes) heldNotesRef.current.add(n)
            setDetectedNote(notes.join(' + '))
            checkNotes()
          } else {
            // All notes released — trigger release logic
            heldNotesRef.current.clear()
            setDetectedNote(null)
            handleRelease()
          }
        }
        const stop = await startBasicPitchDetection(onNotes)
        stopMicRef.current = stop
      } catch (err) {
        const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
        setInputError(
          denied
            ? 'Microphone access was blocked. Grant permission and try again.'
            : `Could not start mic: ${err?.message || 'unknown error'}`
        )
        setMode('idle')
      }
    }
  }

  function handleStopPractice() {
    stopAllInputs()
    setMode('idle')
    setPaused(false)
    setDetectedNote(null)
    setCompleted(false)
    setShowHint(false)
  }

  function handlePausePractice() {
    setPaused(true)
    clearTimeout(wrongTimerRef.current)
    wrongTimerRef.current = null
    setShowHint(false)
  }

  function handleResumePractice() {
    setPaused(false)
  }

  function handleRestart() {
    setCompleted(false)
    setCurrentNoteIndex(0)
    setDetectedNote(null)
    setPaused(false)
    setShowHint(false)
    clearTimeout(wrongTimerRef.current)
    wrongTimerRef.current = null
    lastTickSetRef.current = -1
  }

  // Navigation
  function handlePrevMoment() {
    lastTickSetRef.current = -1
    setCurrentNoteIndex((i) => Math.max(0, i - 1))
  }

  function handleNextMoment() {
    lastTickSetRef.current = -1
    setCurrentNoteIndex((i) => Math.min(noteTimeline.length - 1, i + 1))
  }

  function handlePrevMeasure() {
    const curMeasure = noteTimeline[currentNoteIndex]?.measure ?? 1
    const target = curMeasure - 1
    if (target < 1) return
    const idx = noteTimeline.findIndex((m) => m.measure === target)
    if (idx !== -1) {
      lastTickSetRef.current = -1
      setCurrentNoteIndex(idx)
    }
  }

  function handleNextMeasure() {
    const curMeasure = noteTimeline[currentNoteIndex]?.measure ?? 1
    const target = curMeasure + 1
    const idx = noteTimeline.findIndex((m) => m.measure === target)
    if (idx !== -1) {
      lastTickSetRef.current = -1
      setCurrentNoteIndex(idx)
    }
  }

  // ---------------------------------------------------------------------------
  // Derived display values
  // ---------------------------------------------------------------------------
  const currentEntry = noteTimeline[currentNoteIndex]
  const currentNoteDisplay = currentEntry ? currentEntry.notes.join(' + ') : '---'
  const totalMeasures = noteTimeline.length > 0 ? noteTimeline[noteTimeline.length - 1].measure : 0
  const isMatch = mode === 'practice' && detectedNote && currentEntry &&
    currentEntry.notes.some((tn) =>
      [...heldNotesRef.current].some((held) => notesMatch(held, tn, anyOctave))
    )
  const prevEntry = currentNoteIndex > 0 ? noteTimeline[currentNoteIndex - 1] : null
  const intervalName = currentEntry && prevEntry ? getInterval(prevEntry.notes, currentEntry.notes) : null

  const selectedDevice = midiDevices.find((d) => d.id === selectedDeviceId)

  const chevronLeft = (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
      <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
  const chevronRight = (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
      <path d="M7.5 5L12.5 10L7.5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )

  const { theme } = useTheme()

  const LogoSvg = ({ size = 40, bg }) => (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none" aria-label="Pianly logo">
      <rect x="8" y="20" width="10" height="36" rx="2" fill="white" />
      <rect x="20" y="20" width="10" height="36" rx="2" fill="white" />
      <rect x="32" y="20" width="10" height="36" rx="2" fill="white" />
      <rect x="44" y="20" width="10" height="36" rx="2" fill="white" />
      <rect x="56" y="20" width="10" height="36" rx="2" fill="white" />
      <rect x="15" y="20" width="8" height="22" rx="1.5" fill={bg} />
      <rect x="27" y="20" width="8" height="22" rx="1.5" fill={bg} />
      <rect x="47" y="20" width="8" height="22" rx="1.5" fill={bg} />
      <rect x="59" y="20" width="8" height="22" rx="1.5" fill={bg} />
      <circle cx="58" cy="14" r="4" fill="oklch(0.7 0.2 160)" />
      <rect x="62" y="4" width="2.5" height="12" rx="1" fill="oklch(0.7 0.2 160)" />
      <path d="M64.5 4 C64.5 4 70 6 70 9" stroke="oklch(0.7 0.2 160)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )

  return (
    <div className="h-screen overflow-hidden relative" style={{ background: 'var(--bg)', color: 'var(--ink)', fontFamily: "'Sora', sans-serif" }}>
      <Background />

      {/* ════════════════════════════════════════════════════════
          HOME SCREEN
      ════════════════════════════════════════════════════════ */}
      {!musicXml && (
        <div style={{display:'grid',gridTemplateRows:'auto 1fr clamp(107px,19.3vh,235px)',position:'absolute',inset:0,fontFamily:"'Sora',sans-serif",background:'var(--bg)',color:'var(--ink)',overflow:'hidden'}}>
          {/* Header */}
          <nav style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'clamp(12px,2.2vh,28px) clamp(20px,3.5vw,48px)',borderBottom:'1px solid var(--border)'}}>
            <div style={{fontWeight:700,fontSize:'clamp(14px,1.4vw,20px)'}}>Pianly</div>
            <button onClick={()=>setShowHomeSettings(true)} style={{opacity:.6,background:'none',border:'none',cursor:'pointer',fontSize:'clamp(11px,1.1vw,13px)',color:'var(--ink)',fontFamily:"'Sora',sans-serif"}}>Settings</button>
          </nav>

          {/* Hero row — fills all remaining space between nav and piano */}
          <div style={{display:'flex',position:'relative',overflow:'hidden',minHeight:0}}>
            {/* Ambient glows */}
            <div style={{position:'absolute',top:'-15%',right:'-5%',width:'50vw',height:'50vw',background:'radial-gradient(circle, rgba(0,255,200,0.18), transparent)',filter:'blur(70px)',borderRadius:'50%',zIndex:0,pointerEvents:'none'}}/>
            <div style={{position:'absolute',bottom:'-25%',left:'-15%',width:'40vw',height:'40vw',background:'radial-gradient(circle, rgba(0,255,200,0.1), transparent)',filter:'blur(60px)',borderRadius:'50%',zIndex:0,pointerEvents:'none'}}/>

            {/* Left: headline — exactly 50% */}
            <div style={{flex:'0 0 50%',padding:'clamp(24px,4vh,56px) clamp(20px,4vw,56px)',display:'flex',flexDirection:'column',justifyContent:'center',position:'relative',zIndex:1}}>
              <div style={{fontFamily:"'Dancing Script','Pacifico',cursive",fontSize:'clamp(72px,10vw,156px)',fontWeight:700,lineHeight:0.9,margin:'0 0 clamp(10px,1.5vh,24px)',color:'var(--accent)',letterSpacing:'-0.01em'}}>Pianly</div>
              <p style={{fontSize:'clamp(15px,1.6vw,26px)',fontWeight:600,color:'var(--accent)',lineHeight:1.3,margin:0,fontFamily:"'Sora',sans-serif"}}>A practice engine for all.</p>
            </div>

            {/* Right: button grid — exactly 50% */}
            <div style={{flex:'0 0 50%',padding:'clamp(24px,4vh,56px) clamp(20px,4vw,56px)',display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:'clamp(8px,1.2vh,16px)',alignContent:'center',position:'relative',zIndex:1}}>
              {[
                {label:'Sheet Practice', action: ()=>setShowSheetPicker(true), delay:'0.3s'},
                {label:'Visualizer', action: ()=>{window.location.hash='/visualizer'}, delay:'0.35s'},
                {label:'Read Practice', action: ()=>{window.location.hash='/read-practice'}, delay:'0.4s'},
                {label:'Convert Files', action: ()=>{window.location.hash='/converter'}, delay:'0.45s'},
              ].map(({label, action, delay}) => (
                <button key={label} onClick={action} style={{padding:'clamp(14px,2.2vh,28px) clamp(10px,1.5vw,24px)',background:'var(--accent)',color:'#000',border:'none',borderRadius:'clamp(8px,0.8vw,12px)',fontWeight:700,fontSize:'clamp(11px,1.2vw,15px)',cursor:'pointer',fontFamily:"'Sora',sans-serif",boxShadow:'0 8px 24px rgba(0,255,200,.3)',animation:`slideInRight 0.6s ease-out ${delay} both`,transition:'all 0.2s'}}
                  onMouseEnter={e=>{e.currentTarget.style.boxShadow='0 12px 32px rgba(0,255,200,.4)';e.currentTarget.style.transform='translateY(-2px) scale(1.04)'}}
                  onMouseLeave={e=>{e.currentTarget.style.boxShadow='0 8px 24px rgba(0,255,200,.3)';e.currentTarget.style.transform='translateY(0) scale(1)'}}>
                  {label}
                </button>
              ))}
              <button onClick={()=>{window.location.hash='/library'}} style={{gridColumn:'span 2',padding:'clamp(10px,1.6vh,22px) clamp(10px,1.5vw,24px)',background:'transparent',color:'var(--accent)',border:'1.5px solid var(--accent)',borderRadius:'clamp(8px,0.8vw,12px)',fontWeight:700,fontSize:'clamp(11px,1.2vw,15px)',cursor:'pointer',fontFamily:"'Sora',sans-serif",animation:'slideInRight 0.6s ease-out 0.48s both',transition:'all 0.2s',display:'flex',alignItems:'center',justifyContent:'center',gap:8}}
                onMouseEnter={e=>{e.currentTarget.style.background='rgba(0,255,200,0.08)';e.currentTarget.style.transform='translateY(-2px) scale(1.02)'}}
                onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.transform='translateY(0) scale(1)'}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>
                Sheet Music Library
              </button>
              {!folderPath ? (
                <button onClick={handlePickFolder} style={{gridColumn:'span 2',padding:'clamp(10px,1.6vh,22px) clamp(10px,1.5vw,24px)',background:'transparent',color:'var(--accent)',border:'1.5px solid var(--accent)',borderRadius:'clamp(8px,0.8vw,12px)',fontWeight:700,fontSize:'clamp(11px,1.2vw,15px)',cursor:'pointer',fontFamily:"'Sora',sans-serif",animation:'slideInRight 0.6s ease-out 0.5s both',transition:'all 0.2s'}}
                  onMouseEnter={e=>{e.currentTarget.style.background='rgba(0,255,200,0.08)';e.currentTarget.style.transform='translateY(-2px) scale(1.02)'}}
                  onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.transform='translateY(0) scale(1)'}}>
                  + Open Directory Folder
                </button>
              ) : (
                <button onClick={()=>{window.location.hash='/folder-library'}} style={{gridColumn:'span 2',padding:'clamp(10px,1.6vh,22px) clamp(10px,1.5vw,24px)',background:'transparent',color:'var(--accent)',border:'1.5px solid var(--accent)',borderRadius:'clamp(8px,0.8vw,12px)',fontWeight:700,fontSize:'clamp(11px,1.2vw,15px)',cursor:'pointer',fontFamily:"'Sora',sans-serif",animation:'slideInRight 0.6s ease-out 0.5s both',transition:'all 0.2s',display:'flex',alignItems:'center',justifyContent:'center',gap:8}}
                  onMouseEnter={e=>{e.currentTarget.style.background='rgba(0,255,200,0.08)';e.currentTarget.style.transform='translateY(-2px) scale(1.02)'}}
                  onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.transform='translateY(0) scale(1)'}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                  {folderPath.split('/').filter(Boolean).pop()}
                </button>
              )}
            </div>
          </div>

          {/* Piano — fixed at the very bottom, height scales with viewport */}
          <svg style={{width:'100%',display:'block',height:'100%'}} viewBox="0 0 1200 130" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
            <rect x="0" y="0" width="1200" height="5" fill="rgba(0,255,200,0.5)"/>
            <g fill="#e8ecef" stroke="rgba(0,0,0,0.5)" strokeWidth="1.5">
              <rect x="0" y="5" width="85.7" height="125"/><rect x="85.7" y="5" width="85.7" height="125"/><rect x="171.4" y="5" width="85.7" height="125"/><rect x="257.1" y="5" width="85.7" height="125"/><rect x="342.8" y="5" width="85.7" height="125"/><rect x="428.5" y="5" width="85.7" height="125"/><rect x="514.2" y="5" width="85.7" height="125"/><rect x="599.9" y="5" width="85.7" height="125"/><rect x="685.6" y="5" width="85.7" height="125"/><rect x="771.3" y="5" width="85.7" height="125"/><rect x="857" y="5" width="85.7" height="125"/><rect x="942.7" y="5" width="85.7" height="125"/><rect x="1028.4" y="5" width="85.7" height="125"/><rect x="1114.1" y="5" width="85.9" height="125"/>
            </g>
            <rect x="342.8" y="5" width="85.7" height="125" fill="rgba(0,255,200,0.28)"/>
            <rect x="685.6" y="5" width="85.7" height="125" fill="rgba(0,255,200,0.28)"/>
            <g fill="#0d1117">
              <rect x="58" y="5" width="50" height="78" rx="3"/><rect x="146" y="5" width="50" height="78" rx="3"/><rect x="315" y="5" width="50" height="78" rx="3"/><rect x="401" y="5" width="50" height="78" rx="3"/><rect x="487" y="5" width="50" height="78" rx="3"/><rect x="658" y="5" width="50" height="78" rx="3"/><rect x="744" y="5" width="50" height="78" rx="3"/><rect x="915" y="5" width="50" height="78" rx="3"/><rect x="1001" y="5" width="50" height="78" rx="3"/><rect x="1087" y="5" width="50" height="78" rx="3"/>
            </g>
          </svg>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xml,.musicxml,.mxl"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* ── Library Modal ─────────────────────────────────────────────────────── */}
      {showLibrary && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowLibrary(false) }}>
          <div className="rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col p-5 sm:p-6"
            style={{ background: 'var(--panel)', border: '1px solid var(--border)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
            <div className="flex items-center justify-between mb-4 shrink-0">
              <h2 className="text-lg font-bold" style={{color:'var(--ink)'}}>Song Library</h2>
              <button onClick={() => setShowLibrary(false)} style={{color:'var(--sub)'}} className="transition-colors cursor-pointer" aria-label="Close"
                onMouseEnter={e=>e.currentTarget.style.color='var(--ink)'} onMouseLeave={e=>e.currentTarget.style.color='var(--sub)'}>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </div>
            <div className="flex gap-1 mb-4 shrink-0 rounded-lg p-1" style={{background:'rgba(0,255,200,0.04)'}}>
              {[['mysongs', 'My Scores'], ['demos', 'Demo Pieces']].map(([tab, label]) => (
                <button key={tab} onClick={() => setLibraryTab(tab)}
                  className="flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer"
                  style={libraryTab === tab ? {background:'var(--accent)',color:'#000'} : {color:'var(--sub)'}}>
                  {label}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {libraryTab === 'mysongs' && (
                <div className="flex flex-col gap-2">
                  {!folderPath ? (
                    /* No folder selected yet */
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
                      {/* Folder header */}
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <p className="text-xs truncate flex-1" style={{color:'var(--sub)'}} title={folderPath}>{folderPath}</p>
                        <div className="flex gap-1 shrink-0">
                          <button onClick={() => refreshFolder(folderPath)} title="Refresh"
                            className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors cursor-pointer"
                            style={{color:'var(--sub)'}}
                            onMouseEnter={e=>{e.currentTarget.style.color='var(--ink)';e.currentTarget.style.background='rgba(255,255,255,0.08)'}}
                            onMouseLeave={e=>{e.currentTarget.style.color='var(--sub)';e.currentTarget.style.background='transparent'}}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
                          </button>
                          <button onClick={handleChangeFolder} title="Change Folder"
                            className="px-2.5 py-1 rounded-lg text-xs transition-colors cursor-pointer"
                            style={{border:'1px solid var(--border)',color:'var(--sub)'}}
                            onMouseEnter={e=>e.currentTarget.style.color='var(--ink)'}
                            onMouseLeave={e=>e.currentTarget.style.color='var(--sub)'}>
                            Change
                          </button>
                        </div>
                      </div>
                      {/* Score list */}
                      {folderLoading ? (
                        <p className="text-sm text-center py-8" style={{color:'var(--sub)'}}>Scanning folder…</p>
                      ) : folderScores.length === 0 ? (
                        <p className="text-sm text-center py-8" style={{color:'var(--sub)'}}>No valid score files found (.xml, .musicxml, .mxl, .mid).</p>
                      ) : folderScores.map(score => (
                        <div key={score.path} className="flex items-center justify-between p-3 rounded-xl transition-colors"
                          style={{border:'1px solid var(--border)'}}>
                          <div className="min-w-0 mr-3">
                            <div className="font-medium text-sm truncate" style={{color:'var(--ink)'}}>{score.name.replace(/\.[^.]+$/, '')}</div>
                            <div className="text-xs mt-0.5" style={{color:'var(--sub)'}}>{score.name.split('.').pop().toUpperCase()}</div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button onClick={() => handleOpenFolderScoreInVisualizer(score)}
                              title="Open in Visualizer"
                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer"
                              style={{border:'1.5px solid var(--accent)',color:'var(--accent)'}}>
                              Visualizer
                            </button>
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
                    <div key={piece.id} className="flex items-center justify-between p-3 rounded-xl transition-colors"
                      style={{border:'1px solid var(--border)'}}>
                      <div className="min-w-0 mr-3">
                        <div className="font-semibold text-sm truncate" style={{color:'var(--ink)'}}>{piece.title}</div>
                        <div className="text-xs mt-0.5" style={{color:'var(--sub)'}}>{piece.composer}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{background:'rgba(0,255,200,0.1)',color:'var(--ink)',border:'1px solid var(--border)'}}>
                          {piece.difficulty}
                        </span>
                        <button onClick={async () => { const data = await loadDemoScore(piece); openInVisualizer(data, piece.title) }}
                          title="Open in Visualizer"
                          className="px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer"
                          style={{border:'1.5px solid var(--accent)',color:'var(--accent)'}}>
                          Visualizer
                        </button>
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

      {/* ── Home Settings Modal ────────────────────────────────────────────── */}
      {showHomeSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 py-6"
          onClick={(e) => { if (e.target === e.currentTarget) setShowHomeSettings(false) }}
        >
          <div
            className="w-full max-w-sm md:max-w-lg rounded-2xl shadow-2xl shadow-black/60 flex flex-col max-h-[90vh]"
            style={{ background: 'var(--panel)', border: '1px solid var(--border)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' }}
          >
            {/* Header — sticky */}
            <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b shrink-0" style={{borderColor:'var(--border)'}}>
              <h2 className="text-base md:text-lg font-bold" style={{color:'var(--ink)'}}>Settings</h2>
              <button
                onClick={() => setShowHomeSettings(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors cursor-pointer"
                style={{border:'1px solid var(--border)',background:'rgba(0,255,200,0.04)',color:'var(--sub)'}}
              >
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                  <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">

              {/* Input Mode */}
              <div>
                <p className="text-[10px] uppercase tracking-widest mb-3" style={{color:'var(--sub)'}}>Input Method</p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { id: 'midi', label: 'MIDI Keyboard', icon: (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="7" width="20" height="14" rx="2"/>
                        <path d="M7 7V5a1 1 0 011-1h8a1 1 0 011 1v2"/>
                        <line x1="12" y1="12" x2="12" y2="16"/>
                        <line x1="9" y1="14" x2="15" y2="14"/>
                      </svg>
                    )},
                    { id: 'mic', label: 'Microphone', icon: (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="2" width="6" height="11" rx="3"/>
                        <path d="M5 10a7 7 0 0014 0"/>
                        <line x1="12" y1="17" x2="12" y2="21"/>
                        <line x1="9" y1="21" x2="15" y2="21"/>
                      </svg>
                    )},
                  ].map(({ id, label, icon }) => {
                    const active = inputMode === id
                    return (
                      <button
                        key={id}
                        onClick={() => setInputMode(id)}
                        className="flex flex-col items-center gap-2.5 py-5 rounded-xl border transition-all cursor-pointer"
                        style={{
                          background: active ? 'rgba(0,255,200,0.1)' : 'rgba(0,255,200,0.03)',
                          borderColor: active ? 'var(--accent)' : 'var(--border)',
                          color: active ? 'var(--ink)' : 'var(--sub)',
                        }}
                      >
                        {icon}
                        <span className="text-xs md:text-sm font-medium">{label}</span>
                        {active && <span className="text-[9px] md:text-[10px] font-medium" style={{color:'var(--sub)'}}>Active</span>}
                      </button>
                    )
                  })}
                </div>
              </div>


            </div>
          </div>
        </div>
      )}

        {/* ════════════════════════════════════════════════════════
            PRACTICE / LISTEN SCREEN (musicXml loaded)
        ════════════════════════════════════════════════════════ */}
        {musicXml && (
          <div className="relative z-10 flex flex-col items-center px-4 sm:px-6 pt-4 sm:pt-6 pb-4 h-full overflow-y-auto">
            {/* Thin top bar */}
            <div className="w-full max-w-4xl flex items-center justify-between mb-6 pb-4" style={{borderBottom:'1px solid var(--border)'}}>
              {/* Left: back + filename */}
              <div className="flex items-center gap-3 min-w-0">
                <button
                  onClick={handleBack}
                  className="transition-colors cursor-pointer shrink-0 p-1 -m-1"
                  style={{color:'var(--sub)'}}
                  aria-label="Go back"
                >
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                    <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium truncate" style={{color:'var(--ink)'}}>{filename}</span>
                  {bpm && <span className="text-xs font-mono shrink-0" style={{color:'var(--sub)'}}>{bpm} BPM</span>}
                </div>
              </div>

              {/* Right: actions */}
              <div className="flex items-center gap-2 shrink-0">
                {mode === 'idle' && (
                  <button
                    onClick={() => setShowSettings(true)}
                    className="w-8 h-8 md:w-10 md:h-10 flex items-center justify-center rounded-lg transition-colors cursor-pointer"
                    style={{border:'1px solid var(--border)',color:'var(--sub)'}}
                    aria-label="Settings"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
                    </svg>
                  </button>
                )}

                {/* Listen button */}
                {mode !== 'practice' && (
                  <button
                    onClick={handleListen}
                    disabled={noteTimeline.length === 0}
                    className="w-8 h-8 md:w-10 md:h-10 flex items-center justify-center rounded-lg transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    style={mode === 'listen'
                      ? {border:'1px solid var(--accent)',background:'rgba(0,255,200,0.1)',color:'var(--accent)'}
                      : {border:'1px solid var(--border)',color:'var(--sub)'}}
                    aria-label={mode === 'listen' ? 'Stop' : 'Listen'}
                  >
                    {mode === 'listen' ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    )}
                  </button>
                )}

                {/* Practice buttons */}
                {mode === 'idle' ? (
                  <button
                    onClick={handleStartPractice}
                    disabled={noteTimeline.length === 0}
                    className="px-5 py-2 rounded-lg font-bold text-sm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{background:'var(--accent)',color:'#000',boxShadow:'0 4px 16px rgba(0,255,200,0.25)'}}
                  >
                    Practice
                  </button>
                ) : mode === 'practice' ? (
                  <div className="flex items-center gap-2">
                    {!paused ? (
                      <button
                        onClick={handlePausePractice}
                        className="px-3 py-2 rounded-lg font-semibold text-sm transition-colors cursor-pointer flex items-center gap-1.5"
                        style={{border:'1px solid var(--border)',color:'var(--sub)'}}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                        <span className="hidden sm:inline">Pause</span>
                      </button>
                    ) : (
                      <button
                        onClick={handleResumePractice}
                        className="px-3 py-2 rounded-lg font-bold text-sm transition-all cursor-pointer flex items-center gap-1.5"
                        style={{background:'var(--accent)',color:'#000'}}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        <span className="hidden sm:inline">Resume</span>
                      </button>
                    )}
                    <button
                      onClick={handleStopPractice}
                      className="px-3 py-2 rounded-lg font-semibold text-sm transition-colors cursor-pointer flex items-center gap-1.5"
                      style={{border:'1px solid var(--border)',color:'var(--sub)'}}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                      <span className="hidden sm:inline">Stop</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Input error */}
            {inputError && (
              <div className="w-full max-w-4xl mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
                {inputError}
              </div>
            )}

            {/* Input status */}
            <div className="w-full max-w-4xl mb-4 flex items-center gap-2 text-xs" style={{color:'var(--sub)'}}>
              {inputMode === 'mic' ? (
                <>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${modelLoading ? 'animate-pulse' : ''}`} style={{background:'var(--accent)'}} />
                  <span>Microphone (Basic Pitch){modelLoading && ' — loading model...'}</span>
                </>
              ) : selectedDevice ? (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{background:'var(--accent)'}} />
                  <span>MIDI: {selectedDevice.name}</span>
                </>
              ) : midiSupported === false ? (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400" />
                  <span>MIDI requires Chrome or Edge — switch to Microphone in settings</span>
                </>
              ) : (
                <>
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{background:'var(--panel)'}} />
                  <span>Connect a MIDI keyboard via USB to start</span>
                </>
              )}
              {anyOctave && <><span className="mx-1" style={{color:'var(--border)'}}>|</span><span>Any octave</span></>}
            </div>

            {/* Sheet + practice panel wrapper */}
            <div className="relative w-full max-w-4xl">
              {/* Practice panel */}
              {mode === 'practice' && currentEntry && !completed && !paused && (
                <div className="sticky top-0 z-20 rounded-xl backdrop-blur-md px-4 sm:px-6 py-3 mb-3 shadow-xl shadow-black/40" style={{border:'1px solid var(--border)',backgroundColor:'oklch(0.12 0.025 270 / 0.93)'}}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 sm:gap-4">
                      {/* Note arrows */}
                      <div className="flex items-center gap-1">
                        <button onClick={handlePrevMoment} disabled={currentNoteIndex === 0} className="w-7 h-7 flex items-center justify-center rounded-md transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed shrink-0" style={{border:'1px solid var(--border)',color:'var(--sub)'}}>{chevronLeft}</button>
                        <button onClick={handleNextMoment} disabled={currentNoteIndex === noteTimeline.length - 1} className="w-7 h-7 flex items-center justify-center rounded-md transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed shrink-0" style={{border:'1px solid var(--border)',color:'var(--sub)'}}>{chevronRight}</button>
                        <span className="text-[10px] uppercase tracking-wider ml-0.5" style={{color:'var(--sub)'}}>Note</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={handlePrevMeasure} disabled={currentEntry.measure <= 1} className="w-7 h-7 flex items-center justify-center rounded-md transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed shrink-0" style={{border:'1px solid var(--border)',color:'var(--sub)'}}>{chevronLeft}</button>
                        <button onClick={handleNextMeasure} disabled={currentEntry.measure >= totalMeasures} className="w-7 h-7 flex items-center justify-center rounded-md transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed shrink-0" style={{border:'1px solid var(--border)',color:'var(--sub)'}}>{chevronRight}</button>
                        <span className="text-[10px] uppercase tracking-wider ml-0.5" style={{color:'var(--sub)'}}>Bar</span>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="text-center">
                          <div className="text-[10px] uppercase tracking-wider" style={{color:'var(--sub)'}}>Target</div>
                          <div className="text-lg font-bold font-mono leading-tight" style={{color:'var(--ink)'}}>{currentNoteDisplay}</div>
                        </div>
                        <div className="text-center">
                          <div className="text-[10px] uppercase tracking-wider" style={{color:'var(--sub)'}}>Playing</div>
                          <div className="text-lg font-bold font-mono leading-tight" style={{color: !detectedNote ? 'var(--panel)' : isMatch ? 'var(--ink)' : '#e07878'}}>
                            {detectedNote ?? '---'}
                          </div>
                        </div>
                        <div className="w-3 h-3 rounded-full shrink-0 transition-colors" style={{background: !detectedNote ? 'var(--panel)' : isMatch ? 'var(--accent)' : '#e07878'}} />
                      </div>

                      {intervalName && <div className="text-[10px] font-medium uppercase tracking-wider" style={{color:'var(--sub)'}}>{intervalName}</div>}
                      {showHint && <div className="text-xs font-medium" style={{color:'var(--sub)'}}>Play {currentNoteDisplay}</div>}
                    </div>

                    <div className="text-right">
                      <div className="text-sm font-mono" style={{color:'var(--sub)'}}>{currentNoteIndex + 1} <span style={{opacity:.5}}>/</span> {noteTimeline.length}</div>
                      <div className="text-xs font-mono" style={{color:'var(--sub)',opacity:.5}}>Bar {currentEntry.measure}/{totalMeasures}</div>
                    </div>
                  </div>

                  <div className="mt-2.5 h-0.5 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.05)'}}>
                    <div
                      className="h-full rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${((currentNoteIndex + 1) / noteTimeline.length) * 100}%`, background:'var(--accent)' }}
                    />
                  </div>
                </div>
              )}

              {/* Paused overlay */}
              {mode === 'practice' && paused && !completed && (
                <div className="sticky top-0 z-20 rounded-xl backdrop-blur-md px-6 py-4 text-center mb-3" style={{border:'1px solid rgba(0,255,200,0.25)',background:'rgba(0,255,200,0.06)'}}>
                  <p className="font-bold" style={{color:'var(--accent)'}}>Paused</p>
                  <p className="text-sm mt-1" style={{color:'var(--sub)'}}>
                    Note {currentNoteIndex + 1} of {noteTimeline.length} · Bar {currentEntry?.measure}/{totalMeasures}
                  </p>
                </div>
              )}

              {/* Verovio rendered sheet music */}
              <div
                ref={svgContainerRef}
                className="bg-white rounded-2xl p-3 sm:p-6 min-h-[160px] sm:min-h-[200px] overflow-x-auto shadow-2xl"
              />

              {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/80 rounded-2xl">
                  <div className="flex items-center gap-3" style={{color:'var(--sub)'}}>
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span className="text-sm">Rendering score...</span>
                  </div>
                </div>
              )}
              {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/80 rounded-2xl">
                  <p className="text-red-500 text-sm">{error}</p>
                </div>
              )}

              {/* Completion */}
              {completed && (
                <div className="mt-4 rounded-2xl backdrop-blur-sm px-6 sm:px-8 py-10 text-center" style={{border:'1px solid rgba(0,255,200,0.2)',background:'rgba(0,255,200,0.04)'}}>
                  <div className="text-5xl mb-4">🎹</div>
                  <p className="text-2xl font-bold mb-2" style={{color:'var(--ink)'}}>You finished!</p>
                  <p className="text-sm mb-1" style={{color:'var(--sub)'}}>{filename}</p>
                  <p className="text-sm mb-8" style={{color:'var(--sub)',opacity:.6}}>
                    {noteTimeline.length} notes · {totalMeasures} measures
                  </p>
                  <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                    <button onClick={handleRestart} className="w-full sm:w-auto px-6 py-2.5 rounded-xl font-bold text-sm transition-all cursor-pointer" style={{background:'var(--accent)',color:'#000',boxShadow:'0 8px 24px rgba(0,255,200,0.25)'}}>
                      Play Again
                    </button>
                    <button onClick={handleStopPractice} className="w-full sm:w-auto px-6 py-2.5 rounded-xl font-semibold text-sm transition-all cursor-pointer" style={{border:'1px solid var(--border)',color:'var(--sub)'}}>
                      Back to Score
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Demo picker modal */}
        {/* ── Sheet Picker modal ──────────────────────────────────────────── */}
        {showSheetPicker && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md px-4"
            onClick={e => { if (e.target === e.currentTarget) setShowSheetPicker(false) }}>
            <div className="rounded-2xl w-full max-w-lg p-5 sm:p-6 shadow-2xl" style={{background:'var(--panel)',border:'1px solid var(--border)'}}>
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg sm:text-xl font-bold" style={{color:'var(--ink)'}}>Sheet Practice</h2>
                <button onClick={() => setShowSheetPicker(false)} className="transition-colors cursor-pointer" style={{color:'var(--sub)'}}
                  onMouseEnter={e=>e.currentTarget.style.color='var(--ink)'} onMouseLeave={e=>e.currentTarget.style.color='var(--sub)'}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                </button>
              </div>

              {/* Upload button */}
              <button onClick={() => { setShowSheetPicker(false); handleUploadClick() }}
                className="w-full flex items-center gap-3 p-4 rounded-xl mb-4 cursor-pointer transition-all"
                style={{background:'var(--accent)',color:'#000',border:'none',fontFamily:"'Sora',sans-serif",fontWeight:700,fontSize:14}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                Upload a File
              </button>

              {/* Demo pieces */}
              {DEMO_PIECES.length > 0 && (
                <>
                  <div className="text-xs uppercase tracking-wider font-medium mb-2" style={{color:'var(--sub)'}}>Demo Pieces</div>
                  <div className="flex flex-col gap-2">
                    {DEMO_PIECES.map(piece => (
                      <button key={piece.id}
                        onClick={() => { setShowSheetPicker(false); handleSelectDemo(piece) }}
                        className="flex items-center justify-between p-4 rounded-xl cursor-pointer text-left transition-all"
                        style={{border:'1px solid var(--border)',background:'transparent',fontFamily:"'Sora',sans-serif"}}
                        onMouseEnter={e=>e.currentTarget.style.background='rgba(0,255,200,0.06)'}
                        onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                        <div className="min-w-0 mr-3">
                          <div className="font-semibold truncate" style={{color:'var(--ink)'}}>{piece.title}</div>
                          <div className="text-sm mt-0.5" style={{color:'var(--sub)'}}>{piece.composer}</div>
                        </div>
                        <span className="text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap shrink-0"
                          style={{background:'rgba(0,255,200,0.1)',color:'var(--ink)',border:'1px solid var(--border)'}}>
                          {piece.difficulty}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {showDemoModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md px-4"
            onClick={(e) => { if (e.target === e.currentTarget) setShowDemoModal(false) }}
          >
            <div className="rounded-2xl w-full max-w-lg p-5 sm:p-6 shadow-2xl" style={{background:'var(--panel)',border:'1px solid var(--border)'}}>
              <div className="flex items-center justify-between mb-5 sm:mb-6">
                <h2 className="text-lg sm:text-xl font-bold" style={{color:'var(--ink)'}}>Choose a Demo Piece</h2>
                <button onClick={() => setShowDemoModal(false)} className="transition-colors cursor-pointer" style={{color:'var(--sub)'}} aria-label="Close"
                  onMouseEnter={e=>e.currentTarget.style.color='var(--ink)'} onMouseLeave={e=>e.currentTarget.style.color='var(--sub)'}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                </button>
              </div>
              <div className="flex flex-col gap-2.5">
                {DEMO_PIECES.map((piece) => (
                  <button
                    key={piece.id}
                    onClick={() => handleSelectDemo(piece)}
                    className="flex items-center justify-between p-4 rounded-xl transition-all cursor-pointer text-left group"
                    style={{border:'1px solid var(--border)'}}
                  >
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

        {/* Settings modal */}
        {showSettings && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md px-4"
            onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false) }}
          >
            <div className="rounded-2xl w-full max-w-sm p-5 sm:p-6 shadow-2xl" style={{background:'var(--panel)',border:'1px solid var(--border)'}}>
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold" style={{color:'var(--ink)'}}>Settings</h2>
                <button onClick={() => setShowSettings(false)} className="transition-colors cursor-pointer" style={{color:'var(--sub)'}} aria-label="Close"
                  onMouseEnter={e=>e.currentTarget.style.color='var(--ink)'} onMouseLeave={e=>e.currentTarget.style.color='var(--sub)'}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                </button>
              </div>

              {/* Input Source */}
              <div className="mb-5">
                <label className="text-xs uppercase tracking-wider font-medium mb-2 block" style={{color:'var(--sub)'}}>Input Source</label>
                <div className="flex rounded-lg overflow-hidden text-sm font-medium" style={{border:'1px solid var(--border)'}}>
                  <button onClick={() => setInputMode('midi')} disabled={midiSupported === false} className="flex-1 px-3 py-2 flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed" style={inputMode === 'midi' ? {background:'rgba(0,255,200,0.1)',color:'var(--ink)'} : {color:'var(--sub)'}}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M8 6v8M12 6v8M16 6v8"/></svg>
                    MIDI
                  </button>
                  <button onClick={() => setInputMode('mic')} className="flex-1 px-3 py-2 flex items-center justify-center gap-2 transition-colors cursor-pointer" style={inputMode === 'mic' ? {background:'rgba(0,255,200,0.1)',color:'var(--ink)'} : {color:'var(--sub)'}}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
                    Microphone
                  </button>
                </div>
              </div>

              {inputMode === 'midi' && (
                <div className="mb-5">
                  <label className="text-xs uppercase tracking-wider font-medium mb-2 block" style={{color:'var(--sub)'}}>MIDI Device</label>
                  {midiSupported === false ? (
                    <p className="text-red-400 text-sm">No MIDI support detected.</p>
                  ) : midiDevices.length === 0 ? (
                    <p className="text-sm" style={{color:'var(--sub)'}}>Connect a MIDI keyboard via USB to start.</p>
                  ) : (
                    <select value={selectedDeviceId ?? ''} onChange={(e) => setSelectedDeviceId(e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none transition-colors cursor-pointer" style={{background:'var(--bg)',border:'1px solid var(--border)',color:'var(--ink)',accentColor:'var(--accent)'}}>
                      {midiDevices.map((d) => (<option key={d.id} value={d.id}>{d.name}</option>))}
                    </select>
                  )}
                </div>
              )}

              <div className="mb-5">
                <button onClick={() => setAnyOctave((v) => !v)} className="flex items-center justify-between w-full p-3 rounded-xl transition-colors cursor-pointer" style={{border:'1px solid var(--border)'}}>
                  <div className="text-left">
                    <div className="text-sm font-medium" style={{color:'var(--ink)'}}>Any octave</div>
                    <div className="text-xs mt-0.5" style={{color:'var(--sub)'}}>C3 matches target C4, etc.</div>
                  </div>
                  <div className="w-10 h-6 rounded-full relative transition-colors" style={{background: anyOctave ? 'var(--accent)' : 'var(--panel)'}}>
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${anyOctave ? 'left-5' : 'left-1'}`} />
                  </div>
                </button>
              </div>

              <div className="mb-5">
                <label className="text-xs uppercase tracking-wider font-medium mb-2 block" style={{color:'var(--sub)'}}>
                  Playback Speed: {Math.round(playbackSpeed * 100)}%
                </label>
                <input type="range" min="0.25" max="2" step="0.05" value={playbackSpeed} onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))} className="w-full" style={{accentColor:'var(--accent)'}} />
                <div className="flex justify-between text-[10px] mt-1" style={{color:'var(--sub)',opacity:.5}}>
                  <span>25%</span><span>100%</span><span>200%</span>
                </div>
              </div>

              <div className="mb-5">
                <button onClick={() => setAutoscroll((v) => !v)} className="flex items-center justify-between w-full p-3 rounded-xl transition-colors cursor-pointer" style={{border:'1px solid var(--border)'}}>
                  <div className="text-left">
                    <div className="text-sm font-medium" style={{color:'var(--ink)'}}>Autoscroll</div>
                    <div className="text-xs mt-0.5" style={{color:'var(--sub)'}}>Keep the current bar visible during playback</div>
                  </div>
                  <div className="w-10 h-6 rounded-full relative transition-colors" style={{background: autoscroll ? 'var(--accent)' : 'var(--panel)'}}>
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${autoscroll ? 'left-5' : 'left-1'}`} />
                  </div>
                </button>
              </div>

              {inputMode === 'mic' && (
                <div className="mb-5">
                  <label className="text-xs uppercase tracking-wider font-medium mb-2 block" style={{color:'var(--sub)'}}>Detection Engine</label>
                  <p className="text-sm" style={{color:'var(--ink)'}}>Basic Pitch (Spotify ML)</p>
                  <p className="text-[10px] mt-1.5" style={{color:'var(--sub)',opacity:.5}}>ML-powered polyphonic note detection. Supports chords.</p>
                  {modelLoading && (
                    <div className="flex items-center gap-2 mt-2 text-xs" style={{color:'var(--sub)'}}>
                      <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                      Loading audio model...
                    </div>
                  )}
                  {modelReady && <p className="text-[10px] mt-2" style={{color:'var(--ink)'}}>Model ready</p>}
                </div>
              )}

              <p className="text-xs leading-relaxed" style={{color:'var(--sub)',opacity:.5}}>
                {inputMode === 'midi' ? 'MIDI is supported in Chrome, Edge, and Opera.' : 'Microphone works in all browsers. Grant permission when prompted.'}
              </p>
            </div>
          </div>
        )}

      {/* Microphone permission prompt */}
      {showMicPrompt && micPermission !== 'granted' && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 glass rounded-xl px-5 py-3 shadow-2xl max-w-md" style={{borderColor:'rgba(0,255,200,0.3)'}}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" style={{color:'var(--sub)'}}>
            <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
            <path d="M19 10v2a7 7 0 01-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium" style={{color:'var(--ink)'}}>Microphone access needed</p>
            <p className="text-xs mt-0.5" style={{color:'var(--sub)'}}>
              {micPermission === 'denied' ? 'Permission was blocked. Enable it in your browser settings.' : 'Grant microphone access to use pitch detection for practice.'}
            </p>
          </div>
          {micPermission !== 'denied' && (
            <button
              onClick={async () => {
                try {
                  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
                  stream.getTracks().forEach((t) => t.stop())
                  setMicPermission('granted')
                  setShowMicPrompt(false)
                } catch { setMicPermission('denied') }
              }}
              className="px-3 py-1.5 rounded-lg font-bold text-xs cursor-pointer whitespace-nowrap"
              style={{background:'var(--accent)',color:'#000'}}
            >
              Grant Access
            </button>
          )}
          <button onClick={() => setShowMicPrompt(false)} className="transition-colors cursor-pointer shrink-0" style={{color:'var(--sub)'}} aria-label="Dismiss"
            onMouseEnter={e=>e.currentTarget.style.color='var(--ink)'} onMouseLeave={e=>e.currentTarget.style.color='var(--sub)'}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </div>
      )}

      {/* Floating playback controls — listen mode */}
      {mode === 'listen' && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 glass rounded-2xl px-4 py-3 shadow-2xl shadow-black/60" style={{borderColor:'var(--border)'}}>
          <div className="text-xs font-mono mr-1" style={{color:'var(--sub)'}}>{currentNoteDisplay}</div>
          <button onClick={paused ? handleListenResume : handleListenPause} className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors cursor-pointer" style={{border:'1px solid var(--border)',color:'var(--ink)'}} aria-label={paused ? 'Resume' : 'Pause'}>
            {paused ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
            )}
          </button>
          <div className="w-24 h-0.5 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.06)'}}>
            <div className="h-full rounded-full transition-all duration-200" style={{ width: `${playerProgress * 100}%`, background:'var(--accent)' }} />
          </div>
          <span className="text-[10px] font-mono" style={{color:'var(--sub)',opacity:.6}}>{Math.round(playbackSpeed * 100)}%</span>
          <button onClick={handleListen} className="w-9 h-9 flex items-center justify-center rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-colors cursor-pointer" aria-label="Stop">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
        </div>
      )}

      {/* Debug panel */}
      {showDebug && (
        <div className="fixed bottom-4 left-4 z-[100] w-96 max-h-80 rounded-xl p-3 overflow-y-auto font-mono text-[10px] leading-relaxed shadow-2xl" style={{background:'oklch(0.12 0.025 270 / 0.95)',border:'1px solid var(--border)'}}>
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold text-xs" style={{color:'var(--sub)'}}>Debug Log (press D to close)</span>
            <button onClick={() => setDebugLog([])} className="text-[10px] cursor-pointer" style={{color:'var(--sub)',opacity:.6}}>Clear</button>
          </div>
          {debugLog.length === 0 && <p style={{color:'var(--sub)',opacity:.5}}>No events yet. Load a score and press play.</p>}
          {debugLog.map((entry, i) => (
            <div key={i} className="mb-1.5 pb-1.5" style={{borderBottom:'1px solid var(--panel)'}}>
              <span style={{color:'var(--ink)'}}>{entry.type}</span>
              <span className="ml-2" style={{color:'var(--sub)'}}>{new Date(entry.time).toISOString().slice(11, 23)}</span>
              <pre className="whitespace-pre-wrap break-all mt-0.5" style={{color:'var(--sub)'}}>{JSON.stringify(entry.data, null, 1)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default App
