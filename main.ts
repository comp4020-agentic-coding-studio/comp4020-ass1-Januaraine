import { initScene } from "./src/scene";

const sceneRoot = document.querySelector<HTMLElement>("#scene-root");
const status = document.querySelector<HTMLElement>("#scene-status");

if (sceneRoot) {
  initScene(sceneRoot, {
    onStatus: (message, kind) => {
      if (!status) return;
      status.textContent = message;
      status.dataset.state = kind;
      status.hidden = message === "";
    },
  });
}
