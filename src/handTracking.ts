import * as THREE from "three";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { LINK_LENGTHS, MAX_REACH } from "./arm";

// Keep in sync with the installed @mediapipe/tasks-vision version — the WASM
// runtime is fetched from the jsdelivr CDN at this exact version so it always
// matches the JS API surface bundled here.
const TASKS_VISION_VERSION = "1.0.1";
const WASM_BASE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

export type HandTrackingStatus = "loading" | "tracking" | "no-hand" | "error" | "stopped";

export interface HandTrackingOptions {
  onStatus?: (status: HandTrackingStatus, message?: string) => void;
  onTarget?: (worldTarget: THREE.Vector3) => void;
}

// Maps a mirrored-selfie-view landmark into the arm's world workspace. The
// exact numbers are tuned by feel (a comfortable wave in front of a webcam
// should sweep roughly the arm's full reach), not derived from anything.
const HEIGHT_RANGE = 1.6;
const DEPTH_BASE = 1.1;
const DEPTH_SCALE = 4.5;
const SMOOTHING = 0.35;

/**
 * Wraps MediaPipe's HandLandmarker: requests the webcam, loads the model,
 * and reports a smoothed 3D target once per detected frame. Callers must
 * treat `onStatus("error", ...)` as a signal to fall back to another input
 * source (e.g. pointer drag) — this module never falls back on its own.
 */
export class HandTracker {
  private video: HTMLVideoElement;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private stopped = false;
  private smoothed: THREE.Vector3 | null = null;
  private readonly onStatus: HandTrackingOptions["onStatus"];
  private readonly onTarget: HandTrackingOptions["onTarget"];

  constructor(options: HandTrackingOptions = {}) {
    this.onStatus = options.onStatus;
    this.onTarget = options.onTarget;
    this.video = document.createElement("video");
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    // Mirrored so moving a hand to the right (from the user's point of view)
    // reads as "right" in the preview, matching a mirror rather than a
    // security-camera feed.
    this.video.style.transform = "scaleX(-1)";
  }

  /** The live (mirrored) camera preview, for mounting in the control panel. */
  getVideoElement(): HTMLVideoElement {
    return this.video;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail("This browser can't access the camera.");
      return;
    }
    this.onStatus?.("loading");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 320, height: 240 },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();

      const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 1,
      });

      if (this.stopped) return;
      this.onStatus?.("tracking");
      this.loop();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Camera or model failed to start.");
    }
  }

  private fail(message: string): void {
    this.onStatus?.("error", message);
    this.stop();
  }

  private loop = (): void => {
    if (this.stopped || !this.landmarker) return;
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const result = this.landmarker.detectForVideo(this.video, performance.now());
      const landmarks = result.landmarks[0];
      if (landmarks) {
        // Landmark 9 is the middle-finger MCP joint — a stable palm-centre
        // proxy that doesn't jump around like a fingertip does.
        const palm = landmarks[9];
        const rawX = (0.5 - palm.x) * 2 * (LINK_LENGTHS.shoulder + LINK_LENGTHS.elbow);
        const rawY = LINK_LENGTHS.base + (1 - palm.y) * HEIGHT_RANGE;
        const rawZ = DEPTH_BASE + -palm.z * DEPTH_SCALE;
        const raw = new THREE.Vector3(rawX, rawY, rawZ).clampLength(0, MAX_REACH * 1.5);
        this.smoothed = this.smoothed ? this.smoothed.lerp(raw, SMOOTHING) : raw;
        this.onTarget?.(this.smoothed.clone());
        this.onStatus?.("tracking");
      } else {
        this.onStatus?.("no-hand");
      }
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  stop(): void {
    this.stopped = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.landmarker?.close();
    this.landmarker = null;
  }
}
