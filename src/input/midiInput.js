import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const DEBUG = import.meta.env.DEV

const ENHARMONIC = {
  'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb',
  'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#',
}

export function notesMatch(detected, target, anyOctave = false) {
  if (!detected || !target) return false
  const dMatch = detected.match(/^([A-G][#b]?)(\d+)$/)
  const tMatch = target.match(/^([A-G][#b]?)(\d+)$/)
  if (!dMatch || !tMatch) return false

  const nameMatch = dMatch[1] === tMatch[1] || ENHARMONIC[dMatch[1]] === tMatch[1]
  if (!nameMatch) return false
  return anyOctave || dMatch[2] === tMatch[2]
}

export async function enableMidi() {
  DEBUG && console.log('[MIDI] Querying devices via Tauri...')
  try {
    const inputs = await invoke('get_midi_inputs')
    DEBUG && console.log(`[MIDI] Found ${inputs.length} input(s):`)
    if (DEBUG) inputs.forEach((inp, i) => console.log(`[MIDI]   ${i}: ${inp.name}`))
    return { supported: true, inputs: inputs.map((inp) => ({ id: String(inp.id), name: inp.name })) }
  } catch (err) {
    console.error('[MIDI] Failed to query devices:', err)
    return { supported: false, inputs: [] }
  }
}

export function getInputs() {
  // Re-query synchronously is not possible with Tauri commands;
  // use enableMidi() to refresh the list instead.
  return []
}

let unlistenOn = null
let unlistenOff = null

export async function listenToDevice(deviceId, onNote, onNoteOff) {
  // Disconnect previous
  if (unlistenOn) { unlistenOn(); unlistenOn = null }
  if (unlistenOff) { unlistenOff(); unlistenOff = null }
  try { await invoke('disconnect_midi') } catch {}

  try {
    unlistenOn = await listen('midi-note', (event) => {
      onNote(event.payload.note)
    })

    if (onNoteOff) {
      unlistenOff = await listen('midi-note-off', (event) => {
        onNoteOff(event.payload.note)
      })
    }

    const portName = await invoke('connect_midi', { deviceId: Number(deviceId) })
    DEBUG && console.log(`[MIDI] Connected: ${portName}`)

    return function stop() {
      DEBUG && console.log(`[MIDI] Disconnecting...`)
      if (unlistenOn) { unlistenOn(); unlistenOn = null }
      if (unlistenOff) { unlistenOff(); unlistenOff = null }
      invoke('disconnect_midi').catch(() => {})
    }
  } catch (err) {
    console.error(`[MIDI] Failed to connect device ${deviceId}:`, err)
    if (unlistenOn) { unlistenOn(); unlistenOn = null }
    if (unlistenOff) { unlistenOff(); unlistenOff = null }
    return null
  }
}

let pollInterval = null

export function onDevicesChanged(callback) {
  let lastJson = '[]'

  pollInterval = setInterval(async () => {
    try {
      const inputs = await invoke('get_midi_inputs')
      const json = JSON.stringify(inputs)
      if (json !== lastJson) {
        const oldInputs = JSON.parse(lastJson)
        const newInputs = inputs

        for (const inp of newInputs) {
          if (!oldInputs.some((o) => o.name === inp.name)) {
            DEBUG && console.log(`[MIDI] Device connected: ${inp.name}`)
          }
        }
        for (const inp of oldInputs) {
          if (!newInputs.some((n) => n.name === inp.name)) {
            DEBUG && console.log(`[MIDI] Device disconnected: ${inp.name}`)
          }
        }

        lastJson = json
        callback(inputs.map((inp) => ({ id: String(inp.id), name: inp.name })))
      }
    } catch {}
  }, 1500)

  return () => clearInterval(pollInterval)
}
