/**
 * FlappyBirdPage – a minimal Flappy Bird clone rendered with tldraw shapes.
 *
 * Bird   → yellow ellipse geo shape
 * Pipes  → green rectangle geo shapes (top + bottom pairs)
 * Ground → green rectangle geo shape
 * Score  → text shape
 *
 * Input: Space bar or click/tap to jump / start / restart.
 *
 * tldraw is used purely as a rendering surface:
 *   - all UI is hidden
 *   - camera is locked at zoom=1, top-left at (0,0)
 *   - the tldraw div has pointerEvents:none so no tldraw tool intercepts input
 *   - a transparent sibling div on top captures all pointer + keyboard events
 */

import { useEffect, useRef, useMemo, useCallback } from 'react'
import {
  Tldraw,
  useEditor,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  createShapeId,
  toRichText,
  type TLShapeId,
  type TLCameraOptions,
} from 'tldraw'
import 'tldraw/tldraw.css'

// ─── Game constants ───────────────────────────────────────────────────────────

const W = 480          // game canvas width
const H = 640          // game canvas height

const BIRD_X = 100     // fixed horizontal position of bird
const BIRD_W = 36
const BIRD_H = 28

const GRAVITY = 1500   // px/s²
const JUMP_VEL = -460  // px/s (negative = up)
const PIPE_SPEED = 200 // px/s
const PIPE_W = 64
const PIPE_GAP = 160   // vertical opening height
const PIPE_INTERVAL = 1800 // ms between pipe spawns
const GROUND_H = 48

// ─── Mutable game state (never stored in React state — only in refs) ──────────

type Phase = 'idle' | 'playing' | 'dead'

interface Pipe {
  topId: TLShapeId
  botId: TLShapeId
  x: number
  gapTop: number   // y where gap starts
  passed: boolean
}

interface GS {
  phase: Phase
  birdY: number    // centre y of bird
  birdVY: number
  pipes: Pipe[]
  score: number
  lastPipeAt: number   // timestamp (ms)
  prevTime: number | null
}

function makeGS(): GS {
  return {
    phase: 'idle',
    birdY: H / 2,
    birdVY: 0,
    pipes: [],
    score: 0,
    lastPipeAt: 0,
    prevTime: null,
  }
}

// ─── Camera options (stable reference) ───────────────────────────────────────

const CAMERA_OPTIONS: TLCameraOptions = {
  isLocked: true,
  wheelBehavior: 'none',
  panSpeed: 0,
  zoomSpeed: 0,
  zoomSteps: [1],
  constraints: undefined,
}

// ─── Inner component (has access to editor via useEditor) ─────────────────────

interface ControllerProps {
  jumpRef: React.MutableRefObject<() => void>
}

function GameController({ jumpRef }: ControllerProps) {
  const editor = useEditor()
  const gsRef = useRef<GS>(makeGS())
  const rafRef = useRef<number | null>(null)

  // Stable shape IDs
  const ids = useRef({
    bird: createShapeId('bird'),
    score: createShapeId('score'),
    msg: createShapeId('msg'),
    bg: createShapeId('bg'),
    ground: createShapeId('ground'),
  })

  // ── helpers ──────────────────────────────────────────────────────────────

  const safeDelete = useCallback(
    (list: TLShapeId[]) => {
      const exist = list.filter((id) => editor.getShape(id))
      if (exist.length) editor.deleteShapes(exist)
    },
    [editor]
  )

  const setMsg = useCallback(
    (text: string) => {
      editor.updateShape({
        id: ids.current.msg,
        type: 'text',
        props: { richText: toRichText(text) },
      })
    },
    [editor]
  )

  const setScore = useCallback(
    (gs: GS) => {
      const label =
        gs.phase === 'idle'
          ? 'SPACE or click to start'
          : `Score: ${gs.score}`
      editor.updateShape({
        id: ids.current.score,
        type: 'text',
        props: { richText: toRichText(label) },
      })
    },
    [editor]
  )

  const moveBird = useCallback(
    (gs: GS) => {
      editor.updateShape({
        id: ids.current.bird,
        type: 'geo',
        y: gs.birdY - BIRD_H / 2,
      })
    },
    [editor]
  )

  const spawnPipe = useCallback(
    (gs: GS, now: number) => {
      const minGapTop = 80
      const maxGapTop = H - GROUND_H - PIPE_GAP - 80
      const gapTop = minGapTop + Math.random() * (maxGapTop - minGapTop)
      const topId = createShapeId()
      const botId = createShapeId()
      const botY = gapTop + PIPE_GAP
      const botH = H - GROUND_H - botY

      editor.createShapes([
        {
          id: topId,
          type: 'geo',
          x: W,
          y: 0,
          isLocked: true,
          props: {
            geo: 'rectangle',
            w: PIPE_W,
            h: gapTop,
            fill: 'solid',
            color: 'green',
            dash: 'solid',
            size: 's',
          },
        },
        {
          id: botId,
          type: 'geo',
          x: W,
          y: botY,
          isLocked: true,
          props: {
            geo: 'rectangle',
            w: PIPE_W,
            h: Math.max(botH, 4),
            fill: 'solid',
            color: 'green',
            dash: 'solid',
            size: 's',
          },
        },
      ])

      gs.pipes.push({ topId, botId, x: W, gapTop, passed: false })
      gs.lastPipeAt = now
    },
    [editor]
  )

  const movePipe = useCallback(
    (p: Pipe) => {
      editor.updateShape({ id: p.topId, type: 'geo', x: p.x })
      editor.updateShape({ id: p.botId, type: 'geo', x: p.x })
    },
    [editor]
  )

  const checkCollision = useCallback((gs: GS): boolean => {
    // ground / ceiling
    if (gs.birdY + BIRD_H / 2 >= H - GROUND_H) return true
    if (gs.birdY - BIRD_H / 2 <= 0) return true

    const bL = BIRD_X - BIRD_W / 2
    const bR = BIRD_X + BIRD_W / 2
    const bT = gs.birdY - BIRD_H / 2
    const bB = gs.birdY + BIRD_H / 2

    for (const p of gs.pipes) {
      if (bR > p.x && bL < p.x + PIPE_W) {
        if (bT < p.gapTop || bB > p.gapTop + PIPE_GAP) return true
      }
    }
    return false
  }, [])

  const restartGame = useCallback(
    (gs: GS) => {
      safeDelete(gs.pipes.flatMap((p) => [p.topId, p.botId]))
      const fresh = makeGS()
      Object.assign(gs, fresh)
      moveBird(gs)
      setScore(gs)
      setMsg('')
    },
    [safeDelete, moveBird, setScore, setMsg]
  )

  // ── game loop ─────────────────────────────────────────────────────────────

  const loop = useCallback(
    (now: number) => {
      rafRef.current = requestAnimationFrame(loop)
      const gs = gsRef.current
      if (gs.phase !== 'playing') return

      const dt = gs.prevTime === null ? 0 : Math.min((now - gs.prevTime) / 1000, 0.05)
      gs.prevTime = now

      // Physics
      gs.birdVY += GRAVITY * dt
      gs.birdY += gs.birdVY * dt

      // Spawn pipe
      if (now - gs.lastPipeAt > PIPE_INTERVAL) {
        spawnPipe(gs, now)
      }

      // Move pipes
      for (const p of gs.pipes) {
        p.x -= PIPE_SPEED * dt
        movePipe(p)
        if (!p.passed && p.x + PIPE_W < BIRD_X - BIRD_W / 2) {
          p.passed = true
          gs.score += 1
          setScore(gs)
        }
      }

      // Remove off-screen pipes
      const gone = gs.pipes.filter((p) => p.x + PIPE_W < -20)
      if (gone.length) {
        safeDelete(gone.flatMap((p) => [p.topId, p.botId]))
        gs.pipes = gs.pipes.filter((p) => p.x + PIPE_W >= -20)
      }

      // Move bird shape
      moveBird(gs)

      // Collision
      if (checkCollision(gs)) {
        gs.phase = 'dead'
        setMsg(`Game Over!\nScore: ${gs.score}\n\nSPACE or click to restart`)
        setScore(gs)
      }
    },
    [spawnPipe, movePipe, setScore, safeDelete, moveBird, checkCollision, setMsg]
  )

  // ── jump handler (exposed via jumpRef) ────────────────────────────────────

  useEffect(() => {
    jumpRef.current = () => {
      const gs = gsRef.current
      if (gs.phase === 'idle') {
        gs.phase = 'playing'
        gs.birdVY = JUMP_VEL
        gs.prevTime = null
        setMsg('')
        setScore(gs)
      } else if (gs.phase === 'playing') {
        gs.birdVY = JUMP_VEL
      } else if (gs.phase === 'dead') {
        restartGame(gs)
      }
    }
  }, [jumpRef, setMsg, setScore, restartGame])

  // ── mount: set up camera + create static shapes + start loop ─────────────

  useEffect(() => {
    // Set the camera first (before locking), then lock it.
    // setCamera is a no-op when isLocked=true unless force:true is passed.
    editor.setCameraOptions({ ...CAMERA_OPTIONS, isLocked: false })
    editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true, force: true })
    editor.setCameraOptions(CAMERA_OPTIONS)

    // Sky background
    editor.createShapes([
      {
        id: ids.current.bg,
        type: 'geo',
        x: 0,
        y: 0,
        isLocked: true,
        props: {
          geo: 'rectangle',
          w: W,
          h: H,
          fill: 'solid',
          color: 'light-blue',
          dash: 'solid',
          size: 's',
        },
      },
      // Ground
      {
        id: ids.current.ground,
        type: 'geo',
        x: 0,
        y: H - GROUND_H,
        isLocked: true,
        props: {
          geo: 'rectangle',
          w: W,
          h: GROUND_H,
          fill: 'solid',
          color: 'green',
          dash: 'solid',
          size: 's',
        },
      },
      // Bird
      {
        id: ids.current.bird,
        type: 'geo',
        x: BIRD_X - BIRD_W / 2,
        y: H / 2 - BIRD_H / 2,
        isLocked: true,
        props: {
          geo: 'ellipse',
          w: BIRD_W,
          h: BIRD_H,
          fill: 'solid',
          color: 'yellow',
          dash: 'solid',
          size: 's',
        },
      },
      // Score
      {
        id: ids.current.score,
        type: 'text',
        x: 12,
        y: 12,
        isLocked: true,
        props: {
          richText: toRichText('SPACE or click to start'),
          size: 'm',
          font: 'mono',
          color: 'black',
          textAlign: 'start',
          autoSize: true,
        },
      },
      // Overlay message
      {
        id: ids.current.msg,
        type: 'text',
        x: W / 2 - 140,
        y: H / 2 - 60,
        isLocked: true,
        props: {
          richText: toRichText('Flappy Bird\nSPACE or click to start'),
          size: 'l',
          font: 'draw',
          color: 'black',
          textAlign: 'middle',
          autoSize: true,
          w: 280,
        },
      },
    ])

    // Start the game loop
    rafRef.current = requestAnimationFrame(loop)

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      // Clean up all shapes on unmount (important for React StrictMode double-invoke)
      try {
        const allIds = editor.getCurrentPageShapeIds()
        if (allIds.size > 0) editor.deleteShapes([...allIds])
      } catch {
        // ignore – editor may already be torn down
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function FlappyBirdPage() {
  const store = useMemo(
    () =>
      createTLStore({
        shapeUtils: [...defaultShapeUtils],
        bindingUtils: [...defaultBindingUtils],
      }),
    []
  )

  const jumpRef = useRef<() => void>(() => {})
  const overlayRef = useRef<HTMLDivElement>(null)

  // Space-bar handler at window level so it works even if overlay isn't focused
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
        jumpRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handlePointer = (e: React.PointerEvent) => {
    if (e.button === 0 || e.pointerType !== 'mouse') {
      jumpRef.current()
    }
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        background: '#000',
      }}
    >
      {/* tldraw as pure renderer — pointer events disabled so tldraw tools never intercept input */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <Tldraw
          store={store}
          hideUi
          autoFocus={false}
          cameraOptions={CAMERA_OPTIONS}
        >
          <GameController jumpRef={jumpRef} />
        </Tldraw>
      </div>

      {/* Transparent input-capture overlay — sits on top, captures all pointer events */}
      <div
        ref={overlayRef}
        tabIndex={0}
        onPointerDown={handlePointer}
        style={{
          position: 'absolute',
          inset: 0,
          cursor: 'pointer',
          outline: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      />
    </div>
  )
}
