import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Small procedural textures shared by every food item of a kind. They add surface detail
 * (grain, crumb, veins, seeds) that vertex colours alone can't, and are multiplied by the
 * per-item colour that tracks cooking state. Authored texture sets replace them in Stage 3.
 */
type Paint = (ctx: CanvasRenderingContext2D, s: number) => void;

let seed = 12345;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function speckle(ctx: CanvasRenderingContext2D, s: number, count: number, rMin: number, rMax: number, colors: string[]): void {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[i % colors.length]!;
    ctx.beginPath();
    ctx.arc(rand() * s, rand() * s, rMin + rand() * (rMax - rMin), 0, Math.PI * 2);
    ctx.fill();
  }
}

const PAINTERS: Record<string, Paint> = {
  // Greyscale so the cooking colour shows through: lighter fat flecks, darker grain.
  meat: (ctx, s) => {
    ctx.fillStyle = "#e4e4e4";
    ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, 900, 0.6, 2.4, ["#ffffff", "#c8c8c8", "#b0b0b0", "#f2f2f2"]);
  },
  veggie: (ctx, s) => {
    ctx.fillStyle = "#e0e0e0";
    ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, 600, 1, 3.5, ["#9fd17a", "#f4d27a", "#c43c2c", "#ffffff", "#a8a8a8"]);
  },
  // Grill marks: dark diagonal bars on transparent background.
  grill: (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = "rgba(25,12,6,0.85)";
    for (let i = -2; i < 7; i++) {
      ctx.save();
      ctx.translate(s / 2, s / 2);
      ctx.rotate(-0.6);
      ctx.fillRect(-s, -s / 2 + i * (s / 5), s * 2, s / 16);
      ctx.restore();
    }
  },
  crumb: (ctx, s) => {
    ctx.fillStyle = "#f0f0f0";
    ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, 700, 0.8, 3, ["#d8d8d8", "#ffffff", "#c4c4c4"]);
  },
  crust: (ctx, s) => {
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(1, "#d6d6d6");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, 300, 0.5, 1.5, ["#efefef", "#cfcfcf"]);
  },
  lettuce: (ctx, s) => {
    ctx.fillStyle = "#5fa836";
    ctx.fillRect(0, 0, s, s);
    const g = ctx.createRadialGradient(s / 2, s / 2, 4, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(230,245,190,0.9)");
    g.addColorStop(1, "rgba(60,130,30,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = "rgba(225,245,200,0.75)";
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s / 2, s / 2);
      ctx.quadraticCurveTo(s / 2 + Math.cos(a + 0.3) * s * 0.25, s / 2 + Math.sin(a + 0.3) * s * 0.25, s / 2 + Math.cos(a) * s / 2, s / 2 + Math.sin(a) * s / 2);
      ctx.stroke();
    }
  },
  tomato: (ctx, s) => {
    ctx.fillStyle = "#c81d12";
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = "#e9493a";
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.4, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      ctx.fillStyle = "#f6a36b";
      ctx.beginPath();
      ctx.ellipse(s / 2 + Math.cos(a) * s * 0.2, s / 2 + Math.sin(a) * s * 0.2, s * 0.11, s * 0.07, a, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f7e6a1";
      for (let j = 0; j < 4; j++) {
        ctx.beginPath();
        ctx.ellipse(s / 2 + Math.cos(a) * s * (0.15 + j * 0.03), s / 2 + Math.sin(a) * s * (0.15 + j * 0.03), 3, 1.5, a, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = "#f08c70";
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.06, 0, Math.PI * 2);
    ctx.fill();
  },
  swiss: (ctx, s) => {
    ctx.fillStyle = "#f3e2a2";
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 9; i++) {
      const x = rand() * s;
      const y = rand() * s;
      const r = 6 + rand() * 12;
      const g = ctx.createRadialGradient(x, y, 1, x, y, r);
      g.addColorStop(0, "#b99a4a");
      g.addColorStop(0.8, "#d8c07a");
      g.addColorStop(1, "#f3e2a2");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  bacon: (ctx, s) => {
    for (let y = 0; y < s; y++) {
      const t = y / s;
      const band = Math.sin(t * Math.PI * 7) * 0.5 + 0.5;
      const fat = band > 0.72;
      ctx.fillStyle = fat ? "#f4e2d6" : `rgb(${200 - band * 40},${70 - band * 20},${70 - band * 20})`;
      ctx.fillRect(0, y, s, 1);
    }
    speckle(ctx, s, 120, 0.5, 1.8, ["rgba(255,255,255,0.4)", "rgba(120,30,30,0.35)"]);
  },
  pickle: (ctx, s) => {
    ctx.fillStyle = "#6f8f2a";
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = "#b6c86a";
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.38, 0, Math.PI * 2);
    ctx.fill();
    speckle(ctx, s, 30, 2, 3, ["#e9f0c6"]);
  },
  jalapeno: (ctx, s) => {
    ctx.fillStyle = "#2f7a22";
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = "#cfe8a8";
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.32, 0, Math.PI * 2);
    ctx.fill();
    speckle(ctx, s, 25, 3, 5, ["#f7f1c9"]);
  },
  liner: (ctx, s) => {
    const n = 8;
    const t = s / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? "#f5efe0" : "#c8392b";
      ctx.fillRect(x * t, y * t, t, t);
    }
    ctx.fillStyle = "rgba(245,239,224,0.55)";
    ctx.fillRect(0, 0, s, s);
  },
  steel_slots: (ctx, s) => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, s, s);
    ctx.clearRect(s * 0.25, s * 0.15, s * 0.08, s * 0.55);
    ctx.clearRect(s * 0.46, s * 0.15, s * 0.08, s * 0.55);
    ctx.clearRect(s * 0.67, s * 0.15, s * 0.08, s * 0.55);
  },
};

const cache = new Map<string, DynamicTexture>();

/**
 * Shared painted texture. `repeat` tiles it (each repeat value is its own painted texture,
 * because cloning a DynamicTexture does not copy its canvas).
 */
export function foodTexture(scene: Scene, name: keyof typeof PAINTERS | string, size = 128, repeat = 1): DynamicTexture {
  const key = `${name}:${size}:${repeat}`;
  const existing = cache.get(key);
  if (existing && existing.getScene() === scene) return existing;
  const tex = new DynamicTexture(`food_${key}`, { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  PAINTERS[name]?.(ctx, size);
  tex.update(true);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.hasAlpha = name === "grill" || name === "steel_slots";
  tex.uScale = repeat;
  tex.vScale = repeat;
  cache.set(key, tex);
  return tex;
}

/** Label band for a squeeze bottle. */
export function bottleLabel(scene: Scene, text: string, bg: string, fg: string): DynamicTexture {
  const key = `label:${text}`;
  const existing = cache.get(key);
  if (existing && existing.getScene() === scene) return existing;
  const tex = new DynamicTexture(`food_${key}`, { width: 256, height: 64 }, scene, true);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = fg;
  ctx.font = "bold 30px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text.toUpperCase(), 64, 33);
  ctx.fillText(text.toUpperCase(), 192, 33);
  tex.update(true);
  cache.set(key, tex);
  return tex;
}
