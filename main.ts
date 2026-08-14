import * as THREE from "three";
import type { JointAngles } from "./src/arm";
import { HandTracker } from "./src/handTracking";
import { stepIK, worldPositionToPlanarTarget } from "./src/ik";
import { ControlPanel, type KinematicsMode } from "./src/panel";
import { initScene } from "./src/scene";

const sceneRoot = document.querySelector<HTMLElement>("#scene-root");
const status = document.querySelector<HTMLElement>("#scene-status");

function lerpAngle(from: number, to: number, t: number): number {
  const diff = ((to - from + Math.PI) % (2 * Math.PI)) - Math.PI;
  return from + diff * t;
}

if (sceneRoot) {
  const { scene, camera, renderer, controls, robotArm, targetMarker } = initScene(sceneRoot, {
    onStatus: (message, kind) => {
      if (!status) return;
      status.textContent = message;
      status.dataset.state = kind;
      status.hidden = message === "";
    },
  });

  const panel = new ControlPanel();

  let mode: KinematicsMode = "ik";
  let currentAngles: JointAngles = robotArm.getAngles();
  let fkAngles: JointAngles = panel.readSliderAngles();
  const ikTarget = robotArm.endEffectorPosition(currentAngles);

  panel.onSliderChange((angles) => {
    fkAngles = angles;
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

  // Real webcam hand tracking drives the IK target; a Shift-drag on the 3D
  // view is the fallback when the camera is denied, unavailable, or the
  // tracking model fails to load — the IK math doesn't care which one fed it.
  let fallbackActive = false;
  const handTracker = new HandTracker({
    onStatus: (trackingStatus, message) => {
      panel.setTrackingStatus(trackingStatus, message);
      fallbackActive = trackingStatus === "error";
    },
    onTarget: (worldTarget) => {
      if (mode === "ik" && !fallbackActive) ikTarget.copy(worldTarget);
    },
  });
  panel.mountCameraPreview(handTracker.getVideoElement());
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
      currentAngles = fkAngles;
      robotArm.setAngles(currentAngles);
      const endEffector = robotArm.endEffectorPosition(currentAngles);
      panel.update({ mode, angles: currentAngles, endEffector, jacobian: null, errorNorm: null });
    } else {
      targetMarker.visible = true;
      targetMarker.position.copy(ikTarget);
      const planarTarget = worldPositionToPlanarTarget(ikTarget);
      const result = stepIK(currentAngles.theta1, currentAngles.theta2, currentAngles.theta3, planarTarget);
      currentAngles = {
        theta1: result.theta1,
        theta2: result.theta2,
        theta3: result.theta3,
        baseYaw: lerpAngle(currentAngles.baseYaw, planarTarget.baseYaw, 0.15),
      };
      robotArm.setAngles(currentAngles);
      const endEffector = robotArm.endEffectorPosition(currentAngles);
      panel.update({
        mode,
        angles: currentAngles,
        endEffector,
        jacobian: result.jacobian,
        errorNorm: result.errorNorm,
      });
    }

    renderer.render(scene, camera);
  });
}
