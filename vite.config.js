import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  server: {
    watch: {
      // Cargo build output — watching it can crash Vite on locked .exe files
      ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**'],
    },
  },
})
