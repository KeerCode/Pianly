// Shared star-field background — used on all pages
// Stars are deterministically generated (no canvas, no randomness on re-render)

function lcg(s) { return (((s * 1664525) + 1013904223) & 0xffffffff) >>> 0 }

const STARS = Array.from({ length: 180 }, (_, i) => {
  let s = ((i + 1) * 2654435761) >>> 0
  s = lcg(s); const x = (s % 10000) / 100
  s = lcg(s); const y = (s % 10000) / 100
  s = lcg(s); const size = 0.7 + (s % 6) * 0.28
  s = lcg(s); const opacity = 0.12 + (s % 8) * 0.1
  s = lcg(s); const dur = 2.5 + (s % 80) * 0.1
  s = lcg(s); const delay = -(s % 400) * 0.08
  return { x, y, size, opacity, dur, delay }
})

export default function StarField() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 0 }}>
      {/* Nebula glows */}
      <div
        className="nebula absolute rounded-full"
        style={{
          width: 700, height: 700,
          top: -200, left: -150,
          background: 'radial-gradient(circle, rgba(109,40,217,0.09) 0%, transparent 65%)',
          animationDuration: '28s',
        }}
      />
      <div
        className="nebula absolute rounded-full"
        style={{
          width: 600, height: 600,
          bottom: -150, right: -100,
          background: 'radial-gradient(circle, rgba(212,160,83,0.08) 0%, transparent 65%)',
          animationDuration: '35s',
          animationDelay: '-12s',
        }}
      />
      <div
        className="nebula absolute rounded-full"
        style={{
          width: 500, height: 500,
          top: '40%', left: '55%',
          transform: 'translate(-50%,-50%)',
          background: 'radial-gradient(circle, rgba(34,211,238,0.04) 0%, transparent 65%)',
          animationDuration: '22s',
          animationDelay: '-7s',
        }}
      />

      {/* Stars */}
      {STARS.map((st, i) => (
        <div
          key={i}
          className="star absolute rounded-full bg-white"
          style={{
            left: `${st.x}%`,
            top: `${st.y}%`,
            width: st.size,
            height: st.size,
            '--star-opacity': st.opacity,
            opacity: st.opacity,
            animationDuration: `${st.dur}s`,
            animationDelay: `${st.delay}s`,
          }}
        />
      ))}
    </div>
  )
}
