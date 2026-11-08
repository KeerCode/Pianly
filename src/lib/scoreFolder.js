// Folder-based score library for Pianly
// Uses Tauri plugin-fs and plugin-dialog to scan a user-picked folder.
// On mobile there is no pickable user folder; an app-private "My Scores"
// library lives in $APPDATA/scores instead.

import { readDir, readFile, writeFile, mkdir, remove, BaseDirectory } from '@tauri-apps/plugin-fs'
import { open } from '@tauri-apps/plugin-dialog'
import { isMobile } from './platform'

const LS_KEY = 'nf-scores-folder'

export const MOBILE_FOLDER = 'scores'
const APP_OPTS = { baseDir: BaseDirectory.AppData }

export const VALID_EXTS = ['.xml', '.musicxml', '.mxl', '.mid', '.midi']

function isMusicFile(name) {
  const lower = name.toLowerCase()
  return VALID_EXTS.some(ext => lower.endsWith(ext))
}

function baseName(path) {
  return path.split('/').pop().split('\\').pop()
}

export function getSavedFolder() {
  if (isMobile) return MOBILE_FOLDER
  return localStorage.getItem(LS_KEY) || null
}

export function setSavedFolder(path) {
  if (isMobile) return
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
  if (isMobile) {
    await mkdir(MOBILE_FOLDER, { ...APP_OPTS, recursive: true })
    let entries
    try {
      entries = await readDir(MOBILE_FOLDER, APP_OPTS)
    } catch (err) {
      throw new Error(`Cannot read folder: ${err?.message ?? err}`)
    }
    return entries
      .filter(e => !e.isDirectory && isMusicFile(e.name ?? ''))
      .map(e => ({ name: e.name ?? '', path: `${MOBILE_FOLDER}/${e.name}` }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

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
    bytes = await readFile(score.path, isMobile ? APP_OPTS : undefined)
  } catch (err) {
    throw new Error(`Cannot read file "${score.name}": ${err?.message ?? err}`)
  }

  if (isBinary) {
    return bytes.buffer
  } else {
    return new TextDecoder().decode(bytes)
  }
}

// Mobile only: copy picked files into the app-private scores library.
// Returns { imported, skipped } where skipped counts non-music files.
export async function importScores(fileList) {
  await mkdir(MOBILE_FOLDER, { ...APP_OPTS, recursive: true })
  const files = Array.from(fileList)
  const accepted = files.filter(f => isMusicFile(f.name))
  for (const file of accepted) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await writeFile(`${MOBILE_FOLDER}/${baseName(file.name)}`, bytes, APP_OPTS)
  }
  return { imported: accepted.length, skipped: files.length - accepted.length }
}

export async function deleteScore(score) {
  await remove(score.path, APP_OPTS)
}

// Mobile only: save converted MusicXML into the scores library.
export async function saveXmlToScores(filename, xml) {
  await mkdir(MOBILE_FOLDER, { ...APP_OPTS, recursive: true })
  await writeFile(`${MOBILE_FOLDER}/${baseName(filename)}`, new TextEncoder().encode(xml), APP_OPTS)
}
