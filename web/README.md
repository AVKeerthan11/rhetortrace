# RhetorTrace dashboard

React 19 + TypeScript + Vite. The dashboard reads analysis documents produced by the Python pipeline
and never recomputes analysis values (types: `src/lib/types.ts`).

```bash
npm install
npm run dev          # http://localhost:5173 ; /api is proxied to the analysis server (port 8000)
npm test             # Vitest unit tests
npm run test:e2e     # Playwright end to end (starts the analysis server itself)
npm run build        # type check + production build
```

Data sources:

* **Demo and Lab**: static files in `public/data/` and `public/audio/`, written by
  `python scripts/build_dashboard.py` (the audio `.flac` files are git-ignored; after a fresh clone run
  `python -m src.features.pitch --all` and `python -m src.features.energy --all` first).
* **Your analyses**: the analysis server (`python -m src.server`), `GET /results/{run_id}`.

Layout:

| path | contents |
|---|---|
| `src/pages/` | Home, New analysis, Your recordings, Lab (evaluation, robustness, method, examples) |
| `src/features/stage/` | the recording stage shared by Overview, Finding and Explorer: lanes, rhythm threads, instruments, keyboard model |
| `src/features/finding/` | a finding: hear it, evidence chain, severity scale, word timing |
| `src/features/timeline/` | the Explorer and its transcript |
| `src/features/home/` | the Home opening scene |
| `src/lib/` | data loading, player, shared time cursor, visual grammar, score allocation, alignment mapping |
| `e2e/` | Playwright journey against the real analysis server |

See the [main README](../README.md) for how the dashboard fits the pipeline.
