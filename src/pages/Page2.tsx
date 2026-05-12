import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

/**
 * Page 2 – a separate, isolated tldraw editor instance.
 * State is independent from Page 1.
 */
export default function Page2() {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Tldraw />
    </div>
  )
}
