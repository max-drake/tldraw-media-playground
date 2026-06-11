/**
 * FingerToolSwitchPage – a new experiment where the number of fingers you hold
 * up switches the active tldraw tool.
 *
 * Tool mapping (fingers extended on any detected hand):
 *   0 fingers → select tool   (fist = "nothing selected")
 *   1 finger  → draw / pencil
 *   2 fingers → arrow tool
 *   3 fingers → rectangle (geo)
 *   4 fingers → eraser
 *   5 fingers → text tool
 *
 * Pinching (index + thumb close together) fires pointer_down / pointer_up so
 * you can draw, select, and interact with the canvas.
 * The index-finger tip drives the on-screen pointer position.
 *
 * A small mirrored webcam preview sits in the bottom-right corner.
 * A FingerPointerOverlayUtil renders a coloured cursor ring on the canvas.
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

const THUMB_TIP = 4
const THUMB_IP  = 3   // thumb interphalangeal — used for thumb extension check
const INDEX_TIP = 8
const INDEX_PIP = 6
const MIDDLE_TIP = 12
const MIDDLE_PIP = 10
const RING_TIP = 16
const RING_PIP = 14
const PINKY_TIP = 20
const PINKY_PIP = 18

// Pinch threshold: normalised distance between index tip and thumb tip
const PINCH_THRESHOLD = 0.07

// How many consecutive frames at the same finger count before switching tools.
// Prevents accidental switching mid-gesture.
const DEBOUNCE_FRAMES = 8

// ---------------------------------------------------------------------------
// Tool mapping: finger count → tldraw tool id
// ---------------------------------------------------------------------------

const TOOL_MAP: Record<number, string> = {
  0: 'select',
  1: 'draw',
  2: 'arrow',
  3: 'geo',
  4: 'eraser',
  5: 'text',
}

const TOOL_LABELS: Record<number, string> = {
  0: '✊ Select',
  1: '☝️ Draw',
  2: '✌️ Arrow',
  3: '🤟 Rectangle',
  4: '🤘 Eraser',
  5: '🖐️ Text',
}

// ---------------------------------------------------------------------------
// Persistent tldraw store
// ---------------------------------------------------------------------------

const store = createTLStore({
  shapeUtils: [...defaultShapeUtils],
  bindingUtils: [...defaultBindingUtils],
})

// ---------------------------------------------------------------------------
// Shared reactive atom – updated each animation frame
// ---------------------------------------------------------------------------

interface FingerPointerState {
  visible: boolean
  x: number
  y: number
  pinching: boolean
  fingerCount: number
}

const fingerPointerAtom = atom<FingerPointerState>('fingerPointer', {
  visible: false,
  x: 0,
  y: 0,
  pinching: false,
  fingerCount: -1,
})

// ---------------------------------------------------------------------------
// TLOverlay type
// ---------------------------------------------------------------------------

interface TLFingerPointerOverlay extends TLOverlay {
  type: 'finger-pointer'
  props: {
    x: number
    y: number
    pinching: boolean
    fingerCount: number
  }
}

// ---------------------------------------------------------------------------
// OverlayUtil – renders the cursor ring on the main canvas and minimap
// ---------------------------------------------------------------------------

const POINTER_RADIUS = 18
const POINTER_PINCH_RADIUS = 12
const MINIMAP_RADIUS = 6

export class FingerPointerOverlayUtil extends OverlayUtil<TLFingerPointerOverlay> {
  static override type = 'finger-pointer'

  options = { zIndex: 400 }

  isActive(): boolean {
    return fingerPointerAtom.get().visible
  }

  getOverlays(): TLFingerPointerOverlay[] {
    const { x, y, pinching, fingerCount } = fingerPointerAtom.get()
    return [
      {
        id: 'finger-pointer:tip',
        type: 'finger-pointer',
        props: { x, y, pinching, fingerCount },
      },
    ]
  }

  render(ctx: CanvasRenderingContext2D, overlays: TLFingerPointerOverlay[]): void {
    for (const o of overlays) {
      _drawPointer(ctx, o.props.x, o.props.y, o.props.pinching, POINTER_RADIUS, POINTER_PINCH_RADIUS)
    }
  }

  renderMinimap(
    ctx: CanvasRenderingContext2D,
    overlays: TLFingerPointerOverlay[],
    zoom: number
  ): void {
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
    ctx.strokeStyle = 'rgba(50, 200, 150, 0.9)'
    ctx.lineWidth = Math.max(1, r * 0.15)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, Math.max(1, r * 0.18), 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(50, 200, 150, 0.9)'
    ctx.fill()
  }

  ctx.restore()
}

// ---------------------------------------------------------------------------
// Count how many fingers are extended for a single hand's landmark array.
//
// Thumb: tip x is to the left of the IP joint (works for right hand mirrored).
// Other four fingers: tip y is above (smaller than) the PIP joint y.
// ---------------------------------------------------------------------------

function countExtendedFingers(
  landmarks: Array<{ x: number; y: number; z: number }>
): number {
  let count = 0

  // Thumb heuristic: extended when tip is further left than the IP joint
  if (landmarks[THUMB_TIP].x < landmarks[THUMB_IP].x) count++

  // Index, middle, ring, pinky: tip higher than PIP in image space (y decreases upward)
  const fingerPairs: [number, number][] = [
    [INDEX_TIP,  INDEX_PIP],
    [MIDDLE_TIP, MIDDLE_PIP],
    [RING_TIP,   RING_PIP],
    [PINKY_TIP,  PINKY_PIP],
  ]
  for (const [tip, pip] of fingerPairs) {
    if (landmarks[tip].y < landmarks[pip].y) count++
  }

  return count
}

// ---------------------------------------------------------------------------
// FingerTrackingController – inner component (needs useEditor(), lives inside
// the <Tldraw> tree).
// ---------------------------------------------------------------------------

interface FingerTrackingControllerProps {
  containerRef: React.RefObject<HTMLDivElement | null>
}

function FingerTrackingController({ containerRef }: FingerTrackingControllerProps) {
  const editor = useEditor()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const rafRef   = useRef<number | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const isPinchedRef  = useRef(false)

  const [status,   setStatus]   = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [activeTool, setActiveTool] = useState<string>('select')

  // Debounce: switch tools only after DEBOUNCE_FRAMES stable frames
  const pendingCountRef  = useRef(-1)
  const pendingFramesRef = useRef(0)

  useEffect(() => {
    // Use wider hit areas — hand tracking is coarser than a mouse
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
          numHands: 1,
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
          console.error('[FingerToolSwitch] init error:', e)
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
      fingerPointerAtom.set({ visible: false, x: 0, y: 0, pinching: false, fingerCount: -1 })
      tlenvReactive.set({ ...tlenvReactive.get(), isCoarsePointer: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function processResult(result: HandLandmarkerResult) {
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const W = rect.width
    const H = rect.height

    if (result.landmarks.length === 0) {
      fingerPointerAtom.set({ visible: false, x: 0, y: 0, pinching: false, fingerCount: -1 })
      pendingCountRef.current  = -1
      pendingFramesRef.current = 0
      if (isPinchedRef.current) {
        isPinchedRef.current = false
        editor.dispatch({
          type: 'pointer', name: 'pointer_up', target: 'canvas', button: 0,
          isPen: false, pointerId: 1, point: editor.inputs.currentPagePoint,
          shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
        })
      }
      return
    }

    const landmarks = result.landmarks[0]
    const indexTip  = landmarks[INDEX_TIP]
    const thumbTip  = landmarks[THUMB_TIP]

    // Mirror x to match the mirrored video preview
    const screenX = (1 - indexTip.x) * W
    const screenY = indexTip.y * H
    const point   = { x: screenX, y: screenY }

    const dx = indexTip.x - thumbTip.x
    const dy = indexTip.y - thumbTip.y
    const pinching = Math.sqrt(dx * dx + dy * dy) < PINCH_THRESHOLD

    const pagePoint    = editor.screenToPage(point)
    const fingerCount  = countExtendedFingers(landmarks)

    fingerPointerAtom.set({ visible: true, x: pagePoint.x, y: pagePoint.y, pinching, fingerCount })

    // ------------------------------------------------------------------
    // Debounced tool switching
    // ------------------------------------------------------------------
    if (fingerCount === pendingCountRef.current) {
      pendingFramesRef.current++
      if (pendingFramesRef.current >= DEBOUNCE_FRAMES) {
        const toolId = TOOL_MAP[fingerCount]
        if (toolId && editor.getCurrentToolId() !== toolId) {
          editor.setCurrentTool(toolId)
          setActiveTool(toolId)
        }
      }
    } else {
      pendingCountRef.current  = fingerCount
      pendingFramesRef.current = 1
    }

    // ------------------------------------------------------------------
    // Pointer events
    // ------------------------------------------------------------------
    editor.dispatch({
      type: 'pointer', name: 'pointer_move', target: 'canvas', button: 0,
      isPen: false, pointerId: 1, point,
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
    })

    if (pinching && !isPinchedRef.current) {
      isPinchedRef.current = true
      editor.dispatch({
        type: 'pointer', name: 'pointer_down', target: 'canvas', button: 0,
        isPen: false, pointerId: 1, point,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
      })
    } else if (!pinching && isPinchedRef.current) {
      isPinchedRef.current = false
      editor.dispatch({
        type: 'pointer', name: 'pointer_up', target: 'canvas', button: 0,
        isPen: false, pointerId: 1, point,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
      })
    }
  }

  return (
    <>
      {/* Top-centre HUD showing tool mapping and active tool */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.72)',
          color: '#fff',
          fontSize: 14,
          borderRadius: 10,
          padding: '10px 20px',
          zIndex: 500,
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          minWidth: 260,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: 0.3 }}>
          🖐️ Finger Tool Switcher
        </div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>
          Hold up fingers to switch tools · Pinch to draw
        </div>
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginTop: 4,
            flexWrap: 'wrap',
            justifyContent: 'center',
          }}
        >
          {Object.entries(TOOL_LABELS).map(([count, label]) => {
            const isActive = activeTool === TOOL_MAP[Number(count)]
            return (
              <span
                key={count}
                style={{
                  padding: '2px 10px',
                  borderRadius: 6,
                  background: isActive ? 'rgba(50,200,150,0.9)' : 'rgba(255,255,255,0.1)',
                  fontWeight: isActive ? 700 : 400,
                  fontSize: 12,
                  transition: 'background 0.15s',
                }}
              >
                {label}
              </span>
            )
          })}
        </div>
      </div>

      {/* Webcam preview – mirrored, bottom-right */}
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          width: 200,
          height: 150,
          borderRadius: 8,
          overflow: 'hidden',
          border: '2px solid #32c896',
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
            Loading hand tracker…
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

      {/* Status badge above the preview */}
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
        {status === 'loading' && '⏳ Initialising…'}
        {status === 'ready'   && '🖐️ Finger tracking active'}
        {status === 'error'   && '⚠ Hand tracking unavailable'}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

const overlayUtils = [...defaultOverlayUtils, FingerPointerOverlayUtil] as const

export default function FingerToolSwitchPage() {
  const containerRef = useRef<HTMLDivElement | null>(null)

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw store={store} overlayUtils={overlayUtils}>
        <FingerTrackingController containerRef={containerRef} />
      </Tldraw>
    </div>
  )
}
