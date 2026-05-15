/**
 * EyeTrackingPage – uses Peekr (MIT-licensed ONNX eye-tracking library) to
 * track where the user is looking and use it as a coarse cursor on a tldraw
 * canvas.
 *
 * Architecture
 * ────────────
 * • Peekr requires the @mediapipe/face_mesh CDN script to be loaded as a
 *   global (window.FaceMesh). We inject it with a <script> tag on mount.
 * • Gaze coordinates come in raw [~0, 1] form. A 5-dot calibration step maps
 *   them to screen-pixel coordinates via a simple linear transform.
 * • An exponential-moving-average filter smooths the jittery raw signal.
 * • "Clicking" is implemented as dwell-to-click: when the gaze stays within
 *   DWELL_RADIUS pixels for DWELL_MS milliseconds, a click fires. A
 *   shrinking arc gives the user visual countdown feedback.
 * • A PointerOverlayUtil (same pattern as HandTrackingPage) renders the
 *   cursor ring + dwell-arc on top of the tldraw canvas.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
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
import type { TLOverlay } from 'tldraw'
import { dispatchPointerEvent } from '../utils/pointerEvents'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Pixels: gaze must stay within this radius from its initial dwell point */
const DWELL_RADIUS = 60
/** Milliseconds: how long gaze must dwell before a click fires */
const DWELL_MS = 900
/** Minimum ms between consecutive clicks (prevents double-fire) */
const CLICK_COOLDOWN_MS = 600
/** EMA smoothing factor (higher = more smoothing, slower response) */
const SMOOTH_ALPHA = 0.7
/** How many calibration dots to show */
const CALIB_DOT_COUNT = 5
/** How long each calibration dot is held (ms) */
const CALIB_DOT_HOLD_MS = 1500

// ─── Persistent tldraw store ─────────────────────────────────────────────────

const store = createTLStore({
  shapeUtils: [...defaultShapeUtils],
  bindingUtils: [...defaultBindingUtils],
})

// ─── Shared reactive atom ─────────────────────────────────────────────────────

interface EyePointerState {
  visible: boolean
  x: number
  y: number
  dwellProgress: number
  dwelling: boolean
}

const eyePointerAtom = atom<EyePointerState>('eyePointer', {
  visible: false,
  x: 0,
  y: 0,
  dwellProgress: 0,
  dwelling: false,
})

// ─── Overlay type ─────────────────────────────────────────────────────────────

interface TLEyePointerOverlay extends TLOverlay {
  type: 'eye-pointer'
  props: {
    x: number
    y: number
    dwellProgress: number
    dwelling: boolean
  }
}

// ─── Drawing helper ───────────────────────────────────────────────────────────

const POINTER_RADIUS = 22
const MINIMAP_RADIUS = 6

function drawEyePointer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dwellProgress: number,
  dwelling: boolean,
  radius: number,
): void {
  ctx.save()

  // Outer ring
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(80, 180, 255, 0.85)'
  ctx.lineWidth = Math.max(1, radius * 0.14)
  ctx.stroke()

  // Small centre dot
  ctx.beginPath()
  ctx.arc(x, y, Math.max(1, radius * 0.2), 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(80, 180, 255, 0.9)'
  ctx.fill()

  // Dwell progress arc (sweeps clockwise from top)
  if (dwelling && dwellProgress > 0) {
    const startAngle = -Math.PI / 2
    const endAngle = startAngle + dwellProgress * Math.PI * 2
    ctx.beginPath()
    ctx.arc(x, y, radius * 1.25, startAngle, endAngle)
    ctx.strokeStyle = 'rgba(255, 210, 60, 0.95)'
    ctx.lineWidth = Math.max(2, radius * 0.22)
    ctx.lineCap = 'round'
    ctx.stroke()
  }

  ctx.restore()
}

// ─── OverlayUtil ──────────────────────────────────────────────────────────────

export class EyePointerOverlayUtil extends OverlayUtil<TLEyePointerOverlay> {
  static override type = 'eye-pointer' as const

  options = { zIndex: 400 }

  isActive(): boolean {
    return eyePointerAtom.get().visible
  }

  getOverlays(): TLEyePointerOverlay[] {
    const { x, y, dwellProgress, dwelling } = eyePointerAtom.get()
    return [
      {
        id: 'eye-pointer:cursor',
        type: 'eye-pointer',
        props: { x, y, dwellProgress, dwelling },
      },
    ]
  }

  render(ctx: CanvasRenderingContext2D, overlays: TLEyePointerOverlay[]): void {
    for (const ov of overlays) {
      const { x, y, dwellProgress, dwelling } = ov.props
      drawEyePointer(ctx, x, y, dwellProgress, dwelling, POINTER_RADIUS)
    }
  }

  renderMinimap(
    ctx: CanvasRenderingContext2D,
    overlays: TLEyePointerOverlay[],
    zoom: number,
  ): void {
    const r = MINIMAP_RADIUS / zoom
    for (const ov of overlays) {
      const { x, y, dwellProgress, dwelling } = ov.props
      drawEyePointer(ctx, x, y, dwellProgress, dwelling, r)
    }
  }
}

// ─── Calibration transform ────────────────────────────────────────────────────

interface CalibTransform {
  xSlope: number
  xIntercept: number
  ySlope: number
  yIntercept: number
}

function rawGazeToScreen(
  rawX: number,
  rawY: number,
  calib: CalibTransform,
  containerW: number,
  containerH: number,
): { sx: number; sy: number } {
  const sx = Math.max(0, Math.min(containerW, calib.xSlope * rawX + calib.xIntercept))
  const sy = Math.max(0, Math.min(containerH, calib.ySlope * rawY + calib.yIntercept))
  return { sx, sy }
}

function computeCalibTransform(
  rawSamples: { x: number; y: number }[],
  screenTargets: { x: number; y: number }[],
): CalibTransform {
  const n = rawSamples.length
  if (n < 2) {
    return { xSlope: window.screen.width, xIntercept: 0, ySlope: window.screen.height, yIntercept: 0 }
  }

  function leastSquares(xs: number[], ys: number[]) {
    const sumX = xs.reduce((a, b) => a + b, 0)
    const sumY = ys.reduce((a, b) => a + b, 0)
    const sumXX = xs.reduce((a, b) => a + b * b, 0)
    const sumXY = xs.map((x, i) => x * ys[i]).reduce((a, b) => a + b, 0)
    const denom = n * sumXX - sumX * sumX
    if (Math.abs(denom) < 1e-9) return { slope: window.screen.width, intercept: 0 }
    const slope = (n * sumXY - sumX * sumY) / denom
    const intercept = (sumY - slope * sumX) / n
    return { slope, intercept }
  }

  const { slope: xSlope, intercept: xIntercept } = leastSquares(
    rawSamples.map((s) => s.x),
    screenTargets.map((t) => t.x),
  )
  const { slope: ySlope, intercept: yIntercept } = leastSquares(
    rawSamples.map((s) => s.y),
    screenTargets.map((t) => t.y),
  )
  return { xSlope, xIntercept, ySlope, yIntercept }
}

// 5-dot calibration positions (normalised [0,1] of container): 4 corners + center
const CALIB_POSITIONS: { px: number; py: number }[] = [
  { px: 0.1, py: 0.1 },
  { px: 0.9, py: 0.1 },
  { px: 0.5, py: 0.5 },
  { px: 0.1, py: 0.9 },
  { px: 0.9, py: 0.9 },
]

// ─── CalibrationOverlay (DOM layer) ──────────────────────────────────────────

interface CalibrationOverlayProps {
  containerRef: React.RefObject<HTMLDivElement | null>
  onComplete: (transform: CalibTransform) => void
  onCancel: () => void
  latestGaze: React.MutableRefObject<{ x: number; y: number } | null>
}

function CalibrationOverlay({
  containerRef,
  onComplete,
  onCancel,
  latestGaze,
}: CalibrationOverlayProps) {
  const [dotIndex, setDotIndex] = useState(0)
  const [phase, setPhase] = useState<'waiting' | 'collecting' | 'done'>('waiting')
  const [holdProgress, setHoldProgress] = useState(0)
  const samplesRef = useRef<{ x: number; y: number }[][]>(
    Array.from({ length: CALIB_DOT_COUNT }, () => []),
  )
  const rafRef = useRef<number | null>(null)
  const dotIndexRef = useRef(dotIndex)
  dotIndexRef.current = dotIndex

  const startCollecting = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    setPhase('collecting')
    const startTime = performance.now()
    const idx = dotIndexRef.current

    function tick() {
      const elapsed = performance.now() - startTime
      const progress = Math.min(1, elapsed / CALIB_DOT_HOLD_MS)
      setHoldProgress(progress)

      const g = latestGaze.current
      if (g) samplesRef.current[idx].push({ x: g.x, y: g.y })

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        if (idx + 1 < CALIB_DOT_COUNT) {
          setDotIndex(idx + 1)
          setPhase('waiting')
          setHoldProgress(0)
        } else {
          setPhase('done')
          const container = containerRef.current
          if (!container) { onCancel(); return }
          const rect = container.getBoundingClientRect()
          const rawSamplesArr: { x: number; y: number }[] = []
          const screenTargetsArr: { x: number; y: number }[] = []
          CALIB_POSITIONS.forEach((pos, i) => {
            const dots = samplesRef.current[i]
            if (dots.length > 0) {
              rawSamplesArr.push({
                x: dots.reduce((a, b) => a + b.x, 0) / dots.length,
                y: dots.reduce((a, b) => a + b.y, 0) / dots.length,
              })
              screenTargetsArr.push({ x: pos.px * rect.width, y: pos.py * rect.height })
            }
          })
          const transform = computeCalibTransform(rawSamplesArr, screenTargetsArr)
          setTimeout(() => onComplete(transform), 300)
        }
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [containerRef, latestGaze, onCancel, onComplete])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const container = containerRef.current
  const rect = container?.getBoundingClientRect()
  const W = rect?.width ?? window.innerWidth
  const H = rect?.height ?? window.innerHeight

  const pos = CALIB_POSITIONS[dotIndex]
  const dotX = pos.px * W
  const dotY = pos.py * H
  const dotRadius = 20
  const circumference = 2 * Math.PI * dotRadius
  const dashoffset = circumference * (1 - holdProgress)

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.8)',
        zIndex: 600,
        color: '#fff',
      }}
    >
      {/* Instructions */}
      <div
        style={{
          position: 'absolute',
          top: 24,
          left: 0,
          right: 0,
          textAlign: 'center',
          pointerEvents: 'none',
        }}
      >
        <p style={{ fontSize: 18, margin: 0, fontWeight: 600 }}>
          👁️ Eye Tracking Calibration
        </p>
        <p style={{ fontSize: 14, opacity: 0.8, margin: '6px 0 0' }}>
          {phase === 'waiting'
            ? `Look at the dot, then click it  (${dotIndex + 1} / ${CALIB_DOT_COUNT})`
            : phase === 'collecting'
              ? `Keep your gaze steady…  (${dotIndex + 1} / ${CALIB_DOT_COUNT})`
              : 'Calibration complete!'}
        </p>
      </div>

      {/* Calibration dot */}
      {phase !== 'done' && (
        <div
          style={{
            position: 'absolute',
            left: dotX,
            top: dotY,
            transform: 'translate(-50%, -50%)',
            cursor: phase === 'waiting' ? 'pointer' : 'default',
            userSelect: 'none',
          }}
          onClick={phase === 'waiting' ? startCollecting : undefined}
        >
          <svg
            width={dotRadius * 3}
            height={dotRadius * 3}
            style={{ display: 'block', overflow: 'visible' }}
          >
            {phase === 'collecting' && (
              <circle
                cx={dotRadius * 1.5}
                cy={dotRadius * 1.5}
                r={dotRadius}
                fill="none"
                stroke="rgba(255,210,60,0.9)"
                strokeWidth="4"
                strokeDasharray={circumference}
                strokeDashoffset={dashoffset}
                strokeLinecap="round"
                style={{ transform: 'rotate(-90deg)', transformOrigin: '50% 50%' }}
              />
            )}
            <circle
              cx={dotRadius * 1.5}
              cy={dotRadius * 1.5}
              r={dotRadius * 0.55}
              fill={phase === 'collecting' ? 'rgba(255,210,60,0.9)' : '#50b4ff'}
            />
            <circle
              cx={dotRadius * 1.5}
              cy={dotRadius * 1.5}
              r={dotRadius * 0.2}
              fill="white"
            />
          </svg>
          {phase === 'waiting' && (
            <span
              style={{
                position: 'absolute',
                top: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                fontSize: 11,
                whiteSpace: 'nowrap',
                color: '#ccc',
                marginTop: 4,
              }}
            >
              click to lock
            </span>
          )}
        </div>
      )}

      {/* Cancel */}
      <button
        onClick={onCancel}
        style={{
          position: 'absolute',
          bottom: 24,
          right: 24,
          padding: '8px 18px',
          borderRadius: 6,
          border: '1px solid #555',
          background: '#1a1a2e',
          color: '#aaa',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        Cancel
      </button>
    </div>
  )
}

// ─── EyeTrackingController ────────────────────────────────────────────────────

type Status = 'idle' | 'loading-script' | 'loading-model' | 'calibrating' | 'ready' | 'error'

interface EyeTrackingControllerProps {
  containerRef: React.RefObject<HTMLDivElement | null>
}

function EyeTrackingController({ containerRef }: EyeTrackingControllerProps) {
  const editor = useEditor()
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const calibTransformRef = useRef<CalibTransform | null>(null)
  const latestGaze = useRef<{ x: number; y: number } | null>(null)
  const smoothedRef = useRef<{ sx: number; sy: number } | null>(null)
  const dwellStartRef = useRef<{ sx: number; sy: number; startTime: number } | null>(null)
  const lastClickTimeRef = useRef(0)
  const peekrInitRef = useRef(false)

  // Inject MediaPipe face_mesh CDN script (required by Peekr at runtime)
  useEffect(() => {
    const win = window as unknown as Record<string, unknown>
    if (win['FaceMesh']) return // already loaded
    setStatus('loading-script')
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/face_mesh.min.js'
    script.crossOrigin = 'anonymous'
    script.onload = () => setStatus('idle')
    script.onerror = () => {
      setErrorMsg('Failed to load MediaPipe CDN script. Check your internet connection.')
      setStatus('error')
    }
    document.head.appendChild(script)
  }, [])

  const handleGaze = useCallback(
    (gaze: { output: { cpuData: Float32Array } }) => {
      const rawX = gaze.output.cpuData[0]
      const rawY = gaze.output.cpuData[1]
      latestGaze.current = { x: rawX, y: rawY }

      const calib = calibTransformRef.current
      const container = containerRef.current
      if (!calib || !container) return

      const rect = container.getBoundingClientRect()
      const { sx, sy } = rawGazeToScreen(rawX, rawY, calib, rect.width, rect.height)

      // Exponential moving average smoothing
      smoothedRef.current = smoothedRef.current
        ? {
            sx: SMOOTH_ALPHA * smoothedRef.current.sx + (1 - SMOOTH_ALPHA) * sx,
            sy: SMOOTH_ALPHA * smoothedRef.current.sy + (1 - SMOOTH_ALPHA) * sy,
          }
        : { sx, sy }

      const { sx: smoothX, sy: smoothY } = smoothedRef.current
      const point = { x: smoothX, y: smoothY }
      const pagePoint = editor.screenToPage(point)

      // Dwell-to-click
      const now = performance.now()
      const cooldownOk = now - lastClickTimeRef.current > CLICK_COOLDOWN_MS

      if (!dwellStartRef.current) {
        dwellStartRef.current = { sx: smoothX, sy: smoothY, startTime: now }
      } else {
        const dx = smoothX - dwellStartRef.current.sx
        const dy = smoothY - dwellStartRef.current.sy
        const dist = Math.sqrt(dx * dx + dy * dy)

        if (dist > DWELL_RADIUS) {
          // Gaze moved – reset dwell timer
          dwellStartRef.current = { sx: smoothX, sy: smoothY, startTime: now }
        } else if (cooldownOk) {
          const progress = Math.min(1, (now - dwellStartRef.current.startTime) / DWELL_MS)

          if (progress >= 1) {
            // Dwell complete – fire a click
            lastClickTimeRef.current = now
            dwellStartRef.current = { sx: smoothX, sy: smoothY, startTime: now }
            dispatchPointerEvent(editor, { name: 'pointer_down', point })
            setTimeout(() => dispatchPointerEvent(editor, { name: 'pointer_up', point }), 80)
            eyePointerAtom.set({ visible: true, x: pagePoint.x, y: pagePoint.y, dwellProgress: 1, dwelling: false })
            return
          }

          // Actively dwelling – show progress arc
          eyePointerAtom.set({ visible: true, x: pagePoint.x, y: pagePoint.y, dwellProgress: progress, dwelling: true })
          dispatchPointerEvent(editor, { name: 'pointer_move', point })
          return
        }
      }

      // Default: move cursor, no dwell in progress
      eyePointerAtom.set({ visible: true, x: pagePoint.x, y: pagePoint.y, dwellProgress: 0, dwelling: false })
      dispatchPointerEvent(editor, { name: 'pointer_move', point })
    },
    [containerRef, editor],
  )

  const startTracking = useCallback(
    async (transform: CalibTransform) => {
      calibTransformRef.current = transform
      setStatus('loading-model')
      tlenvReactive.set({ ...tlenvReactive.get(), isCoarsePointer: true })

      try {
        const Peekr = await import('peekr')

        if (peekrInitRef.current) {
          // Already initialised — just restart
          setStatus('ready')
          Peekr.runEyeTracking()
          return
        }

        Peekr.initEyeTracking({
          onReady: () => {
            peekrInitRef.current = true
            setStatus('ready')
            Peekr.runEyeTracking()
          },
          onGaze: handleGaze,
        })
      } catch (e) {
        console.error('[EyeTracking]', e)
        setErrorMsg(String(e))
        setStatus('error')
      }
    },
    [handleGaze],
  )

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      import('peekr').then((P) => P.stopEyeTracking()).catch(() => {})
      eyePointerAtom.set({ visible: false, x: 0, y: 0, dwellProgress: 0, dwelling: false })
      tlenvReactive.set({ ...tlenvReactive.get(), isCoarsePointer: false })
    }
  }, [])

  const handleCalibComplete = useCallback(
    (transform: CalibTransform) => startTracking(transform),
    [startTracking],
  )
  const handleCalibCancel = useCallback(() => setStatus('idle'), [])
  const handleStartCalib = useCallback(() => setStatus('calibrating'), [])

  return (
    <>
      {status === 'calibrating' && (
        <CalibrationOverlay
          containerRef={containerRef}
          onComplete={handleCalibComplete}
          onCancel={handleCalibCancel}
          latestGaze={latestGaze}
        />
      )}

      {/* Small status panel bottom-right */}
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 6,
          zIndex: 500,
        }}
      >
        <div
          style={{
            background: 'rgba(0,0,0,0.65)',
            color:
              status === 'ready' ? '#7fff7f'
              : status === 'error' ? '#f55'
              : '#aaa',
            fontSize: 11,
            borderRadius: 6,
            padding: '4px 10px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {status === 'idle' && '👁️ Eye Tracking — not started'}
          {status === 'loading-script' && '⏳ Loading MediaPipe…'}
          {status === 'loading-model' && '⏳ Loading gaze model…'}
          {status === 'calibrating' && '🎯 Calibrating…'}
          {status === 'ready' && '👁️ Eye tracking active · Dwell to click'}
          {status === 'error' && `⚠ ${errorMsg || 'Eye tracking unavailable'}`}
        </div>

        {status === 'idle' && (
          <button
            onClick={handleStartCalib}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: '#50b4ff',
              color: '#000',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Start Eye Tracking
          </button>
        )}

        {status === 'ready' && (
          <button
            onClick={handleStartCalib}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid #50b4ff',
              background: 'transparent',
              color: '#50b4ff',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Re-calibrate
          </button>
        )}
      </div>

      {/* How-to hint at top when active */}
      {status === 'ready' && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.6)',
            color: '#ddd',
            fontSize: 12,
            borderRadius: 8,
            padding: '6px 16px',
            zIndex: 500,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Look at a spot and hold your gaze to click · Use toolbar on the left to pick a tool
        </div>
      )}
    </>
  )
}

// ─── Page component ───────────────────────────────────────────────────────────

const overlayUtils = [...defaultOverlayUtils, EyePointerOverlayUtil] as const

export default function EyeTrackingPage() {
  const containerRef = useRef<HTMLDivElement | null>(null)

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw store={store} overlayUtils={overlayUtils}>
        <EyeTrackingController containerRef={containerRef} />
      </Tldraw>
    </div>
  )
}
