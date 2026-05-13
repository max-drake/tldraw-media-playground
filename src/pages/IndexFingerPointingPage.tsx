/**
 * IndexFingerPointingPage – uses @mediapipe/tasks-vision HandLandmarker to
 * track where the user's right index finger is *pointing* in 3-D space and
 * projects that direction ray onto the tldraw canvas.
 *
 * Design decisions
 * ────────────────
 * 1. 3-D ray projection: cast a ray from INDEX_MCP through INDEX_TIP in world
 *    landmarks (real-world metres), intersect it with a virtual screen plane
 *    at SCREEN_DEPTH_M, then map to canvas pixels. This means the cursor goes
 *    where the finger *aims*, not where the tip physically is in camera space.
 *
 * 2. Pointing detection: ONLY the index finger joint chain is checked for
 *    straightness. Fingers 3–5 are completely ignored — pointing works with
 *    an open hand, a fist-with-index-out, or anything in between.
 *
 * 3. Click mechanic — "gun / L-shape" gesture:
 *    - Index unfurled = pointing active.
 *    - Thumb roughly perpendicular to index (L-shape) = hovering (no press).
 *    - Thumb NOT perpendicular (folded / alongside index) = mouse DOWN.
 *    Single clicks work by briefly lowering and raising the thumb.
 *
 * 4. Skeleton overlay drawn on a canvas over the webcam preview.
 *    Index highlighted green (hovering) or orange (pressing).
 *    Thumb highlighted blue (L-shape) or orange (pressing).
 *
 * 5. Debug panel (on by default, press D to toggle) sits above the webcam.
 *    Shows: hand detected, index unfurled + cosine values, thumb L-shape,
 *    projection result, raw + filtered coordinates, pressing state, FPS.
 *
 * 6. Webcam border colour-codes tracking state:
 *    green  = pointing active     amber = hand found, not pointing     dark = no hand
 *
 * 7. Dual-stage smoothing: EMA (alpha=0.82) + One-Euro filter (beta=0.007).
 */

import { useEffect, useRef, useState } from 'react'
import {
  Tldraw,
  useEditor,
  tlenvReactive,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  OverlayUtil,
  defaultOverlayUtils,
} from 'tldraw'
import { atom } from '@tldraw/state'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import type { HandLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { TLOverlay } from 'tldraw'

// ─── MediaPipe hand landmark indices ─────────────────────────────────────────
const WRIST     = 0
const THUMB_CMC = 1
const THUMB_TIP = 4
const INDEX_MCP = 5
const INDEX_PIP = 6
const INDEX_DIP = 7
const INDEX_TIP = 8

// ─── Skeleton connections ─────────────────────────────────────────────────────
const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
]

// ─── Tuning constants ─────────────────────────────────────────────────────────

/** Virtual screen plane depth from camera (metres). */
const SCREEN_DEPTH_M = 0.55

/** Virtual screen half-extents (metres). */
const VIRTUAL_HALF_W = 0.24
const VIRTUAL_HALF_H = 0.18

/** Cosine threshold for index straightness — 0.82 ≈ within ~35° of straight. */
const STRAIGHT_COS_THRESH = 0.82

/**
 * |cos| threshold for thumb-perpendicular (L-shape) check.
 * < threshold → thumb is orthogonal to index → L-shape → NOT pressing.
 * >= threshold → thumb aligned/folded → PRESSING.
 */
const THUMB_ORTHO_THRESHOLD = 0.50

/** EMA smoothing alpha (stage 1). */
const SMOOTH_ALPHA = 0.82

/** One-Euro filter params (stage 2). */
const ONE_EURO_MIN_CUTOFF = 1.0
const ONE_EURO_BETA       = 0.007
const ONE_EURO_D_CUTOFF   = 1.0

// ─── Persistent store ─────────────────────────────────────────────────────────

const store = createTLStore({
  shapeUtils: [...defaultShapeUtils],
  bindingUtils: [...defaultBindingUtils],
})

// ─── Reactive atom ────────────────────────────────────────────────────────────

interface FingerPointerState {
  visible: boolean
  x: number
  y: number
  pressing: boolean
}

const fingerPointerAtom = atom<FingerPointerState>('fingerPointer', {
  visible: false, x: 0, y: 0, pressing: false,
})

// ─── Overlay type ─────────────────────────────────────────────────────────────

interface TLFingerPointerOverlay extends TLOverlay {
  type: 'finger-pointer'
  props: { x: number; y: number; pressing: boolean }
}

// ─── Pointer drawing ──────────────────────────────────────────────────────────

const POINTER_RADIUS = 20
const PRESS_RADIUS   = 13
const MINIMAP_RADIUS = 6

function _drawFingerPointer(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  pressing: boolean,
  pointingR: number, pressR: number,
): void {
  ctx.save()
  ctx.beginPath()
  if (pressing) {
    ctx.arc(x, y, pressR, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(91,207,135,0.88)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = Math.max(1, pressR * 0.14)
    ctx.stroke()
  } else {
    const r = pointingR
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(91,207,135,0.92)'
    ctx.lineWidth = Math.max(1, r * 0.14)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, Math.max(1, r * 0.18), 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(91,207,135,0.92)'
    ctx.fill()
    const gap = r * 0.3, arm = r * 0.5
    ctx.beginPath()
    ctx.moveTo(x - r - arm, y); ctx.lineTo(x - gap, y)
    ctx.moveTo(x + gap, y);     ctx.lineTo(x + r + arm, y)
    ctx.moveTo(x, y - r - arm); ctx.lineTo(x, y - gap)
    ctx.moveTo(x, y + gap);     ctx.lineTo(x, y + r + arm)
    ctx.strokeStyle = 'rgba(91,207,135,0.55)'
    ctx.lineWidth = Math.max(1, r * 0.10)
    ctx.stroke()
  }
  ctx.restore()
}

// ─── OverlayUtil ──────────────────────────────────────────────────────────────

export class FingerPointerOverlayUtil extends OverlayUtil<TLFingerPointerOverlay> {
  static override type = 'finger-pointer' as const
  options = { zIndex: 400 }

  isActive(): boolean { return fingerPointerAtom.get().visible }

  getOverlays(): TLFingerPointerOverlay[] {
    const { x, y, pressing } = fingerPointerAtom.get()
    return [{ id: 'finger-pointer:tip', type: 'finger-pointer', props: { x, y, pressing } }]
  }

  render(ctx: CanvasRenderingContext2D, overlays: TLFingerPointerOverlay[]): void {
    for (const ov of overlays) {
      _drawFingerPointer(ctx, ov.props.x, ov.props.y, ov.props.pressing, POINTER_RADIUS, PRESS_RADIUS)
    }
  }

  renderMinimap(ctx: CanvasRenderingContext2D, overlays: TLFingerPointerOverlay[], zoom: number): void {
    const r = MINIMAP_RADIUS / zoom
    for (const ov of overlays) {
      _drawFingerPointer(ctx, ov.props.x, ov.props.y, ov.props.pressing, r, r * 0.65)
    }
  }
}

// ─── 3-D vector helpers ───────────────────────────────────────────────────────

interface Vec3 { x: number; y: number; z: number }
function sub3(a: Vec3, b: Vec3): Vec3 { return { x: a.x-b.x, y: a.y-b.y, z: a.z-b.z } }
function dot3(a: Vec3, b: Vec3): number { return a.x*b.x + a.y*b.y + a.z*b.z }
function len3(a: Vec3): number { return Math.sqrt(dot3(a,a)) }
function norm3(a: Vec3): Vec3 {
  const l = len3(a); if (l < 1e-9) return { x:0, y:0, z:0 }
  return { x: a.x/l, y: a.y/l, z: a.z/l }
}
function cosSim(a: Vec3, b: Vec3): number {
  const la = len3(a), lb = len3(b)
  if (la < 1e-9 || lb < 1e-9) return 1
  return dot3(a,b) / (la*lb)
}

// ─── One-Euro filter ──────────────────────────────────────────────────────────

class OneEuroFilter {
  private prevFiltered: number | null = null
  private prevDx = 0
  private prevTime: number | null = null
  constructor(
    private minCutoff = ONE_EURO_MIN_CUTOFF,
    private beta = ONE_EURO_BETA,
    private dCutoff = ONE_EURO_D_CUTOFF,
  ) {}
  filter(raw: number, t: number): number {
    if (this.prevTime === null || this.prevFiltered === null) {
      this.prevFiltered = raw; this.prevTime = t; return raw
    }
    const dt = Math.max(1e-6, (t - this.prevTime) / 1000)
    this.prevTime = t
    const dx = (raw - this.prevFiltered) / dt
    const dAlpha = this._alpha(dt, this.dCutoff)
    const dxHat = dAlpha * dx + (1 - dAlpha) * this.prevDx
    this.prevDx = dxHat
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat)
    const alpha = this._alpha(dt, cutoff)
    const filtered = alpha * raw + (1 - alpha) * this.prevFiltered
    this.prevFiltered = filtered
    return filtered
  }
  reset(): void { this.prevFiltered = null; this.prevDx = 0; this.prevTime = null }
  private _alpha(dt: number, cutoff: number): number {
    const tau = 1.0 / (2 * Math.PI * cutoff)
    return 1.0 / (1.0 + tau / dt)
  }
}

// ─── Gesture detection ────────────────────────────────────────────────────────

/** Check only the index finger's joint chain for straightness. */
function isIndexUnfurled(
  wl: NormalizedLandmark[],
): { unfurled: boolean; cs12: number; cs23: number } {
  const seg1 = norm3(sub3(wl[INDEX_PIP] as Vec3, wl[INDEX_MCP] as Vec3))
  const seg2 = norm3(sub3(wl[INDEX_DIP] as Vec3, wl[INDEX_PIP] as Vec3))
  const seg3 = norm3(sub3(wl[INDEX_TIP] as Vec3, wl[INDEX_DIP] as Vec3))
  const cs12 = cosSim(seg1, seg2)
  const cs23 = cosSim(seg2, seg3)
  return { unfurled: cs12 >= STRAIGHT_COS_THRESH && cs23 >= STRAIGHT_COS_THRESH, cs12, cs23 }
}

/**
 * L-shape / finger-gun check.
 * orthogonal=true  → L-shape → NOT pressing.
 * orthogonal=false → thumb folded/aligned → PRESSING.
 */
function isThumbOrthogonal(
  wl: NormalizedLandmark[],
): { orthogonal: boolean; cosVal: number } {
  const indexDir = norm3(sub3(wl[INDEX_TIP] as Vec3, wl[INDEX_MCP] as Vec3))
  const thumbDir = norm3(sub3(wl[THUMB_TIP] as Vec3, wl[THUMB_CMC] as Vec3))
  const cosVal = Math.abs(cosSim(indexDir, thumbDir))
  return { orthogonal: cosVal < THUMB_ORTHO_THRESHOLD, cosVal }
}

/**
 * Project the pointing ray (world INDEX_MCP → INDEX_TIP) onto a virtual screen
 * plane at z = -SCREEN_DEPTH_M and map to canvas pixels.
 */
function projectRayToScreen(
  wl: NormalizedLandmark[],
  canvasW: number,
  canvasH: number,
): { sx: number; sy: number } | null {
  const origin = wl[INDEX_MCP] as Vec3
  const target = wl[INDEX_TIP] as Vec3
  const dir = sub3(target, origin)
  const targetZ = -SCREEN_DEPTH_M
  if (Math.abs(dir.z) < 1e-6) return null
  const t = (targetZ - origin.z) / dir.z
  if (t <= 0) return null
  const wx = origin.x + t * dir.x
  const wy = origin.y + t * dir.y
  const nx = wx / VIRTUAL_HALF_W
  const ny = wy / VIRTUAL_HALF_H
  if (Math.abs(nx) > 1.5 || Math.abs(ny) > 1.5) return null
  // Flip x for mirrored display
  const sx = (1 - (nx * 0.5 + 0.5)) * canvasW
  const sy = (ny * 0.5 + 0.5) * canvasH
  return { sx, sy }
}

// ─── Skeleton drawing ─────────────────────────────────────────────────────────

function drawHandSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  W: number, H: number,
  unfurled: boolean,
  pressing: boolean,
): void {
  const indexIds = new Set([INDEX_MCP, INDEX_PIP, INDEX_DIP, INDEX_TIP])
  const thumbIds = new Set([THUMB_CMC, 2, 3, THUMB_TIP])
  const indexConns = new Set(['5-6', '6-7', '7-8'])
  const thumbConns = new Set(['0-1', '1-2', '2-3', '3-4'])

  ctx.save()

  for (const [a, b] of HAND_CONNECTIONS) {
    const la = landmarks[a], lb = landmarks[b]
    if (!la || !lb) continue
    const ax = (1 - la.x) * W, ay = la.y * H
    const bx = (1 - lb.x) * W, by = lb.y * H
    const key = Math.min(a,b) + '-' + Math.max(a,b)
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
    if (indexConns.has(key) && unfurled) {
      ctx.strokeStyle = pressing ? 'rgba(255,160,60,0.95)' : 'rgba(91,207,135,0.85)'
      ctx.lineWidth = 3
    } else if (thumbConns.has(key)) {
      ctx.strokeStyle = pressing ? 'rgba(255,160,60,0.85)' : 'rgba(180,180,255,0.7)'
      ctx.lineWidth = 2
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'
      ctx.lineWidth = 1.5
    }
    ctx.stroke()
  }

  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i]; if (!lm) continue
    const px = (1 - lm.x) * W, py = lm.y * H
    const isIdx = indexIds.has(i), isThb = thumbIds.has(i)
    ctx.beginPath()
    ctx.arc(px, py, i === WRIST ? 4 : (isIdx || isThb) ? 4 : 2.5, 0, Math.PI * 2)
    if (isIdx && unfurled)  ctx.fillStyle = pressing ? 'rgba(255,160,60,1)'   : 'rgba(91,207,135,0.9)'
    else if (isThb)         ctx.fillStyle = pressing ? 'rgba(255,160,60,0.9)' : 'rgba(180,180,255,0.8)'
    else                    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.fill()
    if (i === INDEX_TIP) {
      ctx.beginPath()
      ctx.arc(px, py, 7, 0, Math.PI * 2)
      ctx.strokeStyle = unfurled
        ? (pressing ? 'rgba(255,160,60,1)' : 'rgba(91,207,135,0.9)')
        : 'rgba(255,255,100,0.6)'
      ctx.lineWidth = 2; ctx.stroke()
    }
  }
  ctx.restore()
}

// ─── Debug state ──────────────────────────────────────────────────────────────

interface DebugState {
  modelStatus: 'loading' | 'ready' | 'error'
  errorMsg: string
  handDetected: boolean
  indexUnfurled: boolean
  thumbOrthogonal: boolean
  thumbCosVal: number | null
  projectionResult: 'ok' | 'off-screen' | 'no-hand' | 'not-pointing' | 'none'
  rawSx: number | null
  rawSy: number | null
  smoothedSx: number | null
  smoothedSy: number | null
  pressing: boolean
  fps: number
  cosSim12: number | null
  cosSim23: number | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findRightHand(result: HandLandmarkerResult): number {
  for (let i = 0; i < result.handedness.length; i++) {
    if (result.handedness[i].some((c) => c.categoryName === 'Right')) return i
  }
  return -1
}

function DebugRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: '#777', flexShrink: 0 }}>{label}</span>
      <span style={{ color: color ?? '#ddd', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

// ─── Controller ───────────────────────────────────────────────────────────────

interface ControllerProps {
  containerRef: React.RefObject<HTMLDivElement | null>
}

function IndexFingerController({ containerRef }: ControllerProps) {
  const editor = useEditor()

  const videoRef          = useRef<HTMLVideoElement | null>(null)
  const skeletonCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef            = useRef<number | null>(null)
  const landmarkerRef     = useRef<HandLandmarker | null>(null)
  const isPressedRef      = useRef(false)
  const smoothRef         = useRef<{ sx: number; sy: number } | null>(null)
  const euroXRef          = useRef(new OneEuroFilter())
  const euroYRef          = useRef(new OneEuroFilter())
  const fpsRef            = useRef({ count: 0, lastTime: performance.now(), fps: 0 })

  const [debugVisible, setDebugVisible] = useState(true)
  const [debug, setDebug] = useState<DebugState>({
    modelStatus: 'loading', errorMsg: '',
    handDetected: false, indexUnfurled: false,
    thumbOrthogonal: false, thumbCosVal: null,
    projectionResult: 'none',
    rawSx: null, rawSy: null, smoothedSx: null, smoothedSy: null,
    pressing: false, fps: 0, cosSim12: null, cosSim23: null,
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'd' || e.key === 'D') setDebugVisible((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    tlenvReactive.set({ ...tlenvReactive.get(), isCoarsePointer: true })
    let cancelled = false

    async function init() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm',
        )
        const landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
        })
        if (cancelled) { landmarker.close(); return }
        landmarkerRef.current = landmarker

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }

        const video = videoRef.current!
        video.srcObject = stream
        await new Promise<void>((res) => { video.onloadeddata = () => res() })
        await video.play()
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }

        setDebug((d) => ({ ...d, modelStatus: 'ready' }))

        let lastTs = -1
        function detect() {
          if (cancelled) return
          const now = performance.now()
          if (now <= lastTs) { rafRef.current = requestAnimationFrame(detect); return }
          lastTs = now
          const fp = fpsRef.current
          fp.count++
          if (now - fp.lastTime >= 500) {
            fp.fps = Math.round((fp.count * 1000) / (now - fp.lastTime))
            fp.count = 0; fp.lastTime = now
          }
          const result: HandLandmarkerResult = landmarkerRef.current!.detectForVideo(video, now)
          processResult(result, now)
          drawSkeleton(result)
          rafRef.current = requestAnimationFrame(detect)
        }
        rafRef.current = requestAnimationFrame(detect)
      } catch (e) {
        if (!cancelled) {
          console.error('[IndexFingerPointing] init error:', e)
          setDebug((d) => ({ ...d, modelStatus: 'error', errorMsg: String(e) }))
        }
      }
    }

    init()

    return () => {
      cancelled = true
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (landmarkerRef.current) { landmarkerRef.current.close(); landmarkerRef.current = null }
      const video = videoRef.current
      if (video?.srcObject) {
        ;(video.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
        video.srcObject = null
      }
      fingerPointerAtom.set({ visible: false, x: 0, y: 0, pressing: false })
      tlenvReactive.set({ ...tlenvReactive.get(), isCoarsePointer: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function drawSkeleton(result: HandLandmarkerResult) {
    const canvas = skeletonCanvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const rightIdx = findRightHand(result); if (rightIdx === -1) return
    const { unfurled } = isIndexUnfurled(result.worldLandmarks[rightIdx])
    const { orthogonal } = isThumbOrthogonal(result.worldLandmarks[rightIdx])
    drawHandSkeleton(ctx, result.landmarks[rightIdx], canvas.width, canvas.height,
      unfurled, unfurled && !orthogonal)
  }

  function releasePress(point: { x: number; y: number }) {
    if (isPressedRef.current) {
      isPressedRef.current = false
      editor.dispatch({
        type: 'pointer', name: 'pointer_up', target: 'canvas',
        button: 0, isPen: false, pointerId: 1, point,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
      })
    }
  }

  function processResult(result: HandLandmarkerResult, timestamp: number) {
    const container = containerRef.current; if (!container) return
    const rect = container.getBoundingClientRect()
    const W = rect.width, H = rect.height
    const fps = fpsRef.current.fps
    const rightIdx = findRightHand(result)

    if (rightIdx === -1) {
      fingerPointerAtom.set({ visible: false, x: 0, y: 0, pressing: false })
      smoothRef.current = null; euroXRef.current.reset(); euroYRef.current.reset()
      setDebug((d) => ({
        ...d, fps, handDetected: false, indexUnfurled: false,
        thumbOrthogonal: false, thumbCosVal: null, projectionResult: 'no-hand',
        rawSx: null, rawSy: null, smoothedSx: null, smoothedSy: null,
        pressing: false, cosSim12: null, cosSim23: null,
      }))
      releasePress(editor.inputs.currentPagePoint)
      return
    }

    const wl = result.worldLandmarks[rightIdx]
    const { unfurled, cs12, cs23 } = isIndexUnfurled(wl)

    if (!unfurled) {
      fingerPointerAtom.set({ visible: false, x: 0, y: 0, pressing: false })
      smoothRef.current = null; euroXRef.current.reset(); euroYRef.current.reset()
      setDebug((d) => ({
        ...d, fps, handDetected: true, indexUnfurled: false,
        thumbOrthogonal: false, thumbCosVal: null, projectionResult: 'not-pointing',
        rawSx: null, rawSy: null, smoothedSx: null, smoothedSy: null,
        pressing: false, cosSim12: cs12, cosSim23: cs23,
      }))
      releasePress(editor.inputs.currentPagePoint)
      return
    }

    const { orthogonal: thumbOrtho, cosVal: thumbCos } = isThumbOrthogonal(wl)
    const pressing = !thumbOrtho   // L-shape = hover; folded = press

    const proj = projectRayToScreen(wl, W, H)
    if (!proj) {
      fingerPointerAtom.set({ visible: false, x: 0, y: 0, pressing: false })
      setDebug((d) => ({
        ...d, fps, handDetected: true, indexUnfurled: true,
        thumbOrthogonal: thumbOrtho, thumbCosVal: thumbCos, projectionResult: 'off-screen',
        rawSx: null, rawSy: null, smoothedSx: null, smoothedSy: null,
        pressing: false, cosSim12: cs12, cosSim23: cs23,
      }))
      return
    }

    if (!smoothRef.current) {
      smoothRef.current = { sx: proj.sx, sy: proj.sy }
    } else {
      smoothRef.current = {
        sx: SMOOTH_ALPHA * smoothRef.current.sx + (1 - SMOOTH_ALPHA) * proj.sx,
        sy: SMOOTH_ALPHA * smoothRef.current.sy + (1 - SMOOTH_ALPHA) * proj.sy,
      }
    }
    const screenX = euroXRef.current.filter(smoothRef.current.sx, timestamp)
    const screenY = euroYRef.current.filter(smoothRef.current.sy, timestamp)
    const point = { x: screenX, y: screenY }
    const pagePoint = editor.screenToPage(point)

    fingerPointerAtom.set({ visible: true, x: pagePoint.x, y: pagePoint.y, pressing })
    setDebug((d) => ({
      ...d, fps, handDetected: true, indexUnfurled: true,
      thumbOrthogonal: thumbOrtho, thumbCosVal: thumbCos, projectionResult: 'ok',
      rawSx: Math.round(proj.sx), rawSy: Math.round(proj.sy),
      smoothedSx: Math.round(screenX), smoothedSy: Math.round(screenY),
      pressing, cosSim12: cs12, cosSim23: cs23,
    }))

    editor.dispatch({
      type: 'pointer', name: 'pointer_move', target: 'canvas',
      button: 0, isPen: false, pointerId: 1, point,
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
    })

    if (pressing && !isPressedRef.current) {
      isPressedRef.current = true
      editor.dispatch({
        type: 'pointer', name: 'pointer_down', target: 'canvas',
        button: 0, isPen: false, pointerId: 1, point,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
      })
    } else if (!pressing && isPressedRef.current) {
      isPressedRef.current = false
      editor.dispatch({
        type: 'pointer', name: 'pointer_up', target: 'canvas',
        button: 0, isPen: false, pointerId: 1, point,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
      })
    }
  }

  const { modelStatus } = debug
  const statusColor = modelStatus === 'ready' ? '#7fff7f'
    : modelStatus === 'error' ? '#f55' : '#aaa'
  const borderColor = !debug.handDetected ? '#2a2a2a'
    : debug.indexUnfurled ? '#5bcf87' : '#f0a030'
  const CAM_W = 240, CAM_H = 180
  const DEBUG_BOTTOM = CAM_H + 16 + 10

  return (
    <>
      {debugVisible && (
        <div style={{
          position: 'absolute', bottom: DEBUG_BOTTOM, right: 16,
          background: 'rgba(0,0,0,0.84)', color: '#ddd',
          fontSize: 11, fontFamily: 'monospace', borderRadius: 8,
          padding: '10px 14px', zIndex: 500, pointerEvents: 'none',
          minWidth: 280, lineHeight: 1.75,
          border: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: '#fff', fontSize: 12 }}>
            ☝️ Index Finger Debug
            <span style={{ fontWeight: 400, color: '#666', marginLeft: 8 }}>[D to hide]</span>
          </div>
          <DebugRow label="Model" value={modelStatus}
            color={modelStatus === 'ready' ? '#7fff7f' : modelStatus === 'error' ? '#f55' : '#aaa'} />
          <DebugRow label="FPS" value={modelStatus === 'ready' ? String(debug.fps) : '—'} />
          <DebugRow label="Hand detected"
            value={debug.handDetected ? '✅ yes' : '❌ no — show your right hand'}
            color={debug.handDetected ? '#7fff7f' : '#f88'} />
          <DebugRow label="Index unfurled"
            value={!debug.handDetected ? '—' : debug.indexUnfurled ? '✅ yes' : '❌ no — extend index'}
            color={debug.indexUnfurled ? '#7fff7f' : debug.handDetected ? '#f88' : '#888'} />
          {debug.cosSim12 !== null && (
            <DebugRow label="Cos MCP→PIP→DIP" value={debug.cosSim12.toFixed(2)}
              color={debug.cosSim12 >= STRAIGHT_COS_THRESH ? '#7fff7f' : '#f88'} />
          )}
          {debug.cosSim23 !== null && (
            <DebugRow label="Cos PIP→DIP→TIP" value={debug.cosSim23.toFixed(2)}
              color={debug.cosSim23 >= STRAIGHT_COS_THRESH ? '#7fff7f' : '#f88'} />
          )}
          {debug.indexUnfurled && (
            <DebugRow label="Thumb L-shape"
              value={debug.thumbCosVal !== null
                ? (debug.thumbOrthogonal ? '✅ yes → hovering' : '🟠 no → PRESSING')
                  + '  |cos|=' + debug.thumbCosVal.toFixed(2)
                : '—'}
              color={debug.thumbOrthogonal ? '#7fff7f' : '#f0a030'} />
          )}
          <DebugRow label="Projection"
            value={
              debug.projectionResult === 'ok'          ? '✅ on screen'
              : debug.projectionResult === 'off-screen'? '⚠️ off screen'
              : debug.projectionResult === 'not-pointing'? '✋ unfurl index'
              : debug.projectionResult === 'no-hand'   ? '👋 no hand'
              : '—'
            }
            color={
              debug.projectionResult === 'ok'         ? '#7fff7f'
              : debug.projectionResult === 'off-screen'? '#faaa00' : '#888'
            } />
          {debug.rawSx !== null && (
            <DebugRow label="Raw px" value={'(' + debug.rawSx + ', ' + debug.rawSy + ')'} color="#999" />
          )}
          {debug.smoothedSx !== null && (
            <DebugRow label="Filtered px" value={'(' + debug.smoothedSx + ', ' + debug.smoothedSy + ')'} />
          )}
          <DebugRow label="Pressing"
            value={debug.pressing ? '🟠 yes — L-shape to stop' : '🟢 no — lower thumb to draw'}
            color={debug.pressing ? '#f0a030' : '#7fff7f'} />
          <div style={{
            marginTop: 6, borderTop: '1px solid rgba(255,255,255,0.08)',
            paddingTop: 4, color: '#555', fontSize: 10,
          }}>
            cos≥{STRAIGHT_COS_THRESH} straight · |cos|&lt;{THUMB_ORTHO_THRESHOLD}→L · α={SMOOTH_ALPHA}
          </div>
        </div>
      )}

      {!debugVisible && (
        <div style={{
          position: 'absolute', bottom: DEBUG_BOTTOM, right: 16,
          background: 'rgba(0,0,0,0.65)', color: statusColor,
          fontSize: 11, borderRadius: 6, padding: '4px 10px',
          zIndex: 500, pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          {modelStatus === 'loading' && '⏳ Initialising…'}
          {modelStatus === 'ready'   && '☝️ Extend index · L-shape=hover · Lower thumb=draw'}
          {modelStatus === 'error'   && '⚠ Hand tracking unavailable'}
        </div>
      )}

      <div style={{
        position: 'absolute', bottom: 16, right: 16,
        width: CAM_W, height: CAM_H, borderRadius: 8, overflow: 'hidden',
        border: '2px solid ' + borderColor,
        boxShadow: '0 2px 14px rgba(0,0,0,0.45)', zIndex: 500,
        background: '#0d0d0d', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        transition: 'border-color 0.15s ease',
      }}>
        {modelStatus === 'loading' && (
          <span style={{ color: '#aaa', fontSize: 11, textAlign: 'center', padding: 8 }}>
            Loading hand tracker…
          </span>
        )}
        {modelStatus === 'error' && (
          <span style={{ color: '#f55', fontSize: 10, textAlign: 'center', padding: 8 }}>
            {debug.errorMsg || 'Camera / model error'}
          </span>
        )}
        <video ref={videoRef} style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          objectFit: 'cover', transform: 'scaleX(-1)',
          display: modelStatus === 'ready' ? 'block' : 'none',
        }} playsInline muted />
        <canvas
          ref={(el) => {
            skeletonCanvasRef.current = el
            if (el) { el.width = CAM_W; el.height = CAM_H }
          }}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            pointerEvents: 'none',
            display: modelStatus === 'ready' ? 'block' : 'none',
          }}
        />
        <div style={{
          position: 'absolute', top: 5, right: 5,
          width: 8, height: 8, borderRadius: '50%',
          background: statusColor, boxShadow: '0 0 6px ' + statusColor,
        }} />
      </div>

      {modelStatus === 'ready' && (
        <div style={{
          position: 'absolute', top: 12, left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.6)', color: '#ddd',
          fontSize: 12, borderRadius: 8, padding: '6px 16px',
          zIndex: 500, pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          ☝️ Extend index to point &nbsp;·&nbsp; 🤙 L-shape = hover &nbsp;·&nbsp; 👇 Lower thumb = draw
          &nbsp;·&nbsp; <kbd style={{ color: '#999', fontSize: 11 }}>D</kbd> = debug
        </div>
      )}
    </>
  )
}

// ─── Page component ───────────────────────────────────────────────────────────

const overlayUtils = [...defaultOverlayUtils, FingerPointerOverlayUtil] as const

export default function IndexFingerPointingPage() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw store={store} overlayUtils={overlayUtils}>
        <IndexFingerController containerRef={containerRef} />
      </Tldraw>
    </div>
  )
}
