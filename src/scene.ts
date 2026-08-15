import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MAX_REACH, RobotArm } from "./arm";
import { createJointLabels, type JointLabels } from "./labels";

// Vertical FOV, held constant across every viewport aspect.
const BASE_FOV_DEG = 45;
// Horizontal (azimuth) view direction for the default camera: mostly along
// the robot's arm-reach axis with a small Z offset for a three-quarter feel —
// looking near-along the long axis keeps that width out of the frame instead
// of showing its full diagonal.
const VIEW_AZIMUTH = new THREE.Vector2(1, 0.25).normalize();
// A moderate downward tilt for the three-quarter feel.
const ELEVATION_DEG = 16;
// How far up the robot's height the orbit target sits — a gentle bias toward
// the base (rather than the box's exact vertical midpoint) so the base reads
// as grounded while the end effector still reads as clearly higher.
const TARGET_HEIGHT_FRACTION = 0.45;
// Camera distance from the orbit target, scaled to the arm's own reach
// (rather than a per-aspect bounding-box fit, which depended on camera.aspect
// already reflecting the container's real size — a value that could still be
// its default 1:1 the first time this ran, before ResizeObserver's first
// layout pass, silently placing the camera much farther back than intended).
// Tuned so the default pose fills roughly half the viewport.
const CAMERA_DISTANCE = MAX_REACH * 1.35;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 50;
// How close/far OrbitControls lets the visitor zoom. Tight enough that the
// arm can neither shrink to a speck nor get near-clipped mid-joint.
const MIN_ZOOM_DISTANCE = 0.8;
const MAX_ZOOM_DISTANCE = 8;

export type SceneStatusKind = "loading" | "ready" | "error";

export interface InitSceneOptions {
  onStatus?: (message: string, kind: SceneStatusKind) => void;
}

export interface SceneHandles {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  robotArm: RobotArm;
  /** A small marker showing where the current IK target is in the workspace. */
  targetMarker: THREE.Mesh;
  /** A vertical line from the target down to the floor, so depth reads as the point moving through space rather than sliding on a flat plane. */
  targetProjectionLine: THREE.Line;
  /** A ring on the floor grid directly below the target, marking its (x, z). */
  targetFloorRing: THREE.Mesh;
  /** Restores the camera and orbit target to the auto-framed pose computed at load. */
  resetView: () => void;
  /** CSS2D overlay labels tracking each joint's world position. */
  jointLabels: JointLabels;
}

/** Moves the target marker and its floor-projection indicator to `position` in one call, so the target always reads as a 3D point rather than a flat cursor. */
export function setTargetIndicatorPosition(
  handles: Pick<SceneHandles, "targetMarker" | "targetProjectionLine" | "targetFloorRing">,
  position: THREE.Vector3,
): void {
  const { targetMarker, targetProjectionLine, targetFloorRing } = handles;
  targetMarker.position.copy(position);
  targetFloorRing.position.set(position.x, 0.01, position.z);
  const linePositions = targetProjectionLine.geometry.attributes.position as THREE.BufferAttribute;
  linePositions.setXYZ(0, position.x, position.y, position.z);
  linePositions.setXYZ(1, position.x, 0, position.z);
  linePositions.needsUpdate = true;
  targetProjectionLine.computeLineDistances();
}

// Sets up the 3D scene and the procedural RobotArm (see src/arm.ts — a
// GLB with an opaque baked rig can't be driven by named theta1/theta2/theta3
// joints, so the interactive arm is built from primitives with an explicit
// joint hierarchy instead). Does not run its own render loop: main.ts owns
// the per-frame FK/IK update, so it also owns `renderer.setAnimationLoop`.
export function initScene(container: HTMLElement, options: InitSceneOptions = {}): SceneHandles {
  const { onStatus } = options;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12151a);
  scene.fog = new THREE.Fog(0x12151a, 10, 34);

  const camera = new THREE.PerspectiveCamera(BASE_FOV_DEG, 1, CAMERA_NEAR, CAMERA_FAR);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);
  const hemiLight = new THREE.HemisphereLight(0xaecbff, 0x2a2e38, 1.1);
  scene.add(hemiLight);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
  keyLight.position.set(5, 8, 4);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8fb4ff, 0.7);
  fillLight.position.set(-6, 3, -4);
  scene.add(fillLight);

  // Sized relative to the arm's own reach so the floor reads as a coordinate
  // frame under it, not the dominant shape on screen.
  const grid = new THREE.GridHelper(MAX_REACH * 2.6, 12, 0x3a4250, 0x1f232b);
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.6;
  scene.add(grid);
  const axes = new THREE.AxesHelper(MAX_REACH * 0.5);
  const axesMaterial = axes.material as THREE.Material;
  axesMaterial.transparent = true;
  axesMaterial.opacity = 0.6;
  scene.add(axes);

  const robotRoot = new THREE.Group();
  robotRoot.name = "RobotRoot";
  scene.add(robotRoot);
  const robotArm = new RobotArm(robotRoot);
  const jointLabels = createJointLabels(container, robotArm);

  const targetMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x7dff9e, wireframe: true }),
  );
  scene.add(targetMarker);

  const targetProjectionLine = new THREE.Line(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3)),
    new THREE.LineDashedMaterial({ color: 0x7dff9e, transparent: true, opacity: 0.5, dashSize: 0.05, gapSize: 0.05 }),
  );
  scene.add(targetProjectionLine);

  const targetFloorRing = new THREE.Mesh(
    new THREE.RingGeometry(0.05, 0.07, 24),
    new THREE.MeshBasicMaterial({ color: 0x7dff9e, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
  );
  targetFloorRing.rotation.x = -Math.PI / 2;
  scene.add(targetFloorRing);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  // minPolarAngle keeps the visitor from spinning all the way to a bird's-eye
  // view; maxPolarAngle keeps the camera from dipping below the floor.
  controls.minPolarAngle = THREE.MathUtils.degToRad(20);
  controls.maxPolarAngle = Math.PI / 2 - 0.02;

  function resize(): void {
    const { clientWidth: width, clientHeight: height } = container;
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    jointLabels.resize(width, height);
  }
  new ResizeObserver(resize).observe(container);
  resize();

  // Orbit target: center of the arm's resting silhouette, biased toward the
  // base so it reads as grounded rather than centered on the box's exact
  // vertical midpoint.
  const finalBox = new THREE.Box3().setFromObject(robotRoot);
  const finalCenter = finalBox.getCenter(new THREE.Vector3());
  const finalHeight = finalBox.max.y - finalBox.min.y;
  const target = new THREE.Vector3(
    finalCenter.x,
    finalBox.min.y + finalHeight * TARGET_HEIGHT_FRACTION,
    finalCenter.z,
  );

  const horizForward = new THREE.Vector3(VIEW_AZIMUTH.x, 0, VIEW_AZIMUTH.y);
  const elevationRad = THREE.MathUtils.degToRad(ELEVATION_DEG);
  const viewDir = new THREE.Vector3(
    horizForward.x * Math.cos(elevationRad),
    Math.sin(elevationRad),
    horizForward.z * Math.cos(elevationRad),
  );
  camera.position.copy(target).addScaledVector(viewDir, CAMERA_DISTANCE);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  controls.target.copy(target);
  controls.minDistance = MIN_ZOOM_DISTANCE;
  controls.maxDistance = MAX_ZOOM_DISTANCE;
  controls.update();

  // Snapshot the auto-framed pose so "Reset view" can return to it later,
  // rather than to some hardcoded position that would drift out of sync
  // with the fit computed above.
  const initialCameraPosition = camera.position.clone();
  const initialCameraZoom = camera.zoom;
  const initialControlsTarget = controls.target.clone();
  function resetView(): void {
    camera.position.copy(initialCameraPosition);
    camera.zoom = initialCameraZoom;
    camera.updateProjectionMatrix();
    controls.target.copy(initialControlsTarget);
    controls.update();
  }

  onStatus?.("", "ready");

  return {
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
  };
}
