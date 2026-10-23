import type { Settings } from "../settings.js";

/**
 * Web Audio (spec §12): positional grill sizzle that follows cooking state, ventilation and
 * fridge ambience, and short synthesized effects. Placeholder synthesis until recorded sound
 * arrives in Stage 3. The context starts only after an explicit tap/click.
 */
export type Sfx = "place" | "grab" | "knob" | "flip" | "squeeze" | "ding" | "ticket" | "error" | "drawer" | "trash" | "click";

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private effects!: GainNode;
  private ambience!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  private sizzles: { gain: GainNode; panner: PannerNode }[] = [];
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  get running(): boolean {
    return this.ctx?.state === "running";
  }

  /** Must be called from a user gesture handler. */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.build();
    }
    if (this.ctx.state !== "running") await this.ctx.resume().catch(() => undefined);
  }

  private build(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.effects = ctx.createGain();
    this.ambience = ctx.createGain();
    this.music = ctx.createGain();
    this.effects.connect(this.master);
    this.ambience.connect(this.master);
    this.music.connect(this.master);
    this.applySettings(this.settings);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Ventilation hood rumble.
    const vent = ctx.createBufferSource();
    vent.buffer = this.noise;
    vent.loop = true;
    const ventFilter = ctx.createBiquadFilter();
    ventFilter.type = "lowpass";
    ventFilter.frequency.value = 220;
    const ventGain = ctx.createGain();
    ventGain.gain.value = 0.12;
    vent.connect(ventFilter).connect(ventGain).connect(this.ambience);
    vent.start();
    // Fridge hum.
    const hum = ctx.createOscillator();
    hum.frequency.value = 58;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.015;
    hum.connect(humGain).connect(this.ambience);
    hum.start();
  }

  applySettings(s: Settings): void {
    this.settings = s;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.master, t, 0.05);
    this.effects.gain.setTargetAtTime(s.effects, t, 0.05);
    this.ambience.gain.setTargetAtTime(s.ambience * (s.reducedEffects ? 0.5 : 1), t, 0.05);
    this.music.gain.setTargetAtTime(s.music, t, 0.05);
  }

  /** One positional sizzle voice per grill zone. */
  setupSizzles(positions: { x: number; y: number; z: number }[]): void {
    const ctx = this.ctx;
    if (!ctx || this.sizzles.length > 0) return;
    for (const p of positions) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.loopStart = Math.random();
      const band = ctx.createBiquadFilter();
      band.type = "highpass";
      band.frequency.value = 2400;
      const crackle = ctx.createBiquadFilter();
      crackle.type = "peaking";
      crackle.frequency.value = 5200;
      crackle.gain.value = 8;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const panner = new PannerNode(ctx, { panningModel: "HRTF", distanceModel: "inverse", refDistance: 0.8, maxDistance: 20, rolloffFactor: 1.4, positionX: p.x, positionY: p.y, positionZ: -p.z });
      src.connect(band).connect(crackle).connect(gain).connect(panner).connect(this.effects);
      src.start(0, Math.random());
      this.sizzles.push({ gain, panner });
    }
  }

  setSizzle(zone: number, level: number): void {
    const s = this.sizzles[zone];
    if (!s || !this.ctx) return;
    s.gain.gain.setTargetAtTime(level * 0.35, this.ctx.currentTime, 0.15);
  }

  setListener(x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(x, t, 0.02);
      l.positionY.setTargetAtTime(y, t, 0.02);
      // Babylon is left-handed; Web Audio is right-handed, so every Z is mirrored.
      l.positionZ.setTargetAtTime(-z, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02);
      l.forwardY.setTargetAtTime(fy, t, 0.02);
      l.forwardZ.setTargetAtTime(-fz, t, 0.02);
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    }
  }

  play(kind: Sfx, at?: { x: number; y: number; z: number }): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    if (at) {
      const p = new PannerNode(ctx, { panningModel: "equalpower", refDistance: 1, positionX: at.x, positionY: at.y, positionZ: -at.z });
      out.connect(p).connect(this.effects);
    } else out.connect(this.effects);
    const tone = (freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t + delay);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + delay + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(vol, t + delay + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      o.connect(g).connect(out);
      o.start(t + delay);
      o.stop(t + delay + dur + 0.02);
    };
    const burst = (dur: number, freq: number, vol: number, q = 1) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f).connect(g).connect(out);
      src.start(t, Math.random());
      src.stop(t + dur + 0.02);
    };
    switch (kind) {
      case "place":
        tone(140, 0.08, "sine", 0.4, 70);
        burst(0.05, 900, 0.2);
        break;
      case "grab":
        burst(0.04, 1800, 0.12);
        break;
      case "knob":
        burst(0.015, 4000, 0.15, 6);
        break;
      case "flip":
        burst(0.18, 1200, 0.15, 0.6);
        tone(220, 0.1, "sine", 0.2, 120, 0.2);
        break;
      case "squeeze":
        burst(0.12, 600, 0.2, 2);
        break;
      case "ding":
        tone(1320, 0.6, "sine", 0.3);
        tone(1980, 0.5, "sine", 0.12, undefined, 0.01);
        break;
      case "ticket":
        for (let i = 0; i < 5; i++) burst(0.03, 3000, 0.08, 4);
        tone(880, 0.12, "square", 0.04);
        break;
      case "error":
        tone(220, 0.15, "triangle", 0.15, 160);
        break;
      case "drawer":
        burst(0.25, 500, 0.1, 0.8);
        break;
      case "trash":
        burst(0.2, 300, 0.25, 0.8);
        break;
      case "click":
        burst(0.02, 3000, 0.1, 5);
        break;
    }
  }

  async suspend(): Promise<void> {
    await this.ctx?.suspend().catch(() => undefined);
  }
}
