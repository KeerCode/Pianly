import { createContext, useContext } from 'react'

const THEME = {
  id: 'teal',
  isDark: true,
  fg: 'oklch(0.95 0.008 270)',
  fgMuted: 'oklch(0.62 0.015 270)',
  bg: 'oklch(0.12 0.025 270)',
  accent: 'oklch(0.7 0.2 160)',
  border: 'rgba(0,255,200,.12)',
}

const ThemeContext = createContext({ theme: THEME })
export const useTheme = () => useContext(ThemeContext)
export default function ThemeProvider({ children }) {
  return <ThemeContext.Provider value={{ theme: THEME }}>{children}</ThemeContext.Provider>
}

// Named export for backward compatibility
export { ThemeProvider }
