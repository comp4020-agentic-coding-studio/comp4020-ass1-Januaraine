import * as THREE from "three";
import { DEFAULT_ANGLES, type JointAngles, LINK_LENGTHS, lerpAngle } from "./src/arm";
import { HandTracker, type TrackedPose } from "./src/handTracking";
import { stepIK, worldPositionToPlanarTarget } from "./src/ik";
import { ControlPanel, type KinematicsMode } from "./src/panel";
import { initScene, setTargetIndicatorPosition } from "./src/scene";
import { applyDomTheme, getInitialTheme, setStoredTheme, type Theme } from "./src/theme";

const sceneRoot = document.querySelector<HTMLElement>("#scene-root");
const status = document.querySelector<HTMLElement>("#scene-status");

if (sceneRoot) {
  const {
    scene,
    camera,
    renderer,
    controls,
    robotArm,
    targetMarker,
    targetProjectionLine,
    targetFloorRing,
    resetView,
    jointLabels,
    applyTheme: applySceneTheme,
  } = initScene(sceneRoot, {
      onStatus: (message, kind) => {
        if (!status) return;
        status.textContent = message;
        status.dataset.state = kind;
        status.hidden = message === "";
      },
    });

  const panel = new ControlPanel();

  let theme: Theme = getInitialTheme();
  const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
  function setTheme(next: Theme): void {
    theme = next;
    applyDomTheme(theme);
    setStoredTheme(theme);
    panel.setTheme(theme);
    applySceneTheme(theme);
    if (themeToggle) {
      themeToggle.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
      themeToggle.innerHTML =
        theme === "dark" ? '<span aria-hidden="true">🌙</span> Dark' : '<span aria-hidden="true">☀️</span> Light';
    }
  }
  themeToggle?.addEventListener("click", () => setTheme(theme === "dark" ? "light" : "dark"));
  setTheme(theme);

  let mode: KinematicsMode = "ik";
  let currentAngles: JointAngles = robotArm.getAngles();
  let fkAngles: JointAngles = panel.readSliderAngles();
  const ikTarget = robotArm.endEffectorPosition(currentAngles);
  // Captured once, before anything moves it — what "Reset view" returns the
  // IK target to.
  const defaultIkTarget = ikTarget.clone();

  panel.onSliderChange((angles) => {
    fkAngles = angles;
  });

  panel.onResetView(() => {
    resetView();
    if (mode === "fk") {
      fkAngles = DEFAULT_ANGLES;
      panel.setSliderAngles(DEFAULT_ANGLES);
    } else {
      ikTarget.copy(defaultIkTarget);
    }
  });

  panel.onModeChange((next) => {
    if (next === mode) return;
    if (next === "fk") {
      // Seed the sliders from wherever IK left the arm, so switching modes
      // doesn't snap it to whatever the sliders last held.
      panel.setSliderAngles(currentAngles);
      fkAngles = currentAngles;
    } else {
      // Seed the IK target from the arm's current end effector, for the
      // same reason in the other direction.
      ikTarget.copy(robotArm.endEffectorPosition(currentAngles));
    }
    mode = next;
  });

  // Real webcam arm/hand tracking drives the IK target; a Shift-drag on the
  // 3D view is the fallback when the camera is denied, unavailable, or the
  // tracking model fails to load — the IK math doesn't care which one fed it.
  let fallbackActive = false;
  let trackedPose: TrackedPose | null = null;
  const handTracker = new HandTracker({
    onStatus: (trackingStatus, message) => {
      panel.setTrackingStatus(trackingStatus, message);
      fallbackActive = trackingStatus === "error";
      if (trackingStatus === "no-hand") trackedPose = null;
    },
    onTarget: (worldTarget) => {
      if (mode === "ik" && !fallbackActive) ikTarget.copy(worldTarget);
    },
    onPose: (pose) => {
      trackedPose = pose;
    },
  });
  panel.mountCameraPreview(handTracker.getCanvasElement());
  void handTracker.start();

  const raycaster = new THREE.Raycaster();
  const dragPlane = new THREE.Plane();
  const pointerNDC = new THREE.Vector2();
  let shiftHeld = false;

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Shift") return;
    shiftHeld = true;
    controls.enabled = false;
  });
  window.addEventListener("keyup", (event) => {
    if (event.key !== "Shift") return;
    shiftHeld = false;
    controls.enabled = true;
  });

  function dragTargetTo(clientX: number, clientY: number): void {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNDC, camera);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    dragPlane.setFromNormalAndCoplanarPoint(camDir, controls.target);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, hit)) ikTarget.copy(hit);
  }

  renderer.domElement.addEventListener("pointerdown", (event) => {
    if (shiftHeld && mode === "ik") dragTargetTo(event.clientX, event.clientY);
  });
  renderer.domElement.addEventListener("pointermove", (event) => {
    if (shiftHeld && event.buttons > 0 && mode === "ik") dragTargetTo(event.clientX, event.clientY);
  });

  renderer.setAnimationLoop(() => {
    controls.update();

    if (mode === "fk") {
      targetMarker.visible = false;
      targetProjectionLine.visible = false;
      targetFloorRing.visible = false;
      currentAngles = fkAngles;
      robotArm.setAngles(currentAngles);
      const endEffector = robotArm.endEffectorPosition(currentAngles);
      const workspacePoint = {
        reach: Math.sqrt(endEffector.x ** 2 + endEffector.z ** 2),
        height: endEffector.y - LINK_LENGTHS.base,
      };
      panel.update({ mode, angles: currentAngles, endEffector, jacobian: null, errorNorm: null, workspacePoint });
      panel.updateTrackedPose(trackedPose, null);
      jointLabels.setEndEffectorText(formatEndEffectorText(endEffector));
    } else {
      targetMarker.visible = true;
      targetProjectionLine.visible = true;
      targetFloorRing.visible = true;
      setTargetIndicatorPosition({ targetMarker, targetProjectionLine, targetFloorRing }, ikTarget);
      const planarTarget = worldPositionToPlanarTarget(ikTarget);
      const result = stepIK(currentAngles.theta1, currentAngles.theta2, currentAngles.theta3, planarTarget);
      // theta1/baseYaw keep chasing the fingertip target via IK exactly as
      // before. theta2/theta3 are overridden from the tracked arm's own
      // elbow bend / wrist pitch when available (clamped to the same
      // physical range stepIK enforces internally), so the robot's elbow and
      // wrist visibly match the real arm's posture instead of just whatever
      // angles reach the target with a level tool. Falling back to
      // `result.theta2/theta3` (the classic solve) when no pose is tracked —
      // e.g. the Shift-drag fallback — needs no special-casing here. A second
      // actuator-level lerp (on top of handTracking.ts's own source-level
      // smoothing) damps whatever per-frame noise still reaches this point
      // before it hits the joint.
      const clampJoint = (v: number) => Math.max(-Math.PI, Math.min(Math.PI, v));
      currentAngles = {
        theta1: lerpAngle(currentAngles.theta1, result.theta1, 0.15),
        theta2: clampJoint(lerpAngle(currentAngles.theta2, trackedPose?.elbowBendRad ?? result.theta2, 0.15)),
        theta3: clampJoint(lerpAngle(currentAngles.theta3, trackedPose?.wristPitchRad ?? result.theta3, 0.15)),
        baseYaw: lerpAngle(currentAngles.baseYaw, planarTarget.baseYaw, 0.15),
      };
      robotArm.setAngles(currentAngles);
      const endEffector = robotArm.endEffectorPosition(currentAngles);
      // The raw, unclamped target — unlike worldPositionToPlanarTarget's
      // reach/height (which clamps into the reachable disc for the solver),
      // this is what the Workspace diagram plots so an out-of-reach hand
      // position visibly shows as out of reach.
      const workspacePoint = {
        reach: Math.sqrt(ikTarget.x ** 2 + ikTarget.z ** 2),
        height: ikTarget.y - LINK_LENGTHS.base,
      };
      panel.update({
        mode,
        angles: currentAngles,
        endEffector,
        jacobian: result.jacobian,
        errorNorm: result.errorNorm,
        workspacePoint,
      });
      panel.updateTrackedPose(trackedPose, ikTarget);
      jointLabels.setEndEffectorText(formatEndEffectorText(endEffector));
    }

    renderer.render(scene, camera);
    jointLabels.render(scene, camera);
  });
}

function formatEndEffectorText(position: THREE.Vector3): string {
  return `(${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)})`;
}
