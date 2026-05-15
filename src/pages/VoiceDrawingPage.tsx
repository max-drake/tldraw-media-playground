/**
 * VoiceDrawingPage – uses the Web Speech API (SpeechRecognition) to let the
 * user control a tldraw canvas with spoken commands.
 *
 * Supported commands
 * ──────────────────
 * "undo"          → editor.undo()
 * "redo"          → editor.redo()
 * "clear"         → delete all shapes
 * "select all"    → select all shapes
 * "zoom in"       → zoom the canvas in
 * "zoom out"      → zoom the canvas out
 * "zoom to fit"   → zoom to fit all shapes
 * "draw" / "pen"  → switch to the draw tool
 * "select"        → switch to the select tool
 * "eraser"        → switch to the eraser tool
 * "arrow"         → switch to the arrow tool
 * "text"          → switch to the text tool
 *
 * The latest recognised phrase and command status are shown in a small HUD so
 * the user gets immediate feedback.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Tldraw,
  useEditor,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
} from 'tldraw'

// Persistent store so canvas state survives navigation
const store = createTLStore({
  shapeUtils: [...defaultShapeUtils],
  bindingUtils: [...defaultBindingUtils],
})

// ---------------------------------------------------------------------------
// Type shim for the non-standard (but widely supported) SpeechRecognition API
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance
  }
}

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEvent) => void) | null
  onerror: ((e: Event) => void) | null
  onend: (() => void) | null
}

// ---------------------------------------------------------------------------
// VoiceController – inner component that can call useEditor()
// ---------------------------------------------------------------------------

type CommandStatus = 'idle' | 'listening' | 'matched' | 'unrecognised' | 'error' | 'unsupported'

function VoiceController() {
  const editor = useEditor()
  const [status, setStatus] = useState<CommandStatus>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [lastTranscript, setLastTranscript] = useState('')
  const [lastCommand, setLastCommand] = useState('')
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const activeRef = useRef(false)

  // Check for SpeechRecognition support on mount
  useEffect(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SR) {
      setStatus('unsupported')
    }
    return () => {
      // Stop recognition on unmount
      recognitionRef.current?.abort()
    }
  }, [])

  /**
   * Map a lowercase transcript string to a tldraw editor action.
   * Returns the friendly command name if matched, otherwise null.
   */
  const executeCommand = useCallback(
    (transcript: string): string | null => {
      const t = transcript.toLowerCase().trim()

      if (t.includes('undo')) {
        editor.undo()
        return 'undo'
      }
      if (t.includes('redo')) {
        editor.redo()
        return 'redo'
      }
      if (t.includes('clear')) {
        const ids = Array.from(editor.getCurrentPageShapeIds())
        if (ids.length > 0) editor.deleteShapes(ids)
        return 'clear'
      }
      if (t.includes('select all')) {
        editor.selectAll()
        return 'select all'
      }
      if (t.includes('zoom in')) {
        editor.zoomIn()
        return 'zoom in'
      }
      if (t.includes('zoom out')) {
        editor.zoomOut()
        return 'zoom out'
      }
      if (t.includes('zoom to fit') || t.includes('fit')) {
        editor.zoomToFit()
        return 'zoom to fit'
      }
      if (t.includes('draw') || t.includes('pen')) {
        editor.setCurrentTool('draw')
        return 'draw tool'
      }
      if (t.includes('eraser') || t.includes('erase')) {
        editor.setCurrentTool('eraser')
        return 'eraser tool'
      }
      if (t.includes('arrow')) {
        editor.setCurrentTool('arrow')
        return 'arrow tool'
      }
      if (t.includes('text')) {
        editor.setCurrentTool('text')
        return 'text tool'
      }
      if (t.includes('select')) {
        editor.setCurrentTool('select')
        return 'select tool'
      }

      return null
    },
    [editor],
  )

  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SR) {
      setStatus('unsupported')
      return
    }

    if (activeRef.current) return
    activeRef.current = true

    const recognition = new SR()
    recognitionRef.current = recognition
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onresult = (e: SpeechRecognitionEvent) => {
      const results = e.results
      const transcript = results[results.length - 1][0].transcript
      setLastTranscript(transcript)

      const cmd = executeCommand(transcript)
      if (cmd) {
        setLastCommand(cmd)
        setStatus('matched')
      } else {
        setLastCommand('')
        setStatus('unrecognised')
      }
    }

    recognition.onerror = (e: Event) => {
      const errEvent = e as Event & { error?: string }
      if (errEvent.error === 'no-speech') return // benign, keep listening
      if (errEvent.error === 'aborted') return
      console.error('[VoiceDrawing] SpeechRecognition error:', errEvent.error)
      setErrorMsg(errEvent.error ?? 'Unknown error')
      setStatus('error')
      activeRef.current = false
    }

    recognition.onend = () => {
      // Auto-restart if the user hasn't explicitly stopped
      if (activeRef.current) {
        try {
          recognition.start()
        } catch {
          // May throw if already started in some browsers — safe to ignore
        }
      }
    }

    recognition.start()
    setStatus('listening')
  }, [executeCommand])

  const stopListening = useCallback(() => {
    activeRef.current = false
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setStatus('idle')
    setLastTranscript('')
    setLastCommand('')
  }, [])

  // ── Status colours ────────────────────────────────────────────────────────
  const statusColor =
    status === 'listening' || status === 'matched'
      ? '#7fff7f'
      : status === 'error' || status === 'unsupported'
        ? '#f55'
        : '#aaa'

  const statusLabel =
    status === 'idle' ? '🎙️ Voice Drawing — not started'
    : status === 'listening' ? '🎙️ Listening for commands…'
    : status === 'matched' ? `✅ Command: "${lastCommand}"`
    : status === 'unrecognised' ? `❓ Not recognised: "${lastTranscript}"`
    : status === 'error' ? `⚠ Error: ${errorMsg}`
    : '⚠ SpeechRecognition not supported in this browser'

  return (
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
      {/* Status badge */}
      <div
        style={{
          background: 'rgba(0,0,0,0.65)',
          color: statusColor,
          fontSize: 11,
          borderRadius: 6,
          padding: '4px 10px',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          maxWidth: 340,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {statusLabel}
      </div>

      {/* Start / Stop button */}
      {status === 'unsupported' ? null : status === 'idle' || status === 'error' ? (
        <button
          onClick={startListening}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            background: '#e94560',
            color: '#fff',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Start Listening
        </button>
      ) : (
        <button
          onClick={stopListening}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid #e94560',
            background: 'transparent',
            color: '#e94560',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Stop Listening
        </button>
      )}

      {/* Command reference card */}
      <details
        style={{
          background: 'rgba(0,0,0,0.75)',
          borderRadius: 8,
          padding: '6px 12px',
          fontSize: 11,
          color: '#ccc',
          maxWidth: 260,
        }}
      >
        <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#fff', userSelect: 'none' }}>
          Voice Commands ▾
        </summary>
        <ul style={{ margin: '6px 0 0', paddingLeft: 16, lineHeight: 1.8 }}>
          <li><b>undo</b> / <b>redo</b></li>
          <li><b>clear</b> — delete all shapes</li>
          <li><b>select all</b></li>
          <li><b>zoom in</b> / <b>zoom out</b></li>
          <li><b>zoom to fit</b></li>
          <li><b>draw</b> / <b>pen</b> — draw tool</li>
          <li><b>select</b> — select tool</li>
          <li><b>eraser</b> — eraser tool</li>
          <li><b>arrow</b> — arrow tool</li>
          <li><b>text</b> — text tool</li>
        </ul>
      </details>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function VoiceDrawingPage() {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw store={store}>
        <VoiceController />
      </Tldraw>
    </div>
  )
}
