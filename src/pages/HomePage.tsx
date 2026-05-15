import { navigate } from '../App'

export default function HomePage() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 16,
        background: '#0f3460',
        color: '#eee',
      }}
    >
      <h1 style={{ fontSize: 28 }}>tldraw media playground</h1>
      <p style={{ fontSize: 16, opacity: 0.8 }}>
        Choose a page to open a tldraw editor.
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={() => navigate('/hand-tracking')}
          style={{
            padding: '10px 24px',
            borderRadius: 8,
            border: '2px solid #e94560',
            cursor: 'pointer',
            background: '#16213e',
            color: '#fff',
            fontSize: 16,
          }}
        >
          ✋ Hand Tracking
        </button>
        <button
          onClick={() => navigate('/eye-tracking')}
          style={{
            padding: '10px 24px',
            borderRadius: 8,
            border: '2px solid #50b4ff',
            cursor: 'pointer',
            background: '#16213e',
            color: '#fff',
            fontSize: 16,
          }}
        >
          👁️ Eye Tracking
        </button>
        <button
          onClick={() => navigate('/voice-drawing')}
          style={{
            padding: '10px 24px',
            borderRadius: 8,
            border: '2px solid #e94560',
            cursor: 'pointer',
            background: '#16213e',
            color: '#fff',
            fontSize: 16,
          }}
        >
          🎙️ Voice Drawing
        </button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.6, maxWidth: 560, textAlign: 'center' }}>
        Hand Tracking uses your webcam and MediaPipe to turn your right index finger into a
        pointer. Eye Tracking uses Peekr (MIT, ONNX) to map your gaze to the canvas — dwell
        your eyes on a spot to click. Voice Drawing uses the Web Speech API so you can control
        the canvas with spoken commands like "undo", "clear", or "zoom to fit".
      </p>
    </div>
  )
}
