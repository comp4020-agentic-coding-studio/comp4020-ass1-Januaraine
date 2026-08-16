# Process overview

## What I built

An interactive 3D web explainer for robotic kinematics (Forward & Inverse Kinematics), built with Vite, TypeScript, Three.js, and MediaPipe hand tracking. Designed with a cyberpunk laboratory dashboard aesthetic, the app features interactive 3D joint controls, real-time hand tracking for IK target control, on-canvas coordinate callouts, and a responsive layout that transitions from a three-column desktop view to a single-column mobile flow.

## The moments that mattered

### Moment 1: Pivoting from External GLB Asset to Procedural TypeScript Modeling for Precise Kinematics

1. **what happened**: Initially, I planned to import a pre-built .glb robotic arm model from Blender. However, controlling joint kinematics programmatically required constant tree traversal (getObjectByName()) and was fragile. Misaligned Blender pivot points and nested transform matrices created unpredictable offsets during 360° FK/IK rotations and joint callout tracking.
2. **what you did instead of the obvious thing**: Instead of spending hours re-exporting and fighting Blender origin points, I dropped the external GLB asset entirely. I refactored the entire robotic arm into a fully procedural, code-defined hierarchy in TypeScript using native Three.js primitives (CylinderGeometry, SphereGeometry). This made every pivot point, local transform matrix, and material parameter completely transparent and strictly controlled in code.
3. **how you knew it was right**: FK/IK calculations immediately became deterministic: joint angles mapped $1:1$ to local mesh rotations without manual matrix offset patches. On-canvas label anchors and Raycaster occlusion checks tracked joint coordinates effortlessly, while eliminating asset loading overhead.
4. **the citation**: [`c3fd027...a24d907`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Januaraine/compare/c3fd027...a24d907)


### Moment 2: Reframing MediaPipe Input from Point-Target Tracking to Full Pose Kinematics

1. **what happened**: MediaPipe hand-tracking originally only provided a 3D coordinate point. Treating it as a naive end-effector target caused the robotic arm to blindly chase spatial positions without reflecting true 3D hand orientation or wrist rotation, leading to unnatural arm configurations and joint-snapping when reaching workspace limits.
2. **what you did instead of the obvious thing**: Instead of just using hand tracking as a 3D pointer ("target movement"), I refactored the interaction pipeline into a full "Pose → IK" mapping system. I mapped hand and wrist orientation vectors directly to joint rotation angles ($\theta_1, \theta_2, \theta_3$), added 3D axis-mirroring for intuitive camera control, and implemented LERP filtering with tracking-loss hysteresis to eliminate jitter.
3. **how you knew it was right**: Rotating the wrist in front of the camera smoothly turned the robot's corresponding joint across its full 360° range without gimbal locking. When tracking dropped, hysteresis prevented sudden position jumps, keeping the robot stable.
4. **the citation**: [`995a9de...b3c0771`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Januaraine/compare/995a9de...b3c0771)


### Moment 3: Restructuring CSS Architecture for Mobile Viewport Collision

1. **what happened**: The mobile layout (`<=1024px`) collapsed completely. Desktop CSS Grid areas and fixed card heights were not properly overridden, forcing panels and absolute-positioned elements (like the webcam preview canvas) to stack directly on top of each other over the text content.
2. **what you did instead of the obvious thing**: Rather than endlessly re-prompting the agent to tweak individual card styles, I enforced a full single-column Flexbox layout reset (`flex-direction: column`, `height: auto !important`, `grid-area: auto !important`). Crucially, I maintained `#scene-panel` as `position: relative` while converting all inner components to standard document flow, keeping canvas HUD overlays scoped without breaking the page layout.
3. **how you knew it was right**: Inspected the layout in browser DevTools under mobile viewports (<=1024px). All sections (`#scene-panel`, `#control-panel`, `#right-panel`, `#bottom-grid`) stacked sequentially in DOM order, camera video stayed inside its parent container, and page scrolling worked without overlap.
4. **the citation**: ['11658b4'](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-Januaraine/commit/11658b4)