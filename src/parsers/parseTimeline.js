import { unfoldRepeats } from './osmdParser'

const TICKS_PER_QUARTER = 960

/**
 * Convert an absolute tick to seconds using a tempo map.
 * tempoMap is [{ tick, bpm }] sorted by tick, with at least one entry at tick 0.
 */
export function tickToSec(tick, tempoMap) {
  let seconds = 0
  let prevTick = 0
  let secPerTick = 60 / (tempoMap[0].bpm * TICKS_PER_QUARTER)

  for (let i = 0; i < tempoMap.length; i++) {
    const te = tempoMap[i]
    if (te.tick >= tick) break
    if (te.tick > prevTick) {
      seconds += (te.tick - prevTick) * secPerTick
      prevTick = te.tick
    }
    secPerTick = 60 / (te.bpm * TICKS_PER_QUARTER)
  }
  seconds += (tick - prevTick) * secPerTick
  return seconds
}

/**
 * Parse note timeline directly from MusicXML string.
 * Returns { timeline, divisions, tempo, tempoMap } where timeline entries have:
 *   { tick, duration, durationSec, measure, notes: string[], isTied }
 * Ticks/durations are scaled to 960-per-quarter for AlphaTab compatibility.
 * Parses all <part> elements — first part = right hand, second = left hand.
 * tempoMap is [{ tick, bpm }] tracking all mid-piece tempo changes.
 */
export function parseNoteTimeline(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') return { timeline: [], divisions: 1, tempo: 120, tempoMap: [{ tick: 0, bpm: 120 }] }

  // Expand repeat barlines into a linear sequence before DOM parsing.
  xmlString = unfoldRepeats(xmlString).xml

  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlString, 'text/xml')

  // Build tempo map from all <sound tempo="..."> directives in the first part.
  // We walk the first part's measures to compute tick positions for each tempo change.
  const tempoMap = []
  const firstPart = doc.querySelector('part')
  if (firstPart) {
    const measures = firstPart.querySelectorAll('measure')
    let scanTick = 0
    let scanDivisions = 1

    measures.forEach((measure) => {
      const divEl = measure.querySelector('attributes > divisions')
      if (divEl) scanDivisions = parseInt(divEl.textContent) || 1

      let mTick = scanTick
      const children = measure.children

      for (let i = 0; i < children.length; i++) {
        const el = children[i]

        if (el.tagName === 'forward') {
          const dur = parseInt(el.querySelector('duration')?.textContent) || 0
          mTick += (dur / scanDivisions) * TICKS_PER_QUARTER
        } else if (el.tagName === 'backup') {
          const dur = parseInt(el.querySelector('duration')?.textContent) || 0
          mTick -= (dur / scanDivisions) * TICKS_PER_QUARTER
        } else if (el.tagName === 'direction' || el.tagName === 'sound') {
          // <direction> can contain <sound tempo="...">, or <sound> can appear directly
          const soundEls = el.tagName === 'sound' ? [el] : el.querySelectorAll('sound[tempo]')
          for (const s of soundEls) {
            const t = parseFloat(s.getAttribute('tempo'))
            if (t > 0) tempoMap.push({ tick: Math.round(mTick), bpm: t })
          }
        } else if (el.tagName === 'note') {
          const isChord = !!el.querySelector('chord')
          if (!isChord) {
            const dur = parseInt(el.querySelector('duration')?.textContent) || 0
            if (!el.querySelector('grace')) {
              mTick += (dur / scanDivisions) * TICKS_PER_QUARTER
            }
          }
        }
      }
      scanTick = mTick
    })
  }

  // Ensure tempo map starts at tick 0
  if (tempoMap.length === 0 || tempoMap[0].tick !== 0) {
    tempoMap.unshift({ tick: 0, bpm: 120 })
  }
  // De-duplicate: if multiple entries at the same tick, keep the last one
  for (let i = tempoMap.length - 1; i > 0; i--) {
    if (tempoMap[i].tick === tempoMap[i - 1].tick) {
      tempoMap.splice(i - 1, 1)
    }
  }

  const initialTempo = tempoMap[0].bpm

  const parts = doc.querySelectorAll('part')
  if (parts.length === 0) return { timeline: [], divisions: 1, tempo: initialTempo, tempoMap }

  const allNotes = []

  parts.forEach((part, partIndex) => {
    const hand = partIndex === 0 ? 'right' : 'left'
    const measures = part.querySelectorAll('measure')
    let currentTick = 0
    let divisions = 1

    measures.forEach((measure, measureIndex) => {
      const divEl = measure.querySelector('attributes > divisions')
      if (divEl) divisions = parseInt(divEl.textContent) || 1

      let measureTick = currentTick
      const children = measure.children

      for (let i = 0; i < children.length; i++) {
        const el = children[i]

        if (el.tagName === 'forward') {
          const dur = parseInt(el.querySelector('duration')?.textContent) || 0
          measureTick += (dur / divisions) * TICKS_PER_QUARTER
          continue
        }
        if (el.tagName === 'backup') {
          const dur = parseInt(el.querySelector('duration')?.textContent) || 0
          measureTick -= (dur / divisions) * TICKS_PER_QUARTER
          continue
        }

        if (el.tagName !== 'note') continue

        const duration = parseInt(el.querySelector('duration')?.textContent) || 0
        const durationTicks = (duration / divisions) * TICKS_PER_QUARTER
        const isRest = !!el.querySelector('rest')
        const isChord = !!el.querySelector('chord')

        if (el.querySelector('grace')) continue

        if (!isRest) {
          const pitchEl = el.querySelector('pitch')
          if (!pitchEl) {
            if (!isChord) measureTick += durationTicks
            continue
          }

          const step = pitchEl.querySelector('step')?.textContent || ''
          const xmlOctave = parseInt(pitchEl.querySelector('octave')?.textContent || '4')
          const octave = xmlOctave - 1 // MusicXML C4 = MIDI C3
          const alter = pitchEl.querySelector('alter')?.textContent
          const accidental = alter === '1' ? '#' : alter === '-1' ? 'b' : ''
          const noteName = step + accidental + octave

          const ties = el.querySelectorAll('tie')
          let hasTieStop = false, hasTieStart = false
          ties.forEach(t => {
            if (t.getAttribute('type') === 'stop') hasTieStop = true
            if (t.getAttribute('type') === 'start') hasTieStart = true
          })

          if (hasTieStop && !hasTieStart) {
            if (!isChord) measureTick += durationTicks
            continue
          }

          if (isChord) {
            // Chord note shares the same tick as the preceding note.
            // measureTick was already advanced by that preceding note's duration, so step back.
            const chordTick = Math.round(measureTick - durationTicks)
            // Find the last note at this same tick for this hand
            for (let j = allNotes.length - 1; j >= 0; j--) {
              if (allNotes[j].hand === hand && Math.abs(allNotes[j].tick - chordTick) < 1) {
                if (!allNotes[j].notes.includes(noteName)) {
                  allNotes[j].notes.push(noteName)
                }
                if (hasTieStart) allNotes[j].isTied = true
                break
              }
            }
          } else {
            const noteTick = Math.round(measureTick)
            const noteEndTick = Math.round(measureTick + durationTicks)
            allNotes.push({
              tick: noteTick,
              duration: Math.round(durationTicks),
              durationSec: tickToSec(noteEndTick, tempoMap) - tickToSec(noteTick, tempoMap),
              measure: measureIndex + 1,
              notes: [noteName],
              isTied: hasTieStart,
              hand,
            })
            measureTick += durationTicks
          }
        } else if (!isChord) {
          measureTick += durationTicks
        }
      }

      currentTick = measureTick
    })
  })

  // Sort by tick, then right hand first
  allNotes.sort((a, b) => a.tick - b.tick || (a.hand === 'right' ? -1 : 1))

  return { timeline: allNotes, divisions: 1, tempo: initialTempo, tempoMap }
}

/** Convert note name like "C#3" or "A-1" to MIDI number */
export function noteNameToMidi(name) {
  const m = name.match(/^([A-G])(#|b)?(-?\d+)$/)
  if (!m) return null
  const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  let semi = BASE[m[1]]
  if (semi == null) return null
  if (m[2] === '#') semi++
  else if (m[2] === 'b') semi--
  return semi + (parseInt(m[3]) + 2) * 12
}
