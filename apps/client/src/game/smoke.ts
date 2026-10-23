import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import type { Scene } from "@babylonjs/core/scene";
import type { GraphicsPreset } from "../settings.js";

export interface SmokeSource {
  x: number;
  y: number;
  z: number;
  /** 0..1 sizzle level (from the authoritative cooking state). */
  level: number;
  /** 0..1 burn: darker, heavier smoke. */
  burn: number;
}

/**
 * Wisps of steam and smoke rising off food on the flat-top. One particle system for the whole
 * grill: each new particle starts at a random hot item (weighted by sizzle), so the amount of
 * smoke follows the replicated cooking state with no extra network traffic.
 */
export class GrillSmoke {
  private readonly ps: ParticleSystem;
  private sources: SmokeSource[] = [];
  private total = 0;
  private readonly maxRate: number;

  constructor(scene: Scene, preset: GraphicsPreset) {
    const capacity = preset === "high" ? 420 : preset === "medium" ? 300 : 160;
    this.maxRate = preset === "high" ? 70 : preset === "medium" ? 50 : 26;
    const ps = new ParticleSystem("grill_smoke", capacity, scene);
    ps.particleTexture = puffTexture(scene);
    ps.emitter = new Vector3(0, 0.95, 4.55);
    ps.minLifeTime = 1.2;
    ps.maxLifeTime = 2.6;
    ps.minSize = 0.03;
    ps.maxSize = 0.07;
    ps.minScaleX = ps.minScaleY = 1;
    ps.addSizeGradient(0, 0.035, 0.06);
    ps.addSizeGradient(0.4, 0.12, 0.18);
    ps.addSizeGradient(1, 0.26, 0.36);
    ps.color1 = new Color4(0.86, 0.84, 0.8, 0.16);
    ps.color2 = new Color4(0.74, 0.72, 0.7, 0.12);
    ps.colorDead = new Color4(0.6, 0.6, 0.6, 0);
    ps.addColorGradient(0, new Color4(0.9, 0.88, 0.84, 0));
    ps.addColorGradient(0.12, new Color4(0.86, 0.84, 0.8, 0.14));
    ps.addColorGradient(0.6, new Color4(0.75, 0.74, 0.72, 0.08));
    ps.addColorGradient(1, new Color4(0.6, 0.6, 0.6, 0));
    ps.minEmitPower = 0.18;
    ps.maxEmitPower = 0.34;
    ps.direction1 = new Vector3(-0.08, 1, -0.06);
    ps.direction2 = new Vector3(0.08, 1, 0.1);
    ps.gravity = new Vector3(0, 0.05, 0.02);
    ps.minAngularSpeed = -0.6;
    ps.maxAngularSpeed = 0.6;
    ps.minInitialRotation = 0;
    ps.maxInitialRotation = Math.PI * 2;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.isLocal = false;
    ps.emitRate = 0;
    ps.startPositionFunction = (_world, pos) => {
      const s = this.pick();
      if (!s) {
        pos.set(0, -10, 0);
        return;
      }
      pos.set(s.x + (Math.random() - 0.5) * 0.08, s.y + 0.01, s.z + (Math.random() - 0.5) * 0.08);
    };
    ps.start();
    this.ps = ps;
  }

  private pick(): SmokeSource | null {
    if (this.total <= 0) return null;
    let r = Math.random() * this.total;
    for (const s of this.sources) {
      r -= s.level;
      if (r <= 0) return s;
    }
    return this.sources[this.sources.length - 1] ?? null;
  }

  update(sources: SmokeSource[], paused: boolean): void {
    this.sources = sources.filter((s) => s.level > 0.04);
    this.total = this.sources.reduce((a, s) => a + s.level, 0);
    const burn = this.sources.reduce((a, s) => Math.max(a, s.burn), 0);
    this.ps.emitRate = paused ? 0 : Math.min(this.maxRate, this.total * this.maxRate * 0.55);
    // Burning food: denser, greyer smoke.
    const g = 0.86 - burn * 0.4;
    this.ps.color1.set(g, g * 0.98, g * 0.95, 0.16 + burn * 0.14);
    this.ps.color2.set(g * 0.9, g * 0.88, g * 0.86, 0.12 + burn * 0.12);
  }

  dispose(): void {
    this.ps.dispose(true);
  }
}

/** Soft, slightly lumpy puff sprite painted once (no external texture). */
function puffTexture(scene: Scene): DynamicTexture {
  const size = 64;
  const tex = new DynamicTexture("smoke_puff", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 7; i++) {
    const cx = size / 2 + Math.cos(i * 2.4) * size * 0.12;
    const cy = size / 2 + Math.sin(i * 2.4) * size * 0.12;
    const r = size * (0.26 + 0.06 * Math.sin(i * 1.7));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  tex.hasAlpha = true;
  tex.update(false);
  return tex;
}
