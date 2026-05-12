import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

/**
 * Page 1 – a standalone tldraw editor instance.
 * Each page mounts its own <Tldraw> so stores are fully isolated.
 */
export default function Page1() {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Tldraw />
    </div>
  )
}
