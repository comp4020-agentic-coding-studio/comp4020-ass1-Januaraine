import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// Stage 1 of the assignment: only the 3D scene and GLB loading exist yet, so
// these tests check the structure that stage depends on, not the FK/IK
// interaction that comes later.
const DIST = resolve("dist");

describe("robot scene page", () => {
  const doc = new JSDOM(readFileSync(resolve(DIST, "index.html"), "utf8")).window.document;

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

describe("robot GLB asset", () => {
  it("ships in the built site", () => {
    const glbPath = resolve(DIST, "robotic_arm.glb");
    expect(existsSync(glbPath), `${glbPath} missing — it would 404 once deployed`).toBe(true);
  });
});
