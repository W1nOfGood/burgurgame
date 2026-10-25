import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import { ITEMS, SODA_FOUNTAIN, drinkOfCode, isPatty, saucesInMask, type ItemKind, type SauceKind } from "@ahb/data";
import { pattyDoneness, type FoodState } from "@ahb/simulation";
import { bottleLabel, foodTexture } from "./foodTextures.js";
import type { CookUniforms, FoodLibrary, FoodVisual } from "./food.js";
import type { Material } from "@babylonjs/core/Materials/material";
import type { MaterialLibrary } from "./materials.js";
import { setPick } from "./scene.js";

type RGB = [number, number, number];

function mix(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

const RAW: RGB = [0.86, 0.42, 0.45];
const GREYING: RGB = [0.66, 0.46, 0.42];
const BROWN: RGB = [0.46, 0.25, 0.13];
const DARK: RGB = [0.22, 0.12, 0.06];
const CHAR: RGB = [0.05, 0.04, 0.035];

/** Patty surface colour from browning and burn (authored ramp; texture adds the grain). */
export function pattySurface(cook: number, burn: number, veggie = false): RGB {
  const raw: RGB = veggie ? [0.62, 0.66, 0.4] : RAW;
  const grey: RGB = veggie ? [0.55, 0.52, 0.32] : GREYING;
  let c: RGB;
  if (cook < 0.25) c = mix(raw, grey, cook / 0.25);
  else if (cook < 0.8) c = mix(grey, BROWN, (cook - 0.25) / 0.55);
  else c = mix(BROWN, DARK, (cook - 0.8) / 0.5);
  return mix(c, CHAR, burn * 1.2);
}

export function pattyEdge(inner: number, burn: number, veggie = false): RGB {
  const raw: RGB = veggie ? [0.6, 0.64, 0.38] : RAW;
  return mix(mix(raw, [0.52, 0.34, 0.28], inner / 0.9), CHAR, burn * 0.6);
}

const CRUMB: RGB = [0.96, 0.86, 0.64];
const TOASTED: RGB = [0.76, 0.48, 0.2];
const CRUST: RGB = [0.78, 0.46, 0.16];

export function toastColor(toast: number, burn: number): RGB {
  const c = toast < 1 ? mix(CRUMB, TOASTED, toast) : mix(TOASTED, DARK, (toast - 1) / 0.5);
  return mix(c, CHAR, burn);
}

/** Generic grill-topping tint: raw → cooked → crisp → burnt. */
function cookTint(raw: RGB, cooked: RGB, crisp: RGB, cook: number, burn: number): RGB {
  const c = cook < 0.6 ? mix(raw, cooked, cook / 0.6) : mix(cooked, crisp, (cook - 0.6) / 0.6);
  return mix(c, CHAR, burn);
}

function dirty(c: RGB, isDirty: boolean): RGB {
  return isDirty ? mix(c, [0.28, 0.25, 0.22], 0.5) : c;
}

export const SAUCE_COLORS: Record<SauceKind, RGB> = {
  house: [0.95, 0.55, 0.18],
  ketchup: [0.72, 0.06, 0.04],
  mustard: [0.92, 0.72, 0.08],
  mayo: [0.96, 0.93, 0.8],
  bbq: [0.32, 0.12, 0.05],
};

/** Face classification for vertex colouring: 0 = bottom, 1 = side, 2 = top. */
function classifyFaces(mesh: Mesh): Uint8Array {
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind) ?? [];
  const out = new Uint8Array(normals.length / 3);
  for (let i = 0; i < out.length; i++) {
    const ny = normals[i * 3 + 1]!;
    out[i] = ny > 0.55 ? 2 : ny < -0.55 ? 0 : 1;
  }
  return out;
}

function paintFaces(mesh: Mesh, faces: Uint8Array, bottom: RGB, side: RGB, top: RGB): void {
  const colors = new Float32Array(faces.length * 4);
  for (let i = 0; i < faces.length; i++) {
    const c = faces[i] === 2 ? top : faces[i] === 0 ? bottom : side;
    colors[i * 4] = c[0];
    colors[i * 4 + 1] = c[1];
    colors[i * 4 + 2] = c[2];
    colors[i * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors, true);
}

function paintUniform(mesh: Mesh, c: RGB): void {
  const n = mesh.getTotalVertices();
  const colors = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) colors.set([c[0], c[1], c[2], 1], i * 4);
  mesh.setVerticesData(VertexBuffer.ColorKind, colors, true);
}

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

/** Irregular edge and gently domed top so food doesn't look machine-stamped. */
function sculpt(mesh: Mesh, edge: number, dome: number, seed: number): void {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!pos) return;
  let maxR = 0;
  for (let i = 0; i < pos.length; i += 3) maxR = Math.max(maxR, Math.hypot(pos[i]!, pos[i + 2]!));
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]!;
    const z = pos[i + 2]!;
    const r = Math.hypot(x, z);
    if (r > 1e-4) {
      const a = Math.atan2(z, x);
      const k = 1 + edge * (Math.sin(a * 5 + seed * 40) * 0.6 + Math.sin(a * 11 + seed * 90) * 0.4);
      pos[i] = x * k;
      pos[i + 2] = z * k;
    }
    if (pos[i + 1]! > 0) pos[i + 1] = pos[i + 1]! + dome * (1 - (r / maxR) ** 2);
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, pos);
  mesh.createNormals(true);
}

function lathe(name: string, profile: [number, number][], scene: Scene, tessellation = 32): Mesh {
  return MeshBuilder.CreateLathe(name, { shape: profile.map(([r, y]) => new Vector3(r, y, 0)), tessellation, closed: true, updatable: true }, scene);
}

function texturedMaterial(lib: MaterialLibrary, scene: Scene, name: string, tex: string, roughness: number, opts: { twoSided?: boolean; alpha?: boolean; albedo?: RGB } = {}): PBRMaterial {
  const existing = scene.getMaterialByName(name) as PBRMaterial | null;
  if (existing) return existing;
  const m = lib.solid(name, opts.albedo ?? [1, 1, 1], roughness);
  m.albedoTexture = foodTexture(scene, tex);
  if (opts.twoSided) m.backFaceCulling = false;
  if (opts.alpha) {
    m.useAlphaFromAlbedoTexture = true;
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  }
  return m;
}

export interface ItemSnapshotLike {
  kind: string;
  down: number;
  flip: number;
  level: number;
  drink: number;
  offered: boolean;
  holder: string;
}

let foodLibrary: FoodLibrary | null = null;

/** Installs the Blender-authored food library; new item views use it from then on. */
export function setFoodLibrary(lib: FoodLibrary | null): void {
  foodLibrary = lib;
}

/** Visual for one replicated item. Appearance is a pure function of authoritative state. */
export class ItemView {
  readonly id: string;
  readonly kind: ItemKind;
  /** Stable pose pivot; the visible body is a child that can be swapped for an authored one. */
  readonly root: Mesh;
  private body: Mesh;
  private readonly scene: Scene;
  private readonly lib: MaterialLibrary;
  private faces: Uint8Array | null = null;
  private colorTarget: Mesh | null = null;
  private uniformTargets: { mesh: Mesh; base: RGB; cooked: RGB; crisp: RGB }[] = [];
  private cheeseBase: Float32Array | null = null;
  private marksTop: Mesh | null = null;
  private marksBottom: Mesh | null = null;
  private sauceBlob: Mesh | null = null;
  private cook: CookUniforms | null = null;
  private authored = false;
  /** Per-item material clones (cooking state, sauce colour); released on dispose/upgrade. */
  private owned: Material[] = [];
  private appearanceKey = "";
  /** Cups: the drink inside, and the stream from the valve while it fills. */
  private liquid: Mesh | null = null;
  private pour: Mesh | null = null;
  private lastLevel = 0;
  private lastRiseAt = 0;
  food: FoodState | null = null;

  constructor(scene: Scene, lib: MaterialLibrary, id: string, kind: ItemKind) {
    this.scene = scene;
    this.lib = lib;
    this.id = id;
    this.kind = kind;
    this.root = new Mesh(`it_${id}`, scene);
    this.root.rotationQuaternion = Quaternion.Identity();
    this.root.metadata = { placeholder: false };
    setPick(this.root, { type: "item", id });
    this.body = this.makeBody();
    if (kind === "cup") this.buildCupExtras();
  }

  /** The drink in a cup (a column that rises with the fill) and the pour from the valve. */
  private buildCupExtras(): void {
    const s = this.scene;
    const h = 0.125;
    const liquid = MeshBuilder.CreateCylinder(`it_${this.id}_drink`, { diameterTop: 0.084, diameterBottom: 0.06, height: h, tessellation: 20 }, s);
    liquid.bakeTransformIntoVertices(Matrix.Translation(0, h / 2, 0));
    liquid.parent = this.root;
    liquid.position.y = -0.075 + 0.012;
    liquid.isPickable = false;
    liquid.isVisible = false;
    this.liquid = liquid;
    const pour = MeshBuilder.CreateCylinder(`it_${this.id}_pour`, { diameter: 0.009, height: 1, tessellation: 8 }, s);
    pour.bakeTransformIntoVertices(Matrix.Translation(0, -0.5, 0));
    pour.parent = this.root;
    pour.isPickable = false;
    pour.isVisible = false;
    this.pour = pour;
  }

  /** Per frame for cups: the pour shows while the level is still rising. */
  tickCup(nowMs: number): void {
    if (!this.pour || !this.liquid) return;
    const pouring = nowMs - this.lastRiseAt < 350 && this.lastLevel < 0.995;
    this.pour.isVisible = pouring;
    if (pouring) {
      // From the nozzle (just above the rim) down to the surface of the drink.
      const top = SODA_FOUNTAIN.nozzleY - (this.root.position.y + 0.075 - 0.003) + 0.075;
      const surface = this.liquid.position.y + 0.125 * this.liquid.scaling.y;
      this.pour.position.y = Math.max(top, surface + 0.02);
      this.pour.scaling.y = Math.max(0.01, this.pour.position.y - surface);
    }
  }

  private updateCup(meta: ItemSnapshotLike): void {
    if (!this.liquid || !this.pour) return;
    const level = meta.level / 255;
    const drink = drinkOfCode(meta.drink);
    if (level > this.lastLevel + 0.002) this.lastRiseAt = performance.now();
    this.lastLevel = level;
    const visible = !!drink && level > 0.01;
    this.liquid.isVisible = visible;
    if (!drink) return;
    this.liquid.scaling.y = Math.max(0.01, level);
    const key = `drink_${drink.id}`;
    const mat = this.lib.solid(key, [...drink.color], 0.12);
    if (this.liquid.material !== mat) {
      this.liquid.material = mat;
      this.pour.material = mat;
    }
  }

  /** True when this view shows the authored model rather than the procedural stand-in. */
  get isAuthored(): boolean {
    return this.authored;
  }

  /** Every mesh of this item (for shadows, outlines, picking). */
  meshes(): Mesh[] {
    return [this.root, ...(this.root.getChildMeshes(false) as Mesh[])];
  }

  /** Swaps the procedural stand-in for the authored model once the food library is loaded. */
  upgrade(): boolean {
    if (this.authored || !foodLibrary?.has(this.kind)) return false;
    for (const c of this.root.getChildMeshes(true)) c.dispose(false, false);
    this.releaseMaterials();
    this.faces = null;
    this.colorTarget = null;
    this.uniformTargets = [];
    this.cheeseBase = null;
    this.marksTop = this.marksBottom = null;
    this.sauceBlob = null;
    this.body = this.makeBody();
    this.appearanceKey = "";
    return true;
  }

  private makeBody(): Mesh {
    const visual: FoodVisual | null = foodLibrary?.create(this.kind, `it_${this.id}_body`) ?? null;
    let body: Mesh;
    if (visual) {
      body = visual.root;
      this.cook = visual.cook;
      this.owned.push(...visual.materials);
      this.cheeseBase = visual.meltBase;
      this.authored = true;
    } else {
      body = this.build();
      this.authored = false;
      body.metadata = { placeholder: true };
    }
    body.parent = this.root;
    body.position.setAll(0);
    body.rotationQuaternion = null;
    body.rotation.setAll(0);
    for (const m of [body, ...body.getChildMeshes()] as Mesh[]) setPick(m, { type: "item", id: this.id });
    return body;
  }

  private build(): Mesh {
    const s = this.scene;
    const lib = this.lib;
    const seed = hash(this.id);
    const n = `it_${this.id}`;
    switch (this.kind) {
      case "patty":
      case "veggie_patty": {
        const veggie = this.kind === "veggie_patty";
        const m = MeshBuilder.CreateCylinder(n, { diameter: 0.112, height: veggie ? 0.026 : 0.024, tessellation: 36, subdivisions: 2, updatable: true }, s);
        sculpt(m, 0.045, 0.003, seed);
        m.material = texturedMaterial(lib, s, veggie ? "veggie_mat" : "patty_mat", veggie ? "veggie" : "meat", 0.52);
        this.faces = classifyFaces(m);
        this.colorTarget = m;
        const marksMat = texturedMaterial(lib, s, "grill_marks", "grill", 0.7, { alpha: true });
        this.marksTop = MeshBuilder.CreateDisc(`${n}_mt`, { radius: 0.05, tessellation: 24 }, s);
        this.marksTop.rotation.x = Math.PI / 2;
        this.marksTop.position.y = 0.0135 + 0.002;
        this.marksBottom = MeshBuilder.CreateDisc(`${n}_mb`, { radius: 0.05, tessellation: 24 }, s);
        this.marksBottom.rotation.x = -Math.PI / 2;
        this.marksBottom.position.y = -0.0125;
        for (const mk of [this.marksTop, this.marksBottom]) {
          mk.material = marksMat;
          mk.parent = m;
          mk.isVisible = false;
        }
        return m;
      }
      case "bun_bottom": {
        const m = lathe(n, [
          [0, -0.016],
          [0.054, -0.016],
          [0.059, -0.012],
          [0.061, -0.002],
          [0.06, 0.01],
          [0.056, 0.016],
          [0, 0.016],
        ], s);
        m.material = texturedMaterial(lib, s, "bun_mat", "crumb", 0.6);
        this.faces = classifyFaces(m);
        this.colorTarget = m;
        return m;
      }
      case "bun_top": {
        const m = lathe(n, [
          [0, -0.024],
          [0.056, -0.024],
          [0.061, -0.019],
          [0.062, -0.01],
          [0.057, 0.003],
          [0.047, 0.013],
          [0.032, 0.02],
          [0.015, 0.0235],
          [0, 0.024],
        ], s);
        m.material = texturedMaterial(lib, s, "bun_mat", "crumb", 0.45);
        this.faces = classifyFaces(m);
        this.colorTarget = m;
        const seeds: Mesh[] = [];
        for (let i = 0; i < 18; i++) {
          const a = i * 2.39996 + seed * 6;
          const r = 0.01 + (i / 18) * 0.04;
          const sd = MeshBuilder.CreateSphere(`${n}_s${i}`, { diameter: 0.0065, segments: 3 }, s);
          sd.scaling.set(0.9, 0.45, 1.7);
          const x = Math.cos(a) * r;
          const z = Math.sin(a) * r;
          const t = r / 0.06;
          sd.position.set(x, 0.024 - t * t * 0.03, z);
          sd.rotation.y = a;
          sd.bakeCurrentTransformIntoVertices();
          seeds.push(sd);
        }
        const merged = Mesh.MergeMeshes(seeds, true, true)!;
        merged.name = `${n}_seeds`;
        merged.material = lib.solid("sesame", [0.97, 0.92, 0.78], 0.55);
        merged.parent = m;
        return m;
      }
      case "cheese":
      case "swiss": {
        const m = MeshBuilder.CreateGround(n, { width: 0.09, height: 0.09, subdivisions: 10, updatable: true }, s);
        const mat =
          this.kind === "swiss"
            ? texturedMaterial(lib, s, "swiss_mat", "swiss", 0.55, { twoSided: true })
            : (() => {
                const c = lib.solid("cheese_mat", [1, 0.66, 0.12], 0.45);
                c.backFaceCulling = false;
                c.subSurface.isTranslucencyEnabled = false;
                return c;
              })();
        m.material = mat;
        this.cheeseBase = new Float32Array(m.getVerticesData(VertexBuffer.PositionKind)!);
        paintUniform(m, [1, 1, 1]);
        return m;
      }
      case "lettuce": {
        const m = MeshBuilder.CreateDisc(n, { radius: 0.064, tessellation: 40, updatable: true }, s);
        m.rotation.x = Math.PI / 2;
        m.bakeCurrentTransformIntoVertices();
        const pos = m.getVerticesData(VertexBuffer.PositionKind)!;
        for (let i = 0; i < pos.length; i += 3) {
          const a = Math.atan2(pos[i + 2]!, pos[i]!);
          const r = Math.hypot(pos[i]!, pos[i + 2]!);
          pos[i + 1] = Math.sin(a * 11 + seed * 30) * 0.007 * (r / 0.064) ** 1.5;
          const k = 1 + Math.sin(a * 7 + seed * 50) * 0.07;
          pos[i] = pos[i]! * k;
          pos[i + 2] = pos[i + 2]! * k;
        }
        m.updateVerticesData(VertexBuffer.PositionKind, pos);
        m.createNormals(true);
        m.material = texturedMaterial(lib, s, "lettuce_mat", "lettuce", 0.5, { twoSided: true });
        paintUniform(m, [1, 1, 1]);
        this.uniformTargets.push({ mesh: m, base: [1, 1, 1], cooked: [0.7, 0.72, 0.4], crisp: [0.45, 0.4, 0.2] });
        return m;
      }
      case "tomato": {
        const m = MeshBuilder.CreateCylinder(n, { diameter: 0.082, height: 0.01, tessellation: 32 }, s);
        m.material = texturedMaterial(lib, s, "tomato_mat", "tomato", 0.3);
        paintUniform(m, [1, 1, 1]);
        this.uniformTargets.push({ mesh: m, base: [1, 1, 1], cooked: [0.8, 0.6, 0.5], crisp: [0.5, 0.35, 0.25] });
        return m;
      }
      case "onion": {
        const parts: Mesh[] = [];
        for (const [d, th, dx, dz] of [
          [0.074, 0.007, 0, 0],
          [0.052, 0.006, 0.004, -0.003],
          [0.06, 0.006, -0.012, 0.01],
          [0.034, 0.005, 0.012, 0.012],
        ] as const) {
          const t = MeshBuilder.CreateTorus(`${n}_${d}`, { diameter: d, thickness: th, tessellation: 28 }, s);
          t.position.set(dx, 0, dz);
          t.scaling.y = 0.8;
          t.bakeCurrentTransformIntoVertices();
          parts.push(t);
        }
        const m = Mesh.MergeMeshes(parts, true, true)!;
        m.name = n;
        m.material = lib.solid("onion_mat", [1, 1, 1], 0.35);
        paintUniform(m, [0.95, 0.88, 0.95]);
        this.uniformTargets.push({ mesh: m, base: [0.95, 0.88, 0.95], cooked: [0.82, 0.6, 0.35], crisp: [0.55, 0.32, 0.14] });
        return m;
      }
      case "pickle":
      case "jalapeno": {
        const parts: Mesh[] = [];
        const count = this.kind === "pickle" ? 4 : 5;
        for (let i = 0; i < count; i++) {
          const c = MeshBuilder.CreateCylinder(`${n}_${i}`, { diameter: this.kind === "pickle" ? 0.034 : 0.026, height: 0.004, tessellation: 18 }, s);
          const a = i * 2.2 + seed * 5;
          c.position.set(Math.cos(a) * 0.022, 0.0007 * i, Math.sin(a) * 0.022);
          c.rotation.set(0.08 * Math.sin(a), a, 0.08 * Math.cos(a));
          c.bakeCurrentTransformIntoVertices();
          parts.push(c);
        }
        const m = Mesh.MergeMeshes(parts, true, true)!;
        m.name = n;
        m.material = texturedMaterial(lib, s, `${this.kind}_mat`, this.kind, 0.35);
        paintUniform(m, [1, 1, 1]);
        this.uniformTargets.push({ mesh: m, base: [1, 1, 1], cooked: [0.75, 0.7, 0.45], crisp: [0.5, 0.4, 0.25] });
        return m;
      }
      case "bacon": {
        const m = MeshBuilder.CreateGround(n, { width: 0.15, height: 0.044, subdivisionsX: 16, subdivisionsY: 3, updatable: true }, s);
        const pos = m.getVerticesData(VertexBuffer.PositionKind)!;
        for (let i = 0; i < pos.length; i += 3) pos[i + 1] = Math.sin(pos[i]! * 70 + seed * 10) * 0.0035 + Math.sin(pos[i + 2]! * 90) * 0.001;
        m.updateVerticesData(VertexBuffer.PositionKind, pos);
        m.createNormals(true);
        m.material = texturedMaterial(lib, s, "bacon_mat", "bacon", 0.45, { twoSided: true });
        paintUniform(m, [1, 1, 1]);
        this.uniformTargets.push({ mesh: m, base: [1, 1, 1], cooked: [0.78, 0.5, 0.38], crisp: [0.52, 0.28, 0.16] });
        return m;
      }
      case "mushroom": {
        const parts: Mesh[] = [];
        for (let i = 0; i < 5; i++) {
          const sl = MeshBuilder.CreateCylinder(`${n}_${i}`, { diameter: 0.05, height: 0.006, tessellation: 20, arc: 0.5 }, s);
          const a = i * 1.3 + seed * 7;
          sl.rotation.y = a;
          sl.position.set(Math.cos(a) * 0.016, 0.0012 * i, Math.sin(a) * 0.016);
          sl.bakeCurrentTransformIntoVertices();
          parts.push(sl);
        }
        const m = Mesh.MergeMeshes(parts, true, true)!;
        m.name = n;
        m.material = lib.solid("mushroom_mat", [1, 1, 1], 0.6);
        paintUniform(m, [0.86, 0.76, 0.62]);
        this.uniformTargets.push({ mesh: m, base: [0.86, 0.76, 0.62], cooked: [0.55, 0.38, 0.24], crisp: [0.35, 0.22, 0.12] });
        return m;
      }
      case "fries": {
        // A paper boat with a fan of sticks, a little different each time.
        const sticks: Mesh[] = [];
        const rnd = (i: number) => hash(`${this.id}:${i}`);
        for (let i = 0; i < 46; i++) {
          const len = 0.07 + rnd(i) * 0.035;
          const st = MeshBuilder.CreateBox(`${n}_s${i}`, { width: 0.0075, height: len, depth: 0.0075 }, s);
          st.rotation.set((rnd(i + 100) - 0.5) * 0.5, rnd(i + 200) * Math.PI, (rnd(i + 300) - 0.5) * 0.5);
          st.position.set((rnd(i + 400) - 0.5) * 0.085, 0.012 + len / 2 - 0.02, (rnd(i + 500) - 0.5) * 0.045);
          st.bakeCurrentTransformIntoVertices();
          sticks.push(st);
        }
        const fries = Mesh.MergeMeshes(sticks, true, true)!;
        fries.name = n;
        fries.material = lib.vertexColored("fries_mat", 0.55);
        paintUniform(fries, [0.93, 0.88, 0.66]);
        this.uniformTargets.push({ mesh: fries, base: [0.93, 0.88, 0.66], cooked: [0.93, 0.68, 0.22], crisp: [0.72, 0.42, 0.12] });
        const boat = MeshBuilder.CreateBox(`${n}_boat`, { width: 0.1, height: 0.045, depth: 0.056 }, s);
        boat.position.y = -0.0175;
        boat.material = lib.solid("fries_boat", [0.72, 0.1, 0.1], 0.6);
        boat.parent = fries;
        return fries;
      }
      case "egg": {
        const white = MeshBuilder.CreateCylinder(n, { diameter: 0.1, height: 0.006, tessellation: 32, updatable: true }, s);
        sculpt(white, 0.09, 0.001, seed);
        white.material = lib.solid("egg_white", [1, 1, 1], 0.25);
        paintUniform(white, [0.92, 0.92, 0.85]);
        this.uniformTargets.push({ mesh: white, base: [0.93, 0.93, 0.88], cooked: [0.98, 0.97, 0.94], crisp: [0.8, 0.62, 0.38] });
        const yolk = MeshBuilder.CreateSphere(`${n}_yolk`, { diameter: 0.034, segments: 12, slice: 0.5 }, s);
        yolk.scaling.y = 0.55;
        yolk.position.set(0.006, 0.003, -0.004);
        yolk.material = lib.solid("egg_yolk", [1, 1, 1], 0.15);
        yolk.parent = white;
        paintUniform(yolk, [1, 0.62, 0.08]);
        this.uniformTargets.push({ mesh: yolk, base: [1, 0.6, 0.06], cooked: [0.98, 0.72, 0.25], crisp: [0.85, 0.62, 0.3] });
        return white;
      }
      case "cup": {
        const cup = MeshBuilder.CreateCylinder(n, { diameterTop: 0.092, diameterBottom: 0.066, height: 0.15, tessellation: 20 }, s);
        cup.material = lib.solid("cup_paper", [0.95, 0.94, 0.91], 0.55);
        const band = MeshBuilder.CreateCylinder(`${n}_band`, { diameterTop: 0.0925, diameterBottom: 0.0775, height: 0.07, tessellation: 20 }, s);
        band.position.y = -0.003;
        band.material = lib.solid("cup_band", [0.72, 0.11, 0.12], 0.5);
        band.parent = cup;
        return cup;
      }
      case "tray": {
        const base = MeshBuilder.CreateBox(n, { width: 0.4, height: 0.012, depth: 0.3 }, s);
        base.position.y = -0.004;
        base.bakeCurrentTransformIntoVertices();
        const rims = [
          [0, 0.004, 0.147, 0.4, 0.02, 0.008],
          [0, 0.004, -0.147, 0.4, 0.02, 0.008],
          [0.197, 0.004, 0, 0.008, 0.02, 0.3],
          [-0.197, 0.004, 0, 0.008, 0.02, 0.3],
        ].map(([x, y, z, w, h, d], i) => {
          const r = MeshBuilder.CreateBox(`${n}_r${i}`, { width: w!, height: h!, depth: d! }, s);
          r.position.set(x!, y!, z!);
          r.bakeCurrentTransformIntoVertices();
          return r;
        });
        const merged = Mesh.MergeMeshes([base, ...rims], true, true)!;
        merged.name = n;
        merged.material = lib.solid("tray_red", [0.66, 0.07, 0.05], 0.38);
        const liner = MeshBuilder.CreatePlane(`${n}_liner`, { width: 0.3, height: 0.22 }, s);
        liner.rotation.x = Math.PI / 2;
        liner.position.y = 0.0025;
        liner.material = texturedMaterial(lib, s, "liner_mat", "liner", 0.95);
        liner.parent = merged;
        return merged;
      }
      case "spatula": {
        const blade = MeshBuilder.CreateBox(n, { width: 0.1, height: 0.003, depth: 0.15 }, s);
        blade.position.z = 0.065;
        blade.bakeCurrentTransformIntoVertices();
        const bm = texturedMaterial(lib, s, "spatula_steel", "steel_slots", 0.22, { alpha: true, albedo: [0.86, 0.87, 0.89] });
        bm.metallic = 0.45;
        blade.material = bm;
        const neck = MeshBuilder.CreateBox(`${n}_neck`, { width: 0.022, height: 0.004, depth: 0.06 }, s);
        neck.position.set(0, 0.009, -0.032);
        neck.rotation.x = -0.35;
        neck.material = this.lib.solid("steel_plain", [0.8, 0.81, 0.83], 0.25, 0.45);
        neck.parent = blade;
        const handle = MeshBuilder.CreateCapsule(`${n}_handle`, { radius: 0.012, height: 0.13, tessellation: 12 }, s);
        handle.rotation.x = Math.PI / 2;
        handle.position.set(0, 0.022, -0.115);
        handle.material = lib.solid("handle_wood", [0.45, 0.24, 0.12], 0.55);
        handle.parent = blade;
        return blade;
      }
      default: {
        // Squeeze bottles.
        const sauce = ITEMS[this.kind].sauce ?? "house";
        const body = lathe(n, [
          [0, -0.09],
          [0.027, -0.09],
          [0.03, -0.085],
          [0.03, 0.035],
          [0.026, 0.055],
          [0.012, 0.065],
          [0, 0.065],
        ], s, 24);
        const c = SAUCE_COLORS[sauce];
        body.material = lib.solid(`bottle_${sauce}`, sauce === "mayo" ? [0.95, 0.93, 0.86] : c, 0.25);
        const band = MeshBuilder.CreateCylinder(`${n}_band`, { diameter: 0.0615, height: 0.05, tessellation: 24 }, s);
        band.position.y = -0.03;
        const bandMat = new PBRMaterial(`bottle_band_${sauce}`, s);
        bandMat.albedoTexture = bottleLabel(s, ITEMS[this.kind].label, "#f7f1e3", "#2a1d14");
        bandMat.roughness = 0.6;
        bandMat.metallic = 0;
        band.material = bandMat;
        band.parent = body;
        const cap = MeshBuilder.CreateCylinder(`${n}_cap`, { diameterTop: 0.006, diameterBottom: 0.03, height: 0.035, tessellation: 16 }, s);
        cap.position.y = 0.082;
        cap.material = lib.solid(`cap_${sauce}`, sauce === "mustard" ? [0.95, 0.75, 0.1] : sauce === "ketchup" ? [0.85, 0.1, 0.06] : [0.9, 0.88, 0.85], 0.4);
        cap.parent = body;
        return body;
      }
    }
  }

  setPose(x: number, y: number, z: number, q: Quaternion): void {
    this.root.position.set(x, y, z);
    this.root.rotationQuaternion!.copyFrom(q);
  }

  /** Updates appearance from replicated values; cheap no-op when nothing visible changed. */
  setAppearance(food: FoodState | null, meta: ItemSnapshotLike): void {
    this.food = food;
    const key = food
      ? `${food.cookA.toFixed(2)}|${food.cookB.toFixed(2)}|${food.inner.toFixed(2)}|${food.burn.toFixed(2)}|${food.melt.toFixed(2)}|${food.toast.toFixed(2)}|${food.sauce.toFixed(2)}|${food.sauceMask}|${food.down}|${meta.flip > 127 ? 1 : 0}|${food.dirty}`
      : `${meta.level}|${meta.drink}`;
    if (key === this.appearanceKey) return;
    this.appearanceKey = key;
    if (this.kind === "cup") this.updateCup(meta);
    if (!food) return;

    if (this.authored) {
      this.applyAuthored(food, meta);
    } else if (isPatty(this.kind) && this.colorTarget && this.faces) {
      const veggie = this.kind === "veggie_patty";
      // Map the authoritative "down" side onto mesh faces; during the second half of a flip the
      // mesh is upside down, so the mapping inverts until the flip lands.
      const flipping = meta.flip > 127;
      const visualDown = flipping ? (food.down === 0 ? 1 : 0) : food.down;
      const downCook = visualDown === 0 ? food.cookA : food.cookB;
      const upCook = visualDown === 0 ? food.cookB : food.cookA;
      paintFaces(
        this.colorTarget,
        this.faces,
        dirty(pattySurface(downCook, food.burn, veggie), food.dirty),
        dirty(pattyEdge(food.inner, food.burn, veggie), food.dirty),
        dirty(pattySurface(upCook, food.burn * 0.5, veggie), food.dirty),
      );
      // Grill marks appear on a side once it has seared.
      const mark = (c: number) => Math.max(0, Math.min(1, (c - 0.3) / 0.35));
      if (this.marksTop) {
        this.marksTop.isVisible = mark(upCook) > 0.02;
        this.marksTop.visibility = mark(upCook);
      }
      if (this.marksBottom) {
        this.marksBottom.isVisible = mark(downCook) > 0.02;
        this.marksBottom.visibility = mark(downCook);
      }
    } else if ((this.kind === "bun_bottom" || this.kind === "bun_top") && this.colorTarget && this.faces) {
      const cut = dirty(toastColor(food.toast, food.burn), food.dirty);
      const crust = dirty(CRUST, food.dirty);
      if (this.kind === "bun_bottom") paintFaces(this.colorTarget, this.faces, crust, crust, cut);
      else paintFaces(this.colorTarget, this.faces, cut, crust, crust);
    } else if ((this.kind === "cheese" || this.kind === "swiss") && this.cheeseBase) {
      // Cheese softens and droops over the patty edge as it melts.
      const mesh = this.body;
      const pos = new Float32Array(this.cheeseBase);
      const melt = food.melt;
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i]!;
        const z = pos[i + 2]!;
        const r = Math.hypot(x, z);
        const over = Math.max(0, r - 0.042);
        const spread = 1 + melt * 0.12;
        pos[i] = x * spread;
        pos[i + 2] = z * spread;
        pos[i + 1] = -over * over * 60 * melt * 0.35 - over * melt * 0.3 + Math.sin(x * 120 + z * 80) * 0.0006 * melt;
      }
      mesh.updateVerticesData(VertexBuffer.PositionKind, pos);
      mesh.createNormals(true);
      const tint = this.kind === "swiss" ? mix([1, 1, 1], [1.02, 0.95, 0.82], melt) : mix([1, 1, 1], [0.97, 0.86, 0.72], melt);
      paintUniform(mesh, dirty(tint, food.dirty));
    } else if (this.uniformTargets.length > 0) {
      const cook = Math.max(food.cookA, food.cookB);
      for (const t of this.uniformTargets) paintUniform(t.mesh, dirty(cookTint(t.base, t.cooked, t.crisp, cook, food.burn), food.dirty));
    }

    // Sauce: an authored zig-zag drizzle (or a glossy blob) in the colour of the sauces applied.
    if (food.sauce > 0.02 && this.authored && foodLibrary) {
      if (!this.sauceBlob) {
        const d = foodLibrary.createExtra("sauce_drizzle", `it_${this.id}_sauce`);
        if (d) {
          if (d.material) this.owned.push(d.material);
          d.parent = this.root;
          d.rotation.y = hash(this.id) * Math.PI * 2;
          setPick(d, { type: "item", id: this.id });
          this.sauceBlob = d;
        }
      }
      if (this.sauceBlob) {
        const sauces = saucesInMask(food.sauceMask);
        const c = sauces.length
          ? sauces.reduce<RGB>((acc, k) => [acc[0] + SAUCE_COLORS[k][0] / sauces.length, acc[1] + SAUCE_COLORS[k][1] / sauces.length, acc[2] + SAUCE_COLORS[k][2] / sauces.length], [0, 0, 0])
          : SAUCE_COLORS.house;
        const mat = this.sauceBlob.material as PBRMaterial | null;
        if (mat) mat.albedoColor = new Color3(c[0], c[1], c[2]).toLinearSpace();
        const k = Math.min(1.25, 0.65 + food.sauce * 0.45);
        this.sauceBlob.scaling.set(k, 1 + Math.min(1, food.sauce) * 0.6, k);
        this.sauceBlob.position.y = ITEMS[this.kind].layerHeight / 2 + 0.0008;
      }
    } else if (food.sauce > 0.02) {
      if (!this.sauceBlob) {
        this.sauceBlob = MeshBuilder.CreateSphere(`it_${this.id}_sauce`, { diameter: 1, segments: 12 }, this.scene);
        this.sauceBlob.material = this.lib.solid("sauce_mat", [1, 1, 1], 0.12);
        this.sauceBlob.parent = this.root;
        setPick(this.sauceBlob, { type: "item", id: this.id });
      }
      const sauces = saucesInMask(food.sauceMask);
      const c = sauces.length
        ? sauces.reduce<RGB>((acc, k) => [acc[0] + SAUCE_COLORS[k][0] / sauces.length, acc[1] + SAUCE_COLORS[k][1] / sauces.length, acc[2] + SAUCE_COLORS[k][2] / sauces.length], [0, 0, 0])
        : SAUCE_COLORS.house;
      paintUniform(this.sauceBlob, c);
      const size = Math.min(0.1, 0.03 + food.sauce * 0.05);
      this.sauceBlob.scaling.set(size, 0.005 + food.sauce * 0.003, size * 0.9);
      this.sauceBlob.position.y = ITEMS[this.kind].layerHeight / 2 + 0.002;
    }
  }

  /** Drives the authored model's cooking shader and melt from replicated values. */
  private applyAuthored(food: FoodState, meta: ItemSnapshotLike): void {
    const c = this.cook;
    if (c) {
      c.burn = food.burn;
      c.dirty = food.dirty ? 1 : 0;
      if (isPatty(this.kind)) {
        // Mesh-local top/bottom: during the second half of a flip the mesh is upside down.
        const flipping = meta.flip > 127;
        const visualDown = flipping ? (food.down === 0 ? 1 : 0) : food.down;
        c.bottom = visualDown === 0 ? food.cookA : food.cookB;
        c.top = visualDown === 0 ? food.cookB : food.cookA;
        c.side = Math.min(1, food.inner * 0.75 + Math.max(c.top, c.bottom) * 0.2);
      } else if (this.kind === "bun_bottom" || this.kind === "bun_top") {
        c.amount = food.toast;
      } else {
        c.amount = Math.max(food.cookA, food.cookB);
      }
    }
    if ((this.kind === "cheese" || this.kind === "swiss") && this.cheeseBase) {
      // Melt: the slice relaxes and drapes over the edge of whatever is beneath it.
      const pos = new Float32Array(this.cheeseBase);
      const melt = food.melt;
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i]!;
        const z = pos[i + 2]!;
        const r = Math.max(Math.abs(x), Math.abs(z)) * 0.6 + Math.hypot(x, z) * 0.4;
        const over = Math.max(0, r - 0.04);
        const spread = 1 + melt * 0.08;
        pos[i] = x * spread;
        pos[i + 2] = z * spread;
        pos[i + 1] = pos[i + 1]! - over * over * 70 * melt - over * melt * 0.35 + Math.sin(x * 140 + z * 90) * 0.0005 * melt;
      }
      this.body.updateVerticesData("position", pos);
      this.body.createNormals(true);
      const mat = this.body.material as PBRMaterial | null;
      if (mat) {
        mat.roughness = 0.42 - melt * 0.2;
      }
    }
  }

  setHighlighted(on: boolean, color = new Color3(1, 0.85, 0.4)): void {
    for (const m of [this.root, ...this.root.getChildMeshes()] as Mesh[]) {
      m.renderOutline = on;
      if (on) {
        m.outlineColor = color;
        m.outlineWidth = 0.004;
      }
    }
  }

  setGhost(alpha: number): void {
    this.root.visibility = alpha;
    for (const c of this.root.getChildMeshes()) c.visibility = alpha;
  }

  dispose(): void {
    this.root.dispose(false, false);
    this.releaseMaterials();
  }

  private releaseMaterials(): void {
    // Shared textures (cooked maps, albedo) stay alive for other items.
    for (const m of this.owned) m.dispose(false, false);
    this.owned = [];
  }
}

/** Qualitative inspection text (spec §8: cues before numbers). */
export function describeFood(kind: ItemKind, food: FoodState | null): string[] {
  if (!food) return [ITEMS[kind].label];
  const lines: string[] = [ITEMS[kind].label];
  const side = (c: number) => (c < 0.2 ? "raw" : c < 0.5 ? "lightly browned" : c < 0.95 ? "nicely browned" : c < 1.2 ? "dark" : "charred");
  if (isPatty(kind)) {
    const down = food.down === 0 ? food.cookA : food.cookB;
    const up = food.down === 0 ? food.cookB : food.cookA;
    lines.push(`Underside: ${side(down)}`, `Top: ${side(up)}`, `Inside: ${pattyDoneness(food)}`);
  }
  const cook = Math.max(food.cookA, food.cookB);
  if (kind === "bacon") lines.push(cook < 0.45 ? "Floppy — keep cooking" : cook < 1 ? "Crispy" : "Very crispy");
  if (kind === "egg") lines.push(cook < 0.45 ? "Runny" : "Set");
  if (kind === "mushroom") lines.push(cook < 0.45 ? "Raw" : "Grilled");
  if (kind === "onion") lines.push(cook > 0.35 ? "Grilled" : "Raw");
  if (kind === "cheese" || kind === "swiss") lines.push(food.melt < 0.15 ? "Firm" : food.melt < 0.45 ? "Softening" : "Melted");
  if (kind === "bun_bottom" || kind === "bun_top") lines.push(food.toast < 0.2 ? "Untoasted" : food.toast < 1 ? "Toasted" : "Over-toasted");
  if (food.burn > 0.25) lines.push("Burnt");
  lines.push(food.temp > 55 ? "Hot" : food.temp > 40 ? "Warm" : food.temp > 15 ? "Room temperature" : "Cold");
  if (food.sauce > 0.05) {
    const names = saucesInMask(food.sauceMask);
    lines.push(food.sauce > 1.6 ? "Drowning in sauce" : `Sauce: ${names.join(", ") || "yes"}`);
  }
  if (food.dirty) lines.push("Dropped — throw it away");
  return lines;
}
