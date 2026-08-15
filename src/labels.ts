import * as THREE from "three";
import type { RobotArm } from "./arm";

export interface JointLabels {
  resize(width: number, height: number): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setEndEffectorText(text: string): void;
}

// How far off the joint's screen-space projection the label box sits (CSS
// px), one fixed offset per joint chosen so the four labels land in open
// space around the default pose instead of stacking on top of one another.
// Positive dx offsets right, negative left; dy is screen-space (positive is
// down), so a negative dy offset is "up".
const CALLOUT_OFFSETS: Record<string, { dx: number; dy: number }> = {
  theta1: { dx: 68, dy: -34 },
  theta2: { dx: 68, dy: -66 },
  theta3: { dx: -68, dy: -44 },
  effector: { dx: 68, dy: 44 },
};

// Length (px) of the leader line's final horizontal "shoulder" segment that
// runs into the label's edge — the elbowed leader is what reads as an
// engineering-drawing callout rather than a straight line stabbed at the box.
const LEADER_SHOULDER_LENGTH = 14;

// A raycast hit strictly closer than (distance-to-joint - this) counts as
// occlusion. The margin absorbs the case where the hit is the joint's own
// adjoining link, whose surface meets the joint at almost exactly the same
// distance as the joint center itself.
const OCCLUSION_MARGIN = 0.05;

const OCCLUDED_OPACITY = "0.18";
const VISIBLE_OPACITY = "1";

const SVG_NS = "http://www.w3.org/2000/svg";

interface Callout {
  key: string;
  mesh: THREE.Object3D;
  offset: { dx: number; dy: number };
  wrapper: HTMLElement;
  textEl: HTMLElement;
  leaderGroup: SVGGElement;
  leaderLine: SVGPathElement;
  leaderDot: SVGCircleElement;
}

function createCalloutBox(overlay: HTMLElement, key: string, text: string): { wrapper: HTMLElement; textEl: HTMLElement } {
  const wrapper = document.createElement("div");
  wrapper.className = `joint-callout joint-callout-${key}`;
  const textEl = document.createElement("span");
  textEl.className = "joint-callout-text";
  textEl.textContent = text;
  wrapper.appendChild(textEl);
  overlay.appendChild(wrapper);
  return { wrapper, textEl };
}

function createLeader(svg: SVGSVGElement, color: string): { group: SVGGElement; line: SVGPathElement; dot: SVGCircleElement } {
  const group = document.createElementNS(SVG_NS, "g");
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("class", "joint-leader-line");
  line.setAttribute("stroke", color);
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "joint-leader-dot");
  dot.setAttribute("r", "3.5");
  dot.setAttribute("fill", color);
  group.append(line, dot);
  svg.appendChild(group);
  return { group, line, dot };
}

/**
 * Renders joint annotations as industrial-drawing-style callouts: a small dot
 * marks the joint's screen projection, an elbowed leader line runs out to a
 * text label fixed over a clear patch of screen space beside the model
 * (rather than sitting on top of it), and the whole callout fades when the
 * arm's own body is between the camera and that joint.
 *
 * This replaces CSS2DObject (which anchors a label directly over its 3D
 * point with no control over screen-space offset or occlusion) with manual
 * per-frame projection: each joint's world position is projected to screen
 * space by hand, the label is positioned at a fixed pixel offset from that
 * projection, and a raycast from the camera to the joint against the arm's
 * own meshes decides whether to fade the callout.
 */
export function createJointLabels(container: HTMLElement, robotArm: RobotArm): JointLabels {
  const overlay = document.createElement("div");
  overlay.className = "joint-callout-overlay";
  container.appendChild(overlay);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "joint-leader-svg");
  overlay.appendChild(svg);

  const specs: Array<{ key: string; color: string; text: string; mesh: THREE.Object3D }> = [
    { key: "theta1", color: "#ffb347", text: "θ₁ Base", mesh: robotArm.getJointMesh(0) },
    { key: "theta2", color: "#5b8def", text: "θ₂ Elbow", mesh: robotArm.getJointMesh(1) },
    { key: "theta3", color: "#ff6b6b", text: "θ₃ Wrist", mesh: robotArm.getJointMesh(2) },
    { key: "effector", color: "#7dff9e", text: "End Effector", mesh: robotArm.getEffectorMesh() },
  ];

  const callouts: Callout[] = specs.map((spec) => {
    const { wrapper, textEl } = createCalloutBox(overlay, spec.key, spec.text);
    const { group, line, dot } = createLeader(svg, spec.color);
    return {
      key: spec.key,
      mesh: spec.mesh,
      offset: CALLOUT_OFFSETS[spec.key],
      wrapper,
      textEl,
      leaderGroup: group,
      leaderLine: line,
      leaderDot: dot,
    };
  });
  const effectorCallout = callouts[callouts.length - 1];

  let width = 0;
  let height = 0;

  const raycaster = new THREE.Raycaster();
  const jointWorld = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const rayDirection = new THREE.Vector3();

  function setOpacity(callout: Callout, opacity: string): void {
    callout.wrapper.style.opacity = opacity;
    callout.leaderGroup.style.opacity = opacity;
  }

  /** True when the arm's own body sits between the camera and `worldPos`, closer than `worldPos` itself. */
  function isOccluded(camera: THREE.Camera, selfMesh: THREE.Object3D, worldPos: THREE.Vector3): boolean {
    const distanceToJoint = camera.position.distanceTo(worldPos);
    rayDirection.copy(worldPos).sub(camera.position).normalize();
    raycaster.set(camera.position, rayDirection);
    // Exclude the joint's own mesh: the ray's target point sits on/inside it,
    // so without this every joint would "occlude" itself.
    const occluders = robotArm.getBodyMeshes().filter((candidate) => candidate !== selfMesh);
    const hits = raycaster.intersectObjects(occluders, false);
    return hits.length > 0 && hits[0].distance < distanceToJoint - OCCLUSION_MARGIN;
  }

  return {
    resize(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
    },
    render(_scene, camera) {
      if (width === 0 || height === 0) return;

      for (const callout of callouts) {
        callout.mesh.getWorldPosition(jointWorld);
        projected.copy(jointWorld).project(camera);

        // Behind the camera — projecting it to screen space would be
        // meaningless (or land it mirrored on-screen), so just hide it.
        if (projected.z > 1) {
          setOpacity(callout, "0");
          continue;
        }

        const jointX = ((projected.x + 1) / 2) * width;
        const jointY = ((1 - projected.y) / 2) * height;
        const { dx, dy } = callout.offset;
        const anchorX = jointX + dx;
        const anchorY = jointY + dy;

        // The label box grows away from the joint: its near edge (left edge
        // if the offset points right, right edge if it points left) sits at
        // the anchor point, vertically centered on it — so the anchor is a
        // true edge midpoint, not a corner, for the leader line to land on.
        callout.wrapper.style.left = `${anchorX}px`;
        callout.wrapper.style.top = `${anchorY}px`;
        callout.wrapper.style.transform = `translate(${dx > 0 ? "0%" : "-100%"}, -50%)`;

        const shoulderX = anchorX + (dx > 0 ? -LEADER_SHOULDER_LENGTH : LEADER_SHOULDER_LENGTH);
        callout.leaderLine.setAttribute(
          "d",
          `M ${jointX} ${jointY} L ${shoulderX} ${anchorY} L ${anchorX} ${anchorY}`,
        );
        callout.leaderDot.setAttribute("cx", String(jointX));
        callout.leaderDot.setAttribute("cy", String(jointY));

        const occluded = isOccluded(camera, callout.mesh, jointWorld);
        setOpacity(callout, occluded ? OCCLUDED_OPACITY : VISIBLE_OPACITY);
      }
    },
    setEndEffectorText(text) {
      effectorCallout.textEl.textContent = `End Effector ${text}`;
    },
  };
}
