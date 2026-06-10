# Plan: Two-Hand Zoom & Rotate (Map Gesture)

> **Goal:** Track both hands simultaneously so the vector between the two index-finger tips drives
> tldraw's camera — spread apart → zoom in, squeeze together → zoom out, rotate the vector →
> rotate the viewport.  Mirrors how you'd manipulate a physical map.

---

## 1. High-level approach

The existing `/hand-tracking` page already:
- Loads `HandLandmarker` with `numHands: 2`
- Processes `result.landmarks` / `result.handedness` each frame
- Drives tldraw via `editor.dispatch()` pointer events

We do **not** need to add a new page for this feature; we can extend `HandTrackingPage.tsx` or
create a companion `TwoHandZoomPage.tsx` that reuses most of the same boilerplate.  A new page is
probably cleaner for a first prototype because it keeps mode logic isolated.

The key insight is that tldraw exposes `editor.setCamera()` directly, so we can bypass the pointer
event system entirely for the zoom/pan/rotate gestures and call the camera API once per frame.

---

## 2. Landmark strategy

MediaPipe `HandLandmarker` returns up to `numHands` results.  We use **both** hands:

| Symbol | Landmark | Description |
|--------|----------|-------------|
| `LA`   | 8 (INDEX_TIP) left hand  | anchor point A |
| `RA`   | 8 (INDEX_TIP) right hand | anchor point B |

> Why index tips?  They are the most precisely tracked landmarks and mirror what the current page
> already uses.  Alternatives: use the midpoint of landmark 0 (wrist) on each hand for
> a coarser but more stable anchor.

**Computed values per frame:**
```
midpoint  = (LA + RA) / 2          // where the camera should pan to
span      = |RA - LA|              // Euclidean distance → zoom level
angle     = atan2(RA.y - LA.y, RA.x - LA.x)  // viewport rotation
```

---

## 3. State machine / gesture lifecycle

```
IDLE  ──(both hands visible)──►  ACTIVE
ACTIVE ──(≥1 hand disappears)──► IDLE
```

On the **first frame** where both hands are visible we **latch** the reference state:
- `refSpan`    = initial `span`
- `refAngle`   = initial `angle`
- `refMid`     = initial `midpoint`
- `refCamera`  = `editor.getCamera()` snapshot

On every subsequent **ACTIVE** frame we derive a new camera from the delta:
```
zoomDelta   = currentSpan / refSpan
angleDelta  = currentAngle - refAngle
panDelta    = currentMid - refMid   (in screen pixels, then converted to page units)

newZoom   = refCamera.z * zoomDelta
newX/newY = refCamera.x + panDelta.x / newZoom
            refCamera.y + panDelta.y / newZoom
```

> **Why latch?**  Using absolute frame-to-frame deltas avoids drift — each gesture starts from a
> known snapshot.  Releasing one hand resets the latch so the next two-hand gesture starts fresh.

---

## 4. tldraw camera API

In tldraw v5 the relevant calls are:

```ts
// Read current camera
const cam = editor.getCamera()   // { x, y, z }
// Note: tldraw v5 does not currently expose a "rotation" field on the camera.
// Rotation is therefore deferred to v2 of this feature (see §8).

// Write new camera (instant, no animation)
editor.setCamera({ x: newX, y: newY, z: newZoom }, { immediate: true })
```

For the first iteration we implement **zoom + pan only** (no rotation) because tldraw v5's `Camera`
type is `{ x, y, z }` — `z` is the zoom level (1 = 100%).

---

## 5. Coordinate space conversions

MediaPipe landmarks are normalised `[0, 1]` in the video frame.  We need **screen-space pixels**:

```ts
// containerRef gives us the bounding rect of the Tldraw wrapper div
const rect = containerRef.current!.getBoundingClientRect()
const W = rect.width, H = rect.height

function toScreen(lm: NormalizedLandmark) {
  return { x: (1 - lm.x) * W, y: lm.y * H }   // mirrored on X
}
```

Then to convert a screen-space pan delta to page-space (so we pass the right units to `setCamera`):

```ts
// tldraw's camera x/y are the top-left corner of the viewport in page space.
// Moving the camera by dx screen pixels at zoom z means:
const pageDx = dx / zoom
const pageDy = dy / zoom
```

---

## 6. Preventing interference with single-hand pointer mode

Two modes must coexist gracefully:

| Hands visible | Mode |
|---|---|
| Right hand only | Existing pointer mode (index tip → pointer_move, pinch → click) |
| Both hands | Two-hand zoom mode — **suppress** pointer events so tldraw doesn't also drag |
| Left hand only | Ignore (or implement a future gesture) |
| No hands | Idle |

Implementation: inside `processResult`, detect which hands are present first, then branch:

```ts
const rightIdx = findHand(result, 'Right')
const leftIdx  = findHand(result, 'Left')

if (leftIdx !== -1 && rightIdx !== -1) {
  handleTwoHandZoom(result, leftIdx, rightIdx)
} else {
  handleSingleHandPointer(result, rightIdx)
}
```

When transitioning **from** two-hand mode **back** to single-hand mode:
- Ensure `isPinchedRef.current = false` (cancel any lingering pointer_down)
- Reset latch (`refStateRef.current = null`)

---

## 7. Atom / overlay changes

Add a second atom to communicate two-hand state to the overlay:

```ts
interface TwoHandZoomState {
  active: boolean
  leftX: number; leftY: number   // page coords for left tip
  rightX: number; rightY: number // page coords for right tip
}
const twoHandZoomAtom = atom<TwoHandZoomState>('twoHandZoom', {
  active: false, leftX: 0, leftY: 0, rightX: 0, rightY: 0
})
```

Extend (or add a second) `OverlayUtil` that renders:
- Two small circles at each finger tip
- A dashed line connecting them
- A label in the midpoint showing the current zoom multiplier (e.g. "×1.4")

This gives the user instant visual feedback and helps with debugging during development.

---

## 8. File / component structure

For a new standalone page (recommended for isolation):

```
src/pages/TwoHandZoomPage.tsx        ← new page
  ├─ TwoHandZoomController           ← useEditor() component, mirrors HandTrackingController
  ├─ TwoHandOverlayUtil              ← OverlayUtil subclass
  └─ atoms: twoHandZoomAtom
```

Register the route in `App.tsx` as `/two-hand-zoom` and add a button in `HomePage.tsx`.
Update `worker/index.ts` SPA route list to include the new path.

---

## 9. Sensitivity tuning knobs (constants at top of file)

```ts
const MIN_ZOOM = 0.1        // tldraw minimum: ~0.1
const MAX_ZOOM = 8          // tldraw maximum: ~8
const SPAN_DEADZONE = 0.02  // normalised units — ignore tiny tremors
const SMOOTHING_ALPHA = 0.25 // EMA factor for span/midpoint smoothing
const LATCH_STABLE_FRAMES = 3 // frames both hands must be visible before latching
```

EMA smoothing formula (same approach as EyeTrackingPage):
```ts
smoothedSpan = SMOOTHING_ALPHA * rawSpan + (1 - SMOOTHING_ALPHA) * smoothedSpan
```

---

## 10. Step-by-step implementation checklist

- [ ] **Branch** off `main` → `feature/two-hand-zoom`
- [ ] **Copy** `HandTrackingPage.tsx` → `TwoHandZoomPage.tsx` as starting point
- [ ] **Rename** `HandTrackingController` → `TwoHandZoomController`
- [ ] **Add** `twoHandZoomAtom` and `TwoHandOverlayUtil` (line + dots between tips + zoom label)
- [ ] **Split** `processResult` into `handleSingleHandPointer` + `handleTwoHandZoom`
- [ ] **Implement** latch-based camera computation in `handleTwoHandZoom`
- [ ] **Add** EMA smoothing to `span` and `midpoint`
- [ ] **Wire** `editor.setCamera()` call with clamped `newZoom`
- [ ] **Add route** `/two-hand-zoom` in `App.tsx`, `HomePage.tsx`, `worker/index.ts`
- [ ] **Run** `yarn typecheck` and fix any errors
- [ ] **Manual test** in browser:
  - Single right hand still draws/moves as before
  - Two hands spread apart → zooms in
  - Two hands squeeze → zooms out
  - Two hands translate together → pans canvas
  - Releasing one hand → single-hand mode resumes cleanly

---

## 11. Deferred / future work

| Item | Reason deferred |
|---|---|
| Viewport rotation | `editor.getCamera()` in tldraw v5 has no `rotation` field |
| Smooth zoom animation | Use tldraw animation easing instead of `immediate: true` |
| Stability: N-frame latch warm-up | Reduces accidental latch from a bad first frame |
| Left-hand-only gestures | Out of scope for this feature |

---

## 12. Risks & open questions

1. **tldraw `setCamera` clamping** — tldraw may clamp zoom to its own min/max; test empirically.
2. **Performance** — Running `setCamera` at 30–60 fps should be fine; tldraw re-renders only the
   viewport transform, not every shape.  Profile if there is jank.
3. **Left/Right hand label stability** — MediaPipe occasionally swaps `Left`/`Right` labels across
   frames.  Use `handedness[i][0].score` and prefer the higher-confidence label, or track by
   `handworldLandmarks` X-position as a fallback.
4. **Two-hand detection lag** — The first frame with two hands will latch the reference; if both
   hands appear simultaneously from off-screen there is no warm-up jank.  But if one hand lingers
   at the edge of frame, the latch may be taken with a bad span.  The `LATCH_STABLE_FRAMES`
   constant mitigates this.
