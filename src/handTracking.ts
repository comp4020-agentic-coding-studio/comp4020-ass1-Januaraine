import * as THREE from "three";
import { DrawingUtils, FilesetResolver, HolisticLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { LINK_LENGTHS, lerpAngle, MAX_REACH } from "./arm";

// Keep in sync with the installed @mediapipe/tasks-vision version — the WASM
// runtime is fetched from the jsdelivr CDN at this exact version so it always
// matches the JS API surface bundled here.
const TASKS_VISION_VERSION = "1.0.1";
const WASM_BASE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
// HolisticLandmarker (not separate Hand + Pose landmarkers) so pose and hand
// come from one detectForVideo call on one frame/timestamp: leftHandLandmarks
// / rightHandLandmarks are already side-labeled and correlated to the same
// detected body, so there's no cross-model "whose wrist is this" heuristic
// needed, and only one GPU-delegate task runs per frame instead of two.
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task";

export type HandTrackingStatus = "loading" | "tracking" | "no-hand" | "error" | "stopped";

export interface Point2D {
  x: number;
  y: number;
}

/**
 * The tracked arm chain for one frame, in raw (unmirrored) normalized image
 * space — shoulder/elbow come from BlazePose's pose landmarks, wrist/hand
 * come from the hand model's own (more precise) landmarks. Any joint the
 * model didn't detect this frame is null rather than stale.
 */
export interface TrackedPose {
  side: "left" | "right" | null;
  shoulder: Point2D | null;
  elbow: Point2D | null;
  wrist: Point2D | null;
  /** Landmark 8, INDEX_FINGER_TIP — the single landmark the 3D target is derived from. */
  hand: Point2D | null;
  /** Angle between wrist→indexMCP and wrist→pinkyMCP; a rough hand-roll estimate, secondary to the chain above. */
  orientationRad: number | null;
  /** Signed bend at the elbow (shoulder→elbow vs elbow→wrist), in the robot's theta2 convention. */
  elbowBendRad: number | null;
  /** Signed pitch at the wrist (elbow→wrist vs wrist→hand), in the robot's theta3 convention. */
  wristPitchRad: number | null;
}

export interface HandTrackingOptions {
  onStatus?: (status: HandTrackingStatus, message?: string) => void;
  onTarget?: (worldTarget: THREE.Vector3) => void;
  onPose?: (pose: TrackedPose) => void;
}

// Maps a landmark in raw image space into the arm's world workspace. The
// exact numbers are tuned by feel (a comfortable wave in front of a webcam
// should sweep roughly the arm's full reach), not derived from anything. This
// is an interaction mapping from monocular landmarks into the robot's 3D
// workspace, not metric 3D reconstruction.
const HEIGHT_RANGE = 1.6;
const DEPTH_BASE = 1.1;
const DEPTH_SCALE = 4.5;
// Landmark 8 (a fingertip) moves faster and jitters more than the stable MCP
// joint the previous palm-only version tracked, so it's smoothed a bit harder.
const SMOOTHING = 0.25;

// BlazePose pose-landmark indices (shoulder/elbow only — wrist/hand come from
// the hand model instead, see below).
const POSE_LANDMARK = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
} as const;

// Hand-landmark indices (21-point topology, same for either hand).
const HAND_LANDMARK = {
  wrist: 0,
  indexMcp: 5,
  indexTip: 8,
  pinkyMcp: 17,
} as const;

function toPoint(landmark: NormalizedLandmark | undefined): Point2D | null {
  return landmark ? { x: landmark.x, y: landmark.y } : null;
}

function handOrientation(hand: NormalizedLandmark[]): number | null {
  const wrist = hand[HAND_LANDMARK.wrist];
  const indexMcp = hand[HAND_LANDMARK.indexMcp];
  const pinkyMcp = hand[HAND_LANDMARK.pinkyMcp];
  if (!wrist || !indexMcp || !pinkyMcp) return null;
  const toIndex = new THREE.Vector2(indexMcp.x - wrist.x, indexMcp.y - wrist.y);
  const toPinky = new THREE.Vector2(pinkyMcp.x - wrist.x, pinkyMcp.y - wrist.y);
  return toIndex.angle() - toPinky.angle();
}

function wrapAngle(rad: number): number {
  return ((rad + Math.PI) % (2 * Math.PI)) - Math.PI;
}

// The robot's own theta1/theta2/theta3 convention (see arm.ts) measures each
// segment's direction as an angle in one vertical plane, via
// cos(angle) = reach component, sin(angle) = height component. This mirrors
// that for a pair of tracked image-space points, using the same
// horizontal/vertical flip already applied to the fingertip target below
// (image x/y → world reach/height), so a segment vector built this way and
// the fingertip target agree on which way is "up." Built as a Vector3 (z=0)
// so it's a genuine vector angle computation, not just two atan2 calls on
// raw numbers — but deliberately 2D: shoulder/elbow come from the pose
// model's z (world-scale depth) while wrist/hand come from the hand model's
// z (relative to that hand's own wrist, a different scale entirely), so a
// vector spanning the two — e.g. elbow→wrist — would subtract two
// incompatible depth values. Using x/y only avoids manufacturing a fake
// "more 3D" number out of two numbers that were never on the same scale.
function segmentAngle(from: Point2D, to: Point2D): number {
  const v = new THREE.Vector3(-(to.x - from.x), -(to.y - from.y), 0);
  return Math.atan2(v.y, v.x);
}

/** Signed elbow bend (shoulder→elbow vs elbow→wrist), in the robot's theta2 convention (a2 = a1 + theta2). */
function elbowBendAngle(shoulder: Point2D | null, elbow: Point2D | null, wrist: Point2D | null): number | null {
  if (!shoulder || !elbow || !wrist) return null;
  return wrapAngle(segmentAngle(elbow, wrist) - segmentAngle(shoulder, elbow));
}

/** Signed wrist pitch (elbow→wrist vs wrist→hand), in the robot's theta3 convention (a3 = a2 + theta3). */
function wristPitchAngle(elbow: Point2D | null, wrist: Point2D | null, hand: Point2D | null): number | null {
  if (!elbow || !wrist || !hand) return null;
  return wrapAngle(segmentAngle(wrist, hand) - segmentAngle(elbow, wrist));
}

/**
 * Wraps MediaPipe's HolisticLandmarker: requests the webcam, loads the model,
 * and reports a smoothed 3D target plus the tracked shoulder/elbow/wrist/hand
 * chain once per detected frame. Also owns a <canvas> that draws the raw
 * camera frame with a skeleton overlay burned in, so the tracking result is
 * visible directly on the camera image. Callers must treat
 * `onStatus("error", ...)` as a signal to fall back to another input source
 * (e.g. pointer drag) — this module never falls back on its own.
 */
export class HandTracker {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private canvasCtx: CanvasRenderingContext2D;
  private drawingUtils: DrawingUtils;
  private landmarker: HolisticLandmarker | null = null;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private stopped = false;
  private smoothed: THREE.Vector3 | null = null;
  private smoothedElbowBend: number | null = null;
  private smoothedWristPitch: number | null = null;
  private activeSide: "left" | "right" | null = null;
  private readonly onStatus: HandTrackingOptions["onStatus"];
  private readonly onTarget: HandTrackingOptions["onTarget"];
  private readonly onPose: HandTrackingOptions["onPose"];

  constructor(options: HandTrackingOptions = {}) {
    this.onStatus = options.onStatus;
    this.onTarget = options.onTarget;
    this.onPose = options.onPose;
    this.video = document.createElement("video");
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;

    // The canvas — not the video — is what gets mounted in the panel. It's
    // redrawn every frame from the raw (unmirrored) video plus an overlay
    // drawn in that same raw space, then mirrored as one composited image so
    // the overlay can never drift out of alignment with the picture under it.
    this.canvas = document.createElement("canvas");
    this.canvas.style.transform = "scaleX(-1)";
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable for camera overlay");
    this.canvasCtx = ctx;
    this.drawingUtils = new DrawingUtils(ctx);
  }

  /** The live tracking-overlay canvas (camera frame + skeleton), for mounting in the control panel. */
  getCanvasElement(): HTMLCanvasElement {
    return this.canvas;
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
      this.landmarker = await HolisticLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
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
      if (this.canvas.width !== this.video.videoWidth || this.canvas.height !== this.video.videoHeight) {
        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;
      }
      this.canvasCtx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

      const result = this.landmarker.detectForVideo(this.video, performance.now());
      const leftHand = result.leftHandLandmarks[0];
      const rightHand = result.rightHandLandmarks[0];

      // Keep tracking whichever side was already active if both hands are
      // briefly in frame, so the target doesn't jump between them.
      if (leftHand && rightHand) {
        // no change — keep this.activeSide
      } else if (leftHand) {
        this.activeSide = "left";
      } else if (rightHand) {
        this.activeSide = "right";
      } else {
        this.activeSide = null;
      }

      const hand = this.activeSide === "left" ? leftHand : this.activeSide === "right" ? rightHand : null;

      if (hand) {
        const pose = result.poseLandmarks[0];
        const shoulderIdx = this.activeSide === "left" ? POSE_LANDMARK.leftShoulder : POSE_LANDMARK.rightShoulder;
        const elbowIdx = this.activeSide === "left" ? POSE_LANDMARK.leftElbow : POSE_LANDMARK.rightElbow;

        const shoulderPoint = toPoint(pose?.[shoulderIdx]);
        const elbowPoint = toPoint(pose?.[elbowIdx]);
        const wristPoint = toPoint(hand[HAND_LANDMARK.wrist]);
        const handPoint = toPoint(hand[HAND_LANDMARK.indexTip]);

        // Smoothed like the target position below: a single dropped
        // shoulder/elbow frame holds the last known angle rather than
        // snapping the joint to null-driven fallback for one frame.
        const rawElbowBend = elbowBendAngle(shoulderPoint, elbowPoint, wristPoint);
        this.smoothedElbowBend =
          rawElbowBend === null
            ? this.smoothedElbowBend
            : this.smoothedElbowBend === null
              ? rawElbowBend
              : lerpAngle(this.smoothedElbowBend, rawElbowBend, SMOOTHING);
        const rawWristPitch = wristPitchAngle(elbowPoint, wristPoint, handPoint);
        this.smoothedWristPitch =
          rawWristPitch === null
            ? this.smoothedWristPitch
            : this.smoothedWristPitch === null
              ? rawWristPitch
              : lerpAngle(this.smoothedWristPitch, rawWristPitch, SMOOTHING);

        const trackedPose: TrackedPose = {
          side: this.activeSide,
          shoulder: shoulderPoint,
          elbow: elbowPoint,
          wrist: wristPoint,
          hand: handPoint,
          orientationRad: handOrientation(hand),
          elbowBendRad: this.smoothedElbowBend,
          wristPitchRad: this.smoothedWristPitch,
        };
        this.onPose?.(trackedPose);
        this.drawOverlay(trackedPose, hand);

        const tip = hand[HAND_LANDMARK.indexTip];
        const rawX = (0.5 - tip.x) * 2 * (LINK_LENGTHS.shoulder + LINK_LENGTHS.elbow);
        const rawY = LINK_LENGTHS.base + (1 - tip.y) * HEIGHT_RANGE;
        const rawZ = DEPTH_BASE + -tip.z * DEPTH_SCALE;
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

  /** Draws the shoulder–elbow–wrist chain, the full hand mesh, and a ring marking the target-source landmark — all in the same raw image space as the frame just drawn. */
  private drawOverlay(pose: TrackedPose, hand: NormalizedLandmark[]): void {
    const ctx = this.canvasCtx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const toPx = (p: Point2D): [number, number] => [p.x * w, p.y * h];

    // The shoulder→elbow→wrist chain is drawn by hand rather than via
    // HolisticLandmarker.POSE_CONNECTIONS, which also includes the legs,
    // torso, and other arm — a full-body graph would bury the specific
    // chain the explainer is about.
    const chain = [pose.shoulder, pose.elbow, pose.wrist].filter((p): p is Point2D => p !== null);
    if (chain.length > 1) {
      ctx.strokeStyle = "#7dff9e";
      ctx.lineWidth = 3;
      ctx.beginPath();
      chain.forEach((p, i) => {
        const [x, y] = toPx(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    const joints: [Point2D | null, string][] = [
      [pose.shoulder, "#ffb347"],
      [pose.elbow, "#5b8def"],
      [pose.wrist, "#ff6b6b"],
    ];
    for (const [p, color] of joints) {
      if (!p) continue;
      const [x, y] = toPx(p);
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // The full hand mesh — "use hand landmarks where useful" for the hand
    // itself, beyond just the single target-source fingertip.
    this.drawingUtils.drawConnectors(hand, HolisticLandmarker.HAND_CONNECTIONS, {
      color: "#5b8def",
      lineWidth: 1.5,
    });
    this.drawingUtils.drawLandmarks(hand, { color: "#9aa4b2", radius: 1.5 });

    // Highlight the index fingertip specifically: this is the point the 3D
    // target is derived from, not just another hand landmark.
    if (pose.hand) {
      const [x, y] = toPx(pose.hand);
      ctx.beginPath();
      ctx.strokeStyle = "#7dff9e";
      ctx.lineWidth = 2;
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

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
