/**
 * HandTrackingPage – uses @mediapipe/tasks-vision HandLandmarker to track
 * the right index finger tip as a coarse pointer inside a tldraw canvas.
 *
 * Behaviour:
 *  - The right index finger tip (landmark 8) drives `pointer_move` events.
 *  - Pinching index tip + thumb tip (landmarks 8 & 4, normalised distance
 *    below PINCH_THRESHOLD) fires `pointer_down`; releasing fires `pointer_up`.
 *  - Undo gestures (configurable via UI toggle):
 *      • "Thumbs-down" mode: hold thumb pointing downward (all other fingers
 *        curled) for 500 ms to fire undo; repeats every 300 ms while held.
 *      • "Scissors snip" mode: spread index+middle fingers wide (>=60°) then
 *        snap them closed (<=15°) to fire one undo per snip.
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

// Hand landmark indices (MediaPipe convention)
const INDEX_TIP = 8
const THUMB_TIP = 4
const MIDDLE_TIP = 12
const RING_TIP = 16
const PINKY_TIP = 20
const WRIST = 0
const INDEX_MCP = 5   // Index finger base knuckle
const MIDDLE_MCP = 9  // Middle finger base knuckle
const RING_MCP = 13   // Ring finger base knuckle
const PINKY_MCP = 17  // Pinky finger base knuckle

// Distance threshold (in normalised [0,1] units) to consider a pinch active.
// ~0.07 ≈ 7% of frame width, roughly the gap when fingers visually touch.
const PINCH_THRESHOLD = 0.07

// ---------------------------------------------------------------------------
// Undo gesture configuration
// ---------------------------------------------------------------------------

/** Which hand gesture should trigger undo */
export type UndoGestureMode = 'thumbs-down' | 'scissors'

// Thumbs-down: thumb tip must be this far below the wrist (normalised y).
const THUMB_DOWN_Y_MARGIN = 0.05

// Scissors: angle thresholds (degrees) between index and middle finger tips.
const SCISSORS_OPEN_DEG = 60
const SCISSORS_CLOSED_DEG = 15

// Hold duration (ms) before first undo fires in thumbs-down mode.
const THUMBS_DOWN_HOLD_MS = 500
// Repeat interval (ms) for continued thumbs-down hold.
const THUMBS_DOWN_REPEAT_MS = 300

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
  /** Currently active undo gesture for overlay feedback, or null */
  undoGesture: 'thumbs-down' | 'scissors' | null
}

const handPointerAtom = atom<HandPointerState>('handPointer', {
  visible: false,
  x: 0,
  y: 0,
  pinching: false,
  undoGesture: null,
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
    undoGesture: 'thumbs-down' | 'scissors' | null
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
    const { x, y, pinching, undoGesture } = handPointerAtom.get()
    return [
      {
        id: 'hand-pointer:tip',
        type: 'hand-pointer',
        props: { x, y, pinching, undoGesture },
      },
    ]
  }

  render(ctx: CanvasRenderingContext2D, overlays: TLHandPointerOverlay[]): void {
    for (const overlay of overlays) {
      const { x, y, pinching, undoGesture } = overlay.props
      _drawPointer(ctx, x, y, pinching, POINTER_RADIUS, POINTER_PINCH_RADIUS)
      if (undoGesture) _drawUndoIndicator(ctx, x, y, undoGesture, POINTER_RADIUS)
    }
  }

  renderMinimap(
    ctx: CanvasRenderingContext2D,
    overlays: TLHandPointerOverlay[],
    zoom: number
  ): void {
    // The context is already in page space. We convert our desired pixel radius
    // into page units so the dot is a consistent size on screen.
    const r = MINIMAP_RADIUS / zoom

    for (const overlay of overlays) {
      const { x, y, pinching, undoGesture } = overlay.props
      _drawPointer(ctx, x, y, pinching, r, r * 0.67)
      if (undoGesture) _drawUndoIndicator(ctx, x, y, undoGesture, r)
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


/**
 * Draw an undo-gesture feedback indicator on the canvas.
 * thumbs-down: orange outer ring + downward arrow (while hold is active).
 * scissors:    cyan X-mark flash (snip just fired this frame).
 */
function _drawUndoIndicator(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  gesture: 'thumbs-down' | 'scissors',
  radius: number
): void {
  ctx.save()
  const r = radius
  if (gesture === 'thumbs-down') {
    ctx.beginPath()
    ctx.arc(x, y, r * 1.5, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,165,0,0.85)'
    ctx.lineWidth = Math.max(1, r * 0.2)
    ctx.stroke()
    const ay = y + r * 2.2, ah = r * 0.5
    ctx.beginPath()
    ctx.moveTo(x, ay + ah)
    ctx.lineTo(x - ah, ay - ah * 0.5)
    ctx.lineTo(x + ah, ay - ah * 0.5)
    ctx.closePath()
    ctx.fillStyle = 'rgba(255,165,0,0.85)'
    ctx.fill()
  } else {
    const sz = r * 0.7
    ctx.strokeStyle = 'rgba(0,220,220,0.9)'
    ctx.lineWidth = Math.max(1, r * 0.2)
    ctx.beginPath(); ctx.moveTo(x - sz, y - sz); ctx.lineTo(x + sz, y + sz); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(x + sz, y - sz); ctx.lineTo(x - sz, y + sz); ctx.stroke()
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Undo gesture detection helpers (exported for unit testing)
// ---------------------------------------------------------------------------

type Landmark = { x: number; y: number; z: number }

/**
 * Returns true when landmarks show a "thumbs-down" pose:
 * - Thumb tip is below the wrist by at least THUMB_DOWN_Y_MARGIN.
 * - All four non-thumb fingers are curled (each tip.y >= its MCP.y).
 */
export function detectThumbsDown(landmarks: Landmark[]): boolean {
  const wrist = landmarks[WRIST]
  const thumbTip = landmarks[THUMB_TIP]
  if (thumbTip.y < wrist.y + THUMB_DOWN_Y_MARGIN) return false
  const pairs: [number, number][] = [
    [INDEX_TIP, INDEX_MCP],
    [MIDDLE_TIP, MIDDLE_MCP],
    [RING_TIP, RING_MCP],
    [PINKY_TIP, PINKY_MCP],
  ]
  for (const [tipIdx, mcpIdx] of pairs) {
    if (landmarks[tipIdx].y < landmarks[mcpIdx].y) return false
  }
  return true
}

/**
 * Returns the opening angle (degrees) between index and middle finger tips,
 * measured from their shared MCP midpoint base.
 *
 * >= SCISSORS_OPEN_DEG   → scissors are open
 * <= SCISSORS_CLOSED_DEG → scissors are closed (snip edge = undo trigger)
 */
export function getScissorsAngleDeg(landmarks: Landmark[]): number {
  const iT = landmarks[INDEX_TIP], mT = landmarks[MIDDLE_TIP]
  const iM = landmarks[INDEX_MCP], mM = landmarks[MIDDLE_MCP]
  const bx = (iM.x + mM.x) / 2, by = (iM.y + mM.y) / 2
  const ax = iT.x - bx, ay = iT.y - by
  const cx = mT.x - bx, cy = mT.y - by
  const dot = ax * cx + ay * cy
  const magA = Math.sqrt(ax * ax + ay * ay)
  const magC = Math.sqrt(cx * cx + cy * cy)
  if (magA < 1e-6 || magC < 1e-6) return 0
  return (Math.acos(Math.max(-1, Math.min(1, dot / (magA * magC)))) * 180) / Math.PI
}

// ---------------------------------------------------------------------------
// HandTrackingController – inner component that runs inside the Tldraw tree
// so it can call useEditor().
// ---------------------------------------------------------------------------

interface HandTrackingControllerProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  /** Which gesture mode triggers undo */
  undoGestureMode: UndoGestureMode
}

function HandTrackingController({ containerRef, undoGestureMode }: HandTrackingControllerProps) {
  const editor = useEditor()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const isPinchedRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  // Undo gesture refs
  const undoGestureModeRef = useRef<UndoGestureMode>(undoGestureMode)
  useEffect(() => { undoGestureModeRef.current = undoGestureMode }, [undoGestureMode])
  const thumbsDownStartRef = useRef<number | null>(null)
  const thumbsDownLastFireRef = useRef<number | null>(null)
  const scissorsWasOpenRef = useRef<boolean>(false)

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
      // Hide the overlay pointer when the controller unmounts
      handPointerAtom.set({ visible: false, x: 0, y: 0, pinching: false, undoGesture: null })
      // Restore default pointer environment
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
      handPointerAtom.set({ visible: false, x: 0, y: 0, pinching: false, undoGesture: null })
      thumbsDownStartRef.current = null
      thumbsDownLastFireRef.current = null
      scissorsWasOpenRef.current = false
      if (isPinchedRef.current) {
        isPinchedRef.current = false
        editor.dispatch({
          type: 'pointer',
          name: 'pointer_up',
          target: 'canvas',
          button: 0,
          isPen: false,
          pointerId: 1,
          point: editor.inputs.currentPagePoint,
          shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
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
    const dist = Math.sqrt(dx * dx + dy * dy)
    const pinching = dist < PINCH_THRESHOLD

    const point = { x: screenX, y: screenY }

    // ---- Undo gesture detection ----
    const now = performance.now()
    let undoGesture: 'thumbs-down' | 'scissors' | null = null

    if (undoGestureModeRef.current === 'thumbs-down') {
      const isThumbsDown = detectThumbsDown(landmarks)
      if (isThumbsDown) {
        if (thumbsDownStartRef.current === null) {
          thumbsDownStartRef.current = now
          thumbsDownLastFireRef.current = null
        }
        const held = now - thumbsDownStartRef.current
        if (held >= THUMBS_DOWN_HOLD_MS) {
          const lastFire = thumbsDownLastFireRef.current
          if (lastFire === null || now - lastFire >= THUMBS_DOWN_REPEAT_MS) {
            editor.undo()
            thumbsDownLastFireRef.current = now
          }
        }
        undoGesture = 'thumbs-down'
      } else {
        thumbsDownStartRef.current = null
        thumbsDownLastFireRef.current = null
      }
    } else if (undoGestureModeRef.current === 'scissors') {
      const angleDeg = getScissorsAngleDeg(landmarks)
      const isOpen = angleDeg >= SCISSORS_OPEN_DEG
      const isClosed = angleDeg <= SCISSORS_CLOSED_DEG
      if (isClosed && scissorsWasOpenRef.current) {
        editor.undo()
        undoGesture = 'scissors'
      }
      scissorsWasOpenRef.current = isOpen
    }

    // Convert screen-space → page-space for the overlay util.
    const pagePoint = editor.screenToPage(point)
    handPointerAtom.set({
      visible: true,
      x: pagePoint.x,
      y: pagePoint.y,
      pinching,
      undoGesture,
    })

    // Always send a move event so the cursor tracks the finger tip.
    editor.dispatch({
      type: 'pointer',
      name: 'pointer_move',
      target: 'canvas',
      button: 0,
      isPen: false,
      pointerId: 1,
      point,
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
    })

    // Transition pinch state.
    if (pinching && !isPinchedRef.current) {
      isPinchedRef.current = true
      editor.dispatch({
        type: 'pointer',
        name: 'pointer_down',
        target: 'canvas',
        button: 0,
        isPen: false,
        pointerId: 1,
        point,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
      })
    } else if (!pinching && isPinchedRef.current) {
      isPinchedRef.current = false
      editor.dispatch({
        type: 'pointer',
        name: 'pointer_up',
        target: 'canvas',
        button: 0,
        isPen: false,
        pointerId: 1,
        point,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
      })
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
  const [undoGestureMode, setUndoGestureMode] = useState<UndoGestureMode>('thumbs-down')

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw store={store} overlayUtils={overlayUtils}>
        <HandTrackingController
          containerRef={containerRef}
          undoGestureMode={undoGestureMode}
        />
      </Tldraw>

      {/* Undo gesture mode toggle – bottom-left corner */}
      <div style={{ position: 'absolute', bottom: 16, left: 16, zIndex: 500, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ background: 'rgba(0,0,0,0.65)', color: '#ccc', fontSize: 11, borderRadius: 6, padding: '4px 10px', pointerEvents: 'none' }}>
          Undo gesture
        </div>
        <button
          onClick={() => setUndoGestureMode('thumbs-down')}
          title="Hold thumb pointing DOWN (all other fingers curled) for 0.5 s to undo. Repeats every 0.3 s while held."
          style={{
            background: undoGestureMode === 'thumbs-down' ? 'rgba(255,165,0,0.85)' : 'rgba(0,0,0,0.65)',
            color: undoGestureMode === 'thumbs-down' ? '#000' : '#ccc',
            border: '1.5px solid rgba(255,165,0,0.7)',
            borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer',
            fontWeight: undoGestureMode === 'thumbs-down' ? 700 : 400, whiteSpace: 'nowrap',
          }}
        >
          👎 Thumbs-down undo
        </button>
        <button
          onClick={() => setUndoGestureMode('scissors')}
          title="Spread index and middle fingers wide (≥60°), then snap them shut (≤15°) to undo. Each snip = one undo."
          style={{
            background: undoGestureMode === 'scissors' ? 'rgba(0,220,220,0.85)' : 'rgba(0,0,0,0.65)',
            color: undoGestureMode === 'scissors' ? '#000' : '#ccc',
            border: '1.5px solid rgba(0,220,220,0.7)',
            borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer',
            fontWeight: undoGestureMode === 'scissors' ? 700 : 400, whiteSpace: 'nowrap',
          }}
        >
          ✂️ Scissors snip undo
        </button>
        <div style={{ background: 'rgba(0,0,0,0.5)', color: '#999', fontSize: 10, borderRadius: 5, padding: '3px 8px', pointerEvents: 'none', maxWidth: 190, lineHeight: 1.4 }}>
          {undoGestureMode === 'thumbs-down'
            ? '👎 Point thumb DOWN, all fingers curled. Hold 0.5 s to undo. Repeats every 0.3 s.'
            : '✂️ Spread index + middle wide, then snap shut to snip-undo.'}
        </div>
      </div>
    </div>
  )
}
