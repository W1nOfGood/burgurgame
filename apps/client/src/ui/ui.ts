import { CATALOG_KEYS, DRINKS, FRIES_PRICE_CENTS, ITEMS, MAX_PACKS_PER_ORDER, MODIFIERS, RECIPE_IDS, modifiersFor, type ModifierId, type RecipeId, RECIPES, RESTOCK_PACKS, SAUCE_LABEL, STOCK_LABEL, formatCents, type ItemKind, type StockKey } from "@ahb/data";
import { PING_PRESETS, PING_TEXT, type PingPreset, type ResultMessage, type ServedMessage, type SummaryMessage } from "@ahb/protocol";
import { TILL_HAS } from "@ahb/simulation";
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
  /** Present only when the tutorial can be started (before opening) or skipped (while it runs). */
  tutorial?: { label: string; run(): void };
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
  private readonly coach: HTMLElement;
  private lastCoachKey = "";
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
    this.coach = el("div", "coach");
    this.coach.hidden = true;
    this.prompt = el("button", "click-to-play", "Click to play");
    this.prompt.hidden = true;
    this.toasts = el("div", "toasts");
    this.toasts.setAttribute("role", "status");
    this.toasts.setAttribute("aria-live", "polite");
    this.hud.append(this.crosshair, this.label, this.inspect, this.status, this.banner, this.tickets, this.coach, this.prompt);
    this.screens = el("div", "screens");
    root.append(this.hud, this.toasts, this.screens);
  }

  // ------------------------------------------------------------------ screens

  /** Stops whatever the visible screen keeps running (a live-updating catalog). */
  private cleanup: (() => void) | null = null;

  private show(content: HTMLElement): HTMLElement {
    this.cleanup?.();
    this.cleanup = null;
    this.screens.replaceChildren(content);
    this.screen = content;
    this.screens.hidden = false;
    const focusable = content.querySelector<HTMLElement>("[autofocus], input, button");
    focusable?.focus({ preventScroll: true });
    return content;
  }

  hideScreen(): void {
    this.cleanup?.();
    this.cleanup = null;
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
        ${cb.tutorial ? `<button id="tutorial" class="btn">${esc(cb.tutorial.label)}</button>` : ""}
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
    s.querySelector("#tutorial")?.addEventListener("click", () => cb.tutorial!.run());
    s.querySelector("#settings")!.addEventListener("click", cb.settings);
    s.querySelector("#leave")!.addEventListener("click", cb.leave);
    s.querySelector("#copy")!.addEventListener("click", cb.copyCode);
    s.querySelector("#export")?.addEventListener("click", cb.exportSave);
    this.show(s);
  }

  /**
   * The cash register. A customer at the counter says what they want; the cashier rings up the
   * burger, the changes, the drink and the sides, and sends it to the kitchen. The ticket prints
   * only when it is what they asked for (the customer says what is wrong when it is not).
   */
  showRegister(
    read: () => { tutorial: boolean; customers: { id: string; name: string; say: string }[] },
    ring: (customer: string, order: { recipe: string; modifiers: string[]; drink: string; side: string }) => Promise<ResultMessage>,
    onClose: () => void,
  ): void {
    const s = el("section", "screen register");
    const pick = { recipe: "" as RecipeId | "", mods: new Set<ModifierId>(), drink: "", side: "", customer: "" };
    const recipes = (tutorial: boolean) =>
      RECIPE_IDS.filter((id) => RECIPES[id].enabled && (tutorial || !RECIPES[id].tutorialOnly)).sort((a, b) => RECIPES[a].tier - RECIPES[b].tier || RECIPES[a].priceCents - RECIPES[b].priceCents);
    s.innerHTML = `
      <h2>Register</h2>
      <div class="pos-who"></div>
      <div class="pos-grid">
        <div>
          <h3>Burger</h3>
          <div class="pos-menu"></div>
          <h3 class="pos-mods-h">Changes</h3>
          <div class="pos-mods"></div>
          <div class="pos-extras"></div>
        </div>
        <aside class="pos-ticket">
          <h3>Ticket</h3>
          <ul></ul>
          <p class="pos-total"></p>
          <p class="msg" role="status"></p>
          <button class="btn primary" id="send">Send to kitchen</button>
          <button class="btn ghost" id="clear">Clear</button>
        </aside>
      </div>
      <button class="btn" id="close">Done</button>`;
    const q = <T extends HTMLElement>(sel: string) => s.querySelector<T>(sel)!;
    const msg = q(".msg");
    let menuKey = "";
    let tutorial = false;
    const total = (): number => {
      if (!pick.recipe) return 0;
      let c = RECIPES[pick.recipe].priceCents;
      for (const m of pick.mods) c += MODIFIERS[m].priceDeltaCents;
      if (pick.drink) c += DRINKS.find((d) => d.id === pick.drink)?.priceCents ?? 0;
      if (pick.side) c += FRIES_PRICE_CENTS;
      return c;
    };
    const chip = (label: string, on: boolean, attrs: string) => `<button class="chip-btn ${on ? "on" : ""}" ${attrs}>${esc(label)}</button>`;
    const paint = (): void => {
      const { customers, tutorial: tut } = read();
      tutorial = tut;
      if (!customers.some((c) => c.id === pick.customer)) pick.customer = customers[0]?.id ?? "";
      const cur = customers.find((c) => c.id === pick.customer);
      q(".pos-who").innerHTML = cur
        ? `${tut ? `<p class="coach-line">Tutorial: tap what they said — ${recipes(true).includes("starter") ? "<b>Starter Burger</b>" : ""}${TILL_HAS.drinks ? " and <b>Fizz Cola</b>" : ""} — then <b>Send to kitchen</b>.</p>` : ""}<p class="who-line"><b>${esc(cur.name)}</b> <span class="quote">“${esc(cur.say)}”</span></p>${customers.length > 1 ? `<p class="fine">Also waiting: ${customers.filter((c) => c !== cur).map((c) => `<button class="link" data-cust="${c.id}">${esc(c.name)}</button>`).join(", ")}</p>` : ""}`
        : `<p class="fine">Nobody is at the counter. Customers who walk up will say their order here.</p>`;
      const key = `${tutorial}|${pick.recipe}|${[...pick.mods].join()}|${pick.drink}|${pick.side}`;
      if (key !== menuKey) {
        menuKey = key;
        q(".pos-menu").innerHTML = recipes(tutorial)
          .map((id) => chip(`${RECIPES[id].label} · ${formatCents(RECIPES[id].priceCents)}`, pick.recipe === id, `data-recipe="${id}"`))
          .join("");
        const mods = pick.recipe ? modifiersFor(pick.recipe) : [];
        q(".pos-mods-h").hidden = mods.length === 0;
        q(".pos-mods").innerHTML = mods.map((m) => chip(`${MODIFIERS[m].label}${MODIFIERS[m].priceDeltaCents ? ` +${formatCents(MODIFIERS[m].priceDeltaCents)}` : ""}`, pick.mods.has(m), `data-mod="${m}"`)).join("");
        const extras: string[] = [];
        if (TILL_HAS.drinks) extras.push(`<h3>Drink</h3><div>${chip("No drink", pick.drink === "", `data-drink=""`)}${DRINKS.map((d) => chip(`${d.label} · ${formatCents(d.priceCents)}`, pick.drink === d.id, `data-drink="${d.id}"`)).join("")}</div>`);
        if (TILL_HAS.fries) extras.push(`<h3>Side</h3><div>${chip("No fries", pick.side === "", `data-side=""`)}${chip(`Fries · ${formatCents(FRIES_PRICE_CENTS)}`, pick.side === "fries", `data-side="fries"`)}</div>`);
        q(".pos-extras").innerHTML = extras.join("");
        const lines: string[] = [];
        if (pick.recipe) lines.push(esc(RECIPES[pick.recipe].label));
        for (const m of pick.mods) lines.push(`<em>${esc(MODIFIERS[m].label)}</em>`);
        if (pick.side) lines.push(`<em class="extra">+ Fries</em>`);
        if (pick.drink) lines.push(`<em class="extra">+ ${esc(DRINKS.find((d) => d.id === pick.drink)?.label ?? pick.drink)}</em>`);
        q(".pos-ticket ul").innerHTML = lines.length ? lines.map((l) => `<li>${l}</li>`).join("") : `<li class="fine">Tap what they asked for</li>`;
        q(".pos-total").textContent = pick.recipe ? `Total ${formatCents(total())}` : "";
      }
      q<HTMLButtonElement>("#send").disabled = !pick.recipe || !pick.customer;
    };
    s.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-recipe],[data-mod],[data-drink],[data-side],[data-cust]");
      if (!t) return;
      msg.textContent = "";
      msg.classList.remove("bad");
      if (t.dataset.cust) pick.customer = t.dataset.cust;
      if (t.dataset.recipe) {
        pick.recipe = t.dataset.recipe as RecipeId;
        pick.mods = new Set([...pick.mods].filter((m) => modifiersFor(pick.recipe as RecipeId).includes(m)));
      }
      if (t.dataset.mod) {
        const m = t.dataset.mod as ModifierId;
        if (pick.mods.has(m)) pick.mods.delete(m);
        else pick.mods.add(m);
      }
      if (t.dataset.drink !== undefined) pick.drink = t.dataset.drink;
      if (t.dataset.side !== undefined) pick.side = t.dataset.side;
      menuKey = "";
      paint();
    });
    q("#clear").addEventListener("click", () => {
      pick.recipe = "";
      pick.mods.clear();
      pick.drink = "";
      pick.side = "";
      msg.textContent = "";
      menuKey = "";
      paint();
    });
    q<HTMLButtonElement>("#send").addEventListener("click", () => {
      if (!pick.recipe || !pick.customer) return;
      const btn = q<HTMLButtonElement>("#send");
      btn.disabled = true;
      void ring(pick.customer, { recipe: pick.recipe, modifiers: [...pick.mods], drink: pick.drink, side: pick.side }).then((r) => {
        msg.classList.toggle("bad", !r.ok);
        if (r.ok) {
          msg.textContent = "Sent to the kitchen.";
          pick.recipe = "";
          pick.mods.clear();
          pick.drink = "";
          pick.side = "";
          menuKey = "";
        } else {
          msg.textContent = r.reason ?? "That didn't go through";
        }
        paint();
      });
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    q("#close").addEventListener("click", onClose);
    this.show(s);
    paint();
    const timer = setInterval(paint, 400);
    window.addEventListener("keydown", onKey);
    this.cleanup = () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }

  /**
   * The office computer: the supply catalog. Stock and balance update live (others may be
   * cooking and ordering at the same time); each order is paid for and delivered at once.
   */
  showSupplies(read: () => { balance: number; stock: (key: StockKey) => number }, buy: (key: StockKey, packs: number) => Promise<ResultMessage>, onClose: () => void): void {
    const s = el("section", "screen supplies");
    s.innerHTML = `
      <h2>Supply orders</h2>
      <p class="fine">Packs arrive straight away and come out of the restaurant's money. <b class="balance"></b></p>
      <div class="supply-list">${CATALOG_KEYS.map((key) => {
        const pack = RESTOCK_PACKS[key];
        return `<article class="supply" data-key="${key}">
          <header><b>${esc(STOCK_LABEL[key])}</b><span class="have"></span></header>
          <p class="fine">${pack.quantity} per pack · ${formatCents(pack.priceCents)}</p>
          <div class="buy-row"><button class="btn small" data-packs="1">Buy 1</button><button class="btn small" data-packs="5">Buy 5</button></div>
        </article>`;
      }).join("")}</div>
      <p class="fine msg" role="status"></p>
      <button class="btn primary" id="close">Done</button>`;
    const msg = s.querySelector<HTMLElement>(".msg")!;
    const paint = () => {
      const { balance, stock } = read();
      s.querySelector<HTMLElement>(".balance")!.textContent = `In the till: ${formatCents(balance)}`;
      for (const card of s.querySelectorAll<HTMLElement>(".supply")) {
        const key = card.dataset.key as StockKey;
        const have = stock(key);
        const low = have <= RESTOCK_PACKS[key].quantity / 3;
        const label = card.querySelector<HTMLElement>(".have")!;
        label.textContent = have <= 0 ? "Out of stock" : `${have} left`;
        label.classList.toggle("low", low);
        for (const b of card.querySelectorAll<HTMLButtonElement>("button")) b.disabled = RESTOCK_PACKS[key].priceCents * Number(b.dataset.packs) > balance;
      }
    };
    s.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-packs]");
      if (!b) return;
      const key = b.closest<HTMLElement>(".supply")!.dataset.key as StockKey;
      const packs = Math.min(MAX_PACKS_PER_ORDER, Number(b.dataset.packs));
      b.disabled = true;
      void buy(key, packs).then((r) => {
        msg.textContent = r.ok ? `Ordered ${packs * RESTOCK_PACKS[key].quantity} ${STOCK_LABEL[key].toLowerCase()}.` : (r.reason ?? "Couldn't place that order");
        msg.classList.toggle("bad", !r.ok);
        paint();
      });
    });
    // On the window: after a purchase the pressed button is disabled and focus is lost.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    s.querySelector("#close")!.addEventListener("click", onClose);
    this.show(s);
    paint();
    const timer = setInterval(paint, 400);
    window.addEventListener("keydown", onKey);
    this.cleanup = () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
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

  setTickets(visible: boolean, orders: { number: number; customer?: string; label: string; mods: string[]; extras?: string[]; wait: number; hint?: string }[]): void {
    this.tickets.hidden = !visible || orders.length === 0;
    const key = orders.map((o) => `${o.number}:${Math.floor(o.wait / 5)}:${o.hint ?? ""}:${(o.extras ?? []).join("+")}`).join("|");
    if (key === this.lastTicketsKey) return;
    this.lastTicketsKey = key;
    this.tickets.innerHTML = orders
      .map(
        (o) =>
          `<div class="ticket ${o.wait > 180 ? "late" : ""}"><b>#${o.number}${o.customer ? ` <span class="who">${esc(o.customer)}</span>` : ""}</b> ${esc(o.label)}${o.mods.map((m) => `<em>${esc(m)}</em>`).join("")}${(o.extras ?? []).map((m) => `<em class="extra">+ ${esc(m)}</em>`).join("")}${o.hint ? `<i>${esc(o.hint)}</i>` : ""}<small>${Math.floor(o.wait / 60)}:${String(Math.floor(o.wait % 60)).padStart(2, "0")}</small></div>`,
      )
      .join("");
  }

  /** The tutorial card: what to do next. `null` hides it. */
  setCoach(step: { index: number; total: number; text: string } | null, onSkip: () => void): void {
    if (!step) {
      if (!this.coach.hidden) this.coach.hidden = true;
      this.lastCoachKey = "";
      return;
    }
    const key = `${step.index}|${step.text}`;
    this.coach.hidden = false;
    if (key === this.lastCoachKey) return;
    this.lastCoachKey = key;
    this.coach.innerHTML = `<span class="coach-step">Tutorial · ${step.index}/${step.total}</span><p>${esc(step.text)}</p><button class="link" type="button">Skip tutorial</button>`;
    this.coach.querySelector("button")!.addEventListener("click", onSkip);
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
