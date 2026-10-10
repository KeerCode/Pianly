import { encodeTake, takeFileName } from './takeRecorder.js'

/**
 * Write a take to disk and say where it went.
 *
 * Desktop (Tauri): straight into the user's Downloads folder (in the app's fs
 * scope). Anywhere else — or if that is denied — a normal browser download.
 *
 * @returns {Promise<{ name: string, path: string|null, bytes: number }>}
 */
export async function saveTake(take) {
  const name = takeFileName()
  const json = encodeTake(take)
  const bytes = json.length

  try {
    const { downloadDir, join } = await import('@tauri-apps/api/path')
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    const dir = await downloadDir()
    const path = await join(dir, name)
    await writeTextFile(path, json)
    return { name, path, bytes }
  } catch {
    // not running inside Tauri (dev in a browser) or the write was refused
  }

  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return { name, path: null, bytes }
}
