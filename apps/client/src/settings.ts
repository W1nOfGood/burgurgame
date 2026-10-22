/**
 * Player preferences. Stored in localStorage as a per-device convenience only; every access is
 * guarded because storage can be unavailable (private mode, blocked site data).
 */
export type GraphicsPreset = "tablet" | "low" | "medium" | "high";

export interface KeyBindings {
  forward: string;
  back: string;
  left: string;
  right: string;
  sprint: string;
  crouch: string;
  use: string;
  setDown: string;
  inspect: string;
  ping: string;
  tickets: string;
}

export interface Settings {
  fov: number;
  sensitivity: number;
  invertY: boolean;
  headBob: number;
  cameraShake: number;
  motionBlur: boolean;
  toggleToHold: boolean;
  assistedPlacement: boolean;
  simpleInteractions: boolean;
  showLabels: boolean;
  showTicketOverlay: boolean;
  reducedEffects: boolean;
  subtitles: boolean;
  master: number;
  effects: number;
  ambience: number;
  music: number;
  graphics: GraphicsPreset;
  renderScale: number;
  preferWebGPU: boolean;
  touchControlScale: number;
  touchLeftHanded: boolean;
  touchSensitivity: number;
  touchTutorialSeen: boolean;
  bindings: KeyBindings;
}

export const DEFAULT_BINDINGS: KeyBindings = {
  forward: "KeyW",
  back: "KeyS",
  left: "KeyA",
  right: "KeyD",
  sprint: "ShiftLeft",
  crouch: "ControlLeft",
  use: "KeyE",
  setDown: "KeyQ",
  inspect: "KeyF",
  ping: "KeyT",
  tickets: "Tab",
};

export function isTouchDevice(): boolean {
  return typeof window !== "undefined" && (navigator.maxTouchPoints > 1 || window.matchMedia?.("(pointer: coarse)").matches === true);
}

export function defaultSettings(): Settings {
  const touch = isTouchDevice();
  return {
    fov: 70,
    sensitivity: 1,
    invertY: false,
    headBob: 0.5,
    cameraShake: 0.5,
    motionBlur: false,
    toggleToHold: touch,
    assistedPlacement: true,
    simpleInteractions: false,
    showLabels: true,
    showTicketOverlay: true,
    reducedEffects: false,
    subtitles: true,
    master: 0.8,
    effects: 0.9,
    ambience: 0.6,
    music: 0.4,
    graphics: touch ? "tablet" : "medium",
    renderScale: touch ? 0.8 : 1,
    preferWebGPU: false,
    touchControlScale: 1,
    touchLeftHanded: false,
    touchSensitivity: 1,
    touchTutorialSeen: false,
    bindings: { ...DEFAULT_BINDINGS },
  };
}

const KEY = "ahb.settings.v1";

export function loadSettings(): Settings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...base, ...parsed, bindings: { ...base.bindings, ...(parsed.bindings ?? {}) } };
  } catch {
    return base;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Preferences are a convenience; ignore storage failures.
  }
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}
