import { ITEMS, RECIPES, SAUCE_LABEL, formatCents, type ItemKind } from "@ahb/data";
import { PING_PRESETS, PING_TEXT, type PingPreset, type ServedMessage, type SummaryMessage } from "@ahb/protocol";
import { DEFAULT_BINDINGS, defaultSettings, type GraphicsPreset, type Settings } from "../settings.js";

/**
 * HTML/CSS overlays for menus, settings, reconnect and error states (spec §12: normal HTML
 * overlays for these; the default gameplay interface stays mostly in the restaurant).
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface TitleCallbacks {
  create(name: string, mode: "relaxed" | "normal"): void;
  join(name: string, code: string): void;
  settings(): void;
  recover(code: string, name: string): void;
}

export interface MenuCallbacks {
  resume(): void;
  pause(): void;
  leave(): void;
  exportSave(): void;
  settings(): void;
  copyCode(): void;
  ping(): void;
  recipes(): void;
}

export class Ui {
  readonly root: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly screens: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly label: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly inspect: HTMLElement;
  private readonly status: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly tickets: HTMLElement;
  private readonly prompt: HTMLElement;
  private screen: HTMLElement | null = null;
  private lastStatusKey = "";
  private lastTicketsKey = "";

  constructor(root: HTMLElement) {
    this.root = root;
    this.hud = el("div", "hud");
    this.hud.hidden = true;
    this.crosshair = el("div", "crosshair");
    this.label = el("div", "context-label");
    this.inspect = el("div", "inspect-panel");
    this.inspect.hidden = true;
    this.status = el("div", "status-bar");
    this.banner = el("div", "pause-banner");
    this.banner.hidden = true;
    this.tickets = el("div", "ticket-overlay");
    this.prompt = el("button", "click-to-play", "Click to play");
    this.prompt.hidden = true;
    this.toasts = el("div", "toasts");
    this.toasts.setAttribute("role", "status");
    this.toasts.setAttribute("aria-live", "polite");
    this.hud.append(this.crosshair, this.label, this.inspect, this.status, this.banner, this.tickets, this.prompt);
    this.screens = el("div", "screens");
    root.append(this.hud, this.toasts, this.screens);
  }

  // ------------------------------------------------------------------ screens

  private show(content: HTMLElement): HTMLElement {
    this.screens.replaceChildren(content);
    this.screen = content;
    this.screens.hidden = false;
    const focusable = content.querySelector<HTMLElement>("[autofocus], input, button");
    focusable?.focus({ preventScroll: true });
    return content;
  }

  hideScreen(): void {
    this.screens.replaceChildren();
    this.screen = null;
    this.screens.hidden = true;
  }

  get screenOpen(): boolean {
    return this.screen !== null;
  }

  showTitle(name: string, cb: TitleCallbacks, notice?: string): void {
    const s = el(
      "section",
      "screen title-screen",
      `
      <h1><span>After Hours</span> Burger</h1>
      <p class="tagline">A late-night kitchen for one to four cooks.</p>
      ${notice ? `<p class="notice" role="alert">${esc(notice)}</p>` : ""}
      <label class="field">Your name<input id="name" maxlength="20" autocomplete="nickname" value="${esc(name)}" required></label>
      <div class="card">
        <h2>Open your restaurant</h2>
        <div class="seg" role="radiogroup" aria-label="Shift type">
          <label><input type="radio" name="mode" value="relaxed" checked> Relaxed</label>
          <label><input type="radio" name="mode" value="normal"> Busy shift</label>
        </div>
        <button id="create" class="btn primary">Open kitchen</button>
      </div>
      <div class="card">
        <h2>Join a friend</h2>
        <label class="field">Room code<input id="code" maxlength="6" autocapitalize="characters" autocomplete="off" inputmode="text" pattern="[A-Za-z0-9]{6}" placeholder="ABC234"></label>
        <button id="join" class="btn">Join</button>
      </div>
      <div class="row">
        <button id="settings" class="btn ghost">Settings</button>
        <button id="recover" class="btn ghost">Restore with recovery code</button>
      </div>
      <p class="fine">Works with mouse &amp; keyboard or touch. Audio starts when you open or join a kitchen.</p>
    `,
    );
    const nameInput = s.querySelector<HTMLInputElement>("#name")!;
    const codeInput = s.querySelector<HTMLInputElement>("#code")!;
    const getName = () => {
      const n = nameInput.value.trim();
      if (!n) {
        nameInput.focus();
        nameInput.setCustomValidity("Enter a name");
        nameInput.reportValidity();
        return null;
      }
      nameInput.setCustomValidity("");
      return n;
    };
    s.querySelector("#create")!.addEventListener("click", () => {
      const n = getName();
      const mode = (s.querySelector<HTMLInputElement>("input[name=mode]:checked")?.value ?? "relaxed") as "relaxed" | "normal";
      if (n) cb.create(n, mode);
    });
    const doJoin = () => {
      const n = getName();
      const code = codeInput.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) {
        codeInput.setCustomValidity("Room codes have 6 letters or digits");
        codeInput.reportValidity();
        return;
      }
      codeInput.setCustomValidity("");
      if (n) cb.join(n, code);
    };
    s.querySelector("#join")!.addEventListener("click", doJoin);
    codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doJoin();
    });
    // Keep the focused field visible above the software keyboard.
    for (const input of [nameInput, codeInput]) input.addEventListener("focus", () => setTimeout(() => input.scrollIntoView({ block: "center" }), 250));
    s.querySelector("#settings")!.addEventListener("click", () => cb.settings());
    s.querySelector("#recover")!.addEventListener("click", () => {
      const code = prompt("Paste your recovery code");
      const n = getName();
      if (code && n) cb.recover(code, n);
    });
    this.show(s);
  }

  showLoading(text: string): void {
    this.show(el("section", "screen loading", `<div class="spinner" aria-hidden="true"></div><p>${esc(text)}</p>`));
  }

  showError(title: string, message: string, actions: { label: string; primary?: boolean; run: () => void }[]): void {
    const s = el("section", "screen error-screen", `<h2>${esc(title)}</h2><p>${esc(message)}</p><div class="row"></div>`);
    s.setAttribute("role", "alertdialog");
    const row = s.querySelector(".row")!;
    for (const a of actions) {
      const b = el("button", `btn ${a.primary ? "primary" : ""}`, esc(a.label));
      b.addEventListener("click", a.run);
      row.append(b);
    }
    this.show(s);
  }

  showPauseMenu(opts: { code: string; solo: boolean; paused: boolean; isOwner: boolean; votes: string }, cb: MenuCallbacks): void {
    const s = el(
      "section",
      "screen pause-menu",
      `
      <h2>Menu</h2>
      <p class="code-line">Room code <strong class="code">${esc(opts.code)}</strong> <button class="btn small" id="copy">Copy</button></p>
      <p class="fine">${opts.solo ? "Solo kitchen — pausing stops the clock." : "Co-op kitchen keeps running while you're in this menu."}</p>
      <div class="stack">
        <button id="resume" class="btn primary">Back to the kitchen</button>
        <button id="pause" class="btn">${opts.paused ? "Resume countdown" : opts.solo ? "Pause the kitchen" : `Vote to pause ${esc(opts.votes)}`}</button>
        <button id="ping" class="btn">Ping teammates</button>
        <button id="recipes" class="btn">Recipe book</button>
        <button id="settings" class="btn">Settings</button>
        ${opts.isOwner ? `<button id="export" class="btn">Export save file</button>` : ""}
        <button id="leave" class="btn danger">Leave kitchen</button>
      </div>
    `,
    );
    s.querySelector("#resume")!.addEventListener("click", cb.resume);
    s.querySelector("#pause")!.addEventListener("click", cb.pause);
    s.querySelector("#ping")!.addEventListener("click", cb.ping);
    s.querySelector("#recipes")!.addEventListener("click", cb.recipes);
    s.querySelector("#settings")!.addEventListener("click", cb.settings);
    s.querySelector("#leave")!.addEventListener("click", cb.leave);
    s.querySelector("#copy")!.addEventListener("click", cb.copyCode);
    s.querySelector("#export")?.addEventListener("click", cb.exportSave);
    this.show(s);
  }

  /** The recipe book: the full build of every burger, for learning and lookups. */
  showRecipeBook(onClose: () => void, unlockedTier = 3): void {
    const names: Partial<Record<ItemKind, string>> = {
      bun_bottom: "Bottom bun",
      bun_top: "Top bun",
      patty: "Beef patty",
      veggie_patty: "Veggie patty",
      cheese: "Cheddar",
      swiss: "Swiss",
    };
    const s = el("section", "screen recipe-book");
    s.innerHTML = `
      <h2>Recipe book</h2>
      <p class="fine">Tickets only show the burger's name. Build bottom to top, in this order, with exactly these sauces. Tiers unlock as the night gets busier.</p>
      <div class="recipes">${Object.values(RECIPES)
        .filter((r) => r.enabled)
        .map(
          (r) => `<article class="recipe ${r.tier > unlockedTier ? "locked" : ""}">
            <header><b>${esc(r.label)}</b><span>${formatCents(r.priceCents)} · tier ${r.tier}</span></header>
            <ol>${[...r.layers]
              .reverse()
              .map((k) => `<li>${esc(names[k] ?? ITEMS[k].label)}${r.grilled?.includes(k) ? " <em>(grilled)</em>" : ""}</li>`)
              .join("")}</ol>
            <p class="sauces">${r.sauces.map((x) => esc(SAUCE_LABEL[x])).join(" + ")}</p>
            <p class="fine">${esc(r.blurb)}</p>
          </article>`,
        )
        .join("")}</div>
      <button class="btn primary" id="close">Back</button>`;
    s.querySelector("#close")!.addEventListener("click", onClose);
    s.addEventListener("keydown", (e) => {
      if (e.key === "Escape") onClose();
    });
    this.show(s);
  }

  showPingMenu(onPick: (p: PingPreset) => void, onClose: () => void): void {
    const s = el("section", "screen ping-menu", `<h2>Ping teammates</h2><div class="grid"></div><button class="btn ghost" id="close">Close</button>`);
    const grid = s.querySelector(".grid")!;
    PING_PRESETS.forEach((p, i) => {
      const b = el("button", "btn", `<kbd>${i + 1}</kbd> ${esc(PING_TEXT[p])}`);
      b.addEventListener("click", () => onPick(p));
      grid.append(b);
    });
    s.addEventListener("keydown", (e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= PING_PRESETS.length) onPick(PING_PRESETS[n - 1]!);
      if (e.key === "Escape") onClose();
    });
    s.querySelector("#close")!.addEventListener("click", onClose);
    this.show(s);
  }

  showSettings(settings: Settings, onChange: (s: Settings) => void, onClose: () => void, extras: { recoveryCode?: string } = {}): void {
    const s = el("section", "screen settings");
    const draft: Settings = structuredClone(settings);
    const slider = (key: keyof Settings, label: string, min: number, max: number, step: number) =>
      `<label class="field slider">${label}<input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${draft[key] as number}"><output>${draft[key]}</output></label>`;
    const check = (key: keyof Settings, label: string) => `<label class="check"><input type="checkbox" data-key="${key}" ${draft[key] ? "checked" : ""}> ${label}</label>`;
    const presets: GraphicsPreset[] = ["tablet", "low", "medium", "high"];
    s.innerHTML = `
      <h2>Settings</h2>
      <div class="settings-grid">
        <fieldset><legend>Camera</legend>
          ${slider("fov", "Field of view", 55, 95, 1)}
          ${slider("sensitivity", "Mouse sensitivity", 0.2, 3, 0.05)}
          ${slider("touchSensitivity", "Touch look sensitivity", 0.2, 3, 0.05)}
          ${check("invertY", "Invert look")}
          ${slider("headBob", "Head bob", 0, 1, 0.05)}
          ${slider("cameraShake", "Camera shake", 0, 1, 0.05)}
          ${check("motionBlur", "Motion blur (off by default)")}
        </fieldset>
        <fieldset><legend>Interaction</legend>
          ${check("toggleToHold", "Toggle to hold (click to pick up, click again to place)")}
          ${check("assistedPlacement", "Assisted placement")}
          ${check("simpleInteractions", "Simple interactions (click knobs and drawers to step them)")}
          ${check("showLabels", "Show contextual labels")}
          ${check("showTicketOverlay", "Show ticket overlay")}
          ${check("showRecipeHints", "Show recipe builds on tickets (learning aid)")}
          ${check("subtitles", "Subtitles for important speech")}
          ${check("reducedEffects", "Reduced sensory effects")}
        </fieldset>
        <fieldset><legend>Audio</legend>
          ${slider("master", "Master", 0, 1, 0.05)}
          ${slider("effects", "Effects", 0, 1, 0.05)}
          ${slider("ambience", "Ambience", 0, 1, 0.05)}
          ${slider("music", "Music", 0, 1, 0.05)}
        </fieldset>
        <fieldset><legend>Graphics</legend>
          <label class="field">Preset<select data-key="graphics">${presets.map((p) => `<option value="${p}" ${draft.graphics === p ? "selected" : ""}>${p}</option>`).join("")}</select></label>
          ${slider("renderScale", "Render scale", 0.5, 1, 0.05)}
          ${check("preferWebGPU", "Prefer WebGPU when available (experimental)")}
          <p class="fine">Preset and WebGPU changes apply next time you open a kitchen.</p>
        </fieldset>
        <fieldset><legend>Touch</legend>
          ${slider("touchControlScale", "Control size", 0.8, 1.5, 0.05)}
          ${check("touchLeftHanded", "Swap sides (stick on the right)")}
        </fieldset>
        <fieldset class="bindings"><legend>Keys</legend>
          ${(Object.keys(DEFAULT_BINDINGS) as (keyof Settings["bindings"])[])
            .map((k) => `<label class="field bind">${k}<button class="btn small" data-bind="${k}">${esc(draft.bindings[k])}</button></label>`)
            .join("")}
        </fieldset>
      </div>
      ${extras.recoveryCode ? `<details class="recovery"><summary>Guest recovery code</summary><p class="fine">Keep this private. It restores your guest profile and restaurants on another device.</p><code>${esc(extras.recoveryCode)}</code></details>` : ""}
      <div class="row"><button id="reset" class="btn ghost">Reset to defaults</button><button id="done" class="btn primary">Done</button></div>
    `;
    s.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]").forEach((input) => {
      input.addEventListener("input", () => {
        const key = input.dataset.key as keyof Settings;
        if (input instanceof HTMLInputElement && input.type === "checkbox") (draft as unknown as Record<string, unknown>)[key] = input.checked;
        else if (input instanceof HTMLInputElement) {
          (draft as unknown as Record<string, unknown>)[key] = Number(input.value);
          const out = input.parentElement?.querySelector("output");
          if (out) out.textContent = input.value;
        } else (draft as unknown as Record<string, unknown>)[key] = input.value;
        onChange(structuredClone(draft));
      });
    });
    s.querySelectorAll<HTMLButtonElement>("[data-bind]").forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.textContent = "Press a key…";
        const handler = (e: KeyboardEvent) => {
          e.preventDefault();
          window.removeEventListener("keydown", handler, true);
          if (e.code !== "Escape") draft.bindings[btn.dataset.bind as keyof Settings["bindings"]] = e.code;
          btn.textContent = draft.bindings[btn.dataset.bind as keyof Settings["bindings"]];
          onChange(structuredClone(draft));
        };
        window.addEventListener("keydown", handler, true);
      });
    });
    s.querySelector("#reset")!.addEventListener("click", () => {
      const d = defaultSettings();
      onChange(d);
      this.showSettings(d, onChange, onClose, extras);
    });
    s.querySelector("#done")!.addEventListener("click", onClose);
    this.show(s);
  }

  showTouchTutorial(onDone: () => void): void {
    const s = el(
      "section",
      "screen tutorial",
      `
      <h2>Touch controls</h2>
      <ul>
        <li><b>Left thumb:</b> move. Push all the way to hurry.</li>
        <li><b>Drag anywhere else:</b> look around.</li>
        <li><b>Tap</b> food, tools or trays to pick them up. <b>Tap</b> a counter, the grill or a burger to put them down. Lifting your finger never drops anything.</li>
        <li><b>Drag a knob or the chiller drawer</b> to turn or open it.</li>
        <li>With the spatula: <b>tap a patty</b> to slide under it, then <b>swipe up</b> or press <b>Use</b> to flip.</li>
        <li>With the sauce bottle: <b>press and hold</b> on the burger to squeeze.</li>
        <li><b>Pinch</b> or use Near/Far to change how far you hold things; <b>Rotate</b> turns the held item.</li>
      </ul>
      <button class="btn primary" id="ok">Got it</button>
    `,
    );
    s.querySelector("#ok")!.addEventListener("click", onDone);
    this.show(s);
  }

  // ------------------------------------------------------------------ HUD

  setHudVisible(on: boolean): void {
    this.hud.hidden = !on;
  }

  setCrosshair(visible: boolean, active: boolean): void {
    this.crosshair.hidden = !visible;
    this.crosshair.classList.toggle("active", active);
  }

  setLabel(text: string | null): void {
    if (!text) {
      this.label.hidden = true;
      return;
    }
    this.label.hidden = false;
    if (this.label.textContent !== text) this.label.textContent = text;
  }

  setInspect(lines: string[] | null): void {
    this.inspect.hidden = !lines;
    if (lines) this.inspect.innerHTML = `<strong>${esc(lines[0] ?? "")}</strong>${lines.slice(1).map((l) => `<span>${esc(l)}</span>`).join("")}`;
  }

  setStatus(s: { code: string; balance: number; phase: string; shiftTime: number; save: string; players: number; connected: boolean }): void {
    const key = `${s.code}|${s.balance}|${s.phase}|${Math.floor(s.shiftTime)}|${s.save}|${s.players}|${s.connected}`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    const mins = Math.floor(s.shiftTime / 60);
    const secs = String(Math.floor(s.shiftTime % 60)).padStart(2, "0");
    const phase = s.phase === "open" ? `Open ${mins}:${secs}` : s.phase === "closing" ? "Closing" : s.phase === "prep" ? "Prep — flip the OPEN sign" : s.phase;
    const save = s.save === "ok" ? "" : s.save === "pending" ? `<span class="warn">Saving…</span>` : `<span class="bad">Save unavailable</span>`;
    this.status.innerHTML = `<span class="chip code">${esc(s.code)}</span><span class="chip">${formatCents(s.balance)}</span><span class="chip">${esc(phase)}</span><span class="chip">${s.players} cook${s.players === 1 ? "" : "s"}</span>${save}${s.connected ? "" : `<span class="bad">Reconnecting…</span>`}`;
  }

  setBanner(text: string | null, action?: { label: string; run: () => void }): void {
    if (!text) {
      this.banner.hidden = true;
      return;
    }
    this.banner.hidden = false;
    const key = `${text}|${action?.label ?? ""}`;
    if (this.banner.dataset.key === key) return;
    this.banner.dataset.key = key;
    this.banner.innerHTML = `<span>${esc(text)}</span>`;
    if (action) {
      const b = el("button", "btn small", esc(action.label));
      b.addEventListener("click", action.run);
      this.banner.append(b);
    }
  }

  setTickets(visible: boolean, orders: { number: number; customer?: string; label: string; mods: string[]; wait: number; hint?: string }[]): void {
    this.tickets.hidden = !visible || orders.length === 0;
    const key = orders.map((o) => `${o.number}:${Math.floor(o.wait / 5)}:${o.hint ?? ""}`).join("|");
    if (key === this.lastTicketsKey) return;
    this.lastTicketsKey = key;
    this.tickets.innerHTML = orders
      .map(
        (o) =>
          `<div class="ticket ${o.wait > 180 ? "late" : ""}"><b>#${o.number}${o.customer ? ` <span class="who">${esc(o.customer)}</span>` : ""}</b> ${esc(o.label)}${o.mods.map((m) => `<em>${esc(m)}</em>`).join("")}${o.hint ? `<i>${esc(o.hint)}</i>` : ""}<small>${Math.floor(o.wait / 60)}:${String(Math.floor(o.wait % 60)).padStart(2, "0")}</small></div>`,
      )
      .join("");
  }

  setClickToPlay(on: boolean, onClick?: () => void): void {
    this.prompt.hidden = !on;
    this.prompt.onclick = onClick ?? null;
  }

  toast(text: string, tone: "info" | "warn" | "success" = "info", ms = 3200): void {
    const t = el("div", `toast ${tone}`, esc(text));
    this.toasts.append(t);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
    setTimeout(() => t.classList.add("leaving"), ms);
    setTimeout(() => t.remove(), ms + 400);
  }

  served(m: ServedMessage): void {
    const t = el(
      "div",
      `toast served ${m.score >= 80 ? "success" : m.score >= 50 ? "info" : "warn"}`,
      `<b>Order #${m.orderNumber} served${m.by ? ` by ${esc(m.by)}` : ""}</b> · ${m.score}/100 · ${formatCents(m.priceCents)}${m.tipCents ? ` + ${formatCents(m.tipCents)} tip` : ""}<ul>${m.feedback
        .slice(0, 3)
        .map((f) => `<li>${esc(f)}</li>`)
        .join("")}</ul>`,
    );
    this.toasts.append(t);
    setTimeout(() => t.classList.add("leaving"), 6000);
    setTimeout(() => t.remove(), 6400);
  }

  summary(m: SummaryMessage, onClose: () => void): void {
    const s = el(
      "section",
      "screen ledger",
      `
      <h2>Shift ledger</h2>
      <table>
        <tr><th>Sales &amp; tips</th><td>${formatCents(m.revenue)}</td></tr>
        <tr><th>Ingredients used</th><td>−${formatCents(m.costs)}</td></tr>
        <tr><th>Waste</th><td>−${formatCents(m.waste)}</td></tr>
        <tr><th>Equipment</th><td>${formatCents(0)}</td></tr>
        <tr class="total"><th>Profit</th><td>${formatCents(m.profit)}</td></tr>
        <tr><th>Orders served / refused</th><td>${m.served} / ${m.refused}</td></tr>
        <tr><th>Restaurant balance</th><td>${formatCents(m.balance)}</td></tr>
      </table>
      <button class="btn primary" id="ok">Back to the kitchen</button>
    `,
    );
    s.querySelector("#ok")!.addEventListener("click", onClose);
    this.show(s);
  }
}
