import { useState, useEffect, useCallback } from 'react'
import Background from '../Background'
import { getSavedFolder, pickFolder, listScores, loadScore } from '../lib/scoreFolder'

const BORD  = 'rgba(0,255,200,0.12)'
const BORD2 = 'rgba(0,255,200,0.22)'

const EXT_COLOR = {
  xml:      'rgba(0,255,200,0.15)',
  musicxml: 'rgba(0,255,200,0.15)',
  mxl:      'rgba(100,180,255,0.15)',
  mid:      'rgba(200,140,255,0.15)',
  midi:     'rgba(200,140,255,0.15)',
}
const EXT_BORDER = {
  xml:      'rgba(0,255,200,0.3)',
  musicxml: 'rgba(0,255,200,0.3)',
  mxl:      'rgba(100,180,255,0.35)',
  mid:      'rgba(200,140,255,0.35)',
  midi:     'rgba(200,140,255,0.35)',
}
const EXT_TEXT = {
  xml:      'oklch(0.7 0.2 160)',
  musicxml: 'oklch(0.7 0.2 160)',
  mxl:      '#64b4ff',
  mid:      '#c88cff',
  midi:     '#c88cff',
}

function getExt(name) {
  return name.split('.').pop().toLowerCase()
}

function FolderIcon() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'oklch(0.62 0.015 270)' }}>
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
    </svg>
  )
}

function MusicFileIcon({ ext }) {
  const color = EXT_TEXT[ext] ?? 'oklch(0.62 0.015 270)'
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
    </svg>
  )
}

const RENAMES_KEY = 'pianly-renames'

function loadRenames() {
  try { return JSON.parse(localStorage.getItem(RENAMES_KEY) || '{}') } catch { return {} }
}

export default function FolderLibrary() {
  const [folderPath,    setFolderPath]    = useState(() => getSavedFolder())
  const [scores,        setScores]        = useState([])
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [search,        setSearch]        = useState('')
  const [openingId,     setOpeningId]     = useState(null)
  const [renames,       setRenames]       = useState(loadRenames)
  const [renamingPath,  setRenamingPath]  = useState(null)
  const [renameValue,   setRenameValue]   = useState('')

  const loadFolder = useCallback(async (path) => {
    if (!path) return
    setLoading(true)
    setError(null)
    const delays = [0, 400, 1200]
    for (const delay of delays) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      try {
        const list = await listScores(path)
        setScores(list)
        setLoading(false)
        return
      } catch { /* try next delay */ }
    }
    setError('Could not read folder. Make sure Pianly has permission.')
    setLoading(false)
  }, [])

  useEffect(() => {
    if (folderPath) loadFolder(folderPath)
  }, [folderPath, loadFolder])

  function startRename(score) {
    const displayName = renames[score.path] ?? score.name.replace(/\.[^.]+$/, '')
    setRenamingPath(score.path)
    setRenameValue(displayName)
  }

  function commitRename(scorePath) {
    const trimmed = renameValue.trim()
    const updated = { ...renames }
    if (trimmed) updated[scorePath] = trimmed
    else delete updated[scorePath]
    localStorage.setItem(RENAMES_KEY, JSON.stringify(updated))
    setRenames(updated)
    setRenamingPath(null)
  }

  function cancelRename() {
    setRenamingPath(null)
  }

  async function handlePickFolder() {
    const picked = await pickFolder()
    if (!picked) return
    setFolderPath(picked)
    setSearch('')
  }

  async function openInVisualizer(score) {
    setOpeningId(score.path)
    try {
      const data = await loadScore(score)
      const name = score.name.replace(/\.[^.]+$/, '')
      if (data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data)
        let bin = ''
        bytes.forEach(b => { bin += String.fromCharCode(b) })
        sessionStorage.setItem('nf-vis-song', JSON.stringify({ name, type: 'binary', data: btoa(bin) }))
      } else {
        sessionStorage.setItem('nf-vis-song', JSON.stringify({ name, type: 'text', data }))
      }
      window.location.hash = '/visualizer'
    } catch {
      setError('Failed to open file.')
    } finally {
      setOpeningId(null)
    }
  }

  async function openInSheet(score) {
    setOpeningId(score.path + '-practice')
    try {
      const data = await loadScore(score)
      const name = score.name.replace(/\.[^.]+$/, '')
      sessionStorage.setItem('nf-practice-song', JSON.stringify({
        name,
        type: data instanceof ArrayBuffer ? 'binary' : 'text',
        data: data instanceof ArrayBuffer
          ? (() => { const b = new Uint8Array(data); let s = ''; b.forEach(c => { s += String.fromCharCode(c) }); return btoa(s) })()
          : data,
      }))
      window.location.hash = '#/'
    } catch {
      setError('Failed to open file.')
    } finally {
      setOpeningId(null)
    }
  }

  const filtered = scores.filter(s => {
    const displayName = renames[s.path] ?? s.name.replace(/\.[^.]+$/, '')
    return displayName.toLowerCase().includes(search.toLowerCase()) ||
           s.name.toLowerCase().includes(search.toLowerCase())
  })

  const folderName = folderPath ? folderPath.split('/').filter(Boolean).pop() : null

  return (
    <div style={{ minHeight: '100vh', color: 'var(--ink)', fontFamily: "'Sora', sans-serif",
      position: 'relative', background: 'transparent' }}>
      <Background />

      {/* Ambient glows */}
      <div style={{ position:'fixed', top:'-10%', right:'-5%', width:600, height:600,
        background:'radial-gradient(circle, rgba(0,255,200,0.12), transparent)',
        filter:'blur(80px)', borderRadius:'50%', zIndex:0, pointerEvents:'none' }}/>
      <div style={{ position:'fixed', bottom:'-20%', left:'-10%', width:500, height:500,
        background:'radial-gradient(circle, rgba(0,255,200,0.07), transparent)',
        filter:'blur(70px)', borderRadius:'50%', zIndex:0, pointerEvents:'none' }}/>

      {/* Nav */}
      <nav style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'16px 28px', borderBottom:`1px solid ${BORD}`, position:'relative', zIndex:10 }}>
        <button onClick={() => { window.location.hash = '#/' }}
          style={{ display:'flex', alignItems:'center', gap:7, fontSize:13, fontWeight:500,
            color:'var(--sub)', background:'none', border:'none', cursor:'pointer', transition:'color .15s',
            fontFamily:"'Sora', sans-serif" }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--ink)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--sub)'}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
          Home
        </button>
        <span style={{ fontSize:11, letterSpacing:'.12em', textTransform:'uppercase', color:'var(--sub)' }}>
          Pianly
        </span>
      </nav>

      {/* Main */}
      <div style={{ maxWidth:720, margin:'0 auto', padding:'48px 24px 96px', position:'relative', zIndex:10 }}>

        {/* Header */}
        <header style={{ marginBottom:36 }}>
          <h1 style={{ fontSize:42, fontWeight:800, letterSpacing:'-0.03em', lineHeight:1.05,
            margin:'0 0 12px', color:'var(--ink)' }}>
            My Library
          </h1>
          <p style={{ fontSize:15, color:'var(--sub)', lineHeight:1.65, margin:0 }}>
            Browse and open your local music files.
          </p>
        </header>

        {/* Folder bar */}
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:32,
          padding:'14px 18px', background:'rgba(255,255,255,0.03)',
          border:`1px solid ${BORD}`, borderRadius:12 }}>
          <div style={{ color:'oklch(0.7 0.2 160)', flexShrink:0 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
          </div>
          <span style={{ flex:1, fontSize:13, color: folderPath ? 'var(--ink)' : 'var(--sub)',
            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {folderPath ?? 'No folder selected'}
          </span>
          <button onClick={handlePickFolder}
            style={{ flexShrink:0, padding:'7px 16px', fontSize:12, fontWeight:700, cursor:'pointer',
              background:'var(--accent)', color:'#000', border:'none', borderRadius:8,
              fontFamily:"'Sora', sans-serif" }}>
            {folderPath ? 'Change' : 'Choose Folder'}
          </button>
          {folderPath && (
            <button onClick={() => loadFolder(folderPath)}
              title="Refresh"
              style={{ flexShrink:0, width:32, height:32, display:'flex', alignItems:'center',
                justifyContent:'center', background:'none', border:`1px solid ${BORD}`, borderRadius:8,
                cursor:'pointer', color:'var(--sub)', transition:'color .15s' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--ink)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--sub)'}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
              </svg>
            </button>
          )}
        </div>

        {/* Error */}
        {error && (
          <div style={{ marginBottom:24, padding:'12px 16px', borderRadius:10,
            background:'rgba(255,80,80,0.08)', border:'1px solid rgba(255,80,80,0.25)',
            color:'#ff6b6b', fontSize:13 }}>
            {error}
          </div>
        )}

        {/* Empty state — no folder */}
        {!folderPath && (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
            gap:20, paddingTop:80, textAlign:'center' }}>
            <FolderIcon />
            <div>
              <p style={{ fontSize:17, fontWeight:700, color:'var(--ink)', margin:'0 0 8px' }}>
                No folder selected
              </p>
              <p style={{ fontSize:14, color:'var(--sub)', margin:0 }}>
                Choose a folder containing your MusicXML or MIDI files.
              </p>
            </div>
            <button onClick={handlePickFolder}
              style={{ padding:'14px 32px', fontSize:14, fontWeight:700, cursor:'pointer',
                background:'var(--accent)', color:'#000', border:'none', borderRadius:12,
                fontFamily:"'Sora', sans-serif", boxShadow:'0 8px 24px rgba(0,255,200,0.3)' }}>
              Choose Folder
            </button>
          </div>
        )}

        {/* Loading */}
        {folderPath && loading && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:12,
            paddingTop:80, color:'var(--sub)', fontSize:14 }}>
            <div style={{ width:18, height:18, border:'2px solid rgba(0,255,200,0.2)',
              borderTop:'2px solid oklch(0.7 0.2 160)', borderRadius:'50%',
              animation:'cv-spin 0.7s linear infinite' }}/>
            Scanning folder…
          </div>
        )}

        {/* File list */}
        {folderPath && !loading && scores.length > 0 && (
          <>
            {/* Search + count */}
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
              <div style={{ flex:1, position:'relative' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)',
                    color:'var(--sub)', pointerEvents:'none' }}>
                  <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                </svg>
                <input
                  type="text"
                  placeholder="Search files…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ width:'100%', padding:'9px 12px 9px 36px', fontSize:13,
                    background:'rgba(255,255,255,0.04)', border:`1px solid ${BORD}`,
                    borderRadius:10, color:'var(--ink)', fontFamily:"'Sora', sans-serif",
                    outline:'none', boxSizing:'border-box', transition:'border-color .15s' }}
                  onFocus={e => e.target.style.borderColor = BORD2}
                  onBlur={e => e.target.style.borderColor = BORD}
                />
              </div>
              <span style={{ fontSize:12, color:'var(--sub)', whiteSpace:'nowrap', flexShrink:0 }}>
                {filtered.length} / {scores.length} files
              </span>
            </div>

            {/* Cards */}
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {filtered.length === 0 ? (
                <p style={{ textAlign:'center', color:'var(--sub)', fontSize:14, padding:'48px 0' }}>
                  No files match "{search}"
                </p>
              ) : filtered.map((score, i) => {
                const ext = getExt(score.name)
                const displayName = renames[score.path] ?? score.name.replace(/\.[^.]+$/, '')
                const isOpening = openingId === score.path || openingId === score.path + '-practice'
                const isRenaming = renamingPath === score.path
                return (
                  <div key={score.path}
                    style={{ display:'flex', alignItems:'center', gap:14, padding:'14px 18px',
                      background:'rgba(255,255,255,0.025)', border:`1px solid ${BORD}`,
                      borderRadius:12, animation:`cv-item-in 0.3s ease-out ${i * 0.03}s both`,
                      transition:'border-color .15s, background .15s' }}
                    onMouseEnter={e => { if (!isRenaming) { e.currentTarget.style.borderColor = BORD2; e.currentTarget.style.background = 'rgba(255,255,255,0.04)' } }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = BORD; e.currentTarget.style.background = 'rgba(255,255,255,0.025)' }}>

                    {/* Icon */}
                    <div style={{ flexShrink:0 }}>
                      <MusicFileIcon ext={ext} />
                    </div>

                    {/* Name + ext badge OR rename input */}
                    <div style={{ flex:1, minWidth:0 }}>
                      {isRenaming ? (
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') commitRename(score.path); if (e.key === 'Escape') cancelRename() }}
                            style={{ flex:1, padding:'5px 10px', fontSize:13, fontWeight:600,
                              background:'rgba(255,255,255,0.06)', border:`1.5px solid ${BORD2}`,
                              borderRadius:7, color:'var(--ink)', fontFamily:"'Sora', sans-serif",
                              outline:'none', minWidth:0 }}
                          />
                          <button onClick={() => commitRename(score.path)}
                            style={{ padding:'5px 12px', fontSize:12, fontWeight:700, cursor:'pointer',
                              background:'var(--accent)', color:'#000', border:'none', borderRadius:7,
                              fontFamily:"'Sora', sans-serif", flexShrink:0 }}>
                            Save
                          </button>
                          <button onClick={cancelRename}
                            style={{ padding:'5px 10px', fontSize:12, fontWeight:600, cursor:'pointer',
                              background:'none', border:`1px solid ${BORD}`, borderRadius:7,
                              color:'var(--sub)', fontFamily:"'Sora', sans-serif", flexShrink:0 }}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <div style={{ fontSize:14, fontWeight:600, color:'var(--ink)',
                              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {displayName}
                            </div>
                            <button onClick={() => startRename(score)} title="Rename"
                              style={{ flexShrink:0, background:'none', border:'none', cursor:'pointer',
                                color:'var(--sub)', padding:2, display:'flex', alignItems:'center',
                                transition:'color .15s' }}
                              onMouseEnter={e => e.currentTarget.style.color = 'var(--ink)'}
                              onMouseLeave={e => e.currentTarget.style.color = 'var(--sub)'}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                              </svg>
                            </button>
                          </div>
                          <span style={{ display:'inline-block', marginTop:4, fontSize:10,
                            fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase',
                            padding:'2px 7px', borderRadius:5,
                            background: EXT_COLOR[ext] ?? 'rgba(255,255,255,0.07)',
                            border: `1px solid ${EXT_BORDER[ext] ?? BORD}`,
                            color: EXT_TEXT[ext] ?? 'var(--sub)' }}>
                            .{ext}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Actions */}
                    {!isRenaming && (
                      <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
                        {(ext === 'xml' || ext === 'musicxml' || ext === 'mxl' || ext === 'mid' || ext === 'midi') && (
                          <button onClick={() => openInVisualizer(score)} disabled={!!openingId}
                            style={{ padding:'7px 14px', fontSize:12, fontWeight:700, cursor: openingId ? 'not-allowed' : 'pointer',
                              background:'none', border:`1.5px solid var(--accent)`, color:'var(--accent)',
                              borderRadius:8, fontFamily:"'Sora', sans-serif", opacity: openingId ? 0.5 : 1,
                              transition:'background .15s' }}
                            onMouseEnter={e => { if (!openingId) e.currentTarget.style.background = 'rgba(0,255,200,0.08)' }}
                            onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                            Visualizer
                          </button>
                        )}
                        <button onClick={() => openInSheet(score)} disabled={!!openingId}
                          style={{ padding:'7px 14px', fontSize:12, fontWeight:700, cursor: openingId ? 'not-allowed' : 'pointer',
                            background:'var(--accent)', color:'#000', border:'none',
                            borderRadius:8, fontFamily:"'Sora', sans-serif", opacity: openingId ? 0.5 : 1 }}>
                          {isOpening ? '…' : 'Sheet'}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* Empty state — folder has no music files */}
        {folderPath && !loading && scores.length === 0 && !error && (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
            gap:16, paddingTop:80, textAlign:'center' }}>
            <FolderIcon />
            <div>
              <p style={{ fontSize:17, fontWeight:700, color:'var(--ink)', margin:'0 0 8px' }}>
                {folderName ? `"${folderName}" is empty` : 'No music files found'}
              </p>
              <p style={{ fontSize:14, color:'var(--sub)', margin:0 }}>
                No .xml, .musicxml, .mxl, or .mid files were found in this folder.
              </p>
            </div>
            <button onClick={handlePickFolder}
              style={{ padding:'11px 24px', fontSize:13, fontWeight:700, cursor:'pointer',
                background:'none', color:'var(--accent)', border:`1.5px solid var(--accent)`,
                borderRadius:10, fontFamily:"'Sora', sans-serif" }}>
              Choose a Different Folder
            </button>
          </div>
        )}

      </div>
    </div>
  )
}
