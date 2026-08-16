export type Theme = "dark" | "light";

const THEME_STORAGE_KEY = "fk-ik-theme";

export function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (private browsing, disabled) — theme still applies
    // for the current page view, it just won't persist across reloads.
  }
}

export function applyDomTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * Color values for the handful of things Canvas2D/Three.js draw directly
 * (not via CSS), so they can't read CSS custom properties. Kept numerically
 * in sync with the matching tokens in styles.css by hand.
 */
export const CANVAS_THEME_TOKENS: Record<
  Theme,
  {
    chartBg: string;
    chartMidline: string;
    chartSeries: { theta1: string; theta2: string; theta3: string };
    sceneBackground: number;
    sceneFog: number;
    gridTint: number;
    gridOpacity: number;
    axesOpacity: number;
    targetColor: number;
  }
> = {
  dark: {
    chartBg: "#12151a",
    chartMidline: "#2a2f3a",
    chartSeries: { theta1: "#ffb347", theta2: "#5b8def", theta3: "#ff6b6b" },
    sceneBackground: 0x12151a,
    sceneFog: 0x12151a,
    gridTint: 0xffffff,
    gridOpacity: 0.6,
    axesOpacity: 0.6,
    targetColor: 0x7dff9e,
  },
  light: {
    chartBg: "#ffffff",
    chartMidline: "#d5dae2",
    chartSeries: { theta1: "#b8720b", theta2: "#2f5fc4", theta3: "#d64545" },
    sceneBackground: 0xeef1f5,
    sceneFog: 0xeef1f5,
    gridTint: 0x556074,
    gridOpacity: 0.5,
    axesOpacity: 0.85,
    targetColor: 0x1f8a4c,
  },
};
