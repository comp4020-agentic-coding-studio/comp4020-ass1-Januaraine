import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// The robot's largest dimension is normalised to this many world units, so the
// scene doesn't depend on whatever units/scale the source GLB was authored in.
const TARGET_SIZE = 3;
const MODEL_URL = `${import.meta.env.BASE_URL}robotic_arm.glb`;
// Vertical FOV at aspect 1:1 — chosen so its derived horizontal FOV matches
// the desktop framing. Narrower (portrait) viewports widen the vertical FOV
// to hold that same horizontal FOV, instead of pushing the camera back until
// the robot looks tiny on a phone screen.
const BASE_FOV_DEG = 45;

export type SceneStatusKind = "loading" | "ready" | "error";

export interface InitSceneOptions {
  onStatus?: (message: string, kind: SceneStatusKind) => void;
}

// Sets up the 3D scene and loads the robot GLB as a single visual asset under
// a dedicated RobotRoot group. No joint hierarchy or animation lives here yet
// — that's deliberately deferred to when FK/IK is implemented, so the group
// is the only extension point this stage commits to.
export function initScene(container: HTMLElement, options: InitSceneOptions = {}): void {
  const { onStatus } = options;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12151a);
  scene.fog = new THREE.Fog(0x12151a, 10, 34);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(4, 3.2, 5);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const hemiLight = new THREE.HemisphereLight(0xaecbff, 0x15171c, 1.1);
  scene.add(hemiLight);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(5, 8, 4);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8fb4ff, 0.4);
  fillLight.position.set(-6, 3, -4);
  scene.add(fillLight);

  const grid = new THREE.GridHelper(10, 20, 0x3a4250, 0x22262e);
  scene.add(grid);
  const axes = new THREE.AxesHelper(1.5);
  scene.add(axes);

  const robotRoot = new THREE.Group();
  robotRoot.name = "RobotRoot";
  scene.add(robotRoot);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.5;
  controls.maxDistance = 30;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.target.set(0, TARGET_SIZE * 0.3, 0);
  camera.lookAt(controls.target);

  function resize(): void {
    const { clientWidth: width, clientHeight: height } = container;
    if (width === 0 || height === 0) return;
    const aspect = width / height;
    camera.aspect = aspect;
    camera.fov =
      aspect >= 1
        ? BASE_FOV_DEG
        : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(BASE_FOV_DEG) / 2) / aspect));
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }
  new ResizeObserver(resize).observe(container);
  resize();

  onStatus?.("Loading robot model…", "loading");
  new GLTFLoader().load(
    MODEL_URL,
    (gltf) => {
      const model = gltf.scene;

      const rawBox = new THREE.Box3().setFromObject(model);
      const rawSize = rawBox.getSize(new THREE.Vector3());

      const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z) || 1;
      model.scale.setScalar(TARGET_SIZE / maxDim);

      const scaledBox = new THREE.Box3().setFromObject(model);
      const scaledCenter = scaledBox.getCenter(new THREE.Vector3());
      model.position.x -= scaledCenter.x;
      model.position.z -= scaledCenter.z;
      model.position.y -= scaledBox.min.y;

      robotRoot.add(model);

      // Fit the camera to the robot's actual footprint (height + ground-plane
      // diagonal), not a bounding sphere — a sphere is sized by the box's
      // full 3D diagonal, which for a bent arm is much larger than what's
      // actually visible from any one angle, leaving the robot looking tiny.
      const finalBox = new THREE.Box3().setFromObject(robotRoot);
      const finalSize = finalBox.getSize(new THREE.Vector3());
      const finalCenter = finalBox.getCenter(new THREE.Vector3());
      const halfVFov = THREE.MathUtils.degToRad(camera.fov) / 2;
      const halfHFov = Math.atan(Math.tan(halfVFov) * camera.aspect);
      const distanceForHeight = finalSize.y / 2 / Math.tan(halfVFov);
      const distanceForWidth = Math.hypot(finalSize.x, finalSize.z) / 2 / Math.tan(halfHFov);
      const fitDistance = Math.max(distanceForHeight, distanceForWidth) * 1.25;

      const direction = new THREE.Vector3(1, 0.6, 1).normalize();
      camera.position.copy(finalCenter).addScaledVector(direction, fitDistance);
      camera.near = Math.max(0.01, fitDistance / 100);
      camera.far = fitDistance * 20;
      camera.updateProjectionMatrix();
      controls.target.copy(finalCenter);
      controls.update();

      onStatus?.("", "ready");
    },
    undefined,
    (error) => {
      console.error("[scene] failed to load robotic_arm.glb", error);
      onStatus?.("Couldn't load the robot model — check the console for details.", "error");
    },
  );

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}
