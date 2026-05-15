/**
 * HandTrackingPage – uses @mediapipe/tasks-vision HandLandmarker to track
 * the right index finger tip as a coarse pointer inside a tldraw canvas.
 *
 * Behaviour:
 *  - The right index finger tip (landmark 8) drives `pointer_move` events.
 *  - Pinching index tip + thumb tip (landmarks 8 & 4, normalised distance
 *    below PINCH_THRESHOLD) fires `pointer_down`; releasing fires `pointer_up`.
 *
 * The webcam feed is shown in a small mirrored overlay so the user can see
 * themselves. Landmark x coordinates are flipped (1 - x) to match the mirror.
 *
 * A PointerOverlayUtil renders a visual cursor (ring when pointing, filled dot
 * when pinching) on both the main canvas and the minimap.
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
import { dispatchPointerEvent } from '../utils/pointerEvents'

// Hand landmark indices (MediaPipe convention)
const INDEX_TIP = 8
const THUMB_TIP = 4

// Distance threshold (in normalised [0,1] units) to consider a pinch active.
// ~0.07 ≈ 7% of frame width, roughly the gap when fingers visually touch.
const PINCH_THRESHOLD = 0.07

// Persistent store so canvas state survives tab navigation
const store = createTLStore({
  shapeUtils: [...defaultShapeUtils],
  bindingUtils: [...defaultBindingUtils],
})

// ---------------------------------------------------------------------------
// Shared reactive atom – updated by HandTrackingController, consumed by
// PointerOverlayUtil.  Page-space coordinates so the overlay renders correctly
// at any zoom level.
// ---------------------------------------------------------------------------

interface HandPointerState {
  /** Whether a right hand is currently detected */
  visible: boolean
  /** Index-finger-tip position in page coordinates */
  x: number
  y: number
  /** True when a pinch (index + thumb close together) is detected */
  pinching: boolean
}

const handPointerAtom = atom<HandPointerState>('handPointer', {
  visible: false,
  x: 0,
  y: 0,
  pinching: false,
})

// ---------------------------------------------------------------------------
// TLOverlay type for the hand pointer
// ---------------------------------------------------------------------------

interface TLHandPointerOverlay extends TLOverlay {
  type: 'hand-pointer'
  props: {
    x: number
    y: number
    pinching: boolean
  }
}

// ---------------------------------------------------------------------------
// PointerOverlayUtil – renders the hand-pointer on the main canvas and minimap
// ---------------------------------------------------------------------------

const POINTER_RADIUS = 18       // canvas radius (page units, scales with zoom)
const POINTER_PINCH_RADIUS = 12 // smaller radius when pinching
const MINIMAP_RADIUS = 6        // desired pixel radius on minimap

export class PointerOverlayUtil extends OverlayUtil<TLHandPointerOverlay> {
  static override type = 'hand-pointer'

  options = {
    // Paint on top of everything built-in (which uses up to ~300)
    zIndex: 400,
  }

  isActive(): boolean {
    return handPointerAtom.get().visible
  }

  getOverlays(): TLHandPointerOverlay[] {
    const { x, y, pinching } = handPointerAtom.get()
    return [
      {
        id: 'hand-pointer:tip',
        type: 'hand-pointer',
        props: { x, y, pinching },
      },
    ]
  }

  render(ctx: CanvasRenderingContext2D, overlays: TLHandPointerOverlay[]): void {
    for (const overlay of overlays) {
      const { x, y, pinching } = overlay.props
      drawPointer(ctx, x, y, pinching, POINTER_RADIUS, POINTER_PINCH_RADIUS)
    }
  }

  renderMinimap(
    ctx: CanvasRenderingContext2D,
    overlays: TLHandPointerOverlay[],
    zoom: number
  ): void {
    // Convert our desired pixel radius into page units so the dot is a
    // consistent pixel size on screen regardless of zoom.
    const r = MINIMAP_RADIUS / zoom

    for (const overlay of overlays) {
      const { x, y, pinching } = overlay.props
      drawPointer(ctx, x, y, pinching, r, r * 0.67)
    }
  }
}

/**
 * Draw a single pointer indicator at (x, y) in the current context space.
 *
 * States:
 *  - Pointing (not pinching): hollow ring with a small centre dot –
 *    indicates the finger is hovering but not "pressing".
 *  - Pinching: solid filled circle – indicates a click / drag is active.
 */
function drawPointer(
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
    // Filled dot — active / pressed state
    const r = pinchingRadius
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(233, 69, 96, 0.85)'
    ctx.fill()
    // Thin white ring for contrast
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = Math.max(1, r * 0.12)
    ctx.stroke()
  } else {
    // Hollow ring — hovering / pointing state
    const r = pointingRadius
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(233, 69, 96, 0.9)'
    ctx.lineWidth = Math.max(1, r * 0.15)
    ctx.stroke()
    // Small filled centre dot
    ctx.beginPath()
    ctx.arc(x, y, Math.max(1, r * 0.18), 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(233, 69, 96, 0.9)'
    ctx.fill()
  }

  ctx.restore()
}

// ---------------------------------------------------------------------------
// HandTrackingController – inner component that runs inside the Tldraw tree
// so it can call useEditor().
// ---------------------------------------------------------------------------

interface HandTrackingControllerProps {
  containerRef: React.RefObject<HTMLDivElement | null>
}

function HandTrackingController({ containerRef }: HandTrackingControllerProps) {
  const editor = useEditor()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const isPinchedRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    // Tell tldraw to use wider coarse-pointer hit areas, which suits the
    // imprecision of hand tracking (same heuristic as touch/stylus devices).
    tlenvReactive.set({ ...tlenvReactive.get(), isCoarsePointer: true })

    let cancelled = false

    async function init() {
      try {
        // 1. Resolve the MediaPipe WASM fileset from jsDelivr CDN.
        //    This avoids copying WASM files into /public.
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
        )

        // 2. Create the HandLandmarker for live video.
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

        // 3. Request webcam access.
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

        // 4. Run inference on every animation frame.
        let lastTs = -1
        function detect() {
          if (cancelled) return
          const now = performance.now()
          // MediaPipe requires strictly increasing timestamps.
          if (now <= lastTs) {
            rafRef.current = requestAnimationFrame(detect)
            return
          }
          lastTs = now

          const result: HandLandmarkerResult = landmarkerRef.current!.detectForVideo(video, now)
          processResult(result)
          rafRef.current = requestAnimationFrame(detect)
        }
        rafRef.current = requestAnimationFrame(detect)
      } catch (e) {
        if (!cancelled) {
          console.error('[HandTracking] init error:', e)
          setErrorMsg(String(e))
          setStatus('error')
        }
      }
    }

    init()

    return () => {
      cancelled = true
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (landmarkerRef.current) {
        landmarkerRef.current.close()
        landmarkerRef.current = null
      }
      const video = videoRef.current
      if (video?.srcObject) {
        ;(video.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
        video.srcObject = null
      }
      handPointerAtom.set({ visible: false, x: 0, y: 0, pinching: false })
      tlenvReactive.set({ ...tlenvReactive.get(), isCoarsePointer: false })
    }
    // editor is stable for the component lifetime; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Translate a HandLandmarkerResult into tldraw pointer events and update
   * the handPointerAtom so the PointerOverlayUtil can render the cursor.
   */
  function processResult(result: HandLandmarkerResult) {
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const W = rect.width
    const H = rect.height

    // Find the user's right hand.  MediaPipe's "Right"/"Left" labels are from
    // the model's (camera's) perspective.  Because we display the feed mirrored
    // (CSS scaleX(-1)), the model's "Right" == the user's right hand on-screen.
    let rightHandIdx = -1
    for (let i = 0; i < result.handedness.length; i++) {
      if (result.handedness[i].some((c) => c.categoryName === 'Right')) {
        rightHandIdx = i
        break
      }
    }

    if (rightHandIdx === -1) {
      // No right hand detected – hide overlay and cancel any active pinch drag.
      handPointerAtom.set({ visible: false, x: 0, y: 0, pinching: false })
      if (isPinchedRef.current) {
        isPinchedRef.current = false
        dispatchPointerEvent(editor, {
          name: 'pointer_up',
          point: editor.inputs.currentPagePoint,
        })
      }
      return
    }

    const landmarks = result.landmarks[rightHandIdx]
    const indexTip = landmarks[INDEX_TIP]
    const thumbTip = landmarks[THUMB_TIP]

    // Mirror x so the on-screen pointer matches the mirrored video preview.
    const screenX = (1 - indexTip.x) * W
    const screenY = indexTip.y * H

    // Euclidean distance in normalised [0,1] space.
    const dx = indexTip.x - thumbTip.x
    const dy = indexTip.y - thumbTip.y
    const pinching = Math.sqrt(dx * dx + dy * dy) < PINCH_THRESHOLD

    const point = { x: screenX, y: screenY }

    // Convert screen-space → page-space for the overlay util.
    const pagePoint = editor.screenToPage(point)
    handPointerAtom.set({ visible: true, x: pagePoint.x, y: pagePoint.y, pinching })

    // Always send a move event so the cursor tracks the finger tip.
    dispatchPointerEvent(editor, { name: 'pointer_move', point })

    // Transition pinch state.
    if (pinching && !isPinchedRef.current) {
      isPinchedRef.current = true
      dispatchPointerEvent(editor, { name: 'pointer_down', point })
    } else if (!pinching && isPinchedRef.current) {
      isPinchedRef.current = false
      dispatchPointerEvent(editor, { name: 'pointer_up', point })
    }
  }

  return (
    <>
      {/* Camera preview – small mirrored window in the bottom-right corner */}
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          width: 200,
          height: 150,
          borderRadius: 8,
          overflow: 'hidden',
          border: '2px solid #e94560',
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

        {/* Video element – always mounted so the ref is valid. Hidden until ready. */}
        <video
          ref={videoRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            // Mirror so it looks like a selfie camera to the user.
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
        {status === 'ready' && '✋ Hand tracking active · Pinch to draw'}
        {status === 'error' && '⚠ Hand tracking unavailable'}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

// Include all default overlays plus our custom hand-pointer overlay.
const overlayUtils = [...defaultOverlayUtils, PointerOverlayUtil] as const

export default function HandTrackingPage() {
  const containerRef = useRef<HTMLDivElement | null>(null)

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw store={store} overlayUtils={overlayUtils}>
        <HandTrackingController containerRef={containerRef} />
      </Tldraw>
    </div>
  )
}
