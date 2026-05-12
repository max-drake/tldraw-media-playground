import { Tldraw, createTLStore, defaultShapeUtils, defaultBindingUtils } from 'tldraw'

/**
 * Persistent store for Page 2, lives for the lifetime of the app so that
 * switching away and back does not wipe the canvas.
 */
const store = createTLStore({ shapeUtils: [...defaultShapeUtils], bindingUtils: [...defaultBindingUtils] })

/**
 * Page 2 – a separate, isolated tldraw editor instance.
 * Passes the module-level store so state survives unmount/remount.
 */
export default function Page2() {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Tldraw store={store} />
    </div>
  )
}
