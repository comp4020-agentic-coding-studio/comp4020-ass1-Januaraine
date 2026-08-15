import * as THREE from "three";

// A 3-link planar arm: shoulder (theta1), elbow (theta2), and wrist (theta3)
// all hinge about the same horizontal axis within a vertical plane, plus a
// free base yaw that turns that whole plane to face a target's azimuth. This
// is the classic exactly-determined case — 2 position unknowns (reach,
// height) + 1 orientation unknown (tool pitch) for 3 joint angles — which is
// why the brief's three named angles are the right amount to solve for, and
// it keeps the Jacobian a legible 3x3 rather than a general 3D spatial one.
export const LINK_LENGTHS = {
  base: 0.45,
  shoulder: 1.05,
  elbow: 0.85,
  wrist: 0.5,
} as const;

export const MAX_REACH = LINK_LENGTHS.shoulder + LINK_LENGTHS.elbow + LINK_LENGTHS.wrist;

/**
 * Wraps an angle (or an angle difference) into (-π, π]. `%` alone doesn't do
 * this correctly for magnitudes near ±2π — e.g. `((-6 + π) % 2π) - π` returns
 * -6 unchanged in JS, because `%` there keeps the sign/magnitude of the
 * dividend rather than reducing it mod 2π first. Rounding to the nearest
 * multiple of 2π and subtracting is exact regardless of magnitude or sign.
 */
export function wrapAngle(rad: number): number {
  return rad - 2 * Math.PI * Math.round(rad / (2 * Math.PI));
}

/** Shortest-path angle interpolation — lerping raw radians breaks near the ±π wrap. */
export function lerpAngle(from: number, to: number, t: number): number {
  return from + wrapAngle(to - from) * t;
}

export interface JointAngles {
  theta1: number;
  theta2: number;
  theta3: number;
  baseYaw: number;
}

export interface PlanarPose {
  /** Horizontal distance from the base's vertical axis. */
  reach: number;
  /** Height above the shoulder pivot. */
  height: number;
  /** Cumulative tool pitch, theta1 + theta2 + theta3. */
  pitch: number;
}

/** Forward kinematics within the arm's vertical plane (ignores base yaw). */
export function planarForwardKinematics(theta1: number, theta2: number, theta3: number): PlanarPose {
  const a1 = theta1;
  const a2 = theta1 + theta2;
  const a3 = theta1 + theta2 + theta3;
  const { shoulder, elbow, wrist } = LINK_LENGTHS;
  return {
    reach: shoulder * Math.cos(a1) + elbow * Math.cos(a2) + wrist * Math.cos(a3),
    height: shoulder * Math.sin(a1) + elbow * Math.sin(a2) + wrist * Math.sin(a3),
    pitch: a3,
  };
}

/**
 * Analytic Jacobian of (reach, height, pitch) with respect to
 * (theta1, theta2, theta3) — a standard planar-arm derivative chain, exact
 * (not a numeric approximation), which is what the panel renders live.
 */
export function planarJacobian(theta1: number, theta2: number, theta3: number): number[][] {
  const a1 = theta1;
  const a2 = theta1 + theta2;
  const a3 = theta1 + theta2 + theta3;
  const { shoulder, elbow, wrist } = LINK_LENGTHS;
  const dReach_dA1 = -shoulder * Math.sin(a1);
  const dReach_dA2 = -elbow * Math.sin(a2);
  const dReach_dA3 = -wrist * Math.sin(a3);
  const dHeight_dA1 = shoulder * Math.cos(a1);
  const dHeight_dA2 = elbow * Math.cos(a2);
  const dHeight_dA3 = wrist * Math.cos(a3);
  // Chain rule: a1 depends only on theta1; a2 on theta1+theta2; a3 on all three.
  return [
    [dReach_dA1 + dReach_dA2 + dReach_dA3, dReach_dA2 + dReach_dA3, dReach_dA3],
    [dHeight_dA1 + dHeight_dA2 + dHeight_dA3, dHeight_dA2 + dHeight_dA3, dHeight_dA3],
    [1, 1, 1],
  ];
}

function orientCylinderBetween(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void {
  const offset = new THREE.Vector3().subVectors(to, from);
  const length = Math.max(offset.length(), 1e-4);
  mesh.position.copy(from).addScaledVector(offset, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), offset.clone().normalize());
  mesh.scale.set(1, length, 1);
}

/**
 * The procedural robot arm: an explicit theta1/theta2/theta3 + baseYaw joint
 * hierarchy built from primitives, so both FK (set angles, read position) and
 * IK (solve angles from a target) drive real, named joints — unlike the
 * loaded GLB's opaque baked-rig skeleton, which has no such mapping.
 */
export class RobotArm {
  readonly group: THREE.Group;
  private readonly turntable: THREE.Mesh;
  private readonly linkMeshes: [THREE.Mesh, THREE.Mesh, THREE.Mesh];
  private readonly jointMeshes: [THREE.Mesh, THREE.Mesh, THREE.Mesh];
  private readonly effectorMesh: THREE.Mesh;
  private angles: JointAngles = { theta1: Math.PI / 4, theta2: -Math.PI / 3, theta3: -Math.PI / 6, baseYaw: 0 };

  constructor(parent: THREE.Object3D) {
    this.group = new THREE.Group();
    this.group.name = "RobotArm";
    parent.add(this.group);

    const metal = new THREE.MeshStandardMaterial({ color: 0x4a5568, roughness: 0.5, metalness: 0.6 });
    const link = new THREE.MeshStandardMaterial({ color: 0x5b8def, roughness: 0.4, metalness: 0.3 });
    const joint = new THREE.MeshStandardMaterial({ color: 0xffb347, roughness: 0.35, metalness: 0.5 });
    const effector = new THREE.MeshStandardMaterial({ color: 0xff6b6b, roughness: 0.3, metalness: 0.4 });

    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, LINK_LENGTHS.base, 20), metal);
    pillar.position.y = LINK_LENGTHS.base / 2;
    this.group.add(pillar);

    this.turntable = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.06, 24), metal);
    this.turntable.position.y = LINK_LENGTHS.base;
    this.group.add(this.turntable);

    const unitCylinder = () => new THREE.CylinderGeometry(0.07, 0.07, 1, 16);
    this.linkMeshes = [
      new THREE.Mesh(unitCylinder(), link),
      new THREE.Mesh(unitCylinder(), link),
      new THREE.Mesh(unitCylinder(), link),
    ];
    this.jointMeshes = [
      new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 16), joint),
      new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 16), joint),
      new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 16), joint),
    ];
    this.effectorMesh = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 16), effector);
    for (const mesh of [...this.linkMeshes, ...this.jointMeshes, this.effectorMesh]) {
      this.group.add(mesh);
    }

    this.setAngles(this.angles);
  }

  getAngles(): JointAngles {
    return { ...this.angles };
  }

  /** World-space position of each joint plus the end effector. */
  private jointWorldPositions(angles: JointAngles): THREE.Vector3[] {
    const { theta1, theta2, theta3, baseYaw } = angles;
    const forward = new THREE.Vector3(Math.sin(baseYaw), 0, Math.cos(baseYaw));
    const up = new THREE.Vector3(0, 1, 0);
    const shoulder = new THREE.Vector3(0, LINK_LENGTHS.base, 0);
    const dirAt = (cumulativeAngle: number) =>
      forward.clone().multiplyScalar(Math.cos(cumulativeAngle)).addScaledVector(up, Math.sin(cumulativeAngle));
    const a1 = theta1;
    const a2 = theta1 + theta2;
    const a3 = theta1 + theta2 + theta3;
    const elbow = shoulder.clone().addScaledVector(dirAt(a1), LINK_LENGTHS.shoulder);
    const wrist = elbow.clone().addScaledVector(dirAt(a2), LINK_LENGTHS.elbow);
    const end = wrist.clone().addScaledVector(dirAt(a3), LINK_LENGTHS.wrist);
    return [shoulder, elbow, wrist, end];
  }

  /** Pure FK: world-space end-effector position for a given pose, no mutation. */
  endEffectorPosition(angles: JointAngles): THREE.Vector3 {
    return this.jointWorldPositions(angles)[3];
  }

  setAngles(angles: JointAngles): void {
    this.angles = { ...angles };
    this.turntable.rotation.y = angles.baseYaw;
    const [shoulder, elbow, wrist, end] = this.jointWorldPositions(angles);
    orientCylinderBetween(this.linkMeshes[0], shoulder, elbow);
    orientCylinderBetween(this.linkMeshes[1], elbow, wrist);
    orientCylinderBetween(this.linkMeshes[2], wrist, end);
    this.jointMeshes[0].position.copy(shoulder);
    this.jointMeshes[1].position.copy(elbow);
    this.jointMeshes[2].position.copy(wrist);
    this.effectorMesh.position.copy(end);
    this.effectorMesh.quaternion.copy(this.linkMeshes[2].quaternion);
  }
}
