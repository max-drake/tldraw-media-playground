/**
 * BlinkToClickPage – uses MediaPipe FaceMesh to detect blinks and winks and
 * fire pointer events at the current mouse-cursor position on a tldraw canvas.
 *
 * Behaviour (no gaze / eye tracking – the mouse cursor positions clicks):
 *  • Both eyes close simultaneously (blink)  → left-click  at cursor position
 *  • Only right eye closes (right wink)       → right-click at cursor position
 *  • Only left eye closes (left wink)         → right-click at cursor position
 *
 * Blink detection uses the Eye Aspect Ratio (EAR) computed from MediaPipe
 * face-mesh landmarks.  When EAR drops below EAR_THRESHOLD for at least
 * MIN_CLOSED_FRAMES, a blink/wink is registered on the next frame where the
 * eye(s) re-open.
 *
 * A small webcam preview is shown in the bottom-right corner so users can
 * see themselves and confirm the camera is working.  The eye-closed state is
 * shown via a status badge.
 */

import { useEffect, useRef, useState } from 'react'
import {
  Tldraw,
  useEditor,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
} from 'tldraw'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Eye Aspect Ratio threshold – below this the eye is considered closed */
const EAR_THRESHOLD = 0.21
/** Minimum consecutive closed frames before registering a blink/wink */
const MIN_CLOSED_FRAMES = 2
/** Minimum milliseconds between clicks (prevents double-fire) */
const CLICK_COOLDOWN_MS = 500

// ─── MediaPipe face_mesh landmark indices for left/right eye ─────────────────
// Right eye (from model / camera perspective = user's left eye on screen when mirrored)
const RIGHT_EYE_INDICES = [33, 160, 158, 133, 153, 144]
// Left eye (from model / camera perspective = user's right eye on screen when mirrored)
const LEFT_EYE_INDICES = [362, 385, 387, 263, 373, 380]

// ─── Persistent tldraw store ─────────────────────────────────────────────────

const store = createTLStore({
  shapeUtils: [...defaultShapeUtils],
  bindingUtils: [...defaultBindingUtils],
})

// ─── Eye Aspect Ratio ────────────────────────────────────────────────────────

/**
 * Compute the Eye Aspect Ratio (EAR) for a set of 6 landmark points.
 *
 * Indices in the 6-element array:
 *   0 = outer corner  (p1)
 *   1 = upper-outer   (p2)
 *   2 = upper-inner   (p3)
 *   3 = inner corner  (p4)
 *   4 = lower-inner   (p5)
 *   5 = lower-outer   (p6)
 *
 * EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
 */
function computeEAR(
  landmarks: { x: number; y: number; z: number }[],
  indices: number[],
): number {
  const p = indices.map((i) => landmarks[i])
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)

  const vertical1 = dist(p[1], p[5])
  const vertical2 = dist(p[2], p[4])
  const horizontal = dist(p[0], p[3])

  if (horizontal < 1e-6) return 0
  return (vertical1 + vertical2) / (2 * horizontal)
}

// ─── MediaPipe FaceMesh type stubs ───────────────────────────────────────────

interface FaceMeshInstance {
  setOptions(options: {
    maxNumFaces?: number
    refineLandmarks?: boolean
    minDetectionConfidence?: number
    minTrackingConfidence?: number
  }): void
  onResults(callback: (results: FaceMeshResults) => void): void
  send(inputs: { image: HTMLVideoElement }): Promise<void>
  close(): void
}

interface FaceMeshResults {
  multiFaceLandmarks: { x: number; y: number; z: number }[][] | null
}

// ─── MediaPipe FaceMesh script loader ────────────────────────────────────────

function loadFaceMeshScript(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const win = window as unknown as Record<string, unknown>
    if (win['FaceMesh']) {
      resolve()
      return
    }
    const existing = document.querySelector(
      'script[src*="face_mesh"]',
    ) as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () =>
        reject(new Error('Failed to load MediaPipe FaceMesh CDN script')),
      )
      return
    }
    const script = document.createElement('script')
    script.src =
      'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/face_mesh.min.js'
    script.crossOrigin = 'anonymous'
    script.onload = () => resolve()
    script.onerror = () =>
      reject(
        new Error(
          'Failed to load MediaPipe FaceMesh CDN script. Check your internet connection.',
        ),
      )
    document.head.appendChild(script)
  })
}

// ─── BlinkController – inner component (must be inside <Tldraw>) ─────────────

interface BlinkControllerProps {
  containerRef: React.RefObject<HTMLDivElement | null>
}

type StatusType = 'loading' | 'ready' | 'error'

function BlinkController({ containerRef }: BlinkControllerProps) {
  const editor = useEditor()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const [status, setStatus] = useState<StatusType>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [eyeState, setEyeState] = useState<'open' | 'blink' | 'wink-right' | 'wink-left'>('open')

  // Mutable refs for blink detection state (avoid re-renders in the hot path)
  const rightClosedFramesRef = useRef(0)
  const leftClosedFramesRef = useRef(0)
  const rightWasClosedRef = useRef(false)
  const leftWasClosedRef = useRef(false)
  const lastClickTimeRef = useRef(0)

  // Current mouse cursor position in screen (container-relative) coords
  const cursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  // Track mouse position within the container
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    function onMouseMove(e: MouseEvent) {
      const rect = container!.getBoundingClientRect()
      cursorRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      }
    }
    container.addEventListener('mousemove', onMouseMove)
    return () => container.removeEventListener('mousemove', onMouseMove)
  }, [containerRef])

  // Stable ref so processResults can call fireClick without stale closure
  const editorRef = useRef(editor)
  editorRef.current = editor

  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        await loadFaceMeshScript()
        if (cancelled) return

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        const video = videoRef.current!
        video.srcObject = stream
        await new Promise<void>((res) => {
          video.onloadeddata = () => res()
        })
        await video.play()
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        const win = window as unknown as Record<string, unknown>
        const FaceMeshCtor = win['FaceMesh'] as new (options: {
          locateFile: (f: string) => string
        }) => FaceMeshInstance

        const faceMesh = new FaceMeshCtor({
          locateFile: (f: string) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${f}`,
        })

        faceMesh.setOptions({
          maxNumFaces: 1,
          refineLandmarks: true,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        })

        faceMesh.onResults((results: FaceMeshResults) => {
          if (cancelled) return
          processResults(results)
        })

        setStatus('ready')

        async function detect() {
          if (cancelled) return
          await faceMesh.send({ image: video })
          rafRef.current = requestAnimationFrame(detect)
        }
        rafRef.current = requestAnimationFrame(detect)
      } catch (e) {
        if (!cancelled) {
          console.error('[BlinkToClick] init error:', e)
          setErrorMsg(String(e))
          setStatus('error')
        }
      }
    }

    init()

    return () => {
      cancelled = true
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      const video = videoRef.current
      if (video?.srcObject) {
        ;(video.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
        video.srcObject = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function processResults(results: FaceMeshResults) {
    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      rightClosedFramesRef.current = 0
      leftClosedFramesRef.current = 0
      rightWasClosedRef.current = false
      leftWasClosedRef.current = false
      setEyeState('open')
      return
    }

    const landmarks = results.multiFaceLandmarks[0]
    const rightEAR = computeEAR(landmarks, RIGHT_EYE_INDICES)
    const leftEAR = computeEAR(landmarks, LEFT_EYE_INDICES)

    const rightClosed = rightEAR < EAR_THRESHOLD
    const leftClosed = leftEAR < EAR_THRESHOLD

    rightClosedFramesRef.current = rightClosed ? rightClosedFramesRef.current + 1 : 0
    leftClosedFramesRef.current = leftClosed ? leftClosedFramesRef.current + 1 : 0

    const rightSufficient = rightClosedFramesRef.current >= MIN_CLOSED_FRAMES
    const leftSufficient = leftClosedFramesRef.current >= MIN_CLOSED_FRAMES

    // Update visual indicator
    if (rightSufficient && leftSufficient) {
      setEyeState('blink')
    } else if (rightSufficient) {
      setEyeState('wink-right')
    } else if (leftSufficient) {
      setEyeState('wink-left')
    } else {
      setEyeState('open')
    }

    const now = performance.now()
    const cooldownOk = now - lastClickTimeRef.current > CLICK_COOLDOWN_MS

    if (cooldownOk) {
      if (rightSufficient && leftSufficient && !rightWasClosedRef.current && !leftWasClosedRef.current) {
        // Both eyes closed → left-click (blink)
        fireClick('left')
        lastClickTimeRef.current = now
      } else if (rightSufficient && !leftSufficient && !rightWasClosedRef.current) {
        // Only right eye closed → right-click (wink)
        fireClick('right')
        lastClickTimeRef.current = now
      } else if (leftSufficient && !rightSufficient && !leftWasClosedRef.current) {
        // Only left eye closed → right-click (wink)
        fireClick('right')
        lastClickTimeRef.current = now
      }
    }

    rightWasClosedRef.current = rightSufficient
    leftWasClosedRef.current = leftSufficient
  }

  function fireClick(button: 'left' | 'right') {
    const { x, y } = cursorRef.current
    const point = { x, y }
    const btn = button === 'left' ? 0 : 2

    editorRef.current.dispatch({
      type: 'pointer',
      name: 'pointer_down',
      target: 'canvas',
      button: btn,
      isPen: false,
      pointerId: 1,
      point,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      accelKey: false,
    })

    setTimeout(() => {
      editorRef.current.dispatch({
        type: 'pointer',
        name: 'pointer_up',
        target: 'canvas',
        button: btn,
        isPen: false,
        pointerId: 1,
        point,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        accelKey: false,
      })
    }, 60)
  }

  const eyeBadge =
    eyeState === 'blink'
      ? { icon: '😑', label: 'Blink → left-click!', color: '#7fff7f' }
      : eyeState === 'wink-right'
        ? { icon: '😉', label: 'Right wink → right-click!', color: '#ffd93d' }
        : eyeState === 'wink-left'
          ? { icon: '😉', label: 'Left wink → right-click!', color: '#ffd93d' }
          : { icon: '👁️', label: 'Watching for blinks…', color: '#aaa' }

  return (
    <>
      {/* Camera preview – small mirrored window bottom-right */}
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          width: 200,
          height: 150,
          borderRadius: 8,
          overflow: 'hidden',
          border: `2px solid ${status === 'ready' ? '#50b4ff' : '#555'}`,
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
            Loading blink detector…
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
          color: status === 'ready' ? eyeBadge.color : status === 'error' ? '#f55' : '#aaa',
          fontSize: 11,
          borderRadius: 6,
          padding: '4px 10px',
          zIndex: 500,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {status === 'loading' && '⏳ Initialising…'}
        {status === 'error' && `⚠ ${errorMsg || 'Blink detection unavailable'}`}
        {status === 'ready' && `${eyeBadge.icon} ${eyeBadge.label}`}
      </div>

      {/* Instructions banner at the top */}
      {status === 'ready' && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.65)',
            color: '#ddd',
            fontSize: 12,
            borderRadius: 8,
            padding: '6px 16px',
            zIndex: 500,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          😑 Blink (both eyes) → left-click at cursor &nbsp;·&nbsp; 😉 Wink (one eye) → right-click at cursor
        </div>
      )}
    </>
  )
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function BlinkToClickPage() {
  const containerRef = useRef<HTMLDivElement | null>(null)

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw store={store}>
        <BlinkController containerRef={containerRef} />
      </Tldraw>
    </div>
  )
}
