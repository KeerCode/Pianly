import { useEffect, useState } from 'react'
import { STORE_EVENT, loadStore, getActiveProfile } from './input/micCalibration'

/** Live view of the saved mic calibration (re-renders when it changes). */
export function useMicCalibration() {
  const [store, setStore] = useState(() => loadStore())
  useEffect(() => {
    const sync = () => setStore(loadStore())
    window.addEventListener(STORE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(STORE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  const profile = getActiveProfile(store)
  return { store, profile, noteCount: profile ? Object.keys(profile.notes).length : 0 }
}

/** Short status string for settings rows. */
export function calibrationStatus({ profile, noteCount }) {
  if (!profile || noteCount === 0) return 'Not set up'
  return `${profile.name} · ${noteCount} note${noteCount === 1 ? '' : 's'}`
}
