# tldraw media playground

Minimal scaffolding for multiple tldraw editor instances served via a Cloudflare Worker.

## Structure

```
├── index.html              # SPA entry point
├── src/
│   ├── main.tsx            # React root mount
│   ├── App.tsx             # Client-side router (History API)
│   ├── components/
│   │   └── NavBar.tsx      # Navigation bar with route links
│   └── pages/
│       ├── HomePage.tsx    # Landing page with links to editors
│       ├── Page1.tsx       # Dummy page – isolated Tldraw instance
│       └── Page2.tsx       # Dummy page – isolated Tldraw instance
├── worker/
│   └── index.ts            # Cloudflare Worker – SPA routing + static assets
├── vite.config.ts
├── wrangler.toml           # CF Worker config, points at ./dist
└── tsconfig.json / tsconfig.worker.json
```

## Routes

| Path      | Description                    |
|-----------|-------------------------------|
| `/`       | Home / landing page            |
| `/page-1` | Tldraw editor instance 1       |
| `/page-2` | Tldraw editor instance 2       |

The CF Worker serves `index.html` for all SPA routes; static assets (JS/CSS) are served directly from the KV site bucket.

## Dev

```bash
npm install
npm run dev          # Vite dev server (localhost:5173)
npm run typecheck    # TypeScript check
```

## Build & Deploy

```bash
npm run build        # Outputs to dist/
npm run worker:dev   # Test worker locally with wrangler
npm run worker:deploy
```
