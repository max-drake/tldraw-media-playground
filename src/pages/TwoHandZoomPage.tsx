/**
 * TwoHandZoomPage – two-hand zoom & pan gesture using MediaPipe HandLandmarker.
 *
 * Behaviour:
 *  - Right hand only: index-finger tip drives pointer_move; pinch (index + thumb)
 *    fires pointer_down / pointer_up (same as HandTrackingPage).
 *  - Both hands visible: two-hand zoom mode.
 *      • Spread hands apart  → zoom in
 *      • Squeeze together    → zoom out
 *      • Translate together  → pan canvas
 *    Pointer events are suppressed while two-hand mode is active.
 *  - Left hand only / no hands: idle.
 *
 * Implementation follows the plan in docs/plan-two-hand-zoom.md.
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
import type { HandLandmarkerResult } from '@mediapipe/tasks-vision'
import type { TLOverlay } from 'tldraw'

// ---------------------------------------------------------------------------
// MediaPipe landmark indices
// ---------------------------------------------------------------------------
const INDEX_TIP = 8
const THUMB_TIP = 4

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
const PINCH_THRESHOLD = 0.07
const MIN_ZOOM = 0.1
const MAX_ZOOM = 8
const SMOOTHING_ALPHA = 0.25
const LATCH_STABLE_FRAMES = 3

// ---------------------------------------------------------------------------
// Persistent store so canvas state survives tab navigation
// ---------------------------------------------------------------------------
const store = createTLStore({
  shapeUtils: [...defaultShapeUtils],
  bindingUtils: [...defaultBindingUtils],
})

// ---------------------------------------------------------------------------
// Shared reactive atoms
// ---------------------------------------------------------------------------

interface HandPointerState {
  visible: boolean
  x: number
  y: number
  pinching: boolean
}

const handPointerAtom = atom<HandPointerState>('twoHand/handPointer', {
  visible: false,
  x: 0,
  y: 0,
  pinching: false,
})

interface TwoHandZoomState {
  active: boolean
  leftX: number
  leftY: number
  rightX: number
  rightY: number
  zoomMultiplier: number
}

const twoHandZoomAtom = atom<TwoHandZoomState>('twoHand/zoom', {
  active: false,
  leftX: 0,
  leftY: 0,
  rightX: 0,
  rightY: 0,
  zoomMultiplier: 1,
})

// ---------------------------------------------------------------------------
// TLOverlay types
// ---------------------------------------------------------------------------

interface TLHandPointerOverlay extends TLOverlay {
  type: 'twohand-pointer'
  props: { x: number; y: number; pinching: boolean }
}

interface TLTwoHandZoomOverlay extends TLOverlay {
  type: 'twohand-zoom'
  props: { active: boolean; leftX: number; leftY: number; rightX: number; rightY: number; zoomMultiplier: number }
}

// ---------------------------------------------------------------------------
// PointerOverlayUtil
// ---------------------------------------------------------------------------
const POINTER_RADIUS = 18
const POINTER_PINCH_RADIUS = 12
const MINIMAP_RADIUS = 6

export class PointerOverlayUtil extends OverlayUtil<TLHandPointerOverlay> {
  static override type = 'twohand-pointer'
  options = { zIndex: 400 }

  isActive(): boolean {
    return handPointerAtom.get().visible
  }

  getOverlays(): TLHandPointerOverlay[] {
    const { x, y, pinching } = handPointerAtom.get()
    return [{ id: 'twohand-pointer:tip', type: 'twohand-pointer', props: { x, y, pinching } }]
  }

  render(ctx: CanvasRenderingContext2D, overlays: TLHandPointerOverlay[]): void {
    for (const o of overlays) {
      _drawPointer(ctx, o.props.x, o.props.y, o.props.pinching, POINTER_RADIUS, POINTER_PINCH_RADIUS)
    }
  }

  renderMinimap(ctx: CanvasRenderingContext2D, overlays: TLHandPointerOverlay[], zoom: number): void {
    const r = MINIMAP_RADIUS / zoom
    for (const o of overlays) {
      _drawPointer(ctx, o.props.x, o.props.y, o.props.pinching, r, r * 0.67)
    }
  }
}

function _drawPointer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  pinching: boolean,
  pointingRadius: number,
  pinchingRadius: number
): void {
  ctx.save()
  ctx.beginPath()
  if (pinching) {
    const r = pinchingRadius
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(233, 69, 96, 0.85)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = Math.max(1, r * 0.12)
    ctx.stroke()
  } else {
    const r = pointingRadius
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(233, 69, 96, 0.9)'
    ctx.lineWidth = Math.max(1, r * 0.15)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, Math.max(1, r * 0.18), 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(233, 69, 96, 0.9)'
    ctx.fill()
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// TwoHandOverlayUtil
// ---------------------------------------------------------------------------
const TIP_DOT_RADIUS = 14

export class TwoHandOverlayUtil extends OverlayUtil<TLTwoHandZoomOverlay> {
  static override type = 'twohand-zoom'
  options = { zIndex: 401 }

  isActive(): boolean {
    return twoHandZoomAtom.get().active
  }

  getOverlays(): TLTwoHandZoomOverlay[] {
    const state = twoHandZoomAtom.get()
    return [{ id: 'twohand-zoom:overlay', type: 'twohand-zoom', props: state }]
  }

  render(ctx: CanvasRenderingContext2D, overlays: TLTwoHandZoomOverlay[]): void {
    for (const o of overlays) {
      const { leftX, leftY, rightX, rightY, zoomMultiplier } = o.props
      _drawTwoHandOverlay(ctx, leftX, leftY, rightX, rightY, zoomMultiplier, TIP_DOT_RADIUS)
    }
  }

  renderMinimap(ctx: CanvasRenderingContext2D, overlays: TLTwoHandZoomOverlay[], zoom: number): void {
    const r = (TIP_DOT_RADIUS * 0.4) / zoom
    for (const o of overlays) {
      const { leftX, leftY, rightX, rightY, zoomMultiplier } = o.props
      _drawTwoHandOverlay(ctx, leftX, leftY, rightX, rightY, zoomMultiplier, r)
    }
  }
}

function _drawTwoHandOverlay(
  ctx: CanvasRenderingContext2D,
  lx: number,
  ly: number,
  rx: number,
  ry: number,
  zoomMultiplier: number,
  dotRadius: number
): void {
  ctx.save()

  ctx.setLineDash([dotRadius * 0.8, dotRadius * 0.5])
  ctx.beginPath()
  ctx.moveTo(lx, ly)
  ctx.lineTo(rx, ry)
  ctx.strokeStyle = 'rgba(80, 200, 255, 0.7)'
  ctx.lineWidth = Math.max(1, dotRadius * 0.25)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.beginPath()
  ctx.arc(lx, ly, dotRadius, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(80, 200, 255, 0.8)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = Math.max(1, dotRadius * 0.15)
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(rx, ry, dotRadius, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(80, 200, 255, 0.8)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = Math.max(1, dotRadius * 0.15)
  ctx.stroke()

  const mx = (lx + rx) / 2
  const my = (ly + ry) / 2
  const label = 'x' + zoomMultiplier.toFixed(2)
  const fontSize = Math.max(dotRadius * 0.9, 10)
  ctx.font = 'bold ' + fontSize + 'px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillText(label, mx + 1, my + 1)
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.fillText(label, mx, my)

  ctx.restore()
}

// ---------------------------------------------------------------------------
// TwoHandZoomController
// ---------------------------------------------------------------------------

interface TwoHandZoomControllerProps {
  containerRef: React.RefObject<HTMLDivElement | null>
}

interface GestureRefState {
  refCamera: { x: number; y: number; z: number } | null
  refMid: { x: number; y: number } | null
  refSpan: number
  smoothSpan: number
  smoothMid: { x: number; y: number } | null
  stableFrames: number
}

function TwoHandZoomController({ containerRef }: TwoHandZoomControllerProps) {
  const editor = useEditor()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const isPinchedRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  const gestureRef = useRef<GestureRefState>({
    refCamera: null,
    refMid: null,
    refSpan: 0,
    smoothSpan: 0,
    smoothMid: null,
    stableFrames: 0,
  })

  useEffect(() => {
    tlenvReactive.set({ ...tlenvReactive.get(), isCoarsePointer: true })
    let cancelled = false

    async function init() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
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

        setStatus('ready')

        let lastTs = -1
        function detect() {
          if (cancelled) return
          const now = performance.now()
          if (now <= lastTs) { rafRef.current = requestAnimationFrame(detect); return }
          lastTs = now
          const result: HandLandmarkerResult = landmarkerRef.current!.detectForVideo(video, now)
          processResult(result)
          rafRef.current = requestAnimationFrame(detect)
        }
        rafRef.current = requestAnimationFrame(detect)
      } catch (e) {
        if (!cancelled) {
          console.error('[TwoHandZoom] init error:', e)
          setErrorMsg(String(e))
          setStatus('error')
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
      handPointerAtom.set({ visible: false, x: 0, y: 0, pinching: false })
      twoHandZoomAtom.set({ active: false, leftX: 0, leftY: 0, rightX: 0, rightY: 0, zoomMultiplier: 1 })
      tlenvReactive.set({ ...tlenvReactive.get(), isCoarsePointer: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function findHand(result: HandLandmarkerResult, name: 'Left' | 'Right'): number {
    for (let i = 0; i < result.handedness.length; i++) {
      if (result.handedness[i].some((c) => c.categoryName === name)) return i
    }
    return -1
  }

  function processResult(result: HandLandmarkerResult) {
    const container = containerRef.current
    if (!container) return

    const leftIdx = findHand(result, 'Left')
    const rightIdx = findHand(result, 'Right')

    if (leftIdx !== -1 && rightIdx !== -1) {
      handleTwoHandZoom(result, leftIdx, rightIdx, container)
    } else {
      if (gestureRef.current.refCamera !== null) {
        gestureRef.current.refCamera = null
        gestureRef.current.refMid = null
        gestureRef.current.smoothMid = null
        gestureRef.current.stableFrames = 0
      }
      twoHandZoomAtom.set({ active: false, leftX: 0, leftY: 0, rightX: 0, rightY: 0, zoomMultiplier: 1 })
      handleSingleHandPointer(result, rightIdx, container)
    }
  }

  function handleTwoHandZoom(
    result: HandLandmarkerResult,
    leftIdx: number,
    rightIdx: number,
    container: HTMLDivElement
  ) {
    if (isPinchedRef.current) {
      isPinchedRef.current = false
      editor.dispatch({
        type: 'pointer', name: 'pointer_up', target: 'canvas', button: 0, isPen: false,
        pointerId: 1, point: editor.inputs.currentPagePoint,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
      })
    }
    handPointerAtom.set({ visible: false, x: 0, y: 0, pinching: false })

    const rect = container.getBoundingClientRect()
    const W = rect.width
    const H = rect.height

    const leftLM = result.landmarks[leftIdx][INDEX_TIP]
    const rightLM = result.landmarks[rightIdx][INDEX_TIP]

    const lScreen = { x: (1 - leftLM.x) * W, y: leftLM.y * H }
    const rScreen = { x: (1 - rightLM.x) * W, y: rightLM.y * H }

    const rawMid = {
      x: ((1 - leftLM.x) + (1 - rightLM.x)) / 2,
      y: (leftLM.y + rightLM.y) / 2,
    }
    const dx = (1 - leftLM.x) - (1 - rightLM.x)
    const dy = leftLM.y - rightLM.y
    const rawSpan = Math.sqrt(dx * dx + dy * dy)

    const g = gestureRef.current

    if (g.smoothMid === null) {
      g.smoothMid = { ...rawMid }
      g.smoothSpan = rawSpan
    } else {
      g.smoothSpan = SMOOTHING_ALPHA * rawSpan + (1 - SMOOTHING_ALPHA) * g.smoothSpan
      g.smoothMid = {
        x: SMOOTHING_ALPHA * rawMid.x + (1 - SMOOTHING_ALPHA) * g.smoothMid.x,
        y: SMOOTHING_ALPHA * rawMid.y + (1 - SMOOTHING_ALPHA) * g.smoothMid.y,
      }
    }

    g.stableFrames++

    if (g.refCamera === null && g.stableFrames >= LATCH_STABLE_FRAMES) {
      const cam = editor.getCamera()
      g.refCamera = { x: cam.x, y: cam.y, z: cam.z }
      g.refMid = { ...g.smoothMid }
      g.refSpan = g.smoothSpan
    }

    const lPage = editor.screenToPage(lScreen)
    const rPage = editor.screenToPage(rScreen)

    if (g.refCamera === null) {
      twoHandZoomAtom.set({
        active: true,
        leftX: lPage.x, leftY: lPage.y,
        rightX: rPage.x, rightY: rPage.y,
        zoomMultiplier: 1,
      })
      return
    }

    const zoomDelta = g.refSpan > 0 ? g.smoothSpan / g.refSpan : 1
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, g.refCamera.z * zoomDelta))

    const panScreenDx = (g.smoothMid.x - g.refMid!.x) * W
    const panScreenDy = (g.smoothMid.y - g.refMid!.y) * H
    const newX = g.refCamera.x - panScreenDx / newZoom
    const newY = g.refCamera.y - panScreenDy / newZoom

    editor.setCamera({ x: newX, y: newY, z: newZoom }, { immediate: true })

    const lPageUpdated = editor.screenToPage(lScreen)
    const rPageUpdated = editor.screenToPage(rScreen)

    twoHandZoomAtom.set({
      active: true,
      leftX: lPageUpdated.x, leftY: lPageUpdated.y,
      rightX: rPageUpdated.x, rightY: rPageUpdated.y,
      zoomMultiplier: zoomDelta,
    })
  }

  function handleSingleHandPointer(
    result: HandLandmarkerResult,
    rightHandIdx: number,
    container: HTMLDivElement
  ) {
    if (rightHandIdx === -1) {
      handPointerAtom.set({ visible: false, x: 0, y: 0, pinching: false })
      if (isPinchedRef.current) {
        isPinchedRef.current = false
        editor.dispatch({
          type: 'pointer', name: 'pointer_up', target: 'canvas', button: 0, isPen: false,
          pointerId: 1, point: editor.inputs.currentPagePoint,
          shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
        })
      }
      return
    }

    const rect = container.getBoundingClientRect()
    const W = rect.width
    const H = rect.height

    const landmarks = result.landmarks[rightHandIdx]
    const indexTip = landmarks[INDEX_TIP]
    const thumbTip = landmarks[THUMB_TIP]

    const screenX = (1 - indexTip.x) * W
    const screenY = indexTip.y * H

    const dx = indexTip.x - thumbTip.x
    const dy = indexTip.y - thumbTip.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    const pinching = dist < PINCH_THRESHOLD

    const point = { x: screenX, y: screenY }
    const pagePoint = editor.screenToPage(point)
    handPointerAtom.set({ visible: true, x: pagePoint.x, y: pagePoint.y, pinching })

    editor.dispatch({
      type: 'pointer', name: 'pointer_move', target: 'canvas', button: 0, isPen: false,
      pointerId: 1, point,
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
    })

    if (pinching && !isPinchedRef.current) {
      isPinchedRef.current = true
      editor.dispatch({
        type: 'pointer', name: 'pointer_down', target: 'canvas', button: 0, isPen: false,
        pointerId: 1, point,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
      })
    } else if (!pinching && isPinchedRef.current) {
      isPinchedRef.current = false
      editor.dispatch({
        type: 'pointer', name: 'pointer_up', target: 'canvas', button: 0, isPen: false,
        pointerId: 1, point,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
      })
    }
  }

  return (
    <>
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          width: 200,
          height: 150,
          borderRadius: 8,
          overflow: 'hidden',
          border: '2px solid #50c8ff',
          boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
          zIndex: 500,
          background: '#111',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {status === 'loading' && (
          <span style={{ color: '#ccc', fontSize: 11, textAlign: 'center', padding: 8 }}>
            Loading hand tracker...
          </span>
        )}
        {status === 'error' && (
          <span style={{ color: '#f55', fontSize: 10, textAlign: 'center', padding: 8 }}>
            {errorMsg || 'Camera / model error'}
          </span>
        )}
        <video
          ref={videoRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: 'scaleX(-1)',
            display: status === 'ready' ? 'block' : 'none',
          }}
          playsInline
          muted
        />
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 176,
          right: 16,
          background: 'rgba(0,0,0,0.65)',
          color: status === 'ready' ? '#7fff7f' : status === 'error' ? '#f55' : '#aaa',
          fontSize: 11,
          borderRadius: 6,
          padding: '4px 10px',
          zIndex: 500,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {status === 'loading' && 'Initialising...'}
        {status === 'ready' && 'Two-hand zoom active - Pinch to draw - Spread/squeeze to zoom'}
        {status === 'error' && 'Hand tracking unavailable'}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
const overlayUtils = [
  ...defaultOverlayUtils,
  PointerOverlayUtil,
  TwoHandOverlayUtil,
] as const

export default function TwoHandZoomPage() {
  const containerRef = useRef<HTMLDivElement | null>(null)

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw store={store} overlayUtils={overlayUtils}>
        <TwoHandZoomController containerRef={containerRef} />
      </Tldraw>
    </div>
  )
}
