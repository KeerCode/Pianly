/**
 * Shared note/MIDI conversion utilities used across the app.
 * Single source of truth — import from here instead of defining locally.
 */

const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

const BASE_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/** Convert MIDI number to note name string, e.g. 60 → "C3" */
export function midiToNoteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 2)
}

/** Convert note name string to MIDI number, e.g. "C#3" → 49. Returns null if invalid. */
export function noteNameToMidi(name) {
  const m = name.match(/^([A-G])(#|b)?(-?\d+)$/)
  if (!m) return null
  let semi = BASE_SEMITONES[m[1]]
  if (semi == null) return null
  if (m[2] === '#') semi++
  else if (m[2] === 'b') semi--
  return semi + (parseInt(m[3]) + 2) * 12
}

const INTERVAL_NAMES = [
  'Unison', 'Minor 2nd', 'Major 2nd', 'Minor 3rd', 'Major 3rd',
  'Perfect 4th', 'Tritone', 'Perfect 5th', 'Minor 6th', 'Major 6th',
  'Minor 7th', 'Major 7th', 'Octave',
]

/** Get interval name between two note name arrays (uses first note of each). */
export function getInterval(prevNotes, curNotes) {
  if (!prevNotes?.length || !curNotes?.length) return null
  const a = noteNameToMidi(prevNotes[0])
  const b = noteNameToMidi(curNotes[0])
  if (a == null || b == null) return null
  const diff = Math.abs(b - a)
  if (diff > 12) return `${INTERVAL_NAMES[diff % 12]} +${Math.floor(diff / 12)}oct`
  return INTERVAL_NAMES[diff] ?? `${diff} semitones`
}
