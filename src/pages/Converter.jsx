import { useState, useRef, useCallback } from 'react'
import { parseMidi } from 'midi-file'
import { unzipSync } from 'fflate'
import Background from '../Background'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { getSavedFolder } from '../lib/scoreFolder'

// ── XML helper ────────────────────────────────────────────────────────────────
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── MIDI pitch helpers ────────────────────────────────────────────────────────
const PITCH_CLASS = [
  { step: 'C', alter: 0 }, { step: 'C', alter: 1 },
  { step: 'D', alter: 0 }, { step: 'D', alter: 1 },
  { step: 'E', alter: 0 }, { step: 'F', alter: 0 },
  { step: 'F', alter: 1 }, { step: 'G', alter: 0 },
  { step: 'G', alter: 1 }, { step: 'A', alter: 0 },
  { step: 'A', alter: 1 }, { step: 'B', alter: 0 },
]
function midiToMxmlPitch(n) {
  const pc = PITCH_CLASS[n % 12]
  return { ...pc, octave: Math.floor(n / 12) - 1 }
}

// Duration snap for .mid converter (divisions=4 → 1 per 16th)
const DURATION_TYPES = [
  { min: 32, type: 'breve',   dotted: false, sixteenths: 32 },
  { min: 24, type: 'whole',   dotted: true,  sixteenths: 24 },
  { min: 16, type: 'whole',   dotted: false, sixteenths: 16 },
  { min: 12, type: 'half',    dotted: true,  sixteenths: 12 },
  { min: 8,  type: 'half',    dotted: false, sixteenths: 8  },
  { min: 6,  type: 'quarter', dotted: true,  sixteenths: 6  },
  { min: 4,  type: 'quarter', dotted: false, sixteenths: 4  },
  { min: 3,  type: 'eighth',  dotted: true,  sixteenths: 3  },
  { min: 2,  type: 'eighth',  dotted: false, sixteenths: 2  },
  { min: 1,  type: '16th',    dotted: false, sixteenths: 1  },
]
function snapDuration(sixteenths) {
  const c = Math.max(1, Math.round(sixteenths))
  return DURATION_TYPES.find(d => c >= d.min) ?? DURATION_TYPES[DURATION_TYPES.length - 1]
}
function noteXml(noteNumber, sixteenths, isChord) {
  const { step, alter, octave } = midiToMxmlPitch(noteNumber)
  const dur = snapDuration(sixteenths)
  return `<note>${isChord ? '<chord/>' : ''}<pitch><step>${step}</step>${alter !== 0 ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>${dur.sixteenths}</duration>${dur.dotted ? '<dot/>' : ''}<type>${dur.type}</type></note>`
}
function restXml(sixteenths) {
  let rem = Math.max(1, Math.round(sixteenths)), xml = ''
  while (rem > 0) {
    const dur = snapDuration(rem)
    xml += `<note><rest/><duration>${dur.sixteenths}</duration>${dur.dotted ? '<dot/>' : ''}<type>${dur.type}</type></note>`
    rem -= dur.sixteenths
  }
  return xml
}

// ── .mxl → .musicxml ──────────────────────────────────────────────────────────
async function convertMxl(file) {
  const buf = await file.arrayBuffer()
  let files
  try { files = unzipSync(new Uint8Array(buf)) }
  catch (e) { throw new Error(`Could not unzip .mxl: ${e.message}`) }

  const containerBytes = files['META-INF/container.xml']
  if (!containerBytes) throw new Error('Invalid .mxl: missing META-INF/container.xml')
  const containerStr = new TextDecoder().decode(containerBytes)
  const m = containerStr.match(/full-path="([^"]+\.xml)"/)
  if (!m) throw new Error('Invalid .mxl: no rootfile in container.xml')
  const bytes = files[m[1]]
  if (!bytes) throw new Error(`Invalid .mxl: rootfile "${m[1]}" not found in ZIP`)
  return new TextDecoder().decode(bytes)
}

// ── .mid → .musicxml ──────────────────────────────────────────────────────────
async function convertMidFile(file) {
  const buf = await file.arrayBuffer()
  let midi
  try { midi = parseMidi(new Uint8Array(buf)) }
  catch (e) { throw new Error(`Could not parse MIDI: ${e.message}`) }

  const { format, ticksPerBeat } = midi.header
  if (!ticksPerBeat || ticksPerBeat <= 0) throw new Error('MIDI uses SMPTE timing — not supported.')

  let microsecondsPerBeat = 500000, timeSigNum = 4, timeSigDen = 4
  for (let ti = 0; ti < midi.tracks.length; ti++) {
    for (const ev of midi.tracks[ti]) {
      if (ev.type === 'setTempo') microsecondsPerBeat = ev.microsecondsPerBeat
      if (ev.type === 'timeSignature') {
        const n = typeof ev.numerator === 'number' && ev.numerator > 0 ? ev.numerator : 4
        const dExp = typeof ev.denominator === 'number' ? ev.denominator : 2
        timeSigNum = n
        timeSigDen = Math.pow(2, dExp) || 4
      }
    }
    if (format === 1) break
  }

  const bpm = Math.round(60_000_000 / microsecondsPerBeat)
  const q = ticksPerBeat / 4
  const sixteenthsPerMeasure = Math.round(timeSigNum * (16 / timeSigDen)) || 16
  const hasNotes = t => t.some(e => e.type === 'noteOn' && e.velocity > 0)
  const noteTracks = format === 0
    ? (hasNotes(midi.tracks[0]) ? [midi.tracks[0]] : [])
    : midi.tracks.filter(hasNotes)
  if (!noteTracks.length) throw new Error('No note data found in MIDI file.')

  function trackToNotes(track) {
    let tick = 0; const pending = {}, notes = []
    for (const ev of track) {
      tick += ev.deltaTime
      if (ev.type === 'noteOn' && ev.velocity > 0) { pending[ev.noteNumber] = tick }
      else if (ev.type === 'noteOff' || (ev.type === 'noteOn' && ev.velocity === 0)) {
        if (pending[ev.noteNumber] !== undefined) {
          notes.push({ noteNumber: ev.noteNumber, startTick: pending[ev.noteNumber], durationTicks: Math.max(1, tick - pending[ev.noteNumber]) })
          delete pending[ev.noteNumber]
        }
      }
    }
    return notes.sort((a, b) => a.startTick - b.startTick || a.noteNumber - b.noteNumber)
  }

  function buildPart(notes, partId) {
    const qNotes = notes.map(n => ({ noteNumber: n.noteNumber, qStart: Math.round(n.startTick / q), qDur: Math.max(1, Math.round(n.durationTicks / q)) }))
    const total = qNotes.length > 0 ? Math.max(...qNotes.map(n => n.qStart + n.qDur)) : sixteenthsPerMeasure
    const numM = Math.max(1, Math.ceil(total / sixteenthsPerMeasure))
    let measuresXml = ''
    for (let m = 0; m < numM; m++) {
      const mStart = m * sixteenthsPerMeasure, mEnd = mStart + sixteenthsPerMeasure
      const byPos = new Map()
      for (const n of qNotes) {
        if (n.qStart >= mStart && n.qStart < mEnd) {
          const pos = n.qStart - mStart, dur = Math.min(n.qDur, mEnd - n.qStart)
          if (!byPos.has(pos)) byPos.set(pos, [])
          byPos.get(pos).push({ noteNumber: n.noteNumber, dur })
        }
      }
      const positions = [...byPos.keys()].sort((a, b) => a - b)
      let notesXml = '', cursor = 0
      for (const pos of positions) {
        if (pos > cursor) notesXml += restXml(pos - cursor)
        const group = byPos.get(pos), dur = group[0].dur
        group.forEach((n, i) => { notesXml += noteXml(n.noteNumber, dur, i > 0) })
        cursor = pos + dur
      }
      if (cursor < sixteenthsPerMeasure) notesXml += restXml(sixteenthsPerMeasure - cursor)
      const attrs = m === 0 ? `<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>${timeSigNum}</beats><beat-type>${timeSigDen}</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>` : ''
      measuresXml += `<measure number="${m + 1}">${attrs}${notesXml}</measure>`
    }
    return `<part id="${partId}">${measuresXml}</part>`
  }

  const trackNames = noteTracks.map(t => { const e = t.find(e => e.type === 'trackName'); return e?.text?.trim() || null })
  const partListXml = noteTracks.map((_, i) => `<score-part id="P${i+1}"><part-name>${escapeXml(trackNames[i] || `Part ${i+1}`)}</part-name></score-part>`).join('')
  const partsXml = noteTracks.map((t, i) => buildPart(trackToNotes(t), `P${i+1}`)).join('\n  ')
  const title = escapeXml(file.name.replace(/\.[^.]+$/, ''))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>${title}</work-title></work>
  <identification><encoding><software>Pianly Converter</software></encoding></identification>
  <part-list>${partListXml}</part-list>
  ${partsXml}
</score-partwise>`
}

// ── .pdf → not supported ──────────────────────────────────────────────────────


async function convertPdf() {
  throw new Error(
    'PDF → MusicXML requires Optical Music Recognition (OMR) software which cannot run in-app. ' +
    'Try Audiveris (free, open-source) or PhotoScore, then upload the resulting .musicxml here.'
  )
}

// ── .xml / .musicxml → pass-through (already MusicXML) ───────────────────────
async function passthroughXml(file) {
  return file.text()
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
async function convertFile(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (ext === 'xml' || ext === 'musicxml') return passthroughXml(file)
  if (ext === 'mxl')               return convertMxl(file)
  if (ext === 'mid' || ext === 'midi') return convertMidFile(file)
  if (ext === 'pdf')               return convertPdf()
  throw new Error(`Unsupported format ".${ext}". Accepted: .xml, .musicxml, .mxl, .mid, .pdf`)
}

// ── Save helper ───────────────────────────────────────────────────────────────
async function saveXml(xml, filename) {
  const folder = getSavedFolder()
  if (folder) {
    const sep = folder.endsWith('/') || folder.endsWith('\\') ? '' : '/'
    await writeTextFile(folder + sep + filename, xml)
    return { savedTo: folder }
  }
  // Fall back to browser download → goes to system Downloads folder
  const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click()
  document.body.removeChild(a); URL.revokeObjectURL(url)
  return { savedTo: null }
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:   'transparent',
  text: 'oklch(0.95 0.008 270)',
  muted:'oklch(0.62 0.015 270)',
  dim:  'oklch(0.45 0.01 270)',
  accent: 'oklch(0.7 0.2 160)',
  // state colours
  done: 'oklch(0.7 0.2 160)',
  err:  '#FF6B6B',
}
const CARD  = 'rgba(255,255,255,0.025)'
const BORD  = 'rgba(0,255,200,0.12)'
const BORD2 = 'rgba(0,255,200,0.20)'

// ── Helpers ───────────────────────────────────────────────────────────────────
const extColor = ext => ({ xml: C.text, musicxml: C.text, mxl: C.text, mid: C.muted, midi: C.muted }[ext] ?? C.dim)

function StatusBadge({ status }) {
  if (status === 'converting') return (
    <span style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, fontWeight:600, color: C.accent }}>
      <span style={{ width:10, height:10, borderRadius:'50%', border:`2px solid ${C.accent}`, borderTopColor:'transparent', animation:'cv-spin .7s linear infinite', display:'inline-block' }} />
      Converting
    </span>
  )
  if (status === 'done') return (
    <span style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, fontWeight:600, color: C.done }}>
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
        <circle cx="6" cy="6" r="5.5" stroke={C.done} strokeWidth="1.1"/>
        <path d="M3.5 6l1.5 1.5 3.5-3.5" stroke={C.done} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      Done
    </span>
  )
  if (status === 'error') return (
    <span style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, fontWeight:600, color: C.err }}>
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
        <circle cx="6" cy="6" r="5.5" stroke={C.err} strokeWidth="1.1"/>
        <path d="M4 4l4 4M8 4l-4 4" stroke={C.err} strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
      Failed
    </span>
  )
  return null
}

// ── Format row ────────────────────────────────────────────────────────────────
const FMTS = [
  { ext:'.xml',  label:'XML',  detail:'Pass-through',      color: C.text },
  { ext:'.mxl',  label:'MXL',  detail:'Unzip → XML',      color: C.text },
  { ext:'.mid',  label:'MIDI', detail:'JS parser',         color: C.muted },
  { ext:'.pdf',  label:'PDF',  detail:'Needs OMR tool',    color:'oklch(0.45 0.01 270)' },
]

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Converter() {
  const [items,    setItems]    = useState([])
  const [dragging, setDragging] = useState(false)
  const [savedMsg, setSavedMsg] = useState(null) // { text, id }
  const inputRef  = useRef(null)
  const idCounter = useRef(0)

  async function handleSave(xml, filename) {
    try {
      const { savedTo } = await saveXml(xml, filename)
      if (savedTo) {
        const folder = savedTo.split('/').filter(Boolean).pop() || savedTo
        const msgId = Date.now()
        setSavedMsg({ text: `Saved to "${folder}"`, id: msgId })
        setTimeout(() => setSavedMsg(m => m?.id === msgId ? null : m), 3000)
      }
    } catch (e) {
      console.error('[Converter] save failed:', e)
      // fall back to browser download on error
      saveXml.fallbackDownload?.(xml, filename)
    }
  }

  const processFiles = useCallback(async (fileList) => {
    const newItems = Array.from(fileList).map(file => ({
      id: ++idCounter.current, file, status: 'converting', xml: null, error: null,
    }))
    setItems(prev => [...prev, ...newItems])
    await Promise.all(newItems.map(async item => {
      try {
        const xml = await convertFile(item.file)
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'done', xml } : i))
      } catch (e) {
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'error', error: e.message } : i))
      }
    }))
  }, [])

  const handleDrop      = e => { e.preventDefault(); setDragging(false); e.dataTransfer.files.length && processFiles(e.dataTransfer.files) }
  const handleDragOver  = e => { e.preventDefault(); setDragging(true) }
  const handleDragLeave = e => { !e.currentTarget.contains(e.relatedTarget) && setDragging(false) }
  const handleInput     = e => { e.target.files.length && (processFiles(e.target.files), e.target.value = '') }
  const removeItem      = id => setItems(prev => prev.filter(i => i.id !== id))

  return (
    <div style={{ minHeight:'100vh', color: C.text,
      fontFamily:"'Sora', sans-serif", position:'relative', background:'transparent' }}>
      <Background />

      {/* ── Nav ── */}
      <nav style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'16px 28px', borderBottom:`1px solid ${BORD}`, position:'relative', zIndex:10 }}>
        <button onClick={() => { window.location.hash = '#/' }}
          style={{ display:'flex', alignItems:'center', gap:7, fontSize:13, fontWeight:500,
            color: C.muted, background:'none', border:'none', cursor:'pointer', transition:'color .15s' }}
          onMouseEnter={e => e.currentTarget.style.color = C.text}
          onMouseLeave={e => e.currentTarget.style.color = C.muted}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
          Home
        </button>
        <span style={{ fontSize:11, letterSpacing:'.12em', textTransform:'uppercase', color: C.dim }}>Pianly</span>
      </nav>

      {/* ── Saved toast ── */}
      {savedMsg && (
        <div style={{ position:'fixed', bottom:28, right:28, zIndex:999,
          background:'oklch(0.18 0.03 160)', border:`1px solid ${BORD2}`,
          borderRadius:12, padding:'11px 18px', fontSize:13, fontWeight:500,
          color: C.accent, boxShadow:'0 8px 32px rgba(0,0,0,0.5)',
          display:'flex', alignItems:'center', gap:8,
          animation:'cv-item-in .22s ease-out both' }}>
          <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="6" r="5.5" stroke={C.accent} strokeWidth="1.1"/>
            <path d="M3.5 6l1.5 1.5 3.5-3.5" stroke={C.accent} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {savedMsg.text}
        </div>
      )}

      {/* ── Main layout ── */}
      <div style={{ maxWidth:680, margin:'0 auto', padding:'48px 24px 96px', position:'relative', zIndex:10 }}>

        {/* ── Hero title ── */}
        <header style={{ marginBottom:40 }}>
          <h1 style={{ fontSize:42, fontWeight:750, letterSpacing:'-0.03em', lineHeight:1.05,
            margin:'0 0 14px', color: C.text }}>
            Convert Files
          </h1>
          <p style={{ fontSize:15, color: C.muted, lineHeight:1.65, maxWidth:480, margin:0 }}>
            Turn <strong style={{ color: C.text, fontWeight:600 }}>.xml, .mxl, .mid</strong> or{' '}
            <strong style={{ color: C.text, fontWeight:600 }}>.pdf</strong> into
            MusicXML — entirely in the browser. No installs, no servers.
          </p>
        </header>

        {/* ── Drop zone ── */}
        <div style={{
          padding: 2,
          borderRadius: 28,
          background: dragging
            ? `linear-gradient(135deg, oklch(0.7 0.2 160), oklch(0.5 0.15 160))`
            : `linear-gradient(135deg, rgba(0,255,200,0.15), rgba(0,255,200,0.05))`,
          boxShadow: dragging
            ? '0 0 0 6px rgba(0,255,200,0.10), 0 24px 64px rgba(0,0,0,0.55)'
            : '0 12px 48px rgba(0,0,0,0.45)',
          transition: 'all .3s',
          animation: dragging ? 'none' : 'cv-pulse 3s ease-in-out infinite',
          marginBottom: 14,
          cursor: 'pointer',
        }}>
          <div
            onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}
            onClick={() => inputRef.current?.click()}
            style={{ borderRadius:26, background:'oklch(0.12 0.025 270)', padding:'56px 40px 52px',
              textAlign:'center', userSelect:'none' }}>

            {/* Icon */}
            <div style={{ marginBottom:22 }}>
              <div style={{
                width:72, height:72, borderRadius:22, margin:'0 auto',
                background: dragging ? 'rgba(0,255,200,0.15)' : 'rgba(255,255,255,0.04)',
                border: `1.5px solid ${dragging ? 'var(--accent)' : BORD}`,
                display:'flex', alignItems:'center', justifyContent:'center',
                transition:'all .3s',
                boxShadow: dragging ? '0 8px 32px rgba(0,255,200,0.15)' : 'none',
              }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none"
                  stroke={dragging ? C.accent : C.muted}
                  strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"
                  style={{ transition:'stroke .3s' }}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>
            </div>

            <div style={{ fontSize:20, fontWeight:700, letterSpacing:'-0.01em', marginBottom:8,
              color: C.text, transition:'color .3s' }}>
              {dragging ? 'Release to convert' : 'Drop files here'}
            </div>
            <div style={{ fontSize:13.5, color: C.muted }}>
              or{' '}
              <span style={{ color: C.accent,
                textDecoration:'underline', textDecorationStyle:'dotted', textUnderlineOffset:3 }}>
                click to browse
              </span>
              <span style={{ marginLeft:14, opacity:.45, fontSize:12 }}>
                .xml · .mxl · .mid · .pdf
              </span>
            </div>

            <input ref={inputRef} type="file" accept=".xml,.musicxml,.mxl,.mid,.midi,.pdf"
              multiple style={{ display:'none' }} onChange={handleInput} />
          </div>
        </div>

        {/* ── Format strip ── */}
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:36 }}>
          {FMTS.map(({ ext, label, detail, color }) => (
            <div key={ext} style={{
              display:'flex', alignItems:'center', gap:7,
              padding:'7px 13px', borderRadius:99,
              background: CARD, border:`1px solid ${BORD}`,
            }}>
              <span style={{ width:7, height:7, borderRadius:'50%', background:color, flexShrink:0 }} />
              <span style={{ fontSize:12, fontWeight:700, fontFamily:'monospace', color }}>{label}</span>
              <span style={{ fontSize:11.5, color: C.dim }}>— {detail}</span>
            </div>
          ))}
        </div>

        {/* ── File queue ── */}
        {items.length > 0 && (
          <section>
            {/* Queue header */}
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <span style={{ fontSize:12, fontWeight:700, letterSpacing:'.09em',
                  textTransform:'uppercase', color: C.dim }}>Queue</span>
                <span style={{ fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:99,
                  background:'rgba(0,255,200,0.08)', color: C.muted,
                  border:`1px solid ${BORD}` }}>
                  {items.length}
                </span>
              </div>
              {items.length > 1 && (
                <button onClick={() => setItems([])}
                  style={{ fontSize:12, color: C.dim, background:'none', border:'none', cursor:'pointer', transition:'color .15s' }}
                  onMouseEnter={e => e.currentTarget.style.color = C.muted}
                  onMouseLeave={e => e.currentTarget.style.color = C.dim}>
                  Clear all
                </button>
              )}
            </div>

            {/* Items */}
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {items.map(item => {
                const ext = item.file.name.split('.').pop().toLowerCase()
                const accentCol = extColor(ext)
                return (
                  <div key={item.id} style={{
                    display:'flex', alignItems:'flex-start', gap:0,
                    borderRadius:16, overflow:'hidden',
                    border:`1px solid ${BORD2}`,
                    background:'rgba(17,7,20,0.92)',
                    animation:'cv-item-in .22s ease-out both',
                    boxShadow:'0 2px 12px rgba(0,0,0,0.4)',
                  }}>
                    {/* Colored left stripe */}
                    <div style={{ width:3, alignSelf:'stretch', flexShrink:0,
                      background: item.status === 'error' ? C.err
                        : item.status === 'done' ? `linear-gradient(180deg,${C.accent},${C.muted})`
                        : `linear-gradient(180deg,rgba(0,255,200,0.15),rgba(0,255,200,0.05))`,
                      transition:'background .4s',
                    }} />

                    <div style={{ flex:1, padding:'13px 14px', display:'flex', alignItems:'flex-start', gap:12 }}>
                      {/* Ext badge */}
                      <div style={{
                        flexShrink:0, padding:'3px 8px', borderRadius:6, marginTop:1,
                        background:`${accentCol}18`, border:`1px solid ${accentCol}35`,
                        fontSize:10.5, fontWeight:700, fontFamily:'monospace',
                        color: accentCol, lineHeight:1.5,
                      }}>
                        .{ext}
                      </div>

                      {/* Name + size */}
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3, flexWrap:'wrap' }}>
                          <span style={{ fontSize:13.5, fontWeight:500, color: C.text,
                            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:280 }}>
                            {item.file.name}
                          </span>
                          <StatusBadge status={item.status} />
                        </div>
                        <span style={{ fontSize:11.5, color: C.dim }}>
                          {(item.file.size / 1024).toFixed(1)} KB
                        </span>
                        {item.status === 'error' && (
                          <div style={{ marginTop:8, fontSize:12, lineHeight:1.6,
                            background:'rgba(255,112,112,0.09)',
                            border:'1px solid rgba(255,112,112,0.18)',
                            borderRadius:10, padding:'8px 12px', color:'#FFBBBB' }}>
                            {item.error}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                        {item.status === 'done' && (
                          <button
                            onClick={() => handleSave(item.xml, item.file.name.replace(/\.[^.]+$/,'') + '.musicxml')}
                            style={{
                              display:'flex', alignItems:'center', gap:5,
                              padding:'7px 13px', borderRadius:10,
                              fontSize:12, fontWeight:600, cursor:'pointer',
                              background: C.accent,
                              border:'none', color:'#000',
                              boxShadow:'0 4px 16px rgba(0,255,200,0.20)',
                              transition:'opacity .15s, transform .15s',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.opacity='.88'; e.currentTarget.style.transform='translateY(-1px)' }}
                            onMouseLeave={e => { e.currentTarget.style.opacity='1';   e.currentTarget.style.transform='translateY(0)' }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                              stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                              <polyline points="7 10 12 15 17 10"/>
                              <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                            Download
                          </button>
                        )}
                        <button onClick={() => removeItem(item.id)}
                          style={{ width:28, height:28, borderRadius:8, display:'flex',
                            alignItems:'center', justifyContent:'center',
                            background:'none', border:'none', cursor:'pointer',
                            color: C.dim, transition:'color .15s' }}
                          onMouseEnter={e => e.currentTarget.style.color = C.muted}
                          onMouseLeave={e => e.currentTarget.style.color = C.dim}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                            <path d="M18 6L6 18M6 6l12 12"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}


      </div>
    </div>
  )
}
