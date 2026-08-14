import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MAX_REACH, RobotArm } from "./arm";

// Vertical FOV, held constant across every viewport aspect. The per-corner
// camera fit below already picks whichever of width/height actually binds at
// the current aspect and solves the distance for it, so there's no need to
// widen the FOV on portrait — doing that only added unused vertical frustum
// above/below the robot without bringing the camera any closer, since the
// fit distance stayed pinned to the (unchanged) horizontal constraint.
const BASE_FOV_DEG = 45;
// Horizontal (azimuth) view direction for the default camera: mostly along
// the robot's arm-reach axis with a small Z offset for a three-quarter feel —
// looking near-along the long axis keeps that width out of the frame instead
// of showing its full diagonal.
const VIEW_AZIMUTH = new THREE.Vector2(1, 0.25).normalize();
// A moderate downward tilt for the three-quarter feel, factored into the
// corner-projection fit's own basis below (not bolted on afterward) so the
// fit distance is correct for the actual viewing angle, not a level one.
const ELEVATION_DEG = 16;
// How far up the robot's height the orbit target sits — a gentle bias toward
// the base (rather than the box's exact vertical midpoint) so the base reads
// as grounded while the end effector still reads as clearly higher.
const TARGET_HEIGHT_FRACTION = 0.45;
const FRAMING_MARGIN = 1.15;

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

  const camera = new THREE.PerspectiveCamera(BASE_FOV_DEG, 1, 0.1, 100);
  camera.position.set(4, 3.2, 5);

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

  const targetMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x7dff9e, wireframe: true }),
  );
  scene.add(targetMarker);

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
  }
  new ResizeObserver(resize).observe(container);
  resize();

  // Fit distance from the box's actual silhouette as seen from the real
  // (elevated) camera direction, via per-corner depth-aware projection —
  // not a constant-distance approximation, which treats every corner as if
  // it sat at the target's own depth. Under perspective, a corner that's
  // closer to the camera than the target needs relatively more of the
  // frustum for the same world-space offset, so the required distance for
  // each corner is solved from |offset| <= (fitDistance - rel·viewDir) *
  // tan(halfFov), i.e. fitDistance >= rel·viewDir + |offset| / tan(halfFov).
  const finalBox = new THREE.Box3().setFromObject(robotRoot);
  const finalCenter = finalBox.getCenter(new THREE.Vector3());
  const finalHeight = finalBox.max.y - finalBox.min.y;
  const target = new THREE.Vector3(
    finalCenter.x,
    finalBox.min.y + finalHeight * TARGET_HEIGHT_FRACTION,
    finalCenter.z,
  );

  const halfVFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const halfHFov = Math.atan(Math.tan(halfVFov) * camera.aspect);
  const horizForward = new THREE.Vector3(VIEW_AZIMUTH.x, 0, VIEW_AZIMUTH.y);
  const elevationRad = THREE.MathUtils.degToRad(ELEVATION_DEG);
  const viewDir = new THREE.Vector3(
    horizForward.x * Math.cos(elevationRad),
    Math.sin(elevationRad),
    horizForward.z * Math.cos(elevationRad),
  );
  const worldUp = new THREE.Vector3(0, 1, 0);
  const camRight = new THREE.Vector3().crossVectors(worldUp, viewDir).normalize();
  const camUp = new THREE.Vector3().crossVectors(viewDir, camRight).normalize();
  let fitDistanceUnmargined = 0;
  for (const x of [finalBox.min.x, finalBox.max.x]) {
    for (const y of [finalBox.min.y, finalBox.max.y]) {
      for (const z of [finalBox.min.z, finalBox.max.z]) {
        const rel = new THREE.Vector3(x - target.x, y - target.y, z - target.z);
        const relDepthOffset = rel.dot(viewDir);
        const neededForHeight = relDepthOffset + Math.abs(rel.dot(camUp)) / Math.tan(halfVFov);
        const neededForWidth = relDepthOffset + Math.abs(rel.dot(camRight)) / Math.tan(halfHFov);
        fitDistanceUnmargined = Math.max(fitDistanceUnmargined, neededForHeight, neededForWidth);
      }
    }
  }
  const fitDistance = fitDistanceUnmargined * FRAMING_MARGIN;
  camera.position.copy(target).addScaledVector(viewDir, fitDistance);
  camera.lookAt(target);
  camera.near = Math.max(0.01, fitDistance / 100);
  camera.far = fitDistance * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(target);
  controls.minDistance = fitDistance * 0.4;
  controls.maxDistance = fitDistance * 3;
  controls.update();

  onStatus?.("", "ready");

  return { scene, camera, renderer, controls, robotArm, targetMarker };
}
