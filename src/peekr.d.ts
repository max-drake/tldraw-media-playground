declare module 'peekr' {
  export interface GazeResult {
    output: {
      cpuData: Float32Array
    }
  }

  export interface InitOptions {
    containerId?: string
    video?: HTMLVideoElement | null
    canvas?: HTMLCanvasElement | null
    hide?: boolean
    onReady?: (() => void) | null
    onGaze?: ((gaze: GazeResult) => void) | null
  }

  export function initEyeTracking(options?: InitOptions): void
  export function runEyeTracking(): void
  export function stopEyeTracking(): void
}
