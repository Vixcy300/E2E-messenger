import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // In development, proxy /api to local C++ backend
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      }
    }
  },
  // Production: VITE_API_URL env var points to Render backend
  define: {
    __VITE_API_URL__: JSON.stringify(process.env.VITE_API_URL || '')
  }
})
