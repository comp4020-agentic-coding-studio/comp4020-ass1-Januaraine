import * as THREE from "three";
import { MAX_REACH } from "./arm";
import type { JointAngles } from "./arm";
import type { HandTrackingStatus, TrackedPose } from "./handTracking";

export type KinematicsMode = "fk" | "ik";

export interface FrameState {
  mode: KinematicsMode;
  angles: JointAngles;
  endEffector: THREE.Vector3;
  /** null in FK mode: no solving is happening, there's nothing to show. */
  jacobian: number[][] | null;
  errorNorm: number | null;
  /** The (reach, height) point the Workspace diagram plots — the raw,
   * unclamped IK target in IK mode (so it can visibly leave the reachable
   * disc), or just the actual end effector in FK mode (always reachable). */
  workspacePoint: { reach: number; height: number };
}

const HISTORY_LENGTH = 240;
const CHART_RANGE_RAD = Math.PI;

// Must match the #workspace-viz SVG's viewBox geometry in index.html: the
// disc is centered at (WORKSPACE_ORIGIN_X, WORKSPACE_ORIGIN_Y) with radius
// MAX_REACH * WORKSPACE_SCALE.
const WORKSPACE_ORIGIN_X = 30;
const WORKSPACE_ORIGIN_Y = 95;
const WORKSPACE_SCALE = 77 / MAX_REACH;
// Cosmetic-only clamp so an extreme tracked point still draws inside the SVG
// viewport instead of flying off it; unrelated to the IK solver's own clamp.
const WORKSPACE_DRAW_LIMIT = MAX_REACH * 1.35;

function required<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`control panel is missing ${selector}`);
  return el;
}

/**
 * Owns every DOM element across the dashboard's left (`#control-panel`) and
 * right (`#right-panel`) columns, all declared statically in index.html so
 * the built page is inspectable without running JS: the FK/IK toggle, the FK
 * sliders, the live Jacobian table, the workspace-reachability dot, the
 * angle-history chart, and camera-tracking status. `main.ts` calls
 * `update()` once per animation frame with the current pose.
 */
export class ControlPanel {
  private readonly fkButton = required<HTMLButtonElement>("#mode-fk");
  private readonly ikButton = required<HTMLButtonElement>("#mode-ik");
  private readonly fkControls = required<HTMLElement>("#fk-controls");
  private readonly ikControls = required<HTMLElement>("#ik-controls");
  private readonly fkExplanation = required<HTMLElement>("#fk-explanation");
  private readonly ikExplanation = required<HTMLElement>("#ik-explanation");
  private readonly sliders = {
    theta1: required<HTMLInputElement>("#slider-theta1"),
    theta2: required<HTMLInputElement>("#slider-theta2"),
    theta3: required<HTMLInputElement>("#slider-theta3"),
    baseYaw: required<HTMLInputElement>("#slider-yaw"),
  };
  private readonly sliderValues = {
    theta1: required<HTMLOutputElement>("#value-theta1"),
    theta2: required<HTMLOutputElement>("#value-theta2"),
    theta3: required<HTMLOutputElement>("#value-theta3"),
    baseYaw: required<HTMLOutputElement>("#value-yaw"),
  };
  private readonly stateCells = {
    eeX: required<HTMLElement>('[data-state="ee-x"]'),
    eeY: required<HTMLElement>('[data-state="ee-y"]'),
    eeZ: required<HTMLElement>('[data-state="ee-z"]'),
    theta1: required<HTMLElement>('[data-state="theta1"]'),
    theta2: required<HTMLElement>('[data-state="theta2"]'),
    theta3: required<HTMLElement>('[data-state="theta3"]'),
    yaw: required<HTMLElement>('[data-state="yaw"]'),
  };
  private readonly workspaceDot = required<SVGCircleElement>("#workspace-dot");
  private readonly trackingStatus = required<HTMLElement>("#tracking-status");
  private readonly cameraPreview = required<HTMLElement>("#camera-preview");
  private readonly trackedCells = {
    shoulder: required<HTMLElement>('[data-tracked="shoulder"]'),
    elbow: required<HTMLElement>('[data-tracked="elbow"]'),
    wrist: required<HTMLElement>('[data-tracked="wrist"]'),
    hand: required<HTMLElement>('[data-tracked="hand"]'),
  };
  private readonly targetCells = {
    x: required<HTMLElement>('[data-target="x"]'),
    y: required<HTMLElement>('[data-target="y"]'),
    z: required<HTMLElement>('[data-target="z"]'),
  };
  private readonly jacobianCells: HTMLElement[][] = [0, 1, 2].map((row) =>
    [0, 1, 2].map((col) => required<HTMLElement>(`[data-cell="${row}-${col}"]`)),
  );
  private readonly ikError = required<HTMLElement>("#ik-error");
  private readonly chart = required<HTMLCanvasElement>("#angle-chart");
  private readonly chartCtx: CanvasRenderingContext2D;

  private history: { theta1: number; theta2: number; theta3: number }[] = [];

  constructor() {
    const ctx = this.chart.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.chartCtx = ctx;
  }

  onModeChange(callback: (mode: KinematicsMode) => void): void {
    this.fkButton.addEventListener("click", () => {
      this.setMode("fk");
      callback("fk");
    });
    this.ikButton.addEventListener("click", () => {
      this.setMode("ik");
      callback("ik");
    });
  }

  private setMode(mode: KinematicsMode): void {
    this.fkButton.setAttribute("aria-pressed", String(mode === "fk"));
    this.ikButton.setAttribute("aria-pressed", String(mode === "ik"));
    this.fkControls.hidden = mode !== "fk";
    this.ikControls.hidden = mode !== "ik";
    // The Jacobian table lives inside #ik-explanation, so hiding it here is
    // what keeps it out of FK mode entirely (never shown, never focusable) —
    // it stays in the built markup only because spec/scene.test.ts checks the
    // static HTML for its 9 data-cell elements.
    this.fkExplanation.hidden = mode !== "fk";
    this.ikExplanation.hidden = mode !== "ik";
  }

  onSliderChange(callback: (angles: JointAngles) => void): void {
    const degToRad = (deg: number) => (deg * Math.PI) / 180;
    const emit = () => {
      const angles: JointAngles = {
        theta1: degToRad(Number(this.sliders.theta1.value)),
        theta2: degToRad(Number(this.sliders.theta2.value)),
        theta3: degToRad(Number(this.sliders.theta3.value)),
        baseYaw: degToRad(Number(this.sliders.baseYaw.value)),
      };
      this.sliderValues.theta1.textContent = `${this.sliders.theta1.value}°`;
      this.sliderValues.theta2.textContent = `${this.sliders.theta2.value}°`;
      this.sliderValues.theta3.textContent = `${this.sliders.theta3.value}°`;
      this.sliderValues.baseYaw.textContent = `${this.sliders.baseYaw.value}°`;
      callback(angles);
    };
    for (const slider of Object.values(this.sliders)) {
      slider.addEventListener("input", emit);
    }
    emit();
  }

  /** Sets the FK sliders to match a pose, e.g. so switching from IK to FK
   * doesn't snap the arm to whatever the sliders last held. */
  setSliderAngles(angles: JointAngles): void {
    const radToDeg = (rad: number) => Math.round((rad * 180) / Math.PI);
    this.sliders.theta1.value = String(radToDeg(angles.theta1));
    this.sliders.theta2.value = String(radToDeg(angles.theta2));
    this.sliders.theta3.value = String(radToDeg(angles.theta3));
    this.sliders.baseYaw.value = String(radToDeg(angles.baseYaw));
    this.sliders.theta1.dispatchEvent(new Event("input"));
  }

  /** Reads the FK sliders' current angles, e.g. to seed IK mode on switch. */
  readSliderAngles(): JointAngles {
    const degToRad = (deg: number) => (deg * Math.PI) / 180;
    return {
      theta1: degToRad(Number(this.sliders.theta1.value)),
      theta2: degToRad(Number(this.sliders.theta2.value)),
      theta3: degToRad(Number(this.sliders.theta3.value)),
      baseYaw: degToRad(Number(this.sliders.baseYaw.value)),
    };
  }

  mountCameraPreview(canvas: HTMLCanvasElement): void {
    this.cameraPreview.replaceChildren(canvas);
  }

  /** Renders the live shoulder/elbow/wrist/hand chain and the derived 3D target, or "–" placeholders when nothing is currently tracked. */
  updateTrackedPose(pose: TrackedPose | null, target: THREE.Vector3 | null): void {
    const fmt = (p: { x: number; y: number } | null | undefined) => (p ? `x ${p.x.toFixed(2)}  y ${p.y.toFixed(2)}` : "–");
    this.trackedCells.shoulder.textContent = fmt(pose?.shoulder);
    this.trackedCells.elbow.textContent = fmt(pose?.elbow);
    this.trackedCells.wrist.textContent = fmt(pose?.wrist);
    this.trackedCells.hand.textContent = fmt(pose?.hand);

    this.targetCells.x.textContent = target ? target.x.toFixed(2) : "–";
    this.targetCells.y.textContent = target ? target.y.toFixed(2) : "–";
    this.targetCells.z.textContent = target ? target.z.toFixed(2) : "–";
  }

  setTrackingStatus(status: HandTrackingStatus, message?: string): void {
    const text: Record<HandTrackingStatus, string> = {
      loading: "Loading arm tracking…",
      tracking: "Tracking your arm — raise a hand and move it to set the target.",
      "no-hand": "No hand in view — show your hand and arm to the camera.",
      error: `Arm tracking unavailable (${message ?? "camera denied"}) — drag inside the 3D view instead.`,
      stopped: "Arm tracking stopped.",
    };
    this.trackingStatus.textContent = text[status];
    this.trackingStatus.dataset.state = status;
  }

  update(state: FrameState): void {
    const ee = state.endEffector;
    this.stateCells.eeX.textContent = ee.x.toFixed(2);
    this.stateCells.eeY.textContent = ee.y.toFixed(2);
    this.stateCells.eeZ.textContent = ee.z.toFixed(2);
    const radToDeg = (rad: number) => Math.round((rad * 180) / Math.PI);
    this.stateCells.theta1.textContent = `${radToDeg(state.angles.theta1)}°`;
    this.stateCells.theta2.textContent = `${radToDeg(state.angles.theta2)}°`;
    this.stateCells.theta3.textContent = `${radToDeg(state.angles.theta3)}°`;
    this.stateCells.yaw.textContent = `${radToDeg(state.angles.baseYaw)}°`;
    this.updateWorkspaceDot(state.workspacePoint);

    if (state.jacobian) {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          this.jacobianCells[row][col].textContent = state.jacobian[row][col].toFixed(2);
        }
      }
      this.ikError.textContent =
        state.errorNorm !== null ? `remaining error: ${state.errorNorm.toFixed(3)}` : "";
    } else {
      for (const row of this.jacobianCells) {
        for (const cell of row) cell.textContent = "–";
      }
      this.ikError.textContent = "not solving in FK mode — angles are set directly";
    }

    this.history.push({
      theta1: state.angles.theta1,
      theta2: state.angles.theta2,
      theta3: state.angles.theta3,
    });
    if (this.history.length > HISTORY_LENGTH) this.history.shift();
    this.drawChart();
  }

  private updateWorkspaceDot(point: { reach: number; height: number }): void {
    const radius = Math.sqrt(point.reach ** 2 + point.height ** 2);
    const reachable = radius <= MAX_REACH;
    const drawScale = radius > WORKSPACE_DRAW_LIMIT ? WORKSPACE_DRAW_LIMIT / radius : 1;
    const cx = WORKSPACE_ORIGIN_X + point.reach * drawScale * WORKSPACE_SCALE;
    const cy = WORKSPACE_ORIGIN_Y - point.height * drawScale * WORKSPACE_SCALE;
    this.workspaceDot.setAttribute("cx", cx.toFixed(1));
    this.workspaceDot.setAttribute("cy", cy.toFixed(1));
    this.workspaceDot.dataset.reachable = String(reachable);
  }

  private drawChart(): void {
    const { width, height } = this.chart;
    const ctx = this.chartCtx;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#12151a";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "#2a2f3a";
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    const series: { key: "theta1" | "theta2" | "theta3"; color: string }[] = [
      { key: "theta1", color: "#ffb347" },
      { key: "theta2", color: "#5b8def" },
      { key: "theta3", color: "#ff6b6b" },
    ];
    const yFor = (rad: number) => height / 2 - (rad / CHART_RANGE_RAD) * (height / 2 - 4);
    const xFor = (index: number) => (index / Math.max(HISTORY_LENGTH - 1, 1)) * width;

    for (const { key, color } of series) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      this.history.forEach((sample, index) => {
        const x = xFor(index);
        const y = yFor(sample[key]);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }
}
