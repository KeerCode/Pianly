export default function Background() {
  return (
    <div
      className="fixed inset-0 overflow-hidden"
      style={{ zIndex: 0, background: 'oklch(0.12 0.025 270)', pointerEvents: 'none' }}
    />
  )
}
