import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so dist/ works from file:// or any subpath on the Pi
  base: './',
  plugins: [react()],
})
