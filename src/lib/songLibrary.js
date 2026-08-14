// IndexedDB-backed song library for Pianly
// Stores user-uploaded songs (MusicXML strings or MIDI ArrayBuffers) locally.

const DB_NAME = 'pianly-library'
const DB_VERSION = 1
const STORE = 'songs'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function librarySave({ name, filename, data }) {
  const db = await openDB()
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const song = {
    id,
    name: name || filename || 'Untitled',
    filename: filename || '',
    data, // string (MusicXML) or ArrayBuffer (MIDI/MXL)
    addedAt: Date.now(),
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(song)
    tx.oncomplete = () => resolve(id)
    tx.onerror = (e) => reject(e.target.error)
  })
}

export async function libraryGetAll() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve([...req.result].sort((a, b) => b.addedAt - a.addedAt))
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function libraryDelete(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = resolve
    tx.onerror = (e) => reject(e.target.error)
  })
}
