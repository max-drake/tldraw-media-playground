/**
 * Helpers for dispatching synthetic pointer events to a tldraw Editor.
 *
 * Both HandTrackingPage and EyeTrackingPage inject pointer events to drive
 * the canvas.  The event objects are identical except for the `name` and
 * `point` fields, so we centralise the boilerplate here.
 */

import type { Editor } from 'tldraw'

interface PointerEventOptions {
  name: 'pointer_move' | 'pointer_down' | 'pointer_up'
  point: { x: number; y: number }
}

/**
 * Dispatch a synthetic canvas pointer event to the given editor.
 * Uses pointer-id 1, primary button (0), non-pen, no modifier keys.
 */
export function dispatchPointerEvent(editor: Editor, opts: PointerEventOptions): void {
  editor.dispatch({
    type: 'pointer',
    name: opts.name,
    target: 'canvas',
    button: 0,
    isPen: false,
    pointerId: 1,
    point: opts.point,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    accelKey: false,
  })
}
