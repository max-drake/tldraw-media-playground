/**
 * VoiceDrawingPage – control tldraw with your voice using the Web Speech API.
 *
 * Architecture
 * ────────────
 * • SpeechRecognition (webkit-prefixed or standard) runs in continuous mode
 *   and fires interim/final transcript events.
 * • A command-matching layer maps spoken phrases to tldraw actions:
 *     "draw rectangle"  → switch to rectangle tool
 *     "draw circle"     → switch to ellipse tool
 *     "draw line"       → switch to line tool
 *     "draw arrow"      → switch to arrow tool
 *     "pencil" / "pen"  → switch to draw (pencil) tool
 *     "select"          → switch to select tool
 *     "select all"      → select all shapes
 *     "undo"            → undo
 *     "redo"            → redo
 *     "delete"          → delete selected shapes
 *     "zoom in"         → zoom in
 *     "zoom out"        → zoom out
 *     "fit screen"      → zoom to fit
 *     "clear"           → delete everything on canvas
 * • A visual transcript feed shows recent recognised phrases and which commands
 *   fired, giving clear user feedback.
 * • An OverlayUtil renders a subtle microphone-active indicator on the canvas.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Tldraw,
  useEditor,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  OverlayUtil,
  defaultOverlayUtils,
} from 'tldraw'
import { atom } from '@tldraw/state'
import type { TLOverlay } from 'tldraw'

// ─── Persistent store ─────────────────────────────────────────────────────────

const store = createTLStore({
  shapeUtils: [...defaultShapeUtils],
  bindingUtils: [...defaultBindingUtils],
})

// ─── Shared reactive atom ─────────────────────────────────────────────────────

interface MicState {
  active: boolean
  /** 0–1 normalised pulse driven by command recognition activity */
  pulse: number
}

const micAtom = atom<MicState>('mic', { active: false, pulse: 0 })

// ─── Overlay type & util ──────────────────────────────────────────────────────

interface TLMicOverlay extends TLOverlay {
  type: 'mic-active'
  props: { pulse: number }
}

const OVERLAY_RADIUS = 18
const OVERLAY_PULSE_MAX = 32

export class MicOverlayUtil extends OverlayUtil<TLMicOverlay> {
  static override type = 'mic-active' as const
  options = { zIndex: 400 }

  isActive(): boolean {
    return micAtom.get().active
  }

  getOverlays(): TLMicOverlay[] {
    return [{ id: 'mic-active:ring', type: 'mic-active', props: { pulse: micAtom.get().pulse } }]
  }

  render(ctx: CanvasRenderingContext2D, overlays: TLMicOverlay[]): void {
    const ov = overlays[0]
    if (!ov) return
    const { pulse } = ov.props

    ctx.save()
    const dpr = window.devicePixelRatio ?? 1
    ctx.resetTransform()
    ctx.scale(dpr, dpr)

    const cx = 44
    const cy = 44

    // Pulsing ring (only when pulse > 0)
    if (pulse > 0) {
      const pr = OVERLAY_RADIUS + pulse * OVERLAY_PULSE_MAX
      ctx.beginPath()
      ctx.arc(cx, cy, pr, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 80, 120, ${0.55 * (1 - pulse)})`
      ctx.lineWidth = 3
      ctx.stroke()
    }

    // Outer circle background
    ctx.beginPath()
    ctx.arc(cx, cy, OVERLAY_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(30, 20, 40, 0.82)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255, 80, 120, 0.9)'
    ctx.lineWidth = 2
    ctx.stroke()

    // Microphone icon body
    ctx.beginPath()
    if (ctx.roundRect) {
      ctx.roundRect(cx - 5, cy - 10, 10, 14, 5)
    } else {
      ctx.rect(cx - 5, cy - 10, 10, 14)
    }
    ctx.fillStyle = 'rgba(255, 80, 120, 0.95)'
    ctx.fill()

    // Stand arc
    ctx.beginPath()
    ctx.arc(cx, cy + 4, 8, Math.PI, 0, true)
    ctx.strokeStyle = 'rgba(255, 80, 120, 0.95)'
    ctx.lineWidth = 2
    ctx.stroke()

    // Vertical line from stand
    ctx.beginPath()
    ctx.moveTo(cx, cy + 12)
    ctx.lineTo(cx, cy + 16)
    ctx.stroke()
    // Horizontal base
    ctx.beginPath()
    ctx.moveTo(cx - 5, cy + 16)
    ctx.lineTo(cx + 5, cy + 16)
    ctx.stroke()

    ctx.restore()
  }

  renderMinimap(): void {
    // No minimap representation needed
  }
}

// ─── Command definitions ──────────────────────────────────────────────────────

interface VoiceCommand {
  triggers: string[]
  label: string
  action: (editor: ReturnType<typeof useEditor>) => void
}

const COMMANDS: VoiceCommand[] = [
  {
    triggers: ['draw rectangle', 'rectangle', 'draw rect'],
    label: '⬜ Rectangle tool',
    action: (ed) => ed.setCurrentTool('geo', { geo: 'rectangle' }),
  },
  {
    triggers: ['draw circle', 'circle', 'draw ellipse', 'ellipse'],
    label: '⭕ Ellipse tool',
    action: (ed) => ed.setCurrentTool('geo', { geo: 'ellipse' }),
  },
  {
    triggers: ['draw triangle', 'triangle'],
    label: '🔺 Triangle tool',
    action: (ed) => ed.setCurrentTool('geo', { geo: 'triangle' }),
  },
  {
    triggers: ['draw line', 'draw a line', 'line tool'],
    label: '📏 Line tool',
    action: (ed) => ed.setCurrentTool('line'),
  },
  {
    triggers: ['draw arrow', 'arrow', 'draw an arrow'],
    label: '➡️ Arrow tool',
    action: (ed) => ed.setCurrentTool('arrow'),
  },
  {
    triggers: ['pencil', 'pen', 'draw tool', 'freehand'],
    label: '✏️ Pencil tool',
    action: (ed) => ed.setCurrentTool('draw'),
  },
  {
    triggers: ['text', 'add text', 'text tool', 'write'],
    label: '🔤 Text tool',
    action: (ed) => ed.setCurrentTool('text'),
  },
  {
    triggers: ['select all', 'select everything'],
    label: '🔲 Select all',
    action: (ed) => ed.selectAll(),
  },
  {
    triggers: ['select', 'selection tool', 'pointer'],
    label: '🖱️ Select tool',
    action: (ed) => ed.setCurrentTool('select'),
  },
  {
    triggers: ['undo', 'go back'],
    label: '↩️ Undo',
    action: (ed) => ed.undo(),
  },
  {
    triggers: ['redo', 'go forward'],
    label: '↪️ Redo',
    action: (ed) => ed.redo(),
  },
  {
    triggers: ['delete', 'remove', 'erase selected'],
    label: '🗑️ Delete selected',
    action: (ed) => ed.deleteShapes(ed.getSelectedShapeIds()),
  },
  {
    triggers: ['zoom in'],
    label: '🔍 Zoom in',
    action: (ed) => ed.zoomIn(ed.getViewportScreenCenter()),
  },
  {
    triggers: ['zoom out'],
    label: '🔎 Zoom out',
    action: (ed) => ed.zoomOut(ed.getViewportScreenCenter()),
  },
  {
    triggers: ['fit screen', 'zoom to fit', 'fit all', 'reset zoom', 'fit page'],
    label: '🖥️ Zoom to fit',
    action: (ed) => ed.zoomToFit(),
  },
  {
    triggers: ['clear', 'clear all', 'clear canvas', 'erase all', 'erase everything', 'delete all'],
    label: '🧹 Clear canvas',
    action: (ed) => {
      ed.selectAll()
      ed.deleteShapes(ed.getSelectedShapeIds())
    },
  },
]

function matchCommand(transcript: string): VoiceCommand | null {
  const lower = transcript.toLowerCase().trim()
  let best: VoiceCommand | null = null
  let bestLen = 0

  for (const cmd of COMMANDS) {
    for (const trigger of cmd.triggers) {
      if (lower.includes(trigger) && trigger.length > bestLen) {
        best = cmd
        bestLen = trigger.length
      }
    }
  }
  return best
}

// ─── Types for SpeechRecognition (not in TS stdlib) ──────────────────────────

interface SpeechRecognitionResult {
  readonly isFinal: boolean
  readonly length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}
interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}
interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}
interface SpeechRecognitionEventType extends Event {
  resultIndex: number
  results: SpeechRecognitionResultList
}
interface SpeechRecognitionErrorEventType extends Event {
  error: string
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onresult: ((e: SpeechRecognitionEventType) => void) | null
  onerror: ((e: SpeechRecognitionErrorEventType) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionInstance) | null {
  const w = window as unknown as Record<string, unknown>
  if ('SpeechRecognition' in w) return w['SpeechRecognition'] as new () => SpeechRecognitionInstance
  if ('webkitSpeechRecognition' in w)
    return w['webkitSpeechRecognition'] as new () => SpeechRecognitionInstance
  return null
}

// ─── Feed item ────────────────────────────────────────────────────────────────

interface FeedItem {
  id: number
  transcript: string
  command: string | null
  final: boolean
}

let _feedId = 0

// ─── VoiceController (inner component inside Tldraw tree) ─────────────────────

function VoiceController() {
  const editor = useEditor()
  const recogRef = useRef<SpeechRecognitionInstance | null>(null)
  const [isListening, setIsListening] = useState(false)
  const [supported, setSupported] = useState(true)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const interimIdRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)

  const pushFeed = useCallback((transcript: string, command: string | null, final: boolean) => {
    setFeed((prev) => {
      if (!final && interimIdRef.current !== null) {
        return prev.map((item) =>
          item.id === interimIdRef.current ? { ...item, transcript, command, final } : item,
        )
      }
      const id = ++_feedId
      if (!final) interimIdRef.current = id
      return [{ id, transcript, command, final }, ...prev].slice(0, 20)
    })
  }, [])

  const triggerPulse = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    micAtom.set({ active: true, pulse: 1 })
    let startTs: number | null = null
    const duration = 600
    function animate(ts: number) {
      if (!startTs) startTs = ts
      const progress = Math.min(1, (ts - startTs) / duration)
      micAtom.set({ active: true, pulse: 1 - progress })
      if (progress < 1) rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
  }, [])

  const startListening = useCallback(() => {
    const SR = getSpeechRecognitionCtor()
    if (!SR) { setSupported(false); return }

    const recog = new SR()
    recog.continuous = true
    recog.interimResults = true
    recog.lang = 'en-US'
    recog.maxAlternatives = 3

    recog.onresult = (e: SpeechRecognitionEventType) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const transcript = result[0].transcript.trim()
        const isFinal = result.isFinal

        if (isFinal) interimIdRef.current = null

        let matched: VoiceCommand | null = null
        for (let j = 0; j < result.length; j++) {
          const alt = result[j].transcript
          matched = matchCommand(alt)
          if (matched) break
        }

        if (matched && isFinal) {
          try { matched.action(editor) } catch (err) {
            console.warn('[VoiceDrawing] Command error:', err)
          }
          triggerPulse()
        }

        pushFeed(transcript, matched ? matched.label : null, isFinal)
      }
    }

    recog.onerror = (e: SpeechRecognitionErrorEventType) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return
      console.warn('[VoiceDrawing] Speech error:', e.error)
    }

    recog.onend = () => {
      if (recogRef.current === recog) {
        try { recog.start() } catch { /* already started */ }
      }
    }

    recogRef.current = recog
    try {
      recog.start()
      setIsListening(true)
      micAtom.set({ active: true, pulse: 0 })
    } catch (err) {
      console.error('[VoiceDrawing] Could not start recognition:', err)
    }
  }, [editor, pushFeed, triggerPulse])

  const stopListening = useCallback(() => {
    if (recogRef.current) {
      recogRef.current.onend = null
      recogRef.current.abort()
      recogRef.current = null
    }
    setIsListening(false)
    micAtom.set({ active: false, pulse: 0 })
  }, [])

  useEffect(() => {
    if (!getSpeechRecognitionCtor()) setSupported(false)
    return () => {
      if (recogRef.current) {
        recogRef.current.onend = null
        recogRef.current.abort()
        recogRef.current = null
      }
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      micAtom.set({ active: false, pulse: 0 })
    }
  }, [])

  return (
    <>
      {/* ── Side panel ── */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          width: 260,
          maxHeight: 'calc(100% - 32px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          zIndex: 500,
          pointerEvents: 'none',
        }}
      >
        {/* Header card */}
        <div
          style={{
            background: 'rgba(20, 12, 30, 0.92)',
            borderRadius: 10,
            border: '1.5px solid rgba(255,80,120,0.5)',
            padding: '10px 14px',
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: isListening ? '#ff5078' : '#444',
                boxShadow: isListening ? '0 0 8px #ff5078' : 'none',
                flexShrink: 0,
                transition: 'background 0.3s, box-shadow 0.3s',
              }}
            />
            <span style={{ color: '#fff', fontWeight: 600, fontSize: 14 }}>
              🎙️ Voice Drawing
            </span>
          </div>

          {!supported ? (
            <p style={{ color: '#f88', fontSize: 12, margin: 0 }}>
              ⚠ Web Speech API not supported in this browser. Try Chrome or Edge.
            </p>
          ) : (
            <button
              onClick={isListening ? stopListening : startListening}
              style={{
                padding: '7px 0',
                borderRadius: 7,
                border: 'none',
                background: isListening ? 'rgba(255,80,120,0.15)' : 'rgba(255,80,120,0.85)',
                color: isListening ? '#ff5078' : '#fff',
                fontWeight: 700,
                fontSize: 13,
                cursor: 'pointer',
                outline: isListening ? '1.5px solid #ff5078' : 'none',
                transition: 'all 0.2s',
              }}
            >
              {isListening ? '⏹ Stop Listening' : '🎙 Start Listening'}
            </button>
          )}
        </div>

        {/* Command cheat-sheet */}
        <details
          style={{
            background: 'rgba(20, 12, 30, 0.85)',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.1)',
            padding: '6px 10px',
            pointerEvents: 'auto',
            fontSize: 12,
            color: '#ccc',
          }}
        >
          <summary
            style={{ cursor: 'pointer', fontWeight: 600, color: '#ddd', userSelect: 'none' }}
          >
            📋 Voice Commands
          </summary>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {COMMANDS.map((cmd) => (
              <div key={cmd.label} style={{ display: 'flex', gap: 6 }}>
                <span style={{ color: '#ff8099', flexShrink: 0, minWidth: 120 }}>
                  {cmd.label}
                </span>
                <span style={{ opacity: 0.65, fontSize: 11 }}>
                  &ldquo;{cmd.triggers[0]}&rdquo;
                </span>
              </div>
            ))}
          </div>
        </details>

        {/* Live transcript feed */}
        {feed.length > 0 && (
          <div
            style={{
              background: 'rgba(20, 12, 30, 0.82)',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.08)',
              padding: '8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              maxHeight: 260,
              overflowY: 'auto',
            }}
          >
            <span style={{ fontSize: 11, color: '#888', marginBottom: 2 }}>
              Recent transcript
            </span>
            {feed.map((item) => (
              <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span
                  style={{
                    fontSize: 12,
                    color: item.final ? '#eee' : '#888',
                    fontStyle: item.final ? 'normal' : 'italic',
                    lineHeight: 1.3,
                  }}
                >
                  {item.final ? '"' : '…"'}
                  {item.transcript}
                  {item.final ? '"' : ''}
                </span>
                {item.command && (
                  <span style={{ fontSize: 11, color: '#ff8099', marginLeft: 4 }}>
                    ▶ {item.command}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom-left hint (only when not listening) */}
      {!isListening && supported && (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(20,12,30,0.8)',
            color: '#aaa',
            fontSize: 12,
            borderRadius: 8,
            padding: '6px 16px',
            zIndex: 500,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Click <strong style={{ color: '#ff8099' }}>Start Listening</strong> then say e.g.{' '}
          <em>&ldquo;draw rectangle&rdquo;</em> or <em>&ldquo;undo&rdquo;</em>
        </div>
      )}

      {/* Active indicator strip at top */}
      {isListening && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: 'linear-gradient(90deg, transparent, rgba(255,80,120,0.8), transparent)',
            zIndex: 500,
            pointerEvents: 'none',
            animation: 'voicePulse 1.6s ease-in-out infinite',
          }}
        />
      )}

      <style>{`
        @keyframes voicePulse {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }
      `}</style>
    </>
  )
}

// ─── Overlay utils ────────────────────────────────────────────────────────────

const overlayUtils = [...defaultOverlayUtils, MicOverlayUtil] as const

// ─── Page component ───────────────────────────────────────────────────────────

export default function VoiceDrawingPage() {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw store={store} overlayUtils={overlayUtils}>
        <VoiceController />
      </Tldraw>
    </div>
  )
}
