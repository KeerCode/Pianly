import { parseMidi } from 'midi-file'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const TICKS_PER_QUARTER = 960

function midiToNoteName(midi) {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 2
  return `${name}${octave}`
}

/**
 * Build a tempo map: sorted list of { tick, microsecondsPerBeat }
 * so we can convert any absolute tick to seconds accurately.
 */
function buildTempoMap(tracks) {
  const tempoEvents = []
  for (const track of tracks) {
    let absTick = 0
    for (const event of track) {
      absTick += event.deltaTime
      if (event.type === 'setTempo') {
        tempoEvents.push({ tick: absTick, uspb: event.microsecondsPerBeat })
      }
    }
  }
  tempoEvents.sort((a, b) => a.tick - b.tick)
  if (tempoEvents.length === 0 || tempoEvents[0].tick !== 0) {
    tempoEvents.unshift({ tick: 0, uspb: 500000 }) // default 120 BPM
  }
  return tempoEvents
}

/**
 * Convert a tick value to seconds using the tempo map.
 * ticksPerBeat comes from the MIDI header.
 */
function tickToSec(tick, tempoMap, ticksPerBeat) {
  let seconds = 0
  let prevTick = 0
  let uspb = tempoMap[0].uspb

  for (let i = 0; i < tempoMap.length; i++) {
    const te = tempoMap[i]
    if (te.tick >= tick) break
    if (te.tick > prevTick) {
      seconds += ((te.tick - prevTick) / ticksPerBeat) * (uspb / 1000000)
      prevTick = te.tick
    }
    uspb = te.uspb
  }
  seconds += ((tick - prevTick) / ticksPerBeat) * (uspb / 1000000)
  return seconds
}

/**
 * Parse a MIDI file buffer into the same timeline format as parseNoteTimeline.
 * Returns { timeline, divisions, tempo }
 */
export function parseMidiFile(buffer) {
  const data = new Uint8Array(buffer)
  const midi = parseMidi(data)

  const ticksPerBeat = midi.header.ticksPerBeat || 480
  const scaleFactor = TICKS_PER_QUARTER / ticksPerBeat

  // Build tempo map for accurate tick→sec conversion
  const tempoMap = buildTempoMap(midi.tracks)
  const initialTempo = Math.round(60000000 / tempoMap[0].uspb)

  // Build a bpm-based tempo map (tick values scaled to TICKS_PER_QUARTER) for the Visualizer
  const bpmTempoMap = tempoMap.map(e => ({
    tick: Math.round(e.tick * scaleFactor),
    bpm: Math.round(60000000 / e.uspb),
  }))

  // Collect all raw note events with channel info across all tracks
  const rawNotes = []

  midi.tracks.forEach((track, trackIndex) => {
    let absoluteTick = 0
    const activeNotes = new Map() // key: "noteNumber-channel" -> { tick, noteName, channel }

    for (const event of track) {
      absoluteTick += event.deltaTime
      const scaledTick = Math.round(absoluteTick * scaleFactor)
      const ch = event.channel ?? 0

      if (event.type === 'noteOn' && event.velocity > 0) {
        const noteName = midiToNoteName(event.noteNumber)
        const key = `${event.noteNumber}-${ch}`
        activeNotes.set(key, { tick: scaledTick, noteName, channel: ch, trackIndex })
      } else if (
        event.type === 'noteOff' ||
        (event.type === 'noteOn' && event.velocity === 0)
      ) {
        const key = `${event.noteNumber}-${ch}`
        const started = activeNotes.get(key)
        if (started) {
          const duration = scaledTick - started.tick
          // Convert ticks to seconds via tempo map for audio duration
          const startSec = tickToSec(started.tick / scaleFactor, tempoMap, ticksPerBeat)
          const endSec = tickToSec(absoluteTick, tempoMap, ticksPerBeat)
          rawNotes.push({
            tick: started.tick,
            duration: Math.max(duration, 1),
            durationSec: endSec - startSec,
            measure: Math.floor(started.tick / (TICKS_PER_QUARTER * 4)) + 1,
            noteName: started.noteName,
            channel: started.channel,
            trackIndex: started.trackIndex,
          })
          activeNotes.delete(key)
        }
      }
    }
  })

  // Determine hand assignment:
  // - If notes span multiple channels, use channel (0 = right, 1 = left, else right)
  // - If single channel, use note pitch split (middle C = MIDI 60)
  const channels = new Set(rawNotes.map(n => n.channel))
  const melodicTracks = new Set(rawNotes.map(n => n.trackIndex))
  const useChannels = channels.size > 1
  const useTracks = !useChannels && melodicTracks.size > 1

  function getHand(note) {
    if (useChannels) return note.channel === 0 ? 'right' : 'left'
    if (useTracks) {
      const trackList = [...melodicTracks].sort((a, b) => a - b)
      return note.trackIndex === trackList[0] ? 'right' : 'left'
    }
    // Single track, single channel — split by pitch
    return note.noteName ? noteToMidiNum(note.noteName) >= 60 ? 'right' : 'left' : 'right'
  }

  // Group simultaneous notes on the same hand into chords
  const allNotes = []
  // Sort by tick first to ensure grouping works
  rawNotes.sort((a, b) => a.tick - b.tick)

  for (const note of rawNotes) {
    const hand = getHand(note)
    // Find existing entry at this tick for this hand
    const existing = allNotes.find(
      (n) => n.tick === note.tick && n.hand === hand
    )
    if (existing) {
      if (!existing.notes.includes(note.noteName)) {
        existing.notes.push(note.noteName)
      }
      if (note.duration > existing.duration) {
        existing.duration = note.duration
        existing.durationSec = note.durationSec
      }
    } else {
      allNotes.push({
        tick: note.tick,
        duration: note.duration,
        durationSec: note.durationSec,
        measure: note.measure,
        notes: [note.noteName],
        isTied: false,
        hand,
      })
    }
  }

  allNotes.sort((a, b) => a.tick - b.tick || (a.hand === 'right' ? -1 : 1))

  return { timeline: allNotes, divisions: 1, tempo: initialTempo, tempoMap: bpmTempoMap }
}

/** Helper: convert note name back to MIDI number for pitch-based hand split */
function noteToMidiNum(name) {
  const m = name.match(/^([A-G])(#|b)?(-?\d+)$/)
  if (!m) return 60
  const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  let semi = BASE[m[1]] ?? 0
  if (m[2] === '#') semi++
  else if (m[2] === 'b') semi--
  return semi + (parseInt(m[3]) + 2) * 12
}
