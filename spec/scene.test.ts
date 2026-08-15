import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// Stage 2 of the assignment: the FK vs IK explainer, split into a 3D scene
// and a control/explanation panel. These check the built structure the
// interaction depends on — the FK/IK math itself only runs in a browser, so
// it's exercised manually (see PROCESS.md), not asserted here.
const DIST = resolve("dist");
const doc = new JSDOM(readFileSync(resolve(DIST, "index.html"), "utf8")).window.document;

describe("robot scene page", () => {
  it("names the FK vs IK question in its heading", () => {
    expect(doc.querySelector("h1")?.textContent).toMatch(/Robot Moves/i);
  });

  it("has a container for the 3D scene", () => {
    expect(doc.querySelector("#scene-root")).toBeTruthy();
  });

  it("has a status element for load/error feedback", () => {
    expect(doc.querySelector("#scene-status")).toBeTruthy();
  });
});

describe("left/right split layout", () => {
  it("has a scene panel and a control panel as siblings", () => {
    const scenePanel = doc.querySelector("#scene-panel");
    const controlPanel = doc.querySelector("#control-panel");
    expect(scenePanel).toBeTruthy();
    expect(controlPanel).toBeTruthy();
    expect(scenePanel?.parentElement).toBe(controlPanel?.parentElement);
  });
});

describe("FK vs IK mode toggle", () => {
  it("has both mode buttons", () => {
    expect(doc.querySelector("#mode-fk")).toBeTruthy();
    expect(doc.querySelector("#mode-ik")).toBeTruthy();
  });

  it("names forward and inverse kinematics", () => {
    const toggle = doc.querySelector(".mode-toggle")?.textContent ?? "";
    expect(toggle).toMatch(/forward kinematics/i);
    expect(toggle).toMatch(/inverse kinematics/i);
  });

  it("has the FK joint-angle sliders for theta1, theta2, and theta3", () => {
    expect(doc.querySelector("#slider-theta1")).toBeTruthy();
    expect(doc.querySelector("#slider-theta2")).toBeTruthy();
    expect(doc.querySelector("#slider-theta3")).toBeTruthy();
  });
});

describe("Jacobian and joint-angle visualisation", () => {
  it("has a 3x3 Jacobian matrix table", () => {
    const cells = doc.querySelectorAll("#jacobian-table [data-cell]");
    expect(cells.length).toBe(9);
  });

  it("has a chart for joint angles over time", () => {
    expect(doc.querySelector("#angle-chart")).toBeTruthy();
  });
});

describe("real-world analogies", () => {
  it("mentions da Vinci surgical robots and welding arms", () => {
    const text = doc.querySelector("#analogies")?.textContent ?? "";
    expect(text).toMatch(/da vinci/i);
    expect(text).toMatch(/weld/i);
  });
});

describe("arm-pose tracking overlay", () => {
  it("mounts a canvas (not a raw video) for the camera preview", () => {
    expect(doc.querySelector("#camera-preview canvas")).toBeTruthy();
  });

  it("explains that the camera sees landmarks, not a hand", () => {
    const text = doc.querySelector("#ik-controls .explainer")?.textContent ?? "";
    expect(text).toMatch(/landmark/i);
  });

  it("does not claim metric 3D tracking", () => {
    const text = doc.querySelector("#ik-controls .explainer")?.textContent ?? "";
    expect(text).toMatch(/not metric 3d/i);
  });

  it("has a tracked-pose readout for shoulder, elbow, wrist, and hand", () => {
    expect(doc.querySelector('[data-tracked="shoulder"]')).toBeTruthy();
    expect(doc.querySelector('[data-tracked="elbow"]')).toBeTruthy();
    expect(doc.querySelector('[data-tracked="wrist"]')).toBeTruthy();
    expect(doc.querySelector('[data-tracked="hand"]')).toBeTruthy();
  });

  it("has a target readout for X, Y, and Z", () => {
    expect(doc.querySelector('[data-target="x"]')).toBeTruthy();
    expect(doc.querySelector('[data-target="y"]')).toBeTruthy();
    expect(doc.querySelector('[data-target="z"]')).toBeTruthy();
  });
});
