import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import { ITEMS, type ItemKind } from "@ahb/data";
import { pattyDoneness, type FoodState } from "@ahb/simulation";
import type { MaterialLibrary } from "./materials.js";
import { setPick } from "./scene.js";

type RGB = [number, number, number];

function mix(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

const RAW: RGB = [0.78, 0.33, 0.36];
const GREYING: RGB = [0.6, 0.4, 0.36];
const BROWN: RGB = [0.42, 0.22, 0.12];
const DARK: RGB = [0.2, 0.11, 0.06];
const CHAR: RGB = [0.05, 0.04, 0.035];

/** Patty surface colour from its browning and burn values (authored ramp, not a texture bake). */
export function pattySurface(cook: number, burn: number): RGB {
  let c: RGB;
  if (cook < 0.25) c = mix(RAW, GREYING, cook / 0.25);
  else if (cook < 0.8) c = mix(GREYING, BROWN, (cook - 0.25) / 0.55);
  else c = mix(BROWN, DARK, (cook - 0.8) / 0.5);
  return mix(c, CHAR, burn * 1.2);
}

export function pattyEdge(inner: number, burn: number): RGB {
  return mix(mix(RAW, [0.5, 0.33, 0.28], inner / 0.9), CHAR, burn * 0.6);
}

const CRUMB: RGB = [0.93, 0.82, 0.6];
const TOASTED: RGB = [0.72, 0.45, 0.2];
const CRUST: RGB = [0.7, 0.42, 0.16];

export function toastColor(toast: number, burn: number): RGB {
  const c = toast < 1 ? mix(CRUMB, TOASTED, toast) : mix(TOASTED, DARK, (toast - 1) / 0.5);
  return mix(c, CHAR, burn);
}

function dirty(c: RGB, isDirty: boolean): RGB {
  return isDirty ? mix(c, [0.25, 0.22, 0.2], 0.45) : c;
}

/** Face classification for vertex colouring: 0 = bottom, 1 = side, 2 = top. */
function classifyFaces(mesh: Mesh): Uint8Array {
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind) ?? [];
  const out = new Uint8Array(normals.length / 3);
  for (let i = 0; i < out.length; i++) {
    const ny = normals[i * 3 + 1]!;
    out[i] = ny > 0.6 ? 2 : ny < -0.6 ? 0 : 1;
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

/** Irregular edge so patties don't look machine-stamped. */
function roughenRadially(mesh: Mesh, amount: number, seed: number): void {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!pos) return;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]!;
    const z = pos[i + 2]!;
    const a = Math.atan2(z, x);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    const k = 1 + amount * (Math.sin(a * 5 + seed) * 0.6 + Math.sin(a * 11 + seed * 2.3) * 0.4);
    pos[i] = x * k;
    pos[i + 2] = z * k;
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, pos);
}

export interface ItemSnapshotLike {
  kind: string;
  down: number;
  flip: number;
  level: number;
  offered: boolean;
  holder: string;
}

/** Visual for one replicated item. Appearance is a pure function of authoritative state. */
export class ItemView {
  readonly id: string;
  readonly kind: ItemKind;
  readonly root: Mesh;
  private readonly scene: Scene;
  private readonly lib: MaterialLibrary;
  private faces: Uint8Array | null = null;
  private colorTarget: Mesh | null = null;
  private cheeseBase: Float32Array | null = null;
  private sauceBlob: Mesh | null = null;
  private appearanceKey = "";
  food: FoodState | null = null;

  constructor(scene: Scene, lib: MaterialLibrary, id: string, kind: ItemKind) {
    this.scene = scene;
    this.lib = lib;
    this.id = id;
    this.kind = kind;
    this.root = this.build();
    this.root.rotationQuaternion = Quaternion.Identity();
    this.root.metadata = { placeholder: true };
    for (const m of [this.root, ...this.root.getChildMeshes()] as Mesh[]) setPick(m, { type: "item", id });
  }

  private build(): Mesh {
    const s = this.scene;
    const lib = this.lib;
    const seed = parseInt(this.id.replace(/\D/g, ""), 10) || 1;
    switch (this.kind) {
      case "patty": {
        const m = MeshBuilder.CreateCylinder(`it_${this.id}`, { diameter: 0.11, height: 0.024, tessellation: 28, updatable: true }, s);
        roughenRadially(m, 0.05, seed);
        m.material = lib.vertexColored("patty_mat", 0.62);
        this.faces = classifyFaces(m);
        this.colorTarget = m;
        return m;
      }
      case "bun_bottom": {
        const m = MeshBuilder.CreateCylinder(`it_${this.id}`, { diameterTop: 0.116, diameterBottom: 0.12, height: 0.032, tessellation: 28, updatable: true }, s);
        m.material = lib.vertexColored("bun_mat", 0.75);
        this.faces = classifyFaces(m);
        this.colorTarget = m;
        return m;
      }
      case "bun_top": {
        const dome = MeshBuilder.CreateSphere(`it_${this.id}`, { diameter: 0.12, segments: 16, slice: 0.5, updatable: true }, s);
        dome.scaling.y = 0.8;
        dome.position.y = -0.024;
        dome.bakeCurrentTransformIntoVertices();
        const cap = MeshBuilder.CreateDisc(`it_${this.id}_cap`, { radius: 0.06, tessellation: 28 }, s);
        cap.rotation.x = Math.PI / 2;
        cap.position.y = -0.024;
        cap.bakeCurrentTransformIntoVertices();
        const merged = Mesh.MergeMeshes([dome, cap], true, true)!;
        merged.name = `it_${this.id}`;
        merged.material = lib.vertexColored("bun_mat", 0.75);
        this.faces = classifyFaces(merged);
        this.colorTarget = merged;
        // Sesame seeds.
        const seedMat = lib.solid("sesame", [0.95, 0.9, 0.75], 0.6);
        for (let i = 0; i < 14; i++) {
          const a = i * 2.39996 + seed;
          const r = 0.012 + (i / 14) * 0.035;
          const sd = MeshBuilder.CreateSphere(`it_${this.id}_seed${i}`, { diameter: 0.006, segments: 3 }, s);
          sd.scaling.set(1, 0.5, 1.6);
          const x = Math.cos(a) * r;
          const z = Math.sin(a) * r;
          const y = Math.sqrt(Math.max(0, 0.06 * 0.06 - x * x - z * z)) * 0.8 - 0.024 + 0.001;
          sd.position.set(x, y, z);
          sd.rotation.y = a;
          sd.material = seedMat;
          sd.parent = merged;
        }
        return merged;
      }
      case "cheese": {
        const m = MeshBuilder.CreateGround(`it_${this.id}`, { width: 0.09, height: 0.09, subdivisions: 8, updatable: true }, s);
        const mat = lib.solid("cheese_mat", [0.98, 0.68, 0.12], 0.5);
        mat.backFaceCulling = false;
        m.material = mat;
        this.cheeseBase = new Float32Array(m.getVerticesData(VertexBuffer.PositionKind)!);
        return m;
      }
      case "lettuce": {
        const m = MeshBuilder.CreateDisc(`it_${this.id}`, { radius: 0.062, tessellation: 32, updatable: true }, s);
        m.rotation.x = Math.PI / 2;
        m.bakeCurrentTransformIntoVertices();
        const pos = m.getVerticesData(VertexBuffer.PositionKind)!;
        for (let i = 0; i < pos.length; i += 3) {
          const a = Math.atan2(pos[i + 2]!, pos[i]!);
          const r = Math.hypot(pos[i]!, pos[i + 2]!);
          pos[i + 1] = Math.sin(a * 9 + seed) * 0.006 * (r / 0.062);
          const k = 1 + Math.sin(a * 7 + seed) * 0.06;
          pos[i] = pos[i]! * k;
          pos[i + 2] = pos[i + 2]! * k;
        }
        m.updateVerticesData(VertexBuffer.PositionKind, pos);
        const mat = lib.solid("lettuce_mat", [0.38, 0.68, 0.22], 0.55);
        mat.backFaceCulling = false;
        m.material = mat;
        return m;
      }
      case "tomato": {
        const m = MeshBuilder.CreateCylinder(`it_${this.id}`, { diameter: 0.08, height: 0.01, tessellation: 24 }, s);
        m.material = lib.solid("tomato_mat", [0.82, 0.13, 0.08], 0.35);
        const inner = MeshBuilder.CreateCylinder(`it_${this.id}_in`, { diameter: 0.058, height: 0.0104, tessellation: 24 }, s);
        inner.material = lib.solid("tomato_in", [0.92, 0.32, 0.22], 0.3);
        inner.parent = m;
        return m;
      }
      case "onion": {
        const outer = MeshBuilder.CreateTorus(`it_${this.id}`, { diameter: 0.07, thickness: 0.007, tessellation: 24 }, s);
        const inner = MeshBuilder.CreateTorus(`it_${this.id}_b`, { diameter: 0.046, thickness: 0.006, tessellation: 20 }, s);
        const merged = Mesh.MergeMeshes([outer, inner], true, true)!;
        merged.name = `it_${this.id}`;
        merged.material = lib.solid("onion_mat", [0.9, 0.84, 0.9], 0.4);
        return merged;
      }
      case "pickle": {
        const parts: Mesh[] = [];
        for (let i = 0; i < 3; i++) {
          const c = MeshBuilder.CreateCylinder(`it_${this.id}_${i}`, { diameter: 0.032, height: 0.004, tessellation: 14 }, s);
          c.position.set(Math.cos(i * 2.1) * 0.022, 0.0005 * i, Math.sin(i * 2.1) * 0.022);
          c.bakeCurrentTransformIntoVertices();
          parts.push(c);
        }
        const merged = Mesh.MergeMeshes(parts, true, true)!;
        merged.name = `it_${this.id}`;
        merged.material = lib.solid("pickle_mat", [0.4, 0.52, 0.16], 0.4);
        return merged;
      }
      case "tray": {
        const base = MeshBuilder.CreateBox(`it_${this.id}`, { width: 0.4, height: 0.012, depth: 0.3 }, s);
        base.position.y = -0.004;
        base.bakeCurrentTransformIntoVertices();
        const rims = [
          [0, 0.004, 0.147, 0.4, 0.02, 0.006],
          [0, 0.004, -0.147, 0.4, 0.02, 0.006],
          [0.197, 0.004, 0, 0.006, 0.02, 0.3],
          [-0.197, 0.004, 0, 0.006, 0.02, 0.3],
        ].map(([x, y, z, w, h, d], i) => {
          const r = MeshBuilder.CreateBox(`it_${this.id}_r${i}`, { width: w!, height: h!, depth: d! }, s);
          r.position.set(x!, y!, z!);
          r.bakeCurrentTransformIntoVertices();
          return r;
        });
        const merged = Mesh.MergeMeshes([base, ...rims], true, true)!;
        merged.name = `it_${this.id}`;
        merged.material = lib.solid("tray_red", [0.62, 0.08, 0.06], 0.45);
        const liner = MeshBuilder.CreatePlane(`it_${this.id}_liner`, { width: 0.3, height: 0.22 }, s);
        liner.rotation.x = Math.PI / 2;
        liner.position.y = 0.0025;
        liner.material = lib.solid("paper_liner", [0.95, 0.93, 0.86], 0.95);
        liner.parent = merged;
        return merged;
      }
      case "spatula": {
        const blade = MeshBuilder.CreateBox(`it_${this.id}`, { width: 0.1, height: 0.004, depth: 0.15 }, s);
        blade.position.z = 0.065;
        blade.bakeCurrentTransformIntoVertices();
        blade.material = lib.solid("spatula_steel", [0.82, 0.82, 0.84], 0.25, 1);
        const neck = MeshBuilder.CreateBox(`it_${this.id}_neck`, { width: 0.02, height: 0.004, depth: 0.05 }, s);
        neck.position.set(0, 0.008, -0.03);
        neck.rotation.x = -0.35;
        neck.material = blade.material;
        neck.parent = blade;
        const handle = MeshBuilder.CreateCylinder(`it_${this.id}_handle`, { diameter: 0.024, height: 0.12, tessellation: 12 }, s);
        handle.rotation.x = Math.PI / 2;
        handle.position.set(0, 0.022, -0.11);
        handle.material = lib.solid("handle_black", [0.05, 0.04, 0.04], 0.5);
        handle.parent = blade;
        return blade;
      }
      case "sauce_bottle": {
        const body = MeshBuilder.CreateCylinder(`it_${this.id}`, { diameter: 0.06, height: 0.15, tessellation: 20 }, s);
        body.position.y = -0.015;
        body.bakeCurrentTransformIntoVertices();
        body.material = lib.solid("sauce_bottle", [0.95, 0.55, 0.1], 0.3);
        const cap = MeshBuilder.CreateCylinder(`it_${this.id}_cap`, { diameterTop: 0.006, diameterBottom: 0.04, height: 0.04, tessellation: 16 }, s);
        cap.position.y = 0.08;
        cap.material = lib.solid("sauce_cap", [0.9, 0.88, 0.85], 0.4);
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
      ? `${food.cookA.toFixed(2)}|${food.cookB.toFixed(2)}|${food.inner.toFixed(2)}|${food.burn.toFixed(2)}|${food.melt.toFixed(2)}|${food.toast.toFixed(2)}|${food.sauce.toFixed(2)}|${food.down}|${meta.flip > 127 ? 1 : 0}|${food.dirty}`
      : `${meta.level}`;
    if (key === this.appearanceKey) return;
    this.appearanceKey = key;
    if (!food) return;

    if (this.kind === "patty" && this.colorTarget && this.faces) {
      // Map the authoritative "down" side onto mesh faces; during the second half of a flip the
      // mesh is upside down, so the mapping inverts until the flip lands.
      const flipping = meta.flip > 127;
      const visualDown = flipping ? (food.down === 0 ? 1 : 0) : food.down;
      const downCook = visualDown === 0 ? food.cookA : food.cookB;
      const upCook = visualDown === 0 ? food.cookB : food.cookA;
      paintFaces(
        this.colorTarget,
        this.faces,
        dirty(pattySurface(downCook, food.burn), food.dirty),
        dirty(pattyEdge(food.inner, food.burn), food.dirty),
        dirty(pattySurface(upCook, food.burn * 0.5), food.dirty),
      );
    } else if ((this.kind === "bun_bottom" || this.kind === "bun_top") && this.colorTarget && this.faces) {
      const cut = dirty(toastColor(food.toast, food.burn), food.dirty);
      const crust = dirty(CRUST, food.dirty);
      if (this.kind === "bun_bottom") paintFaces(this.colorTarget, this.faces, crust, crust, cut);
      else paintFaces(this.colorTarget, this.faces, cut, crust, crust);
    } else if (this.kind === "cheese" && this.cheeseBase) {
      // Cheese softens and droops over the patty edge as it melts.
      const mesh = this.root;
      const pos = new Float32Array(this.cheeseBase);
      const melt = food.melt;
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i]!;
        const z = pos[i + 2]!;
        const r = Math.hypot(x, z);
        const over = Math.max(0, r - 0.04);
        const spread = 1 + melt * 0.12;
        pos[i] = x * spread;
        pos[i + 2] = z * spread;
        pos[i + 1] = -over * over * 60 * melt * 0.35 - over * melt * 0.25;
      }
      mesh.updateVerticesData(VertexBuffer.PositionKind, pos);
      const mat = mesh.material as PBRMaterial;
      if (melt > 0.05 && mat.name === "cheese_mat") {
        mesh.material = mat.clone(`cheese_mat_${this.id}`);
      }
      const own = mesh.material as PBRMaterial;
      if (own.name !== "cheese_mat") {
        own.roughness = 0.5 - melt * 0.25;
        const c = dirty(mix([0.98, 0.7, 0.14], [0.95, 0.58, 0.08], melt), food.dirty);
        own.albedoColor = new Color3(...c);
      }
    } else if (food.dirty && !this.root.material?.name.endsWith("_dirty")) {
      const base = this.root.material as PBRMaterial;
      const dm = base.clone(`${base.name}_dirty`);
      dm.albedoColor = base.albedoColor.scale(0.55);
      this.root.material = dm;
    }

    // Sauce shows as a glossy blob sized by the amount applied.
    if (food.sauce > 0.02) {
      if (!this.sauceBlob) {
        this.sauceBlob = MeshBuilder.CreateSphere(`it_${this.id}_sauce`, { diameter: 1, segments: 10 }, this.scene);
        this.sauceBlob.material = this.lib.solid("sauce_mat", [0.92, 0.45, 0.08], 0.15);
        this.sauceBlob.parent = this.root;
        setPick(this.sauceBlob, { type: "item", id: this.id });
      }
      const size = Math.min(0.1, 0.03 + food.sauce * 0.05);
      this.sauceBlob.scaling.set(size, 0.006 + food.sauce * 0.003, size);
      this.sauceBlob.position.y = ITEMS[this.kind].layerHeight / 2 + 0.002;
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
  }
}

/** Qualitative inspection text (spec §8: cues before numbers). */
export function describeFood(kind: ItemKind, food: FoodState | null): string[] {
  if (!food) return [ITEMS[kind].label];
  const lines: string[] = [ITEMS[kind].label];
  const side = (c: number) => (c < 0.2 ? "raw" : c < 0.5 ? "lightly browned" : c < 0.95 ? "nicely browned" : c < 1.2 ? "dark" : "charred");
  if (kind === "patty") {
    const down = food.down === 0 ? food.cookA : food.cookB;
    const up = food.down === 0 ? food.cookB : food.cookA;
    lines.push(`Underside: ${side(down)}`, `Top: ${side(up)}`, `Inside: ${pattyDoneness(food)}`);
  }
  if (kind === "cheese") lines.push(food.melt < 0.15 ? "Firm" : food.melt < 0.45 ? "Softening" : "Melted");
  if (kind === "bun_bottom" || kind === "bun_top") lines.push(food.toast < 0.2 ? "Untoasted" : food.toast < 1 ? "Toasted" : "Over-toasted");
  lines.push(food.temp > 55 ? "Hot" : food.temp > 40 ? "Warm" : food.temp > 15 ? "Room temperature" : "Cold");
  if (food.sauce > 0.05) lines.push(food.sauce > 1.6 ? "Drowning in sauce" : "Sauced");
  if (food.dirty) lines.push("Dropped — throw it away");
  return lines;
}
