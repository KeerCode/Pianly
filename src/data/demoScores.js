// Auto-discover demo scores from src/demoScores/
// Add any .mxl, .xml, or .mid file to that folder and it appears automatically.

const demoGlob = import.meta.glob('/src/demoScores/*.{mxl,xml,musicxml,mid,midi}', {
  eager: true,
  query: '?url',
  import: 'default',
})

// Optional metadata overrides keyed by filename slug (no extension).
// Files without an entry here get a title derived from the filename.
const META = {
  'Fur_Elise_fingered': {
    title: 'Für Elise',
    composer: 'Beethoven',
    difficulty: 'Intermediate',
  },
}

function slugFromPath(path) {
  return path.split('/').pop().replace(/\.[^.]+$/, '')
}

function titleFromSlug(slug) {
  // "Fur_Elise_fingered" → "Fur Elise fingered"
  return slug.replace(/_/g, ' ')
}

export const DEMO_PIECES = Object.entries(demoGlob).map(([path, url]) => {
  const filename = path.split('/').pop()
  const ext      = filename.split('.').pop().toLowerCase()
  const slug     = filename.replace(/\.[^.]+$/, '')
  const meta     = META[slug] ?? {}
  return {
    id:         slug,
    title:      meta.title      ?? titleFromSlug(slug),
    composer:   meta.composer   ?? 'Unknown',
    difficulty: meta.difficulty ?? 'Unknown',
    url,
    ext,
  }
})

/**
 * Fetch the raw data for a demo piece.
 * Returns an ArrayBuffer for binary formats (.mxl, .mid, .midi)
 * or a string for text XML formats.
 */
export async function loadDemoScore(piece) {
  const res = await fetch(piece.url)
  if (!res.ok) throw new Error(`Could not load demo: ${piece.title}`)
  if (piece.ext === 'mxl' || piece.ext === 'mid' || piece.ext === 'midi') {
    return res.arrayBuffer()
  }
  return res.text()
}
