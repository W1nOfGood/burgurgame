import type { Settings } from "../settings.js";
import type { Action, InputManager } from "./input.js";

/**
 * Compact on-screen controls for iPad (spec §6A): left movement stick, contextual buttons on the
 * right, all at least 44 CSS px and inside safe areas. Cooking itself stays in the 3D world.
 */
export class TouchControls {
  readonly el: HTMLElement;
  private readonly input: InputManager;
  private readonly onAction: (a: Action, down: boolean) => void;
  private stickPointer: number | null = null;
  private stickCenter = { x: 0, y: 0 };
  private readonly knob: HTMLElement;
  private readonly base: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();

  constructor(parent: HTMLElement, input: InputManager, settings: Settings, onAction: (a: Action | "rotate" | "closer" | "farther" | "menu", down: boolean) => void) {
    this.input = input;
    this.onAction = onAction as (a: Action, down: boolean) => void;
    this.el = document.createElement("div");
    this.el.className = "touch-controls";
    this.el.innerHTML = `
      <div class="stick-zone" aria-label="Move">
        <div class="stick-base"><div class="stick-knob"></div></div>
      </div>
      <div class="touch-buttons" role="toolbar" aria-label="Actions">
        <button data-act="use" class="tb tb-primary" aria-label="Use">Use</button>
        <button data-act="setDown" class="tb" aria-label="Set down">Set down</button>
        <button data-act="rotate" class="tb tb-toggle" aria-pressed="false" aria-label="Rotate held item">Rotate</button>
        <button data-act="farther" class="tb tb-small" aria-label="Hold farther">Far</button>
        <button data-act="closer" class="tb tb-small" aria-label="Hold closer">Near</button>
        <button data-act="crouchToggle" class="tb tb-toggle" aria-pressed="false" aria-label="Crouch">Crouch</button>
        <button data-act="inspect" class="tb" aria-label="Inspect">Inspect</button>
        <button data-act="ping" class="tb tb-small" aria-label="Ping teammates">Ping</button>
        <button data-act="recipes" class="tb tb-small" aria-label="Recipe book">Recipes</button>
      </div>
      <button data-act="menu" class="tb tb-menu" aria-label="Menu and settings">☰</button>
    `;
    parent.appendChild(this.el);
    this.base = this.el.querySelector(".stick-base")!;
    this.knob = this.el.querySelector(".stick-knob")!;
    const zone = this.el.querySelector<HTMLElement>(".stick-zone")!;
    zone.addEventListener("pointerdown", this.stickDown);
    zone.addEventListener("pointermove", this.stickMove);
    zone.addEventListener("pointerup", this.stickUp);
    zone.addEventListener("pointercancel", this.stickUp);
    zone.addEventListener("lostpointercapture", this.stickUp);

    for (const btn of this.el.querySelectorAll<HTMLButtonElement>("button[data-act]")) {
      const act = btn.dataset.act!;
      this.buttons.set(act, btn);
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.setPointerCapture(e.pointerId);
        btn.classList.add("active");
        if (act === "rotate") {
          input.touchRotate = !input.touchRotate;
          btn.setAttribute("aria-pressed", String(input.touchRotate));
          return;
        }
        if (act === "crouchToggle") {
          input.setCrouchToggle(!input.crouchToggle);
          btn.setAttribute("aria-pressed", String(input.crouchToggle));
          return;
        }
        onAction(act as Action, true);
      });
      const up = (e: PointerEvent) => {
        e.preventDefault();
        btn.classList.remove("active");
        if (act === "inspect") onAction("inspect", false);
      };
      btn.addEventListener("pointerup", up);
      btn.addEventListener("pointercancel", up);
    }
    this.applySettings(settings);
  }

  applySettings(s: Settings): void {
    this.el.style.setProperty("--tc-scale", String(s.touchControlScale));
    this.el.classList.toggle("left-handed", s.touchLeftHanded);
  }

  setVisible(on: boolean): void {
    this.el.hidden = !on;
  }

  setLabel(act: string, label: string, enabled = true): void {
    const b = this.buttons.get(act);
    if (!b) return;
    if (b.textContent !== label) b.textContent = label;
    b.disabled = !enabled;
  }

  reset(): void {
    this.stickPointer = null;
    this.input.stick.x = this.input.stick.y = 0;
    this.knob.style.transform = "translate(-50%, -50%)";
  }

  private stickDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (this.stickPointer !== null) return;
    this.stickPointer = e.pointerId;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const r = this.base.getBoundingClientRect();
    this.stickCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    this.stickMove(e);
  };

  private stickMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickPointer) return;
    e.preventDefault();
    const r = this.base.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = (e.clientX - this.stickCenter.x) / radius;
    let dy = (e.clientY - this.stickCenter.y) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    this.input.stick.x = dx;
    this.input.stick.y = -dy;
    this.knob.style.transform = `translate(calc(-50% + ${dx * radius * 0.6}px), calc(-50% + ${dy * radius * 0.6}px))`;
  };

  private stickUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickPointer) return;
    this.reset();
  };
}
