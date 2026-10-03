import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// /api -> the analysis server (python -m src.server). Without it the static demo still works.
const api = {
  '/api': {
    target: process.env.RHETORTRACE_API ?? 'http://127.0.0.1:8000',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api/, ''),
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { proxy: api },
  preview: { proxy: api },
})
