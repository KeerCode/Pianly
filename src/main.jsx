import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './pages/App.jsx'
import Visualizer from './pages/Visualizer.jsx'
import ReadPractice from './pages/ReadPractice.jsx'
import Converter from './pages/Converter.jsx'
import FolderLibrary from './pages/FolderLibrary.jsx'
import Library from './pages/Library.jsx'
import { ThemeProvider } from './ThemeContext.jsx'

function Router() {
  const [route, setRoute] = useState(window.location.hash || '#/')

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '#/')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (route === '#/visualizer')      return <Visualizer />
  if (route === '#/read-practice')   return <ReadPractice />
  if (route === '#/converter')       return <Converter />
  if (route === '#/folder-library')  return <FolderLibrary />
  if (route === '#/library')         return <Library />
  return <App />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <Router />
    </ThemeProvider>
  </StrictMode>,
)
