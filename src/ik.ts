import * as THREE from "three";
import { LINK_LENGTHS, MAX_REACH, planarForwardKinematics, planarJacobian } from "./arm";

export interface PlanarTarget {
  baseYaw: number;
  reach: number;
  height: number;
  /** Desired tool pitch — kept level (0) so the tool reads as "always horizontal". */
  pitch: number;
}

export interface IKStepResult {
  theta1: number;
  theta2: number;
  theta3: number;
  jacobian: number[][];
  error: [number, number, number];
  errorNorm: number;
}

/** Converts a world-space hand/pointer position into the arm's planar target. */
export function worldPositionToPlanarTarget(worldTarget: THREE.Vector3): PlanarTarget {
  const baseYaw = Math.atan2(worldTarget.x, worldTarget.z);
  let reach = Math.sqrt(worldTarget.x ** 2 + worldTarget.z ** 2);
  let height = worldTarget.y - LINK_LENGTHS.base;
  // Radial clamp into the reachable disc so an out-of-range hand position
  // still gives the solver a sane target to converge toward, instead of one
  // it can never reach and would keep straining against.
  const radius = Math.sqrt(reach ** 2 + height ** 2);
  const limit = MAX_REACH * 0.97;
  if (radius > limit) {
    const scale = limit / radius;
    reach *= scale;
    height *= scale;
  }
  return { baseYaw, reach, height, pitch: 0 };
}

const SUBSTEPS_PER_CALL = 6;
const GAIN = 0.35;
const MAX_STEP_RAD = 0.2;
// The one remaining physical clamp: keeps the shoulder from swinging visibly
// below the base plane, through the floor grid.
const SHOULDER_MIN_RAD = THREE.MathUtils.degToRad(-80);

/**
 * Runs a handful of damped Jacobian-transpose iterations toward `target`,
 * starting from the current (theta1, theta2, theta3). Called once per
 * animation frame with the latest target, so convergence is visibly
 * incremental — the panel renders the Jacobian and error this function
 * returns, which is the "solving process," not just the final answer.
 */
export function stepIK(theta1: number, theta2: number, theta3: number, target: PlanarTarget): IKStepResult {
  let t1 = theta1;
  let t2 = theta2;
  let t3 = theta3;
  let jacobian = planarJacobian(t1, t2, t3);
  let error: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < SUBSTEPS_PER_CALL; i++) {
    const pose = planarForwardKinematics(t1, t2, t3);
    error = [target.reach - pose.reach, target.height - pose.height, target.pitch - pose.pitch];
    jacobian = planarJacobian(t1, t2, t3);

    // Jacobian-transpose update: dTheta = gain * J^T * error.
    const delta = jacobian[0].map(
      (_, col) => GAIN * (jacobian[0][col] * error[0] + jacobian[1][col] * error[1] + jacobian[2][col] * error[2]),
    );
    const clamp = (v: number) => Math.max(-MAX_STEP_RAD, Math.min(MAX_STEP_RAD, v));
    t1 += clamp(delta[0]);
    t2 += clamp(delta[1]);
    t3 += clamp(delta[2]);

    // Keep the shoulder from swinging visibly through the floor grid; elbow
    // and wrist are otherwise free to rotate through the full circle.
    t1 = Math.max(SHOULDER_MIN_RAD, Math.min(Math.PI, t1));
    t2 = Math.max(-Math.PI, Math.min(Math.PI, t2));
    t3 = Math.max(-Math.PI, Math.min(Math.PI, t3));
  }

  const errorNorm = Math.sqrt(error[0] ** 2 + error[1] ** 2 + error[2] ** 2);
  return { theta1: t1, theta2: t2, theta3: t3, jacobian, error, errorNorm };
}
