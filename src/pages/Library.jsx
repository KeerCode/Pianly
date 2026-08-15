import { useState, useMemo } from 'react'
import { LIBRARY_INDEX } from '../data/libraryIndex'

const DIFFICULTIES = ['Beginner', 'Intermediate', 'Advanced']
const ERAS = ['Baroque', 'Classical', 'Romantic', 'Modern']
const FORMATS = ['MusicXML', 'MIDI']

const CACHE_PREFIX = 'nf-lib-'

function getCached(id) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + id)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function setCached(id, entry) {
  try { localStorage.setItem(CACHE_PREFIX + id, JSON.stringify(entry)) } catch { /* quota */ }
}

function isBinaryUrl(url) {
  const lower = url.toLowerCase()
  return lower.endsWith('.mxl') || lower.endsWith('.mid') || lower.endsWith('.midi')
}

function SheetThumbnail() {
  return (
    <svg style={{flexShrink:0,width:92,height:64,borderRadius:6,background:'#f5f2ea'}} viewBox="0 0 92 64" xmlns="http://www.w3.org/2000/svg">
      <g stroke="#3a3a3a" strokeWidth="1">
        <line x1="8" y1="20" x2="84" y2="20"/>
        <line x1="8" y1="26" x2="84" y2="26"/>
        <line x1="8" y1="32" x2="84" y2="32"/>
        <line x1="8" y1="38" x2="84" y2="38"/>
        <line x1="8" y1="44" x2="84" y2="44"/>
      </g>
      <text x="10" y="42" fontSize="28" fill="#1a1a1a" fontFamily="serif">𝄞</text>
      <ellipse cx="50" cy="30" rx="4" ry="3" fill="#1a1a1a"/>
      <line x1="54" y1="30" x2="54" y2="14" stroke="#1a1a1a" strokeWidth="1.2"/>
      <ellipse cx="68" cy="24" rx="4" ry="3" fill="#1a1a1a"/>
      <line x1="72" y1="24" x2="72" y2="10" stroke="#1a1a1a" strokeWidth="1.2"/>
    </svg>
  )
}

function FilterChip({ label, count, active, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'9px 14px',
        background: active ? 'rgba(0,255,200,0.1)' : 'transparent',
        border: active ? '1.5px solid var(--accent)' : '1px solid var(--border)',
        borderRadius:8, cursor:'pointer', transition:'all 0.15s',
        color: active ? 'var(--ink)' : 'var(--sub)',
        fontSize:13,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(0,255,200,0.06)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      <span>{label}</span>
      {count != null && <span style={{fontSize:12, color:'var(--sub)'}}>{count.toLocaleString()}</span>}
    </div>
  )
}

export default function Library() {
  const [inputVal, setInputVal] = useState('')
  const [query, setQuery]       = useState('')
  const [difficulty, setDifficulty] = useState(null)
  const [era, setEra]               = useState(null)
  const [format, setFormat]         = useState(null)
  const [loadingId, setLoadingId]   = useState(null)
  const [errorId, setErrorId]       = useState(null)
  const [errorMsg, setErrorMsg]     = useState('')

  const results = useMemo(() => {
    return LIBRARY_INDEX.filter(p => {
      if (difficulty && p.difficulty !== difficulty) return false
      if (era && p.era !== era) return false
      if (format && p.format !== format) return false
      if (query) {
        const q = query.toLowerCase()
        return p.title.toLowerCase().includes(q) || p.composer.toLowerCase().includes(q)
      }
      return true
    })
  }, [query, difficulty, era, format])

  function countFor(field, value) {
    return LIBRARY_INDEX.filter(p => {
      if (field !== 'difficulty' && difficulty && p.difficulty !== difficulty) return false
      if (field !== 'era' && era && p.era !== era) return false
      if (field !== 'format' && format && p.format !== format) return false
      return p[field] === value
    }).length
  }

  async function fetchEntry(piece) {
    let entry = getCached(piece.id)
    if (!entry) {
      const res = await fetch(piece.downloadUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (isBinaryUrl(piece.downloadUrl)) {
        const buf = await res.arrayBuffer()
        const bytes = new Uint8Array(buf)
        let bin = ''
        bytes.forEach(b => { bin += String.fromCharCode(b) })
        entry = { type: 'binary', data: btoa(bin) }
      } else {
        entry = { type: 'text', data: await res.text() }
      }
      setCached(piece.id, entry)
    }
    return entry
  }

  async function openSheetMusic(piece) {
    if (!piece.downloadUrl) { setErrorId(piece.id); setErrorMsg('No download URL'); return }
    setLoadingId(piece.id); setErrorId(null)
    try {
      const entry = await fetchEntry(piece)
      sessionStorage.setItem('nf-practice-song', JSON.stringify({ name: piece.title, ...entry }))
      window.location.hash = '#/'
    } catch (e) {
      setErrorId(piece.id); setErrorMsg(e.message || 'Download failed')
    } finally { setLoadingId(null) }
  }

  async function openVisualizer(piece) {
    if (!piece.downloadUrl) { setErrorId(piece.id); setErrorMsg('No download URL'); return }
    setLoadingId(piece.id + '-vis'); setErrorId(null)
    try {
      const entry = await fetchEntry(piece)
      sessionStorage.setItem('nf-vis-song', JSON.stringify({ name: piece.title, ...entry }))
      window.location.hash = '/visualizer'
    } catch (e) {
      setErrorId(piece.id); setErrorMsg(e.message || 'Download failed')
    } finally { setLoadingId(null) }
  }

  const hasFilters = difficulty || era || format || query

  return (
    <div style={{position:'absolute',inset:0,background:'var(--bg)',color:'var(--ink)',fontFamily:"'Sora',sans-serif",display:'flex',flexDirection:'column',overflow:'hidden'}}>

      {/* Header */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'20px 40px',borderBottom:'1px solid var(--border)',flexShrink:0}}>
        <div style={{display:'flex',alignItems:'center',gap:20}}>
          <button
            onClick={() => { window.location.hash = '#/' }}
            style={{display:'flex',alignItems:'center',gap:6,background:'none',border:'none',color:'var(--sub)',cursor:'pointer',fontSize:13,fontFamily:"'Sora',sans-serif",padding:0,opacity:.7}}
            onMouseEnter={e => e.currentTarget.style.opacity = '1'}
            onMouseLeave={e => e.currentTarget.style.opacity = '.7'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Home
          </button>
          <div style={{fontWeight:700,fontSize:18}}>Library</div>
        </div>
        <div style={{fontSize:13,color:'var(--sub)'}}>{LIBRARY_INDEX.length.toLocaleString()} scores</div>
      </div>

      {/* Search bar */}
      <div style={{padding:'20px 40px',borderBottom:'1px solid var(--border)',flexShrink:0,display:'flex',gap:12,alignItems:'center'}}>
        <div style={{flex:1,display:'flex',alignItems:'center',padding:'12px 18px',background:'rgba(0,255,200,0.05)',border:'1.5px solid var(--accent)',borderRadius:10}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--sub)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight:10,flexShrink:0}}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') setQuery(inputVal.trim()) }}
            placeholder="Search by title or composer…"
            style={{flex:1,background:'none',border:'none',outline:'none',color:'var(--ink)',fontSize:14,fontFamily:"'Sora',sans-serif"}}
          />
        </div>
        <button
          onClick={() => setQuery(inputVal.trim())}
          style={{padding:'12px 28px',background:'var(--accent)',color:'#000',border:'none',borderRadius:10,fontWeight:700,fontSize:13,cursor:'pointer',fontFamily:"'Sora',sans-serif",boxShadow:'0 6px 20px rgba(0,255,200,.25)',transition:'all 0.2s',flexShrink:0}}
          onMouseEnter={e => { e.currentTarget.style.transform='translateY(-1px)'; e.currentTarget.style.boxShadow='0 10px 28px rgba(0,255,200,.35)' }}
          onMouseLeave={e => { e.currentTarget.style.transform='translateY(0)'; e.currentTarget.style.boxShadow='0 6px 20px rgba(0,255,200,.25)' }}
        >
          Search
        </button>
      </div>

      {/* Body */}
      <div style={{flex:1,display:'flex',minHeight:0}}>

        {/* Sidebar */}
        <div style={{flexShrink:0,width:240,borderRight:'1px solid var(--border)',padding:'28px 24px',display:'flex',flexDirection:'column',gap:24,overflowY:'auto'}}>

          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{fontWeight:700,fontSize:13}}>Difficulty</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {DIFFICULTIES.map(d => (
                <FilterChip key={d} label={d} count={countFor('difficulty', d)}
                  active={difficulty === d}
                  onClick={() => setDifficulty(prev => prev === d ? null : d)} />
              ))}
            </div>
          </div>

          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{fontWeight:700,fontSize:13}}>Era</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {ERAS.map(e => (
                <FilterChip key={e} label={e} count={countFor('era', e)}
                  active={era === e}
                  onClick={() => setEra(prev => prev === e ? null : e)} />
              ))}
            </div>
          </div>

          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{fontWeight:700,fontSize:13}}>Format</div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {FORMATS.map(f => (
                <FilterChip key={f} label={f} count={countFor('format', f)}
                  active={format === f}
                  onClick={() => setFormat(prev => prev === f ? null : f)} />
              ))}
            </div>
          </div>

          {hasFilters && (
            <button
              onClick={() => { setDifficulty(null); setEra(null); setFormat(null); setQuery(''); setInputVal('') }}
              style={{background:'none',border:'none',color:'var(--accent)',cursor:'pointer',fontSize:13,fontFamily:"'Sora',sans-serif",textAlign:'left',padding:0,marginTop:'auto'}}
            >
              Clear all filters
            </button>
          )}
        </div>

        {/* Results */}
        <div style={{flex:1,padding:'24px 36px',display:'flex',flexDirection:'column',gap:14,overflowY:'auto',position:'relative'}}>

          {/* Background glow */}
          <div style={{position:'absolute',top:'-25%',right:'-10%',width:480,height:480,background:'radial-gradient(circle, rgba(0,255,200,0.08), transparent)',filter:'blur(60px)',borderRadius:'50%',pointerEvents:'none'}}/>

          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0,position:'relative',zIndex:1}}>
            <div style={{fontSize:13,color:'var(--sub)'}}>
              {results.length} result{results.length !== 1 ? 's' : ''}
              {(difficulty || era || format) && ` — ${[era, difficulty, format].filter(Boolean).join(', ')}`}
            </div>
            <div style={{fontSize:13,color:'var(--sub)'}}>Sorted by relevance</div>
          </div>

          {results.length === 0 && (
            <div style={{textAlign:'center',color:'var(--sub)',fontSize:14,padding:'60px 0',position:'relative',zIndex:1}}>
              No pieces match your filters.
            </div>
          )}

          {results.map(piece => {
            const isLoading    = loadingId === piece.id || loadingId === piece.id + '-vis'
            const isLoadingSM  = loadingId === piece.id
            const isLoadingVis = loadingId === piece.id + '-vis'
            const hasError     = errorId === piece.id
            return (
              <div
                key={piece.id}
                style={{
                  display:'flex', alignItems:'center', gap:20,
                  padding:'18px 22px',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius:12, cursor:'pointer', transition:'all 0.15s',
                  position:'relative', zIndex:1,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,255,200,0.04)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <SheetThumbnail />

                <div style={{flex:1,display:'flex',flexDirection:'column',gap:4,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:15,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{piece.title}</div>
                  <div style={{fontSize:13,color:'var(--sub)'}}>{piece.composer} · {piece.era} · {piece.duration}</div>
                  {hasError && (
                    <div style={{fontSize:12,color:'#ff6b6b',marginTop:2}}>{errorMsg}</div>
                  )}
                </div>

                <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:8,flexShrink:0}}>
                  <div style={{fontSize:12,color:'var(--sub)'}}>{piece.difficulty} · {piece.format}</div>
                  <div style={{display:'flex',gap:6}}>
                    <button
                      onClick={e => { e.stopPropagation(); openSheetMusic(piece) }}
                      disabled={isLoading}
                      style={{
                        padding:'8px 14px',
                        background: isLoadingSM ? 'transparent' : 'var(--accent)',
                        border: isLoadingSM ? '1.5px solid var(--accent)' : 'none',
                        color: isLoadingSM ? 'var(--accent)' : '#000',
                        borderRadius:8, fontWeight:700, fontSize:11,
                        cursor: isLoading ? 'default' : 'pointer',
                        fontFamily:"'Sora',sans-serif",
                        boxShadow: isLoadingSM ? 'none' : '0 4px 14px rgba(0,255,200,.2)',
                        transition:'all 0.15s', whiteSpace:'nowrap',
                      }}
                    >
                      {isLoadingSM ? '…' : 'Sheet Music'}
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); openVisualizer(piece) }}
                      disabled={isLoading}
                      style={{
                        padding:'8px 14px',
                        background: isLoadingVis ? 'transparent' : 'transparent',
                        border: isLoadingVis ? '1.5px solid var(--accent)' : '1.5px solid var(--accent)',
                        color: isLoadingVis ? 'var(--accent)' : 'var(--accent)',
                        borderRadius:8, fontWeight:700, fontSize:11,
                        cursor: isLoading ? 'default' : 'pointer',
                        fontFamily:"'Sora',sans-serif",
                        transition:'all 0.15s', whiteSpace:'nowrap',
                      }}
                    >
                      {isLoadingVis ? '…' : 'Visualizer'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Footer — attribution */}
      <div style={{flexShrink:0,padding:'10px 40px',borderTop:'1px solid var(--border)',fontSize:11,color:'var(--sub)',display:'flex',alignItems:'center',justifyContent:'space-between',gap:16}}>
        <span>
          Solo piano scores from{' '}
          <a href="https://github.com/musetrainer/library" target="_blank" rel="noreferrer" style={{color:'var(--accent)',textDecoration:'none'}}>musetrainer/library</a>
          {' '}· Voice + piano from{' '}
          <a href="https://github.com/OpenScore/Lieder" target="_blank" rel="noreferrer" style={{color:'var(--accent)',textDecoration:'none'}}>OpenScore Lieder</a>
          {' '}(CC0). All compositions are public domain.
        </span>
        <span style={{flexShrink:0}}>
          <a href="https://github.com/KeerCode/Pianly/issues" target="_blank" rel="noreferrer" style={{color:'var(--accent)',textDecoration:'none'}}>Report an issue</a>
        </span>
      </div>
    </div>
  )
}
