import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// End to end: the real analysis server (python -m src.server, in a throwaway runs directory)
// behind the Vite dev server's /api proxy. Uploads of the dataset recordings reuse their cached
// alignments (same audio and transcript bytes), so no speech model has to load.
const repo = path.resolve(import.meta.dirname, '..')
const venv = path.join(repo, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const python = existsSync(venv) ? `"${venv}"` : 'python'
const runs = mkdtempSync(path.join(tmpdir(), 'rhetortrace-e2e-'))
const API_PORT = 8765
const WEB_PORT = 5175

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1, // one analysis server, jobs run one at a time
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
  webServer: [
    {
      command: `${python} -m src.server --port ${API_PORT} --runs-dir "${runs}"`,
      cwd: repo,
      url: `http://127.0.0.1:${API_PORT}/openapi.json`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      env: { RHETORTRACE_API: `http://127.0.0.1:${API_PORT}` },
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
})
