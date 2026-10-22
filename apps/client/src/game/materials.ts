import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import type { MaterialId } from "@ahb/data";

/**
 * Placeholder PBR materials with small procedural textures (spec §11 allows primitive layout
 * geometry early). Metal, paper, bread and vegetables keep distinct roughness/metalness so they
 * read differently even before authored textures arrive.
 */
type Painter = (ctx: CanvasRenderingContext2D, size: number) => void;

function canvasTexture(scene: Scene, name: string, size: number, paint: Painter): DynamicTexture {
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  paint(ctx, size);
  tex.update(true);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 4;
  return tex;
}

function noise(ctx: CanvasRenderingContext2D, size: number, alpha: number, seed = 1): void {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 255 * alpha;
    img.data[i] = Math.max(0, Math.min(255, img.data[i]! + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1]! + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2]! + n));
  }
  ctx.putImageData(img, 0, 0);
}

const painters: Partial<Record<MaterialId, Painter>> = {
  floor_tile: (ctx, size) => {
    const n = 4;
    const t = size / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? "#e9e2d4" : "#1d1a18";
        ctx.fillRect(x * t, y * t, t, t);
      }
    }
    ctx.strokeStyle = "rgba(80,70,60,0.6)";
    ctx.lineWidth = 3;
    for (let i = 0; i <= n; i++) {
      ctx.beginPath();
      ctx.moveTo(i * t, 0);
      ctx.lineTo(i * t, size);
      ctx.moveTo(0, i * t);
      ctx.lineTo(size, i * t);
      ctx.stroke();
    }
    noise(ctx, size, 0.06, 7);
  },
  wall_tile: (ctx, size) => {
    ctx.fillStyle = "#f2efe6";
    ctx.fillRect(0, 0, size, size);
    const rows = 8;
    const h = size / rows;
    ctx.strokeStyle = "#b9b2a4";
    ctx.lineWidth = 2;
    for (let r = 0; r < rows; r++) {
      const offset = r % 2 === 0 ? 0 : h;
      for (let x = -offset; x < size; x += h * 2) ctx.strokeRect(x, r * h, h * 2, h);
    }
    noise(ctx, size, 0.04, 3);
  },
  wall_plaster: (ctx, size) => {
    ctx.fillStyle = "#7a3b2e";
    ctx.fillRect(0, 0, size, size);
    noise(ctx, size, 0.08, 11);
  },
  timber: (ctx, size) => {
    ctx.fillStyle = "#7b4a2a";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 40; i++) {
      ctx.strokeStyle = `rgba(${40 + (i % 5) * 8},${22 + (i % 3) * 6},10,0.35)`;
      ctx.lineWidth = 1 + (i % 3);
      ctx.beginPath();
      const y = (i / 40) * size;
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(size * 0.3, y + 6, size * 0.6, y - 6, size, y + 3);
      ctx.stroke();
    }
    noise(ctx, size, 0.05, 5);
  },
  laminate: (ctx, size) => {
    ctx.fillStyle = "#b8322a";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#e8dcc4";
    ctx.fillRect(0, 0, size, size * 0.12);
    noise(ctx, size, 0.05, 9);
  },
  stainless: (ctx, size) => {
    ctx.fillStyle = "#c9ccd0";
    ctx.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y += 2) {
      ctx.fillStyle = `rgba(255,255,255,${0.04 + ((y * 7919) % 13) / 200})`;
      ctx.fillRect(0, y, size, 1);
    }
  },
  street: (ctx, size) => {
    ctx.fillStyle = "#2b2b2e";
    ctx.fillRect(0, 0, size, size);
    noise(ctx, size, 0.12, 13);
  },
};

interface Spec {
  albedo: [number, number, number];
  metallic: number;
  roughness: number;
  alpha?: number;
  emissive?: [number, number, number];
  tile?: number;
}

const SPECS: Record<MaterialId, Spec> = {
  floor_tile: { albedo: [1, 1, 1], metallic: 0, roughness: 0.35, tile: 1.2 },
  wall_plaster: { albedo: [1, 1, 1], metallic: 0, roughness: 0.85, tile: 2 },
  wall_tile: { albedo: [1, 1, 1], metallic: 0, roughness: 0.25, tile: 1.2 },
  // Without a baked reflection environment (Stage 3) high metalness renders black, so the
  // placeholder steel uses moderate metalness and a bright albedo.
  stainless: { albedo: [0.82, 0.83, 0.85], metallic: 0.85, roughness: 0.34, tile: 1 },
  grill_plate: { albedo: [0.22, 0.21, 0.2], metallic: 0.7, roughness: 0.55 },
  laminate: { albedo: [1, 1, 1], metallic: 0, roughness: 0.4, tile: 1 },
  timber: { albedo: [1, 1, 1], metallic: 0, roughness: 0.6, tile: 1 },
  glass: { albedo: [0.6, 0.7, 0.75], metallic: 0, roughness: 0.05, alpha: 0.18 },
  dark_metal: { albedo: [0.16, 0.16, 0.17], metallic: 0.7, roughness: 0.45 },
  ceiling: { albedo: [0.82, 0.8, 0.75], metallic: 0, roughness: 0.9 },
  fridge_white: { albedo: [0.88, 0.89, 0.9], metallic: 0.15, roughness: 0.3 },
  red_vinyl: { albedo: [0.55, 0.06, 0.06], metallic: 0, roughness: 0.45 },
  street: { albedo: [1, 1, 1], metallic: 0, roughness: 0.9, tile: 4 },
};

export class MaterialLibrary {
  private readonly scene: Scene;
  private readonly cache = new Map<string, PBRMaterial>();
  private readonly intendedMetalness = new Map<PBRMaterial, number>();
  private readonly maxLights: number;

  constructor(scene: Scene, maxLights: number) {
    this.scene = scene;
    this.maxLights = maxLights;
  }

  /**
   * One shared material per layout material id. Boxes get world-space box-mapped UVs (see
   * boxMapUVs), so texel density stays constant and same-material boxes can be merged.
   */
  forBox(id: MaterialId): PBRMaterial {
    const existing = this.cache.get(id);
    if (existing) return existing;
    const spec = SPECS[id];
    const mat = this.basic(id, spec);
    const paint = painters[id];
    if (paint) mat.albedoTexture = canvasTexture(this.scene, `tex_${id}`, 256, paint);
    return mat;
  }

  tileFor(id: MaterialId): number {
    return SPECS[id].tile ?? 1;
  }

  basic(name: string, spec: Spec): PBRMaterial {
    const mat = new PBRMaterial(name, this.scene);
    mat.albedoColor = new Color3(...spec.albedo);
    // Placeholder rule until the Stage 3 reflection environment exists: cap metalness so
    // metal props stay readable instead of rendering black.
    mat.metallic = Math.min(spec.metallic, 0.45);
    this.intendedMetalness.set(mat, spec.metallic);
    mat.roughness = spec.roughness;
    mat.maxSimultaneousLights = this.maxLights;
    if (spec.alpha !== undefined) {
      mat.alpha = spec.alpha;
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    }
    if (spec.emissive) mat.emissiveColor = new Color3(...spec.emissive);
    this.cache.set(name, mat);
    return mat;
  }

  /** Simple solid PBR material for props and food, cached by name. */
  solid(name: string, albedo: [number, number, number], roughness: number, metallic = 0, emissive?: [number, number, number]): PBRMaterial {
    const existing = this.cache.get(name);
    if (existing) return existing;
    return this.basic(name, { albedo, roughness, metallic, emissive });
  }

  /** Material driven by per-vertex colours (food whose surfaces change with cooking state). */
  vertexColored(name: string, roughness: number): PBRMaterial {
    const existing = this.cache.get(name);
    if (existing) return existing;
    const mat = this.basic(name, { albedo: [1, 1, 1], roughness, metallic: 0 });
    return mat;
  }

  /** Once a reflection environment exists, metals can use their real metalness. */
  restoreMetalness(): void {
    for (const [mat, metallic] of this.intendedMetalness) mat.metallic = metallic;
  }

  signTexture(name: string, width: number, height: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): DynamicTexture {
    const tex = new DynamicTexture(name, { width, height }, this.scene, true);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    draw(ctx, width, height);
    tex.update(true);
    return tex;
  }
}
