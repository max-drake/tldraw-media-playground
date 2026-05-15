/**
 * Cloudflare Worker – minimal routing for the tldraw multi-page SPA.
 *
 * Known SPA routes:
 *   /               → home / landing
 *   /hand-tracking  → Hand Tracking editor
 *   /eye-tracking   → Eye Tracking editor
 *
 * All SPA routes serve index.html; the client-side router handles rendering.
 * Everything else is served from the KV-backed static asset bucket (JS, CSS, etc.).
 */

import { getAssetFromKV } from '@cloudflare/kv-asset-handler'
import manifestJSON from '__STATIC_CONTENT_MANIFEST'

const assetManifest = JSON.parse(manifestJSON)

const SPA_ROUTES = new Set(['/', '/hand-tracking', '/eye-tracking'])

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname.replace(/\/$/, '') || '/'

    // For known SPA routes, serve index.html so client-side routing takes over
    if (SPA_ROUTES.has(pathname)) {
      try {
        return await getAssetFromKV(
          { request: new Request(new URL('/index.html', url.origin)), waitUntil: ctx.waitUntil.bind(ctx) },
          { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
        )
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }

    // For all other paths (JS/CSS/assets), try to serve from the static bucket
    try {
      return await getAssetFromKV(
        { request, waitUntil: ctx.waitUntil.bind(ctx) },
        { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
      )
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  },
}

interface Env {
  __STATIC_CONTENT: KVNamespace
}
