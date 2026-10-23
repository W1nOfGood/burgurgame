/**
 * Network overlay (F3, or ?net=1): what the connection is doing right now, in words a player can
 * read back to us. Ping, how many simulation ticks the server really runs per second, how far
 * behind other players are drawn, prediction corrections, and anything that stops movement
 * (pause, reconnecting, a menu).
 */
export interface NetSample {
  connected: boolean;
  reconnecting: boolean;
  paused: string | null;
  menuOpen: boolean;
  serverTick: number;
  renderDelayMs: number;
  jitterMs: number;
  pendingInputs: number;
  fps: number;
}

export class NetStats {
  private readonly el: HTMLDivElement;
  private visible = false;
  private pingMs: number | null = null;
  private lastPing = 0;
  private tickRate: number | null = null;
  private tickRef: { tick: number; at: number } | null = null;
  private corrections: { at: number; size: number }[] = [];
  private lastDraw = 0;

  constructor(private readonly ping: (cb: (ms: number) => void) => void) {
    this.el = document.createElement("div");
    this.el.className = "net-stats";
    this.el.setAttribute("aria-live", "off");
    Object.assign(this.el.style, {
      position: "fixed",
      left: "max(12px, env(safe-area-inset-left, 0px))",
      bottom: "max(12px, env(safe-area-inset-bottom, 0px))",
      zIndex: "40",
      font: "12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
      color: "#f2efe6",
      background: "rgba(10, 12, 14, 0.78)",
      padding: "8px 10px",
      borderRadius: "6px",
      whiteSpace: "pre",
      pointerEvents: "none",
    });
    this.el.hidden = true;
    document.body.appendChild(this.el);
    try {
      if (new URLSearchParams(location.search).has("net")) this.toggle(true);
    } catch {
      // No location (tests).
    }
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.el.hidden = !this.visible;
  }

  /** Every reconcile: how far the server moved us from where we predicted (m). */
  correction(size: number): void {
    if (size < 0.01) return;
    this.corrections.push({ at: performance.now(), size });
  }

  frame(s: NetSample): void {
    const now = performance.now();
    // Server tick rate, measured over a few seconds of patches.
    if (!this.tickRef) this.tickRef = { tick: s.serverTick, at: now };
    else if (now - this.tickRef.at > 3000) {
      const rate = ((s.serverTick - this.tickRef.tick) * 1000) / (now - this.tickRef.at);
      if (!s.paused && rate > 0) this.tickRate = rate;
      this.tickRef = { tick: s.serverTick, at: now };
    }
    if (!this.visible) return;
    if (now - this.lastPing > 2000 && s.connected) {
      this.lastPing = now;
      this.ping((ms) => (this.pingMs = ms));
    }
    if (now - this.lastDraw < 250) return;
    this.lastDraw = now;
    this.corrections = this.corrections.filter((c) => now - c.at < 10_000);
    const big = this.corrections.filter((c) => c.size > 0.1).length;
    const worst = this.corrections.reduce((m, c) => Math.max(m, c.size), 0);
    const blocked = !s.connected ? (s.reconnecting ? "RECONNECTING" : "DISCONNECTED") : s.paused ? `PAUSED (${s.paused})` : s.menuOpen ? "menu open" : "";
    const tick = this.tickRate === null ? "…" : this.tickRate.toFixed(0);
    this.el.textContent = [
      `ping        ${this.pingMs === null ? "…" : `${Math.round(this.pingMs)} ms`}`,
      `server      ${tick} ticks/s${this.tickRate !== null && this.tickRate < 55 ? "  ← server is falling behind" : ""}`,
      `others      drawn ${Math.round(s.renderDelayMs)} ms behind (jitter ${Math.round(s.jitterMs)} ms)`,
      `you         ${this.corrections.length} corrections/10 s, ${big} over 10 cm, worst ${(worst * 100).toFixed(0)} cm`,
      `inputs      ${s.pendingInputs} waiting for the server`,
      `fps         ${s.fps.toFixed(0)}`,
      ...(blocked ? [`movement    blocked: ${blocked}`] : []),
    ].join("\n");
  }

  dispose(): void {
    this.el.remove();
  }
}
