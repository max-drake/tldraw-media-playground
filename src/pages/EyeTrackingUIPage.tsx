/**
 * EyeTrackingUIPage – uses eye tracking to navigate tldraw's UI elements.
 *
 * Unlike EyeTrackingPage (which uses gaze as a canvas cursor), this demo
 * uses gaze ONLY to highlight and activate UI controls (toolbar buttons,
 * menu items, panels, etc.). The canvas itself is not interacted with.
 *
 * Architecture
 * ────────────
 * • Same Peekr + MediaPipe setup as EyeTrackingPage.
 * • A fixed-position gaze cursor div follows the raw screen-space gaze.
 * • At each gaze update we call document.elementsFromPoint and walk up the
 *   DOM to find the nearest interactive element (button, [role="button"], etc.)
 *   that is NOT part of the canvas drawing surface.
 * • That element gets a highlight outline, and a dwell countdown fires a
 *   synthetic click after DWELL_MS of stable focus.
 * • Moving gaze to a different element resets the dwell timer.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { Tldraw, createTLStore, defaultShapeUtils, defaultBindingUtils } from 'tldraw'

// ─── Constants ───────────────────────────────────────────────────────────────

const DWELL_RADIUS = 80
const DWELL_MS = 1000
const CLICK_COOLDOWN_MS = 800
const SMOOTH_ALPHA = 0.65
const CALIB_DOT_COUNT = 5
const CALIB_DOT_HOLD_MS = 1500

// ─── Persistent tldraw store ─────────────────────────────────────────────────

const store = createTLStore({
  shapeUtils: [...defaultShapeUtils],
  bindingUtils: [...defaultBindingUtils],
})

// ─── DOM helpers ─────────────────────────────────────────────────────────────

const INTERACTIVE_SELECTORS = [
  'button',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="listitem"]',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[tabindex]:not([tabindex="-1"])',
]

const CANVAS_SELECTORS = ['.tl-canvas', 'canvas', '[data-testid="canvas"]']

function isCanvasSurface(el: Element): boolean {
  for (const sel of CANVAS_SELECTORS) {
    if (el.matches(sel) || el.closest(sel)) return true
  }
  return false
}

function findNearestInteractive(x: number, y: number): Element | null {
  const els = document.elementsFromPoint(x, y)
  for (const el of els) {
    if (isCanvasSurface(el)) continue
    for (const sel of INTERACTIVE_SELECTORS) {
      if (el.matches(sel)) return el
    }
    const parent = el.parentElement
    if (parent && !isCanvasSurface(parent)) {
      for (const sel of INTERACTIVE_SELECTORS) {
        if (parent.matches(sel)) return parent
      }
    }
  }
  return null
}

// ─── Calibration ─────────────────────────────────────────────────────────────

interface CalibTransform {
  xSlope: number
  xIntercept: number
  ySlope: number
  yIntercept: number
}

const CALIB_POSITIONS: { px: number; py: number }[] = [
  { px: 0.1, py: 0.1 },
  { px: 0.9, py: 0.1 },
  { px: 0.5, py: 0.5 },
  { px: 0.1, py: 0.9 },
  { px: 0.9, py: 0.9 },
]

function computeCalibTransform(
  rawSamples: { x: number; y: number }[],
  screenTargets: { x: number; y: number }[],
): CalibTransform {
  const n = rawSamples.length
  if (n < 2) {
    return { xSlope: window.innerWidth, xIntercept: 0, ySlope: window.innerHeight, yIntercept: 0 }
  }
  function leastSquares(xs: number[], ys: number[]) {
    const sumX = xs.reduce((a, b) => a + b, 0)
    const sumY = ys.reduce((a, b) => a + b, 0)
    const sumXX = xs.reduce((a, b) => a + b * b, 0)
    const sumXY = xs.map((x, i) => x * ys[i]).reduce((a, b) => a + b, 0)
    const denom = n * sumXX - sumX * sumX
    if (Math.abs(denom) < 1e-9) return { slope: window.innerWidth, intercept: 0 }
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

function rawGazeToScreen(
  rawX: number,
  rawY: number,
  calib: CalibTransform,
): { sx: number; sy: number } {
  const sx = Math.max(0, Math.min(window.innerWidth, calib.xSlope * rawX + calib.xIntercept))
  const sy = Math.max(0, Math.min(window.innerHeight, calib.ySlope * rawY + calib.yIntercept))
  return { sx, sy }
}

// ─── CalibrationOverlay ───────────────────────────────────────────────────────

interface CalibrationOverlayProps {
  onComplete: (transform: CalibTransform) => void
  onCancel: () => void
  latestGaze: React.MutableRefObject<{ x: number; y: number } | null>
}

function CalibrationOverlay({ onComplete, onCancel, latestGaze }: CalibrationOverlayProps) {
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
          const rawSamplesArr: { x: number; y: number }[] = []
          const screenTargetsArr: { x: number; y: number }[] = []
          CALIB_POSITIONS.forEach((pos, i) => {
            const dotScreenX = pos.px * window.innerWidth
            const dotScreenY = pos.py * window.innerHeight
            const dots = samplesRef.current[i]
            if (dots.length > 0) {
              const avgX = dots.reduce((a, b) => a + b.x, 0) / dots.length
              const avgY = dots.reduce((a, b) => a + b.y, 0) / dots.length
              rawSamplesArr.push({ x: avgX, y: avgY })
              screenTargetsArr.push({ x: dotScreenX, y: dotScreenY })
            }
          })
          const transform = computeCalibTransform(rawSamplesArr, screenTargetsArr)
          setTimeout(() => onComplete(transform), 300)
        }
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [latestGaze, onComplete])

  useEffect(() => {
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current) }
  }, [])

  const W = window.innerWidth
  const H = window.innerHeight
  const pos = CALIB_POSITIONS[dotIndex]
  const dotX = pos.px * W
  const dotY = pos.py * H
  const dotRadius = 20
  const circumference = 2 * Math.PI * dotRadius
  const dashoffset = circumference * (1 - holdProgress)

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, color: '#fff' }}>
      <div style={{ position: 'absolute', top: 24, left: 0, right: 0, textAlign: 'center', pointerEvents: 'none' }}>
        <p style={{ fontSize: 18, margin: 0, fontWeight: 600 }}>👁️ UI Eye Tracking — Calibration</p>
        <p style={{ fontSize: 14, opacity: 0.8, margin: '6px 0 0' }}>
          {phase === 'waiting'
            ? `Look at the dot and click it  (${dotIndex + 1} / ${CALIB_DOT_COUNT})`
            : phase === 'collecting'
              ? `Keep your gaze steady…  (${dotIndex + 1} / ${CALIB_DOT_COUNT})`
              : 'Calibration complete!'}
        </p>
      </div>
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
          <svg width={dotRadius * 3} height={dotRadius * 3} style={{ display: 'block', overflow: 'visible' }}>
            {phase === 'collecting' && (
              <circle
                cx={dotRadius * 1.5} cy={dotRadius * 1.5} r={dotRadius}
                fill="none" stroke="rgba(255,210,60,0.9)" strokeWidth="4"
                strokeDasharray={circumference} strokeDashoffset={dashoffset}
                strokeLinecap="round"
                style={{ transform: 'rotate(-90deg)', transformOrigin: '50% 50%' }}
              />
            )}
            <circle cx={dotRadius * 1.5} cy={dotRadius * 1.5} r={dotRadius * 0.55}
              fill={phase === 'collecting' ? 'rgba(255,210,60,0.9)' : '#50b4ff'} />
            <circle cx={dotRadius * 1.5} cy={dotRadius * 1.5} r={dotRadius * 0.2} fill="white" />
          </svg>
          {phase === 'waiting' && (
            <span style={{ position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', fontSize: 11, whiteSpace: 'nowrap', color: '#ccc', marginTop: 4 }}>
              click to lock
            </span>
          )}
        </div>
      )}
      <button onClick={onCancel} style={{ position: 'absolute', bottom: 24, right: 24, padding: '8px 18px', borderRadius: 6, border: '1px solid #555', background: '#1a1a2e', color: '#aaa', cursor: 'pointer', fontSize: 13 }}>
        Cancel
      </button>
    </div>
  )
}

// ─── GazeCursor overlay ───────────────────────────────────────────────────────

interface GazeCursorProps {
  x: number
  y: number
  visible: boolean
  dwellProgress: number
  dwelling: boolean
  highlightedEl: Element | null
}

function GazeCursor({ x, y, visible, dwellProgress, dwelling, highlightedEl }: GazeCursorProps) {
  const R = 18
  const [highlightRect, setHighlightRect] = useState<DOMRect | null>(null)

  useEffect(() => {
    if (!highlightedEl) { setHighlightRect(null); return }
    setHighlightRect(highlightedEl.getBoundingClientRect())
  }, [highlightedEl, x, y])

  if (!visible) return null

  return (
    <>
      {/* Highlight box */}
      {highlightRect && (
        <div style={{
          position: 'fixed',
          left: highlightRect.left - 4,
          top: highlightRect.top - 4,
          width: highlightRect.width + 8,
          height: highlightRect.height + 8,
          border: `3px solid ${dwelling ? 'rgba(255,210,60,0.9)' : 'rgba(80,180,255,0.8)'}`,
          borderRadius: 6,
          pointerEvents: 'none',
          zIndex: 9000,
          boxShadow: dwelling ? '0 0 12px rgba(255,210,60,0.6)' : '0 0 8px rgba(80,180,255,0.4)',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }} />
      )}

      {/* Gaze dot */}
      <div style={{
        position: 'fixed',
        left: x,
        top: y,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: 9002,
      }}>
        <svg width={R * 2 + 16} height={R * 2 + 16} style={{ overflow: 'visible', display: 'block' }}>
          <circle cx={R + 8} cy={R + 8} r={R} fill="none" stroke="rgba(80,180,255,0.7)" strokeWidth="2" />
          <circle cx={R + 8} cy={R + 8} r={4} fill="rgba(80,180,255,0.9)" />
          {!highlightedEl && dwelling && dwellProgress > 0 && (
            <circle
              cx={R + 8} cy={R + 8} r={R + 6}
              fill="none" stroke="rgba(255,210,60,0.9)" strokeWidth="3"
              strokeDasharray={2 * Math.PI * (R + 6)}
              strokeDashoffset={2 * Math.PI * (R + 6) * (1 - dwellProgress)}
              strokeLinecap="round"
              style={{ transform: `rotate(-90deg)`, transformOrigin: `${R + 8}px ${R + 8}px` }}
            />
          )}
        </svg>
      </div>
    </>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

type Status = 'idle' | 'loading-script' | 'loading-model' | 'calibrating' | 'ready' | 'error'

function useUIEyeTracking() {
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [gazeVisible, setGazeVisible] = useState(false)
  const [gazeX, setGazeX] = useState(0)
  const [gazeY, setGazeY] = useState(0)
  const [dwellProgress, setDwellProgress] = useState(0)
  const [dwelling, setDwelling] = useState(false)
  const [highlightedEl, setHighlightedEl] = useState<Element | null>(null)

  const calibTransformRef = useRef<CalibTransform | null>(null)
  const latestGaze = useRef<{ x: number; y: number } | null>(null)
  const smoothedRef = useRef<{ sx: number; sy: number } | null>(null)
  const dwellStartRef = useRef<{ el: Element | null; sx: number; sy: number; startTime: number } | null>(null)
  const lastClickTimeRef = useRef(0)
  const peekrInitRef = useRef(false)
  const lastHighlightedElRef = useRef<Element | null>(null)

  // Load MediaPipe CDN script
  useEffect(() => {
    const win = window as unknown as Record<string, unknown>
    if (win['FaceMesh']) return
    setStatus('loading-script')
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/face_mesh.min.js'
    script.crossOrigin = 'anonymous'
    script.onload = () => setStatus('idle')
    script.onerror = () => { setErrorMsg('Failed to load MediaPipe CDN script.'); setStatus('error') }
    document.head.appendChild(script)
  }, [])

  const handleGaze = useCallback((gaze: { output: { cpuData: Float32Array } }) => {
    const rawX = gaze.output.cpuData[0]
    const rawY = gaze.output.cpuData[1]
    latestGaze.current = { x: rawX, y: rawY }

    const calib = calibTransformRef.current
    if (!calib) return

    const { sx, sy } = rawGazeToScreen(rawX, rawY, calib)
    if (!smoothedRef.current) {
      smoothedRef.current = { sx, sy }
    } else {
      smoothedRef.current = {
        sx: SMOOTH_ALPHA * smoothedRef.current.sx + (1 - SMOOTH_ALPHA) * sx,
        sy: SMOOTH_ALPHA * smoothedRef.current.sy + (1 - SMOOTH_ALPHA) * sy,
      }
    }
    const { sx: smoothX, sy: smoothY } = smoothedRef.current

    setGazeX(smoothX)
    setGazeY(smoothY)
    setGazeVisible(true)

    const targetEl = findNearestInteractive(smoothX, smoothY)

    if (targetEl !== lastHighlightedElRef.current) {
      lastHighlightedElRef.current = targetEl
      setHighlightedEl(targetEl)
      dwellStartRef.current = null
      setDwellProgress(0)
      setDwelling(false)
    }

    const now = performance.now()
    const cooldownOk = now - lastClickTimeRef.current > CLICK_COOLDOWN_MS

    if (!targetEl) {
      dwellStartRef.current = null
      return
    }

    if (!dwellStartRef.current) {
      dwellStartRef.current = { el: targetEl, sx: smoothX, sy: smoothY, startTime: now }
    } else {
      const dx = smoothX - dwellStartRef.current.sx
      const dy = smoothY - dwellStartRef.current.sy
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist > DWELL_RADIUS || dwellStartRef.current.el !== targetEl) {
        dwellStartRef.current = { el: targetEl, sx: smoothX, sy: smoothY, startTime: now }
        setDwellProgress(0)
        setDwelling(false)
      } else if (cooldownOk) {
        const elapsed = now - dwellStartRef.current.startTime
        const progress = Math.min(1, elapsed / DWELL_MS)
        if (progress >= 1) {
          lastClickTimeRef.current = now
          dwellStartRef.current = { el: targetEl, sx: smoothX, sy: smoothY, startTime: now }
          setDwellProgress(0)
          setDwelling(false)
          ;(targetEl as HTMLElement).click()
        } else {
          setDwellProgress(progress)
          setDwelling(true)
        }
      }
    }
  }, [])

  const startTracking = useCallback(async (transform: CalibTransform) => {
    calibTransformRef.current = transform
    setStatus('loading-model')
    try {
      const Peekr = await import('peekr')
      if (peekrInitRef.current) {
        setStatus('ready')
        Peekr.runEyeTracking()
        return
      }
      Peekr.initEyeTracking({
        onReady: () => { peekrInitRef.current = true; setStatus('ready'); Peekr.runEyeTracking() },
        onGaze: handleGaze,
      })
    } catch (e) {
      console.error('[UIEyeTracking]', e)
      setErrorMsg(String(e))
      setStatus('error')
    }
  }, [handleGaze])

  useEffect(() => {
    return () => {
      import('peekr').then((P) => P.stopEyeTracking()).catch(() => {})
      setGazeVisible(false)
      setHighlightedEl(null)
    }
  }, [])

  return { status, setStatus, errorMsg, gazeVisible, gazeX, gazeY, dwellProgress, dwelling, highlightedEl, latestGaze, startTracking }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EyeTrackingUIPage() {
  const { status, setStatus, errorMsg, gazeVisible, gazeX, gazeY, dwellProgress, dwelling, highlightedEl, latestGaze, startTracking } = useUIEyeTracking()

  const handleCalibComplete = useCallback((transform: CalibTransform) => startTracking(transform), [startTracking])
  const handleCalibCancel = useCallback(() => setStatus('idle'), [setStatus])
  const handleStartCalib = useCallback(() => setStatus('calibrating'), [setStatus])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw store={store} />

      <GazeCursor x={gazeX} y={gazeY} visible={gazeVisible} dwellProgress={dwellProgress} dwelling={dwelling} highlightedEl={highlightedEl} />

      {status === 'calibrating' && (
        <CalibrationOverlay onComplete={handleCalibComplete} onCancel={handleCalibCancel} latestGaze={latestGaze} />
      )}

      {/* Status panel */}
      <div style={{ position: 'absolute', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, zIndex: 8000, pointerEvents: 'none' }}>
        <div style={{
          background: 'rgba(0,0,0,0.7)',
          color: status === 'ready' ? '#7fff7f' : status === 'error' ? '#f55' : '#aaa',
          fontSize: 11, borderRadius: 6, padding: '4px 10px', whiteSpace: 'nowrap',
        }}>
          {status === 'idle' && '👁️ UI Eye Tracking — not started'}
          {status === 'loading-script' && '⏳ Loading MediaPipe…'}
          {status === 'loading-model' && '⏳ Loading gaze model…'}
          {status === 'calibrating' && '🎯 Calibrating…'}
          {status === 'ready' && '👁️ Gaze active · Dwell on a button to click it'}
          {status === 'error' && `⚠ ${errorMsg || 'Eye tracking unavailable'}`}
        </div>
        {(status === 'idle' || status === 'error') && (
          <button onClick={handleStartCalib} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#50b4ff', color: '#000', fontWeight: 600, fontSize: 13, cursor: 'pointer', pointerEvents: 'auto' }}>
            Start Eye Tracking
          </button>
        )}
        {status === 'ready' && (
          <button onClick={handleStartCalib} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #50b4ff', background: 'transparent', color: '#50b4ff', fontSize: 12, cursor: 'pointer', pointerEvents: 'auto' }}>
            Re-calibrate
          </button>
        )}
      </div>

      {status === 'ready' && (
        <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.65)', color: '#ddd', fontSize: 12, borderRadius: 8, padding: '6px 16px', zIndex: 8000, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          Look at any toolbar button or menu and hold your gaze to activate it
        </div>
      )}
    </div>
  )
}
