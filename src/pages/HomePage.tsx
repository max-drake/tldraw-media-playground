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
          👁️ Eye Tracking (Canvas)
        </button>
        <button
          onClick={() => navigate('/eye-tracking-ui')}
          style={{
            padding: '10px 24px',
            borderRadius: 8,
            border: '2px solid #a855f7',
            cursor: 'pointer',
            background: '#16213e',
            color: '#fff',
            fontSize: 16,
          }}
        >
          👁️ Eye Tracking (UI)
        </button>
      </div>
      <p style={{ fontSize: 13, opacity: 0.6, maxWidth: 600, textAlign: 'center' }}>
        <b>Hand Tracking</b> uses your webcam and MediaPipe to turn your right index finger into a
        pointer. <b>Eye Tracking (Canvas)</b> uses Peekr (MIT, ONNX) to map your gaze to the
        canvas — dwell to click. <b>Eye Tracking (UI)</b> uses gaze to navigate and activate
        tldraw's toolbar buttons and menus — dwell on any UI control to click it.
      </p>
    </div>
  )
}
