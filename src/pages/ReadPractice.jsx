import { useState, useRef, useEffect, useCallback } from 'react'
import createVerovioModule from 'verovio/wasm'
import { VerovioToolkit } from 'verovio/esm'
import { enableMidi, listenToDevice, onDevicesChanged } from '../input/midiInput'
import { startBasicPitchDetection, loadBasicPitchModel } from '../input/pitchDetector'
import Background from '../Background'
import { useTheme } from '../ThemeContext'

// ─── Constants ────────────────────────────────────────────────────────────────

const DIFFICULTIES = [
  { id: 1, name: 'Beginner',  desc: 'Single note, right hand' },
  { id: 2, name: 'Easy',      desc: 'One note each hand' },
  { id: 3, name: 'Novice',    desc: 'Interval RH + single LH' },
  { id: 4, name: 'Medium',    desc: '3-note chord RH + single LH' },
  { id: 5, name: 'Advanced',  desc: '3-note chord RH + interval LH' },
  { id: 6, name: 'Hard',      desc: 'Chords both hands (3 max)' },
  { id: 7, name: 'Extreme',   desc: 'Chords both hands (5 max)' },
]

const RH_MIN = 72   // Pianly C4 (MIDI 72 = one octave above middle C)
const RH_MAX = 96   // Pianly C6
const LH_MIN = 48   // Pianly C2
const LH_MAX = 71   // Pianly B3  (stays below C4; no overlap with RH)

// Real chord shapes as semitone intervals from root
const CHORD_SHAPES = [
  [0, 4, 7],       // major triad
  [0, 3, 7],       // minor triad
  [0, 3, 6],       // diminished
  [0, 4, 8],       // augmented
  [0, 4, 7, 11],   // major 7th
  [0, 3, 7, 10],   // minor 7th
  [0, 4, 7, 10],   // dominant 7th
  [0, 2, 7],       // sus2
  [0, 5, 7],       // sus4
]

// Consonant intervals for interval targets (m3, M3, P4, P5, m6, M6, P8)
const CONSONANT_INTERVALS = [3, 4, 5, 7, 8, 9, 12]

// Semitone → [step, alter] — use sharps throughout
const SEMI_TO_PITCH = [
  ['C',  0], ['C',  1], ['D',  0], ['E', -1], ['E',  0],
  ['F',  0], ['F',  1], ['G',  0], ['A', -1], ['A',  0],
  ['B', -1], ['B',  0],
]

// ─── Pure Utilities ───────────────────────────────────────────────────────────

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1))
const pick    = (arr) => arr[Math.floor(Math.random() * arr.length)]

function midiToXmlParts(midi) {
  const semi   = ((midi % 12) + 12) % 12
  const octave = Math.floor(midi / 12) - 1   // MusicXML standard: MIDI 60 = C4 (middle C)
  const [step, alter] = SEMI_TO_PITCH[semi]
  return { step, alter, octave }
}

const NOTE_NAMES_DISPLAY = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
function midiToNoteName(midi) {
  const name   = NOTE_NAMES_DISPLAY[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 2   // Pianly convention: MIDI 60 = C3
  return `${name}${octave}`
}

// pitchDetector emits note names where middle C = "C3" (MIDI 60 → "C3")
function pitchNameToMidi(name) {
  const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  const m = name?.match(/^([A-G])(#|b)?(-?\d+)$/)
  if (!m) return null
  const semi = (NOTE[m[1]] ?? 0) + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)
  return (parseInt(m[3]) + 2) * 12 + semi
}

// ─── Chord / Note Generation ──────────────────────────────────────────────────

function isPlayable(notes) {
  if (notes.length < 2) return true
  const s = [...notes].sort((a, b) => a - b)
  if (s[s.length - 1] - s[0] > 12) return false   // max one-octave span
  for (let i = 1; i < s.length; i++) {
    if (s[i] - s[i - 1] < 2) return false           // no adjacent semitones
  }
  return true
}

function generateChord(maxNotes, min, max) {
  const validShapes = CHORD_SHAPES.filter(s => s.length <= maxNotes)

  for (let attempt = 0; attempt < 40; attempt++) {
    const shape = pick(validShapes)

    // Random inversion: rotate bottom notes up by an octave
    const inv = randInt(0, shape.length - 1)
    const inverted  = shape.map((v, i) => i < inv ? v + 12 : v)
    const minI      = Math.min(...inverted)
    const normalized = inverted.map(n => n - minI)
    const span = Math.max(...normalized)

    const rootMax = max - span
    if (rootMax < min) continue

    const root  = randInt(min, rootMax)
    const notes = normalized.map(n => root + n).sort((a, b) => a - b)
    if (notes.some(n => n < min || n > max)) continue
    if (!isPlayable(notes)) continue

    // For Extreme difficulty, optionally extend to a 4th note
    if (maxNotes >= 4 && notes.length < maxNotes && notes[notes.length - 1] - notes[0] <= 9 && Math.random() < 0.5) {
      for (const gap of [3, 4, 2, 5]) {
        const ext = notes[notes.length - 1] + gap
        if (ext <= max) {
          const extended = [...notes, ext]
          if (isPlayable(extended)) return extended
        }
      }
    }

    return notes
  }

  return [randInt(min, max)]  // fallback: single note
}

function generateInterval(min, max) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const interval = pick(CONSONANT_INTERVALS)
    const rootMax  = max - interval
    if (rootMax < min) continue
    const root  = randInt(min, rootMax)
    const notes = [root, root + interval]
    if (!isPlayable(notes)) continue
    return notes
  }
  return [randInt(min, max)]
}

function generateTarget(difficulty) {
  switch (difficulty) {
    case 1: return { rightNotes: [randInt(RH_MIN, RH_MAX)], leftNotes: [] }
    case 2: return { rightNotes: [randInt(RH_MIN, RH_MAX)], leftNotes: [randInt(LH_MIN, LH_MAX)] }
    case 3: return { rightNotes: generateInterval(RH_MIN, RH_MAX),  leftNotes: [randInt(LH_MIN, LH_MAX)] }
    case 4: return { rightNotes: generateChord(3, RH_MIN, RH_MAX),  leftNotes: [randInt(LH_MIN, LH_MAX)] }
    case 5: return { rightNotes: generateChord(3, RH_MIN, RH_MAX),  leftNotes: generateInterval(LH_MIN, LH_MAX) }
    case 6: return { rightNotes: generateChord(3, RH_MIN, RH_MAX),  leftNotes: generateChord(3, LH_MIN, LH_MAX) }
    case 7: return { rightNotes: generateChord(5, RH_MIN, RH_MAX),  leftNotes: generateChord(5, LH_MIN, LH_MAX) }
    default: return { rightNotes: [randInt(RH_MIN, RH_MAX)], leftNotes: [] }
  }
}

// ─── MusicXML Generation ──────────────────────────────────────────────────────

function noteXml(midi, isChord, staff, voice) {
  const { step, alter, octave } = midiToXmlParts(midi)
  return [
    '      <note>',
    isChord      ? '        <chord/>'                  : null,
    '        <pitch>',
    `          <step>${step}</step>`,
    alter !== 0  ? `          <alter>${alter}</alter>` : null,
    `          <octave>${octave}</octave>`,
    '        </pitch>',
    '        <duration>4</duration>',
    '        <type>whole</type>',
    `        <staff>${staff}</staff>`,
    `        <voice>${voice}</voice>`,
    '      </note>',
  ].filter(Boolean).join('\n')
}

const restXml = (staff, voice) =>
  `      <note>\n        <rest/>\n        <duration>4</duration>` +
  `\n        <type>whole</type>\n        <staff>${staff}</staff>` +
  `\n        <voice>${voice}</voice>\n      </note>`

const backupXml = '      <backup>\n        <duration>4</duration>\n      </backup>'

function generateMusicXML(rightNotes, leftNotes) {
  const rh = rightNotes.length > 0
    ? rightNotes.map((m, i) => noteXml(m, i > 0, 1, 1)).join('\n')
    : restXml(1, 1)

  const lh = leftNotes.length > 0
    ? backupXml + '\n' + leftNotes.map((m, i) => noteXml(m, i > 0, 2, 2)).join('\n')
    : backupXml + '\n' + restXml(2, 2)

  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time print-object="no"><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
${rh}
${lh}
    </measure>
  </part>
</score-partwise>`
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ReadPractice() {
  const { theme } = useTheme()

  // ── Screens & settings ──
  const [screen, setScreen]           = useState('start')   // 'start' | 'playing' | 'summary'
  const [mode, setMode]               = useState('vibe')    // 'vibe' | 'practice'
  const [difficulty, setDifficulty]   = useState(1)
  const [inputMethod, setInputMethod] = useState('midi')
  const [midiDevices, setMidiDevices] = useState([])
  const [selectedDevice, setSelectedDevice] = useState(null)
  const [showNoteNames, setShowNoteNames]   = useState(true)

  // ── Game UI state ──
  const [svgContent, setSvgContent]       = useState('')
  const [reactionFlash, setReactionFlash] = useState(null)   // ms number or null
  const [stats, setStats]                 = useState({ times: [], total: 0, score: 0 })
  const [heldNotes, setHeldNotes]         = useState([])     // MIDI ints currently held
  const [targetNotes, setTargetNotes]     = useState([])     // flat sorted MIDI int list for display

  // ── Refs for use inside callbacks / effects ──
  const vrvRef          = useRef(null)
  const svgContainerRef = useRef(null)
  const targetRef       = useRef(null)    // { rightNotes, leftNotes }
  const modeRef         = useRef('vibe')
  const difficultyRef   = useRef(1)
  const reactionStartRef = useRef(null)
  const heldNotesRef    = useRef(new Set())
  const advancingRef         = useRef(false)
  const stopMicRef           = useRef(null)
  const statsRef             = useRef({ times: [], total: 0, score: 0 })
  const advanceRef           = useRef(null)   // forward-ref to advanceTarget
  const updateHeldDisplayRef = useRef(null)   // syncs heldNotes state from heldNotesRef

  useEffect(() => { modeRef.current      = mode      }, [mode])
  useEffect(() => { difficultyRef.current = difficulty }, [difficulty])
  useEffect(() => { statsRef.current      = stats     }, [stats])

  // Always-fresh callback so MIDI/mic handlers never hold stale setHeldNotes
  updateHeldDisplayRef.current = () => setHeldNotes([...heldNotesRef.current])

  // ── Verovio init ──
  useEffect(() => {
    createVerovioModule().then(mod => {
      vrvRef.current = new VerovioToolkit(mod)
    })
    return () => { vrvRef.current = null }
  }, [])

  // ── Score rendering ──
  const renderTarget = useCallback((tgt) => {
    const tk = vrvRef.current
    if (!tk || !tgt) return
    tk.setOptions({
      scale: 80,
      pageWidth: 2400,
      pageHeight: 900,
      noJustification: 1,
      adjustPageWidth: 1,
      adjustPageHeight: 1,
      spacingSystem: 0,
      topMarginPage: 4,
      bottomMarginPage: 4,
    })
    tk.loadData(generateMusicXML(tgt.rightNotes, tgt.leftNotes))
    setSvgContent(tk.renderToSVG(1))
  }, [])

  // ── Advance to next note target ──
  const advanceTarget = useCallback(() => {
    heldNotesRef.current.clear()
    setHeldNotes([])
    const tgt = generateTarget(difficultyRef.current)
    targetRef.current = tgt
    setTargetNotes([...tgt.rightNotes, ...tgt.leftNotes].sort((a, b) => a - b))
    renderTarget(tgt)
    reactionStartRef.current = Date.now()
  }, [renderTarget])

  // Keep a stable ref so MIDI/mic handlers can call it without stale closures
  useEffect(() => { advanceRef.current = advanceTarget }, [advanceTarget])

  // ── Note match check ──
  // Stored as a ref to avoid stale-closure issues in MIDI/mic effects
  const checkMatchRef = useRef(null)
  checkMatchRef.current = () => {
    const tgt = targetRef.current
    if (!tgt || advancingRef.current) return

    const allTarget = [...tgt.rightNotes, ...tgt.leftNotes].sort((a, b) => a - b)
    const held      = [...heldNotesRef.current].sort((a, b) => a - b)

    if (held.length !== allTarget.length) return
    if (!held.every((n, i) => n === allTarget[i])) return

    // Match!
    advancingRef.current = true

    if (modeRef.current === 'practice') {
      const ms = reactionStartRef.current ? Date.now() - reactionStartRef.current : null
      if (ms !== null) {
        const pts = ms < 500 ? 3 : ms < 1000 ? 2 : ms < 2000 ? 1 : 0
        setReactionFlash(ms)
        setStats(prev => {
          const next = { times: [...prev.times, ms], total: prev.total + 1, score: prev.score + pts }
          statsRef.current = next
          return next
        })
        setTimeout(() => {
          setReactionFlash(null)
          advancingRef.current = false
          advanceRef.current?.()
        }, 600)
        return
      }
    }

    advancingRef.current = false
    advanceRef.current?.()
  }

  // ── MIDI device list ──
  useEffect(() => {
    if (screen !== 'playing' || inputMethod !== 'midi') return
    enableMidi().then(({ inputs }) => {
      const mapped = (inputs || []).map(inp => ({ id: inp.id, name: inp.name }))
      setMidiDevices(mapped)
      if (mapped.length > 0 && selectedDevice == null) {
        setSelectedDevice(mapped[0].id)
      }
    })
    const stopWatch = onDevicesChanged(inputs => setMidiDevices(inputs))
    return () => stopWatch?.()
  }, [screen, inputMethod])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── MIDI device connection ──
  useEffect(() => {
    if (screen !== 'playing' || inputMethod !== 'midi' || selectedDevice == null) return
    let stopDevice = null

    listenToDevice(
      selectedDevice,
      (noteStr) => {
        // Tauri emits note name strings ("C3" = MIDI 60), convert to integer
        const midi = pitchNameToMidi(noteStr)
        if (midi == null) return
        heldNotesRef.current.add(midi)
        updateHeldDisplayRef.current?.()
        checkMatchRef.current?.()
      },
      (noteStr) => {
        const midi = pitchNameToMidi(noteStr)
        if (midi == null) return
        heldNotesRef.current.delete(midi)
        updateHeldDisplayRef.current?.()
      },
    ).then(stop => { stopDevice = stop })

    return () => {
      stopDevice?.()
      heldNotesRef.current.clear()
    }
  }, [screen, inputMethod, selectedDevice])

  // ── Mic connection ──
  useEffect(() => {
    if (screen !== 'playing' || inputMethod !== 'mic') return
    let stopFn = null
    loadBasicPitchModel()

    startBasicPitchDetection((noteNames) => {
      if (!noteNames) {
        heldNotesRef.current.clear()
        updateHeldDisplayRef.current?.()
        return
      }
      const midis = noteNames.map(pitchNameToMidi).filter(m => m !== null)
      heldNotesRef.current.clear()
      midis.forEach(m => heldNotesRef.current.add(m))
      updateHeldDisplayRef.current?.()
      checkMatchRef.current?.()
    }).then(stop => {
      stopFn = stop
      stopMicRef.current = stop
    })

    return () => {
      stopFn?.()
      stopMicRef.current = null
      heldNotesRef.current.clear()
    }
  }, [screen, inputMethod])

  // ── Start game ──
  const startGame = useCallback(() => {
    const tgt = generateTarget(difficultyRef.current)
    targetRef.current  = tgt
    advancingRef.current = false
    heldNotesRef.current.clear()
    setHeldNotes([])
    setTargetNotes([...tgt.rightNotes, ...tgt.leftNotes].sort((a, b) => a - b))
    setStats({ times: [], total: 0, score: 0 })
    setReactionFlash(null)
    setScreen('playing')
    // Wait one frame so Verovio ref is alive after screen renders
    setTimeout(() => {
      renderTarget(tgt)
      reactionStartRef.current = Date.now()
    }, 50)
  }, [renderTarget])

  // ── Exit game ──
  const exitGame = useCallback(() => {
    advancingRef.current = false
    heldNotesRef.current.clear()
    stopMicRef.current?.()
    const s = statsRef.current
    if (modeRef.current === 'practice' && s.total > 0) {
      setScreen('summary')
    } else {
      setScreen('start')
    }
  }, [])

  // ── Derived stats ──
  const avgMs   = stats.times.length > 0 ? Math.round(stats.times.reduce((a, b) => a + b, 0) / stats.times.length) : 0
  const bestMs  = stats.times.length > 0 ? Math.min(...stats.times) : 0
  const worstMs = stats.times.length > 0 ? Math.max(...stats.times) : 0

  const flashColor = reactionFlash == null ? '' :
    reactionFlash < 500  ? 'text-green-300' :
    reactionFlash < 1000 ? 'text-green-400' :
    reactionFlash < 2000 ? 'text-yellow-400' : 'text-red-400'

  const flashPoints = reactionFlash == null ? null :
    reactionFlash < 500 ? '+3' : reactionFlash < 1000 ? '+2' : reactionFlash < 2000 ? '+1' : '+0'

  // ─── Start screen ───────────────────────────────────────────────────────────
  if (screen === 'start') {
    return (
      <div className="min-h-screen text-white relative overflow-hidden" style={{ backgroundColor: theme.bg }}>
        <Background />
        <div className="relative z-10 flex flex-col items-center justify-center min-h-screen p-6">

          {/* Back */}
          <button
            onClick={() => { window.location.hash = '#/' }}
            className="absolute top-5 left-5 text-sm flex items-center gap-1.5 transition-colors cursor-pointer"
            style={{ color: 'var(--sub)' }}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
              <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Home
          </button>

          {/* Header */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-5"
              style={{ border: '1px solid var(--border)', background: 'rgba(0,255,200,0.05)' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
                style={{ stroke: 'var(--accent)' }}>
                <path d="M9 19V6l12-3v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
              </svg>
            </div>
            <h1 className="text-4xl font-bold tracking-tight mb-1" style={{ color: 'var(--ink)' }}>Read Practice</h1>
            <p className="text-sm" style={{ color: 'var(--sub)' }}>Sight-reading reaction training</p>
          </div>

          {/* Mode toggle */}
          <div className="flex gap-1 mb-8 p-1 rounded-xl" style={{ border: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)' }}>
            {[
              { id: 'vibe',     label: 'Vibe',     sub: 'Endless flow'        },
              { id: 'practice', label: 'Practice', sub: 'Track reaction time' },
            ].map(m => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className="px-6 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer"
                style={mode === m.id
                  ? { background: 'var(--accent)', color: '#000' }
                  : { color: 'var(--sub)' }}
              >
                {m.label}
                <span className="block text-xs font-normal mt-0.5 opacity-60">{m.sub}</span>
              </button>
            ))}
          </div>

          {/* Difficulty grid */}
          <div className="w-full max-w-xl mb-8">
            <p className="text-[10px] uppercase tracking-widest mb-3 text-center" style={{ color: 'var(--sub)', opacity: 0.6 }}>Difficulty</p>
            <div className="grid grid-cols-4 gap-2">
              {DIFFICULTIES.map(d => (
                <button
                  key={d.id}
                  onClick={() => setDifficulty(d.id)}
                  className="p-3 rounded-xl border text-left transition-all cursor-pointer"
                  style={difficulty === d.id
                    ? { borderColor: 'var(--accent)', background: 'rgba(0,255,200,0.1)', color: 'var(--ink)' }
                    : { borderColor: 'var(--border)', background: 'rgba(255,255,255,0.02)', color: 'var(--sub)' }}
                >
                  <div className="text-sm font-semibold">{d.name}</div>
                  <div className="text-[11px] opacity-60 mt-0.5 leading-tight">{d.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Input + note names row */}
          <div className="flex flex-wrap items-center justify-center gap-3 mb-10">
            {[
              { id: 'midi', label: 'MIDI Keyboard' },
              { id: 'mic',  label: 'Microphone'    },
            ].map(m => (
              <button
                key={m.id}
                onClick={() => setInputMethod(m.id)}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all border cursor-pointer"
                style={inputMethod === m.id
                  ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'rgba(0,255,200,0.06)' }
                  : { borderColor: 'var(--border)', color: 'var(--sub)', background: 'transparent' }}
              >
                {m.label}
              </button>
            ))}

            <div className="w-px h-5" style={{ background: 'var(--border)' }} />

            <button
              onClick={() => setShowNoteNames(v => !v)}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all cursor-pointer text-sm"
              style={{ border: '1px solid var(--border)', color: 'var(--sub)' }}
            >
              <div className="w-8 rounded-full relative flex-shrink-0 transition-colors"
                style={{ height: '18px', background: showNoteNames ? 'var(--accent)' : 'rgba(255,255,255,0.08)' }}>
                <span className="absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all"
                  style={{ left: showNoteNames ? '14px' : '2px' }} />
              </div>
              Note names
            </button>
          </div>

          <button
            onClick={startGame}
            className="px-14 py-3.5 rounded-xl text-base font-bold transition-all cursor-pointer"
            style={{ background: 'var(--accent)', color: '#000' }}
          >
            Start
          </button>
        </div>
      </div>
    )
  }

  // ─── Summary screen ──────────────────────────────────────────────────────────
  if (screen === 'summary') {
    return (
      <div className="min-h-screen text-white relative overflow-hidden" style={{ backgroundColor: theme.bg }}>
        <Background />
        <div className="relative z-10 flex flex-col items-center justify-center min-h-screen p-6">
          {/* Glow behind score */}
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, rgba(0,255,200,0.07) 0%, transparent 70%)' }} />

          <h2 className="text-4xl font-bold mb-1" style={{ color: 'var(--ink)' }}>Session Complete</h2>
          <p className="text-sm mb-10" style={{ color: 'var(--sub)' }}>
            {DIFFICULTIES[difficulty - 1].name} · Practice Mode
          </p>

          {/* Score hero */}
          <div className="w-full max-w-sm mb-8">
            <div className="rounded-2xl p-6 text-center mb-4"
              style={{ border: '1px solid rgba(0,255,200,0.2)', background: 'rgba(0,255,200,0.04)' }}>
              <div className="text-5xl font-bold mb-1" style={{ color: 'var(--ink)' }}>{stats.score}</div>
              <div className="text-xs uppercase tracking-widest" style={{ color: 'var(--sub)' }}>Total Score</div>
              <div className="text-[10px] mt-2" style={{ color: 'var(--sub)', opacity: 0.5 }}>+3 &lt;500ms · +2 &lt;1s · +1 &lt;2s</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <StatBox label="Notes Played"  value={stats.total} />
              <StatBox label="Avg Reaction"  value={`${avgMs}ms`} />
              <StatBox label="Fastest"       value={`${bestMs}ms`}  valueClass="text-green-400" />
              <StatBox label="Slowest"       value={`${worstMs}ms`} valueClass="text-red-400" />
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={startGame} className="px-6 py-2.5 rounded-xl font-bold text-sm transition-all cursor-pointer"
              style={{ background: 'var(--accent)', color: '#000' }}>
              Play Again
            </button>
            <button onClick={() => setScreen('start')} className="px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors cursor-pointer"
              style={{ border: '1.5px solid var(--accent)', color: 'var(--accent)', background: 'transparent' }}>
              Settings
            </button>
            <button onClick={() => { window.location.hash = '#/' }} className="px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors cursor-pointer"
              style={{ border: '1px solid var(--border)', color: 'var(--sub)', background: 'transparent' }}>
              Home
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ─── Playing screen ───────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen text-white flex flex-col relative overflow-hidden" style={{ backgroundColor: theme.bg }}>
      <Background />

      {/* Top bar */}
      <div className="relative z-10 flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <button
          onClick={exitGame}
          className="text-sm flex items-center gap-1.5 transition-colors cursor-pointer"
          style={{ color: 'var(--sub)' }}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Exit
        </button>

        <span className="text-xs" style={{ color: 'var(--sub)', opacity: 0.6 }}>
          {DIFFICULTIES[difficulty - 1].name} · {mode === 'vibe' ? 'Vibe' : 'Practice'}
        </span>

        <div className="flex items-center gap-4">
          {mode === 'practice' && (
            <div className="flex gap-4 text-xs items-center">
              <span className="font-bold" style={{ color: 'var(--ink)' }}>{stats.score} pts</span>
              <span style={{ color: 'var(--sub)' }}>
                Notes: <span className="font-semibold" style={{ color: 'var(--ink)' }}>{stats.total}</span>
              </span>
              {avgMs > 0 && (
                <span style={{ color: 'var(--sub)' }}>
                  Avg: <span className="font-semibold" style={{ color: 'var(--ink)' }}>{avgMs}ms</span>
                </span>
              )}
            </div>
          )}
          <button
            onClick={() => setShowNoteNames(v => !v)}
            className="text-xs px-2.5 py-1.5 rounded-lg border transition-colors cursor-pointer"
            style={{ borderColor: showNoteNames ? 'var(--accent)' : 'var(--border)', color: showNoteNames ? 'var(--accent)' : 'var(--sub)' }}
          >
            {showNoteNames ? 'Hide names' : 'Show names'}
          </button>
        </div>
      </div>

      {/* Sheet music + note feedback */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 gap-5">
        {/* White sheet */}
        <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl shadow-black/50 px-8 py-6 ring-1 ring-white/10">
          <div
            ref={svgContainerRef}
            className="[&_svg]:w-full [&_svg]:h-auto"
            dangerouslySetInnerHTML={{ __html: svgContent }}
          />
        </div>

        {/* Note feedback panel */}
        {(() => {
          const held = [...heldNotes].sort((a, b) => a - b)
          const allCorrect = held.length === targetNotes.length &&
            held.every((n, i) => n === targetNotes[i])
          const anyHeld = held.length > 0
          const dotStyle = !anyHeld
            ? { background: 'var(--border)' }
            : allCorrect
              ? { background: 'var(--accent)', boxShadow: '0 0 6px rgba(0,255,200,0.4)' }
              : { background: '#e07878' }
          return (
            <div className="w-full max-w-2xl rounded-xl backdrop-blur-md px-5 py-3.5"
              style={{ border: '1px solid var(--border)', background: 'rgba(255,255,255,0.025)' }}>
              <div className="flex items-center gap-6">
                {/* Target */}
                <div>
                  <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--sub)' }}>Target</div>
                  <div className="flex gap-2 flex-wrap">
                    {targetNotes.map(midi => (
                      <span
                        key={midi}
                        className="text-lg font-bold font-mono leading-tight transition-colors"
                        style={{ color: heldNotes.includes(midi) ? 'var(--ink)' : 'var(--sub)' }}
                      >
                        {showNoteNames ? midiToNoteName(midi) : '●'}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="w-px h-8 shrink-0" style={{ background: 'var(--border)' }} />

                {/* Playing */}
                <div>
                  <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--sub)' }}>Playing</div>
                  <div className="flex gap-2 flex-wrap min-w-[3rem]">
                    {held.length === 0 ? (
                      <span className="text-lg font-bold font-mono" style={{ color: 'var(--border)' }}>---</span>
                    ) : (
                      held.map(midi => {
                        const correct = targetNotes.includes(midi)
                        return (
                          <span
                            key={midi}
                            className="text-lg font-bold font-mono leading-tight"
                            style={{ color: correct ? 'var(--ink)' : '#e07878' }}
                          >
                            {showNoteNames ? midiToNoteName(midi) : '●'}
                          </span>
                        )
                      })
                    )}
                  </div>
                </div>

                {/* Match dot */}
                <div className="w-3 h-3 rounded-full shrink-0 transition-all ml-auto" style={dotStyle} />
              </div>
            </div>
          )
        })()}

        {/* Reaction time flash */}
        {reactionFlash !== null && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-1">
            <span className={`text-7xl font-bold tabular-nums tracking-tight ${flashColor}`}>
              {reactionFlash}ms
            </span>
            <span className={`text-3xl font-bold ${flashColor} opacity-80`}>{flashPoints}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function StatBox({ label, value, valueClass = '' }) {
  return (
    <div className="rounded-xl p-4 text-center" style={{ border: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
      <div className={`text-2xl font-bold ${valueClass}`} style={!valueClass ? { color: 'var(--ink)' } : {}}>{value}</div>
      <div className="text-xs mt-1" style={{ color: 'var(--sub)' }}>{label}</div>
    </div>
  )
}
