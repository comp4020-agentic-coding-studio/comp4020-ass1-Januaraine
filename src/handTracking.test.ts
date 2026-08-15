import { describe, expect, it } from "vitest";
import { elbowBendAngle, segmentAngle, wristPitchAngle } from "./handTracking";

describe("segmentAngle mirror/flip convention", () => {
  it("points toward +reach (angle 0) when the raw image moves toward larger x (mirrored to smaller reach-side x)", () => {
    // to is to the raw-image-left of from → mirrored horizontal coord increases → +reach.
    const angle = segmentAngle({ x: 0.6, y: 0.5 }, { x: 0.4, y: 0.5 });
    expect(angle).toBeCloseTo(0, 5);
  });

  it("points toward +height (angle +90deg) when the raw image moves upward (smaller y)", () => {
    const angle = segmentAngle({ x: 0.5, y: 0.6 }, { x: 0.5, y: 0.4 });
    expect(angle).toBeCloseTo(Math.PI / 2, 5);
  });
});

describe("elbowBendAngle / wristPitchAngle", () => {
  it("is null when any input point is missing", () => {
    expect(elbowBendAngle(null, { x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 })).toBeNull();
    expect(wristPitchAngle({ x: 0.5, y: 0.5 }, null, { x: 0.6, y: 0.5 })).toBeNull();
  });

  it("is zero when the forearm continues straight from the upper arm", () => {
    const shoulder = { x: 0.5, y: 0.3 };
    const elbow = { x: 0.5, y: 0.5 };
    const wrist = { x: 0.5, y: 0.7 };
    expect(elbowBendAngle(shoulder, elbow, wrist)).toBeCloseTo(0, 5);
  });

  it("stays within (-pi, pi] even across the wrap boundary", () => {
    const shoulder = { x: 0.9, y: 0.5 };
    const elbow = { x: 0.5, y: 0.5 };
    const wrist = { x: 0.9, y: 0.501 };
    const angle = elbowBendAngle(shoulder, elbow, wrist);
    expect(angle).not.toBeNull();
    expect(angle as number).toBeGreaterThan(-Math.PI);
    expect(angle as number).toBeLessThanOrEqual(Math.PI);
  });
});
