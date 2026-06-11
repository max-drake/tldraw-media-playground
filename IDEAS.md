# New Input Type Ideas

## 🎙️ Hand Tracking + Microphone / Audio Analysis = "Expressive Voice-Gesture Drawing"

### Concept

Combine the existing **hand-tracking pointer** with **real-time microphone audio analysis** (via the Web Audio API) to create an expressive drawing mode where:

- **Hand position** (index-finger tip) → where you draw on the canvas (existing behaviour)
- **Pinch gesture** → pointer down / pointer up (existing behaviour — starts/ends a stroke)
- **Microphone volume (RMS amplitude)** → **stroke width** in real time

The result is a "conduct-to-draw" experience: you hum, sing, speak, or tap a desk to modulate line thickness as you gesture across the canvas. Loud → thick brushstroke; quiet → hairline.

---

### Why It's Interesting

1. **Orthogonal modalities** — spatial (hand) and acoustic (voice/sound) are completely independent channels. They don't interfere with each other and add a genuinely new expressive dimension.
2. **No extra hardware** — all modern laptops/phones already have a microphone alongside the webcam that MediaPipe already uses.
3. **Fits the existing architecture** — the stroke-width can be applied by setting `editor.setStyleForNextShapes(DefaultSizeStyle, ...)` or by directly controlling the `strokeWidth` numeric style before each segment. The audio pipeline is a simple `AnalyserNode` read on each animation frame — it slots naturally alongside the existing `requestAnimationFrame` detect loop in `HandTrackingPage.tsx`.
4. **Expressive art outcome** — users can "sing a shape" with a fat blob for a loud note and a thin wisp for a whisper. This is novel in the whiteboard-tool space.

---

### Technical Sketch

```
Web Audio API
  └─ getUserMedia({ audio: true })
       └─ AudioContext
            └─ MediaStreamSource → AnalyserNode
                 └─ getByteTimeDomainData() → RMS → normalised [0, 1]

Hand tracking (existing)
  └─ index-finger tip → pointer_move
  └─ pinch → pointer_down / pointer_up
  └─ [NEW] before pointer_down: set stroke width = lerp(MIN_WIDTH, MAX_WIDTH, rmsLevel)
```

**Implementation steps:**

1. In `HandTrackingController`, alongside the existing `init()` function, request `getUserMedia({ audio: true })` and create an `AnalyserNode`.
2. On each animation frame (inside `detect()`), read `analyser.getByteTimeDomainData(buffer)`, compute RMS, and store it in a ref.
3. When a pinch starts (`pointer_down`), or continuously while pinching (for variable-width drawing), apply the stroke width:
   ```ts
   const width = lerp(1, 32, rmsRef.current)
   editor.setStyleForNextShapes(DefaultSizeStyle, widthToSizeStyle(width))
   ```
4. Add a small audio-level meter to the camera preview overlay (a vertical bar) so the user gets visual feedback of their microphone input.

**Variant — voice commands for tool switching:**
As a lower-effort alternative (or complement), use the **Web Speech API** (`SpeechRecognition`) for discrete tool commands: say "red", "blue", "circle", "undo", "eraser". This requires zero additional ML models and works offline-ish via the browser's built-in speech engine.

---

### New Route / Page

```
/hand-audio   →  Hand + Mic Drawing
```

**NavBar label:** `🎙️ Hand + Voice`

---

### Open Questions / Risks

| Question | Note |
|---|---|
| Microphone permission UX | Need to handle getUserMedia denial gracefully — fall back to default stroke width |
| Background noise | Consider a noise gate (only react to levels above a baseline) |
| Latency | AnalyserNode reads are sync and on the same rAF loop — should be <16 ms |
| DefaultSizeStyle enum values | tldraw v5 uses 's' or 'm' or 'l' or 'xl' — map continuous RMS to discrete bucket, or use a custom shape with numeric strokeWidth |
| Multi-stroke consistency | Should width be locked at pinch-start, or vary mid-stroke? Both are interesting UX choices |
