import { INTERACTION } from "@ahb/data";
import type { Settings } from "../settings.js";

export type Action = "use" | "setDown" | "inspect" | "pause" | "ping" | "tickets" | "flick" | "crouchToggle";

export interface InputHandlers {
  /** Primary press on the scene. Return true to capture subsequent drag deltas (knob, drawer, squeeze). */
  primaryDown(x: number, y: number, kind: "mouse" | "touch"): boolean;
  primaryUp(x: number, y: number, kind: "mouse" | "touch", captured: boolean, moved: boolean): void;
  captureMove(dx: number, dy: number): void;
  action(a: Action): void;
  actionEnd(a: Action): void;
}

interface TouchTrack {
  id: number;
  role: "look" | "capture" | "stick";
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startT: number;
  moved: boolean;
}

/**
 * Unified desktop + touch input built on Pointer Events with independent pointer tracking
 * (spec §6A). Desktop uses Pointer Lock after an explicit click and falls back to cursor mode
 * when lock is unavailable or denied; no action relies on hover, right-click or the wheel alone.
 */
export class InputManager {
  private readonly canvas: HTMLCanvasElement;
  private settings: Settings;
  private readonly handlers: InputHandlers;
  private readonly keys = new Set<string>();
  private lookDX = 0;
  private lookDY = 0;
  private rotDX = 0;
  private rotDY = 0;
  private holdDelta = 0;
  private mouseCaptured = false;
  private mouseDownAt = { x: 0, y: 0 };
  private mouseMoved = false;
  private rmbDown = false;
  private readonly touches = new Map<number, TouchTrack>();
  private crouchToggled = false;
  pointerLocked = false;
  lockDenied = false;
  enabled = false;
  cursor = { x: 0, y: 0 };
  lastPointer: "mouse" | "touch" = "mouse";
  /** Touch stick vector (-1..1). */
  stick = { x: 0, y: 0 };
  /** Touch rotate-modifier mode: look drags rotate the held item instead. */
  touchRotate = false;
  private pinch: { a: number; b: number; dist: number } | null = null;

  constructor(canvas: HTMLCanvasElement, settings: Settings, handlers: InputHandlers) {
    this.canvas = canvas;
    this.settings = settings;
    this.handlers = handlers;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", () => this.clear());
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("lostpointercapture", this.onPointerCancel);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("pointerlockchange", this.onLockChange);
    document.addEventListener("pointerlockerror", () => {
      this.lockDenied = true;
    });
  }

  updateSettings(s: Settings): void {
    this.settings = s;
  }

  /** Clears every held input. Called on blur, backgrounding, menus and disconnects. */
  clear(): void {
    this.keys.clear();
    this.lookDX = this.lookDY = this.rotDX = this.rotDY = this.holdDelta = 0;
    this.stick.x = this.stick.y = 0;
    for (const t of this.touches.values()) if (t.role === "capture") this.handlers.primaryUp(t.lastX, t.lastY, "touch", true, t.moved);
    this.touches.clear();
    if (this.mouseCaptured) this.handlers.primaryUp(this.cursor.x, this.cursor.y, "mouse", true, this.mouseMoved);
    this.mouseCaptured = false;
    this.rmbDown = false;
    this.pinch = null;
  }

  requestLock(): void {
    if (this.lastPointer === "touch" || this.pointerLocked) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {
        this.lockDenied = true;
      });
    } catch {
      this.lockDenied = true;
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private onLockChange = (): void => {
    const locked = document.pointerLockElement === this.canvas;
    const wasLocked = this.pointerLocked;
    this.pointerLocked = locked;
    if (wasLocked && !locked && this.enabled) {
      // Escape (or the browser) released the lock: open the pause/settings menu.
      this.clear();
      this.handlers.action("pause");
    }
  };

  private bindingFor(code: string): keyof Settings["bindings"] | null {
    const b = this.settings.bindings;
    for (const k of Object.keys(b) as (keyof Settings["bindings"])[]) if (b[k] === code) return k;
    if (code === "ShiftRight") return "sprint";
    if (code === "KeyC" || code === "ControlRight") return "crouch";
    if (code === "ArrowUp") return "forward";
    if (code === "ArrowDown") return "back";
    return null;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
    this.lastPointer = "mouse";
    if (e.code === "Escape") {
      this.handlers.action("pause");
      return;
    }
    const b = this.bindingFor(e.code);
    if (b === "tickets") e.preventDefault();
    if (e.repeat) return;
    this.keys.add(e.code);
    if (b === "use") this.handlers.action("use");
    else if (b === "setDown") this.handlers.action("setDown");
    else if (b === "inspect") this.handlers.action("inspect");
    else if (b === "ping") this.handlers.action("ping");
    else if (b === "tickets") this.handlers.action("tickets");
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    const b = this.bindingFor(e.code);
    if (b === "inspect") this.handlers.actionEnd("inspect");
  };

  private pressed(name: keyof Settings["bindings"]): boolean {
    const code = this.settings.bindings[name];
    if (this.keys.has(code)) return true;
    if (name === "sprint") return this.keys.has("ShiftRight");
    if (name === "crouch") return this.keys.has("KeyC") || this.keys.has("ControlRight");
    if (name === "forward") return this.keys.has("ArrowUp");
    if (name === "back") return this.keys.has("ArrowDown");
    return false;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (e.pointerType === "mouse") {
      this.lastPointer = "mouse";
      if (!this.pointerLocked && !this.lockDenied && e.button === 0) {
        // First click only acquires pointer lock (explicit gesture).
        this.requestLock();
        return;
      }
      this.cursor = { x: e.clientX, y: e.clientY };
      if (e.button === 0) {
        const pt = this.aimPoint();
        this.mouseDownAt = { x: e.clientX, y: e.clientY };
        this.mouseMoved = false;
        this.mouseCaptured = this.handlers.primaryDown(pt.x, pt.y, "mouse");
      } else if (e.button === 2) {
        this.rmbDown = true;
      }
      return;
    }
    // Touch / pen.
    e.preventDefault();
    this.lastPointer = "touch";
    this.canvas.setPointerCapture(e.pointerId);
    const track: TouchTrack = { id: e.pointerId, role: "look", startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, startT: performance.now(), moved: false };
    const looks = [...this.touches.values()].filter((t) => t.role === "look");
    if (looks.length === 1) {
      const other = looks[0]!;
      this.pinch = { a: other.id, b: e.pointerId, dist: Math.hypot(other.lastX - e.clientX, other.lastY - e.clientY) };
    } else if (this.handlers.primaryDown(e.clientX, e.clientY, "touch")) {
      track.role = "capture";
    }
    this.touches.set(e.pointerId, track);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (e.pointerType === "mouse") {
      const sens = 0.0022 * this.settings.sensitivity;
      if (this.pointerLocked) {
        const dx = e.movementX;
        const dy = e.movementY;
        if (this.mouseCaptured) this.handlers.captureMove(dx, dy);
        else if (this.rmbDown) {
          this.rotDX += dx * 0.01;
          this.rotDY += dy * 0.01;
        } else {
          this.lookDX += dx * sens;
          this.lookDY += dy * sens * (this.settings.invertY ? -1 : 1);
        }
      } else {
        const dx = e.clientX - this.cursor.x;
        const dy = e.clientY - this.cursor.y;
        this.cursor = { x: e.clientX, y: e.clientY };
        if (Math.hypot(e.clientX - this.mouseDownAt.x, e.clientY - this.mouseDownAt.y) > 6) this.mouseMoved = true;
        if (this.mouseCaptured) this.handlers.captureMove(dx, dy);
        else if (this.rmbDown) {
          // Cursor mode: right-drag looks around (pointer lock unavailable).
          this.lookDX += dx * sens * 1.5;
          this.lookDY += dy * sens * 1.5 * (this.settings.invertY ? -1 : 1);
        }
      }
      return;
    }
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    const dx = e.clientX - t.lastX;
    const dy = e.clientY - t.lastY;
    t.lastX = e.clientX;
    t.lastY = e.clientY;
    if (Math.hypot(e.clientX - t.startX, e.clientY - t.startY) > 10) t.moved = true;
    if (this.pinch && (this.pinch.a === e.pointerId || this.pinch.b === e.pointerId)) {
      const a = this.touches.get(this.pinch.a);
      const b = this.touches.get(this.pinch.b);
      if (a && b) {
        const dist = Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY);
        this.holdDelta += (dist - this.pinch.dist) * 0.004;
        this.pinch.dist = dist;
      }
      return;
    }
    if (t.role === "capture") {
      this.handlers.captureMove(dx, dy);
      return;
    }
    if (t.role === "look" && t.moved) {
      if (dy < -18 && Math.abs(dx) < 12) this.handlers.action("flick");
      const sens = 0.0045 * this.settings.touchSensitivity;
      if (this.touchRotate) {
        this.rotDX += dx * 0.015;
        this.rotDY += dy * 0.015;
      } else {
        this.lookDX += dx * sens;
        this.lookDY += dy * sens * (this.settings.invertY ? -1 : 1);
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === "mouse") {
      if (e.button === 0 && (this.pointerLocked || this.lockDenied)) {
        const pt = this.aimPoint();
        this.handlers.primaryUp(pt.x, pt.y, "mouse", this.mouseCaptured, this.mouseMoved);
        this.mouseCaptured = false;
      } else if (e.button === 2) this.rmbDown = false;
      return;
    }
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    this.touches.delete(e.pointerId);
    if (this.pinch && (this.pinch.a === e.pointerId || this.pinch.b === e.pointerId)) {
      this.pinch = null;
      return;
    }
    const quick = performance.now() - t.startT < 450;
    if (t.role === "capture") this.handlers.primaryUp(e.clientX, e.clientY, "touch", true, t.moved);
    else if (!t.moved && quick) this.handlers.primaryUp(e.clientX, e.clientY, "touch", false, false);
  };

  private onPointerCancel = (e: PointerEvent): void => {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    this.touches.delete(e.pointerId);
    if (t.role === "capture") this.handlers.primaryUp(t.lastX, t.lastY, "touch", true, t.moved);
    if (this.pinch && (this.pinch.a === e.pointerId || this.pinch.b === e.pointerId)) this.pinch = null;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    this.holdDelta += -Math.sign(e.deltaY) * 0.06;
  };

  /** Screen point used for aiming: crosshair when locked, cursor otherwise. */
  aimPoint(): { x: number; y: number } {
    if (this.pointerLocked || this.lastPointer === "touch") {
      const r = this.canvas.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return this.cursor;
  }

  addHoldDelta(d: number): void {
    this.holdDelta += d;
  }

  setCrouchToggle(on: boolean): void {
    this.crouchToggled = on;
  }

  get crouchToggle(): boolean {
    return this.crouchToggled;
  }

  /** Per-frame continuous input. Look deltas are consumed. */
  frame(): { moveX: number; moveZ: number; sprint: boolean; crouch: boolean; lookDX: number; lookDY: number; rotDX: number; rotDY: number; hold: number } {
    let mx = 0;
    let mz = 0;
    if (this.pressed("forward")) mz += 1;
    if (this.pressed("back")) mz -= 1;
    if (this.pressed("right")) mx += 1;
    if (this.pressed("left")) mx -= 1;
    // Arrow-key look for accessibility.
    if (this.keys.has("ArrowLeft")) this.lookDX -= 0.03;
    if (this.keys.has("ArrowRight")) this.lookDX += 0.03;
    const stickMag = Math.hypot(this.stick.x, this.stick.y);
    if (stickMag > 0.08) {
      mx += this.stick.x;
      mz += this.stick.y;
    }
    const out = {
      moveX: Math.max(-1, Math.min(1, mx)),
      moveZ: Math.max(-1, Math.min(1, mz)),
      sprint: this.pressed("sprint") || stickMag > 0.95,
      crouch: this.pressed("crouch") || this.crouchToggled,
      lookDX: this.lookDX,
      lookDY: this.lookDY,
      rotDX: this.rotDX,
      rotDY: this.rotDY,
      hold: this.holdDelta,
    };
    this.lookDX = this.lookDY = this.rotDX = this.rotDY = this.holdDelta = 0;
    return out;
  }

  get rotating(): boolean {
    return this.rmbDown || this.touchRotate;
  }

  static clampHold(h: number): number {
    return Math.max(INTERACTION.holdDistanceMin, Math.min(INTERACTION.holdDistanceMax, h));
  }
}
