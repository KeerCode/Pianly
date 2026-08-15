import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'

/**
 * Unfold MusicXML repeat barlines into a linear measure sequence.
 *
 * Handles:
 *  - <barline><repeat direction="forward"/></barline>  — marks repeat start
 *  - <barline><repeat direction="backward"/></barline> — marks repeat end
 *  - <ending number="1" type="start/stop">             — 1st volta (first pass only)
 *  - <ending number="2" type="start/stop">             — 2nd volta (repeat pass only)
 *
 * Returns a new XML string with measures reordered / duplicated in playback order.
 * Verovio rendering always uses the original XML — only audio/practice parsing
 * should use the unfolded form.
 */
export function unfoldRepeats(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') return { xml: xmlString, order: null }
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlString, 'text/xml')
    if (doc.querySelector('parsererror')) return { xml: xmlString, order: null }

    let globalOrder = null  // capture from first part

    for (const part of doc.querySelectorAll('part')) {
      const measures = [...part.querySelectorAll('measure')]
      if (measures.length === 0) continue

      // Pre-scan: identify which measure indices belong to volta 1 or volta 2 brackets.
      const voltaOf = {}   // index → 1 | 2
      let inVolta = null
      for (let j = 0; j < measures.length; j++) {
        for (const e of measures[j].querySelectorAll('barline ending')) {
          const type = e.getAttribute('type')
          if (type === 'start') {
            const num = e.getAttribute('number') ?? ''
            inVolta = num.includes('2') ? 2 : 1
          }
          if (type === 'stop' || type === 'discontinue') inVolta = null
        }
        if (inVolta !== null) voltaOf[j] = inVolta
      }

      // Simulate playback to build the ordered list of source-measure indices.
      const order = []
      let i = 0
      let repeatStart = 0
      let passNum = 1              // 1 = first time through, 2 = after first repeat
      const takenRepeats = new Set()

      while (i < measures.length) {
        const m = measures[i]

        // Forward repeat → new repeat region begins; reset pass counter.
        if (m.querySelector('repeat[direction="forward"]')) {
          repeatStart = i
          passNum = 1
        }

        // Skip volta brackets that don't apply to the current pass.
        const volta = voltaOf[i]
        if (volta === 1 && passNum > 1)  { i++; continue }  // skip 1st ending on repeat
        if (volta === 2 && passNum < 2)  { i++; continue }  // skip 2nd ending on first pass

        // Backward repeat: append this measure then loop back to repeatStart.
        if (m.querySelector('repeat[direction="backward"]') && !takenRepeats.has(i)) {
          order.push(i)
          takenRepeats.add(i)
          passNum++
          i = repeatStart
          continue
        }

        order.push(i)
        i++
      }

      // Capture order from first part for cursor mapping.
      if (globalOrder === null) globalOrder = order

      // Nothing changed → skip reconstruction.
      if (order.length === measures.length && order.every((idx, j) => idx === j)) continue

      // Clone each source measure in playback order.
      const newMeasures = order.map((srcIdx, newNum) => {
        const clone = measures[srcIdx].cloneNode(true)
        clone.setAttribute('number', String(newNum + 1))
        // Strip repeat/ending elements so the unfolded form has no repeat barlines.
        for (const el of clone.querySelectorAll('repeat, ending')) {
          el.parentNode.removeChild(el)
        }
        // Remove now-empty <barline> shells.
        for (const bl of [...clone.querySelectorAll('barline')]) {
          if (bl.children.length === 0) bl.parentNode.removeChild(bl)
        }
        return clone
      })

      // Replace the part's measure list with the new sequence.
      for (const m of measures) part.removeChild(m)
      for (const m of newMeasures) part.appendChild(m)
    }

    const xml = new XMLSerializer().serializeToString(doc)
    return { xml, order: globalOrder }
  } catch (err) {
    console.warn('[unfoldRepeats]', err)
    return { xml: xmlString, order: null }
  }
}

const ALPHATAB_TICKS_PER_QUARTER = 960
const TICKS_PER_WHOLE = ALPHATAB_TICKS_PER_QUARTER * 4

// Flat-preferred note names for MIDI-to-name conversion (matches standard sheet music convention).
// Enharmonic matching in midiInput.js handles C#↔Db etc. for practice mode.
const MIDI_NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

function tickToSeconds(tick, tempoMap) {
  let seconds = 0
  let prevTick = 0
  let secPerTick = 60 / (tempoMap[0].bpm * ALPHATAB_TICKS_PER_QUARTER)

  for (let i = 1; i < tempoMap.length; i++) {
    const te = tempoMap[i]
    if (te.tick >= tick) break
    seconds += (te.tick - prevTick) * secPerTick
    prevTick = te.tick
    secPerTick = 60 / (te.bpm * ALPHATAB_TICKS_PER_QUARTER)
  }
  seconds += (tick - prevTick) * secPerTick
  return seconds
}

function pitchToNoteName(pitch) {
  if (!pitch) return null
  // Use getHalfTone() for the exact semitone value — avoids dropped accidentals
  // from pitch.Accidental which OSMD sometimes fails to populate for flats.
  // OSMD halfTone = fundamentalNote + accidentalHalfTones + (octave + 3) * 12
  // Standard MIDI = halfTone + 12
  const midi = pitch.getHalfTone() + 12
  const name = MIDI_NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 2 // Pianly convention: MIDI 60 = C3 (middle C)
  return name + octave
}

/**
 * Walk original (non-unfolded) MusicXML and return an array where
 * origMeasureStartTicks[i] = the absolute tick (960-per-quarter) at which
 * measure i (0-based) begins in the original score.
 */
function buildOriginalMeasureStartTicks(xmlString) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlString, 'text/xml')
  const part = doc.querySelector('part')
  if (!part) return []

  const measures = part.querySelectorAll('measure')
  const starts = []
  let currentTick = 0
  let divisions = 1

  measures.forEach((measure) => {
    starts.push(Math.round(currentTick))

    const divEl = measure.querySelector('attributes > divisions')
    if (divEl) divisions = parseInt(divEl.textContent) || 1

    let measureTick = currentTick
    let maxTick = currentTick
    const children = measure.children

    for (let i = 0; i < children.length; i++) {
      const el = children[i]
      if (el.tagName === 'forward') {
        const dur = parseInt(el.querySelector('duration')?.textContent) || 0
        measureTick += (dur / divisions) * ALPHATAB_TICKS_PER_QUARTER
        if (measureTick > maxTick) maxTick = measureTick
      } else if (el.tagName === 'backup') {
        const dur = parseInt(el.querySelector('duration')?.textContent) || 0
        measureTick -= (dur / divisions) * ALPHATAB_TICKS_PER_QUARTER
      } else if (el.tagName === 'note') {
        const isChord = !!el.querySelector('chord')
        if (!isChord && !el.querySelector('grace')) {
          const dur = parseInt(el.querySelector('duration')?.textContent) || 0
          measureTick += (dur / divisions) * ALPHATAB_TICKS_PER_QUARTER
          if (measureTick > maxTick) maxTick = measureTick
        }
      }
    }
    currentTick = maxTick
  })

  return starts
}

/** Extract tempo map from raw MusicXML (simple DOM walk, no OSMD needed). */
function extractTempoMap(xmlString) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlString, 'text/xml')
  const part = doc.querySelector('part')
  if (!part) return [{ tick: 0, bpm: 120 }]

  const tempoMap = []
  const measures = part.querySelectorAll('measure')
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
        mTick += (dur / scanDivisions) * ALPHATAB_TICKS_PER_QUARTER
      } else if (el.tagName === 'backup') {
        const dur = parseInt(el.querySelector('duration')?.textContent) || 0
        mTick -= (dur / scanDivisions) * ALPHATAB_TICKS_PER_QUARTER
      } else if (el.tagName === 'direction' || el.tagName === 'sound') {
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
            mTick += (dur / scanDivisions) * ALPHATAB_TICKS_PER_QUARTER
          }
        }
      }
    }
    scanTick = mTick
  })

  if (tempoMap.length === 0 || tempoMap[0].tick !== 0) {
    tempoMap.unshift({ tick: 0, bpm: 120 })
  }
  for (let i = tempoMap.length - 1; i > 0; i--) {
    if (tempoMap[i].tick === tempoMap[i - 1].tick) tempoMap.splice(i - 1, 1)
  }
  return tempoMap
}

/**
 * Parse note timeline using OSMD's MusicXML parser.
 * Returns { timeline, divisions, tempoMap } with the same shape as the old parser.
 * Only extracts notes from the first instrument's first staff (right hand / treble).
 */
export async function parseNoteTimelineOSMD(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') {
    return { timeline: [], divisions: 1, tempoMap: [{ tick: 0, bpm: 120 }] }
  }

  // Expand repeat barlines into a linear measure sequence before any parsing.
  const { xml, order } = unfoldRepeats(xmlString)

  const tempoMap = extractTempoMap(xml)

  // For cursor mapping back to original-score time during repeats.
  const origMeasureStartTicks = buildOriginalMeasureStartTicks(xmlString)
  const origTempoMap = extractTempoMap(xmlString)

  // Hidden container — OSMD needs a DOM element but we only use it for parsing
  const container = document.createElement('div')
  container.style.cssText =
    'position:absolute;left:-9999px;visibility:hidden;width:800px;height:600px;overflow:hidden'
  document.body.appendChild(container)

  let osmd
  try {
    osmd = new OpenSheetMusicDisplay(container, {
      autoResize: false,
      drawTitle: false,
      drawSubtitle: false,
      drawComposer: false,
      drawCredits: false,
      drawPartNames: false,
      drawPartAbbreviations: false,
    })

    await osmd.load(xml)
    osmd.render()

    const sheet = osmd.Sheet
    if (!sheet || !sheet.SourceMeasures) {
      return { timeline: [], divisions: 1, tempoMap }
    }

    const instrument = sheet.Instruments?.[0]
    if (!instrument) return { timeline: [], divisions: 1, tempoMap }

    const timeline = []

    for (let mi = 0; mi < sheet.SourceMeasures.length; mi++) {
      const measure = sheet.SourceMeasures[mi]
      const measureStartReal = measure.AbsoluteTimestamp?.RealValue ?? 0
      const measureStartTick = Math.round(measureStartReal * TICKS_PER_WHOLE)

      const containers = measure.VerticalSourceStaffEntryContainers
      if (!containers) continue

      for (const vc of containers) {
        const staffEntries = vc.StaffEntries
        if (!staffEntries) continue

        for (const staffEntry of staffEntries) {
          if (!staffEntry) continue

          const voiceEntries = staffEntry.VoiceEntries
          if (!voiceEntries) continue

          for (const voiceEntry of voiceEntries) {
            if (voiceEntry.IsGrace) continue

            const notes = []
            let isTied = false
            let maxDurationReal = 0

            for (const note of voiceEntry.Notes) {
              if (note.isRest()) continue
              // Skip tie continuations — only include notes that start a tie or are untied
              if (note.NoteTie && note.NoteTie.StartNote !== note) continue

              const noteName = pitchToNoteName(note.Pitch)
              if (!noteName) continue
              if (!notes.includes(noteName)) notes.push(noteName)

              if (note.NoteTie && note.NoteTie.StartNote === note) isTied = true

              const dur = note.Length?.RealValue ?? 0
              if (dur > maxDurationReal) maxDurationReal = dur
            }

            if (notes.length === 0) continue

            const relTimestamp =
              voiceEntry.Timestamp?.RealValue ?? staffEntry.Timestamp?.RealValue ?? 0
            const absReal = measureStartReal + relTimestamp
            const tick = Math.round(absReal * TICKS_PER_WHOLE)
            const durationTicks = Math.round(maxDurationReal * TICKS_PER_WHOLE)
            // relTick: offset of this note within its unfolded measure (for cursor mapping)
            const relTick = tick - measureStartTick

            // Merge with previous entry at same tick (chord across voices/staves)
            const prev = timeline[timeline.length - 1]
            if (prev && prev.tick === tick) {
              for (const n of notes) {
                if (!prev.notes.includes(n)) prev.notes.push(n)
              }
              if (isTied) prev.isTied = true
              if (durationTicks > prev.durationTicks) prev.durationTicks = durationTicks
            } else {
              // _mi and _relTick are used below to compute cursorSec; stripped before return.
              timeline.push({ tick, durationTicks, measure: mi + 1, notes, isTied, _mi: mi, _relTick: relTick })
            }
          }
        }
      }
    }

    // Post-sort merge: catch any same-tick entries from non-adjacent voices
    timeline.sort((a, b) => a.tick - b.tick)
    for (let i = timeline.length - 1; i > 0; i--) {
      if (timeline[i].tick === timeline[i - 1].tick) {
        for (const n of timeline[i].notes) {
          if (!timeline[i - 1].notes.includes(n)) timeline[i - 1].notes.push(n)
        }
        if (timeline[i].isTied) timeline[i - 1].isTied = true
        if (timeline[i].durationTicks > timeline[i - 1].durationTicks) {
          timeline[i - 1].durationTicks = timeline[i].durationTicks
        }
        timeline.splice(i, 1)
      }
    }

    // Compute timeSec / durationSec from unfolded tempo map,
    // and cursorSec = original-score time for cursor highlighting during repeats.
    for (const entry of timeline) {
      entry.timeSec = tickToSeconds(entry.tick, tempoMap)
      entry.durationSec =
        tickToSeconds(entry.tick + entry.durationTicks, tempoMap) - entry.timeSec

      // Map back to original-score time so cursor highlight works on repeated sections.
      const origMeasureIdx = (order && order[entry._mi] != null) ? order[entry._mi] : entry._mi
      const origStartTick = origMeasureStartTicks[origMeasureIdx] ?? 0
      const cursorTick = origStartTick + (entry._relTick ?? 0)
      entry.cursorSec = tickToSeconds(cursorTick, origTempoMap)

      delete entry._mi
      delete entry._relTick
    }

    return { timeline, divisions: 1, tempoMap }
  } finally {
    try { osmd?.clear() } catch {}
    if (container.parentNode) container.parentNode.removeChild(container)
  }
}
