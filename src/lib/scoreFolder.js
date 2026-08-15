// Folder-based score library for Pianly
// Uses Tauri plugin-fs and plugin-dialog to scan a user-picked folder.

import { readDir, readFile } from '@tauri-apps/plugin-fs'
import { open } from '@tauri-apps/plugin-dialog'

const LS_KEY = 'nf-scores-folder'

const VALID_EXTS = ['.xml', '.musicxml', '.mxl', '.mid', '.midi']

function isMusicFile(name) {
  const lower = name.toLowerCase()
  return VALID_EXTS.some(ext => lower.endsWith(ext))
}

export function getSavedFolder() {
  return localStorage.getItem(LS_KEY) || null
}

export function setSavedFolder(path) {
  if (path) localStorage.setItem(LS_KEY, path)
  else localStorage.removeItem(LS_KEY)
}

export async function pickFolder() {
  const selected = await open({ directory: true, multiple: false })
  if (!selected) return null
  const path = typeof selected === 'string' ? selected : selected[0]
  if (!path) return null
  setSavedFolder(path)
  return path
}

export async function listScores(folderPath) {
  let entries
  try {
    entries = await readDir(folderPath)
  } catch (err) {
    throw new Error(`Cannot read folder: ${err?.message ?? err}`)
  }
  return entries
    .filter(e => !e.isDirectory && isMusicFile(e.name ?? ''))
    .map(e => ({ name: e.name ?? '', path: e.path ?? (folderPath + '/' + e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadScore(score) {
  const isBinary = score.name.toLowerCase().endsWith('.mxl') ||
                   score.name.toLowerCase().endsWith('.mid') ||
                   score.name.toLowerCase().endsWith('.midi')

  let bytes
  try {
    bytes = await readFile(score.path)
  } catch (err) {
    throw new Error(`Cannot read file "${score.name}": ${err?.message ?? err}`)
  }

  if (isBinary) {
    return bytes.buffer
  } else {
    return new TextDecoder().decode(bytes)
  }
}
