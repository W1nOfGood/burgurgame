import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Light } from "@babylonjs/core/Lights/light";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Scene } from "@babylonjs/core/scene";
import {
  BOXES,
  CHILLER_DRAWER,
  DISPENSERS,
  GRILL_ZONES,
  ITEMS,
  PICKUP_ZONE,
  RECIPES,
  MODIFIERS,
  SHIFT_SWITCH,
  TRASH_ZONE,
  formatCents,
  type ItemKind,
  type ModifierId,
  type RecipeId,
  type SurfaceKind,
} from "@ahb/data";
import type { RestaurantState } from "@ahb/protocol";
import type { GraphicsPreset } from "../settings.js";
import { MaterialLibrary } from "./materials.js";

export type PickInfo =
  | { type: "surface"; kind: SurfaceKind }
  | { type: "item"; id: string }
  | { type: "knob"; zone: number }
  | { type: "drawer" }
  | { type: "dispenser"; id: string; kind: ItemKind }
  | { type: "switch" }
  | { type: "trash" }
  | { type: "player"; id: string }
  | { type: "static" };

export function setPick(mesh: Mesh, pick: PickInfo): void {
  mesh.metadata = { ...(mesh.metadata ?? {}), pick };
  mesh.isPickable = true;
}

export function getPick(mesh: { metadata?: unknown } | null | undefined): PickInfo | null {
  const md = mesh?.metadata as { pick?: PickInfo } | undefined;
  return md?.pick ?? null;
}

/** World-space box mapping so one material can cover boxes of any size at constant density. */
function boxMapUVs(mesh: Mesh, tile: number): void {
  mesh.bakeCurrentTransformIntoVertices();
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const nrm = mesh.getVerticesData(VertexBuffer.NormalKind)!;
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length / 3; i++) {
    const nx = Math.abs(nrm[i * 3]!);
    const ny = Math.abs(nrm[i * 3 + 1]!);
    const x = pos[i * 3]!;
    const y = pos[i * 3 + 1]!;
    const z = pos[i * 3 + 2]!;
    let u: number;
    let v: number;
    if (ny >= nx && ny >= Math.abs(nrm[i * 3 + 2]!)) {
      u = x;
      v = z;
    } else if (nx >= Math.abs(nrm[i * 3 + 2]!)) {
      u = z;
      v = y;
    } else {
      u = x;
      v = y;
    }
    uv[i * 2] = u / tile;
    uv[i * 2 + 1] = v / tile;
  }
  mesh.setVerticesData(VertexBuffer.UVKind, uv, false);
}

/** Merges meshes that share a material and pick role into one draw call. */
function mergeGroup(name: string, meshes: Mesh[], pick: PickInfo | null): Mesh | null {
  if (meshes.length === 0) return null;
  const merged = meshes.length === 1 ? meshes[0]! : Mesh.MergeMeshes(meshes, true, true)!;
  merged.name = name;
  merged.metadata = { placeholder: true };
  if (pick) setPick(merged, pick);
  else merged.isPickable = false;
  merged.receiveShadows = true;
  merged.freezeWorldMatrix();
  return merged;
}

const BIN_LABELS: Partial<Record<ItemKind, string>> = {
  bun_bottom: "BUN BASE",
  bun_top: "BUN TOP",
  cheese: "CHEESE",
  lettuce: "LETTUCE",
  tomato: "TOMATO",
  onion: "ONION",
  pickle: "PICKLE",
};

const FOOD_BIN_COLORS: Partial<Record<ItemKind, [number, number, number]>> = {
  bun_bottom: [0.78, 0.55, 0.28],
  bun_top: [0.72, 0.46, 0.2],
  cheese: [0.98, 0.72, 0.15],
  lettuce: [0.35, 0.65, 0.2],
  tomato: [0.8, 0.12, 0.08],
  onion: [0.88, 0.82, 0.86],
  pickle: [0.36, 0.48, 0.16],
  patty: [0.78, 0.36, 0.38],
};

export interface GraphicsBudget {
  shadowMapSize: number;
  maxLights: number;
}

export function budgetFor(preset: GraphicsPreset): GraphicsBudget {
  switch (preset) {
    case "tablet":
      return { shadowMapSize: 512, maxLights: 4 };
    case "low":
      return { shadowMapSize: 0, maxLights: 3 };
    case "high":
      return { shadowMapSize: 2048, maxLights: 6 };
    default:
      return { shadowMapSize: 1024, maxLights: 5 };
  }
}

/** Builds and updates the restaurant: shell, equipment, signage, lights. */
export class RestaurantView {
  readonly materials: MaterialLibrary;
  readonly shadows: ShadowGenerator | null;
  private readonly scene: Scene;
  private readonly knobs: Mesh[] = [];
  private readonly knobLamps: PBRMaterial[] = [];
  private readonly zoneGlow: PBRMaterial[] = [];
  private readonly drawer: TransformNode;
  private readonly lever: Mesh;
  private readonly openSign: PBRMaterial;
  private readonly ticketTex: DynamicTexture;
  private readonly boardTex: DynamicTexture;
  private ticketKey = "";
  private ticketTimer = 0;
  private boardKey = "";

  constructor(scene: Scene, preset: GraphicsPreset) {
    this.scene = scene;
    const budget = budgetFor(preset);
    this.materials = new MaterialLibrary(scene, budget.maxLights);
    const m = this.materials;

    // Lights: one warm fill, a few practical lights, one shadow-casting spot over the line.
    const hemi = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.45;
    hemi.diffuse = new Color3(1, 0.88, 0.74);
    hemi.groundColor = new Color3(0.2, 0.14, 0.1);
    const warm = new Color3(1, 0.82, 0.62);
    const kitchenLight = new PointLight("kitchen_light", new Vector3(-1.5, 2.9, 2.6), scene);
    kitchenLight.diffuse = warm;
    kitchenLight.intensity = 1.1;
    kitchenLight.range = 9;
    kitchenLight.falloffType = Light.FALLOFF_STANDARD;
    const diningLight = new PointLight("dining_light", new Vector3(0, 2.9, -3.2), scene);
    diningLight.diffuse = new Color3(1, 0.7, 0.45);
    diningLight.intensity = 0.9;
    diningLight.range = 9;
    diningLight.falloffType = Light.FALLOFF_STANDARD;
    const spot = new SpotLight("line_spot", new Vector3(0, 3.0, 3.4), new Vector3(0, -1, 0.35).normalize(), Math.PI / 2.1, 2, scene);
    spot.diffuse = new Color3(1, 0.9, 0.78);
    spot.intensity = 1.6;
    spot.range = 8;
    spot.falloffType = Light.FALLOFF_STANDARD;
    if (budget.maxLights >= 5) {
      const front = new PointLight("front_light", new Vector3(0, 2.5, 0.2), scene);
      front.diffuse = warm;
      front.intensity = 0.6;
      front.range = 5;
      front.falloffType = Light.FALLOFF_STANDARD;
    }
    if (budget.shadowMapSize > 0) {
      const sg = new ShadowGenerator(budget.shadowMapSize, spot);
      sg.usePercentageCloserFiltering = true;
      sg.filteringQuality = budget.shadowMapSize >= 2048 ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_LOW;
      sg.bias = 0.0008;
      sg.normalBias = 0.01;
      this.shadows = sg;
    } else {
      this.shadows = null;
    }

    // Shell, counters and equipment bodies from the shared layout, merged per material and
    // pick role to keep scene submission low.
    const groups = new Map<string, { meshes: Mesh[]; pick: PickInfo | null }>();
    for (const box of BOXES) {
      const mesh = MeshBuilder.CreateBox(box.id, { width: box.half[0] * 2, height: box.half[1] * 2, depth: box.half[2] * 2 }, scene);
      mesh.position.set(box.center[0], box.center[1], box.center[2]);
      boxMapUVs(mesh, m.tileFor(box.material));
      mesh.material = m.forBox(box.material);
      const pick: PickInfo | null = box.surface ? { type: "surface", kind: box.surface } : box.id === "trash" ? { type: "trash" } : box.collide ? { type: "static" } : null;
      const key = `${box.material}|${JSON.stringify(pick)}`;
      const g = groups.get(key) ?? { meshes: [], pick };
      g.meshes.push(mesh);
      groups.set(key, g);
    }
    for (const [key, g] of groups) mergeGroup(`layout_${key}`, g.meshes, g.pick);

    this.buildGrill(m);
    this.drawer = this.buildDrawer(m);
    this.buildBins(m);
    this.lever = this.buildSwitch(m);
    this.openSign = this.buildOpenSign(m);
    this.ticketTex = this.buildTicketRail(m);
    this.boardTex = this.buildMenuBoard(m);
    this.buildDecor(m);
    this.buildExterior(m);
  }

  private buildGrill(m: MaterialLibrary): void {
    const knobMat = m.solid("knob", [0.08, 0.08, 0.08], 0.4, 0.2);
    const markMat = m.solid("knob_mark", [0.95, 0.95, 0.95], 0.5);
    const plate = m.solid("grill_zone", [0.14, 0.13, 0.12], 0.45, 0.45);
    GRILL_ZONES.forEach((zone, i) => {
      const w = zone.rect.maxX - zone.rect.minX - 0.02;
      const d = zone.rect.maxZ - zone.rect.minZ - 0.02;
      const top = MeshBuilder.CreateBox(`zone_${i}`, { width: w, height: 0.006, depth: d }, this.scene);
      top.position.set((zone.rect.minX + zone.rect.maxX) / 2, zone.y + 0.003, (zone.rect.minZ + zone.rect.maxZ) / 2);
      const glow = plate.clone(`zone_mat_${i}`) as PBRMaterial;
      top.material = glow;
      this.zoneGlow.push(glow);
      top.receiveShadows = true;
      setPick(top, { type: "surface", kind: "grill" });

      const knob = MeshBuilder.CreateCylinder(`knob_${i}`, { diameter: 0.07, height: 0.04, tessellation: 20 }, this.scene);
      knob.rotation.x = Math.PI / 2;
      knob.position.set(zone.knob[0], zone.knob[1], zone.knob[2] - 0.0);
      knob.material = knobMat;
      const mark = MeshBuilder.CreateBox(`knob_mark_${i}`, { width: 0.008, height: 0.012, depth: 0.03 }, this.scene);
      mark.parent = knob;
      mark.position.set(0, -0.021, 0.02);
      mark.material = markMat;
      mark.isPickable = false;
      setPick(knob, { type: "knob", zone: i });
      this.knobs.push(knob);

      const lamp = MeshBuilder.CreateSphere(`knob_lamp_${i}`, { diameter: 0.014, segments: 8 }, this.scene);
      lamp.position.set(zone.knob[0] + 0.06, zone.knob[1] + 0.05, zone.knob[2]);
      const lampMat = m.solid(`lamp_${i}`, [0.1, 0.1, 0.1], 0.3, 0, [0, 0, 0]);
      lamp.material = lampMat;
      lamp.isPickable = false;
      this.knobLamps.push(lampMat);
    });
    // Grease trough along the front edge.
    const trough = MeshBuilder.CreateBox("grease_tray", { width: 1.6, height: 0.03, depth: 0.05 }, this.scene);
    trough.position.set(0, 0.88, 4.18);
    trough.material = m.solid("grease", [0.2, 0.18, 0.15], 0.3, 0.9);
    trough.isPickable = false;
  }

  private buildDrawer(m: MaterialLibrary): TransformNode {
    const root = new TransformNode("drawer", this.scene);
    const [hx, hy, hz] = CHILLER_DRAWER.half;
    const front = MeshBuilder.CreateBox("drawer_front", { width: hx * 2, height: hy * 2 + 0.06, depth: 0.03 }, this.scene);
    front.parent = root;
    front.position.set(0, 0, 0);
    front.material = m.forBox("stainless");
    setPick(front, { type: "drawer" });
    const handle = MeshBuilder.CreateCylinder("drawer_handle", { diameter: 0.02, height: hx * 1.4, tessellation: 10 }, this.scene);
    handle.parent = root;
    handle.rotation.z = Math.PI / 2;
    handle.position.set(0, 0.04, -0.03);
    handle.material = m.solid("handle", [0.7, 0.7, 0.72], 0.25, 1);
    setPick(handle, { type: "drawer" });
    const tub = MeshBuilder.CreateBox("drawer_tub", { width: hx * 2 - 0.04, height: hy * 2 - 0.02, depth: hz * 2 }, this.scene);
    tub.parent = root;
    tub.position.set(0, -0.01, hz + 0.015);
    tub.material = m.solid("tub", [0.75, 0.76, 0.78], 0.3, 0.35);
    tub.isPickable = false;
    const disp = DISPENSERS.find((d) => d.kind === "patty")!;
    const patties = MeshBuilder.CreateBox("drawer_patties", { width: hx * 2 - 0.1, height: 0.04, depth: hz * 2 - 0.08 }, this.scene);
    patties.parent = root;
    patties.position.set(0, hy - 0.04, hz + 0.015);
    patties.material = m.solid("raw_pile", FOOD_BIN_COLORS.patty!, 0.6);
    setPick(patties, { type: "dispenser", id: disp.id, kind: "patty" });
    root.position.set(CHILLER_DRAWER.handle[0], CHILLER_DRAWER.handle[1], CHILLER_DRAWER.handle[2]);
    return root;
  }

  private buildBins(m: MaterialLibrary): void {
    const rims: Mesh[] = [];
    const binDefs = DISPENSERS.filter((d) => d.kind !== "patty" && d.kind !== "tray");
    for (const d of DISPENSERS) {
      if (d.kind === "patty") continue;
      if (d.kind === "tray") {
        const stack = MeshBuilder.CreateBox(`tray_stack`, { width: 0.4, height: 0.08, depth: 0.3 }, this.scene);
        stack.position.set(d.center[0], d.center[1], d.center[2]);
        stack.material = m.solid("tray_red", [0.62, 0.08, 0.06], 0.45);
        setPick(stack, { type: "dispenser", id: d.id, kind: "tray" });
        continue;
      }
      const bin = MeshBuilder.CreateBox(`bin_${d.id}`, { width: d.half[0] * 2 - 0.02, height: 0.012, depth: d.half[2] * 2 - 0.02 }, this.scene);
      bin.position.set(d.center[0], d.center[1] + 0.012, d.center[2]);
      bin.material = m.solid(`bin_${d.kind}`, FOOD_BIN_COLORS[d.kind] ?? [0.5, 0.5, 0.5], d.kind === "cheese" ? 0.5 : 0.65);
      bin.receiveShadows = true;
      setPick(bin, { type: "dispenser", id: d.id, kind: d.kind });
      // Hollow rim frame so the ingredients inside stay visible.
      const [hx, , hz] = d.half;
      for (const [w, dd, ox, oz] of [
        [hx * 2, 0.012, 0, hz - 0.006],
        [hx * 2, 0.012, 0, -hz + 0.006],
        [0.012, hz * 2, hx - 0.006, 0],
        [0.012, hz * 2, -hx + 0.006, 0],
      ] as const) {
        const rim = MeshBuilder.CreateBox(`rim_${d.id}_${ox}_${oz}`, { width: w, height: 0.03, depth: dd }, this.scene);
        rim.position.set(d.center[0] + ox, d.center[1] + 0.012, d.center[2] + oz);
        rims.push(rim);
      }
    }
    const rimMerged = mergeGroup("bin_rims", rims, null);
    if (rimMerged) rimMerged.material = m.solid("bin_rim", [0.7, 0.71, 0.73], 0.3, 0.9);
    // One label strip for the whole bin row (one texture, one draw call).
    const first = binDefs[0]!;
    const last = binDefs[binDefs.length - 1]!;
    const minX = first.center[0] - first.half[0];
    const maxX = last.center[0] + last.half[0];
    const strip = MeshBuilder.CreatePlane("bin_labels", { width: maxX - minX, height: 0.05 }, this.scene);
    strip.position.set((minX + maxX) / 2, first.center[1] + 0.06, first.center[2] - first.half[2] - 0.004);
    const texW = 1024;
    const tex = m.signTexture("bin_labels_tex", texW, 48, (ctx, w, h) => {
      ctx.fillStyle = "#f4efe2";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#2b2420";
      ctx.font = "bold 22px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const d of binDefs) {
        const cx = ((d.center[0] - minX) / (maxX - minX)) * w;
        ctx.fillText(BIN_LABELS[d.kind] ?? ITEMS[d.kind].label.toUpperCase(), cx, h / 2 + 1);
      }
    });
    const lm = new PBRMaterial("bin_labels_mat", this.scene);
    lm.albedoTexture = tex;
    lm.emissiveTexture = tex;
    lm.emissiveColor = new Color3(0.3, 0.3, 0.3);
    lm.roughness = 0.8;
    lm.metallic = 0;
    strip.material = lm;
    strip.isPickable = false;
    // Trash opening marker.
    const opening = MeshBuilder.CreateCylinder("trash_opening", { diameter: 0.36, height: 0.01, tessellation: 24 }, this.scene);
    opening.position.set((TRASH_ZONE.minX + TRASH_ZONE.maxX) / 2, 0.805, (TRASH_ZONE.minZ + TRASH_ZONE.maxZ) / 2);
    opening.material = this.materials.solid("trash_hole", [0.02, 0.02, 0.02], 0.9);
    setPick(opening, { type: "trash" });
  }

  private buildSwitch(m: MaterialLibrary): Mesh {
    const plate = MeshBuilder.CreateBox("switch_plate", { width: 0.12, height: 0.16, depth: 0.02 }, this.scene);
    plate.position.set(SHIFT_SWITCH[0], SHIFT_SWITCH[1], SHIFT_SWITCH[2] - 0.01);
    plate.material = m.solid("switch_plate", [0.9, 0.88, 0.84], 0.4);
    setPick(plate, { type: "switch" });
    const lever = MeshBuilder.CreateBox("switch_lever", { width: 0.03, height: 0.07, depth: 0.03 }, this.scene);
    lever.parent = plate;
    lever.position.set(0, 0, 0.02);
    lever.material = m.solid("switch_lever", [0.12, 0.12, 0.12], 0.4);
    setPick(lever, { type: "switch" });
    const label = MeshBuilder.CreatePlane("switch_label", { width: 0.2, height: 0.05 }, this.scene);
    label.position.set(SHIFT_SWITCH[0], SHIFT_SWITCH[1] + 0.12, SHIFT_SWITCH[2] + 0.001);
    label.rotation.y = Math.PI;
    const tex = m.signTexture("switch_label_tex", 256, 64, (ctx, w, h) => {
      ctx.fillStyle = "#1c1a19";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#f6d37a";
      ctx.font = "bold 30px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("OPEN SIGN", w / 2, h / 2);
    });
    const lm = new PBRMaterial("switch_label_mat", this.scene);
    lm.albedoTexture = tex;
    lm.emissiveTexture = tex;
    lm.emissiveColor = new Color3(0.4, 0.4, 0.4);
    lm.roughness = 0.9;
    label.material = lm;
    label.isPickable = false;
    return lever;
  }

  private buildOpenSign(m: MaterialLibrary): PBRMaterial {
    const sign = MeshBuilder.CreatePlane("open_sign", { width: 1.2, height: 0.42 }, this.scene);
    sign.position.set(-3.6, 1.9, -6.0);
    const tex = m.signTexture("open_sign_tex", 512, 180, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "#ff3b5c";
      ctx.lineWidth = 10;
      ctx.strokeRect(12, 12, w - 24, h - 24);
      ctx.fillStyle = "#ff3b5c";
      ctx.font = "bold 110px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("OPEN", w / 2, h / 2 + 6);
    });
    tex.hasAlpha = true;
    const mat = new PBRMaterial("open_sign_mat", this.scene);
    mat.albedoTexture = tex;
    mat.useAlphaFromAlbedoTexture = true;
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
    mat.emissiveTexture = tex;
    mat.emissiveColor = new Color3(0.08, 0.02, 0.02);
    mat.roughness = 1;
    mat.metallic = 0;
    sign.material = mat;
    sign.isPickable = false;
    return mat;
  }

  private buildTicketRail(m: MaterialLibrary): DynamicTexture {
    const plane = MeshBuilder.CreatePlane("tickets", { width: 2.0, height: 0.26 }, this.scene);
    plane.position.set(PICKUP_ZONE.minX + 1.0, 1.62, 0.34);
    plane.rotation.y = Math.PI;
    const tex = m.signTexture("tickets_tex", 1024, 134, (ctx, w, h) => ctx.clearRect(0, 0, w, h));
    tex.hasAlpha = true;
    const mat = new PBRMaterial("tickets_mat", this.scene);
    mat.albedoTexture = tex;
    mat.useAlphaFromAlbedoTexture = true;
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
    mat.emissiveTexture = tex;
    mat.emissiveColor = new Color3(0.35, 0.35, 0.35);
    mat.roughness = 0.9;
    mat.backFaceCulling = false;
    plane.material = mat;
    plane.isPickable = false;
    return tex;
  }

  private buildMenuBoard(m: MaterialLibrary): DynamicTexture {
    const board = MeshBuilder.CreatePlane("menu_board", { width: 2.4, height: 0.9 }, this.scene);
    board.position.set(-3.2, 2.3, 0.36);
    board.rotation.y = Math.PI;
    const tex = m.signTexture("menu_tex", 1024, 384, (ctx, w, h) => ctx.clearRect(0, 0, w, h));
    const mat = new PBRMaterial("menu_mat", this.scene);
    mat.albedoTexture = tex;
    mat.emissiveTexture = tex;
    mat.emissiveColor = new Color3(0.5, 0.5, 0.5);
    mat.roughness = 0.9;
    mat.backFaceCulling = false;
    board.material = mat;
    board.isPickable = false;
    // A second face toward the dining room.
    const back = board.clone("menu_board_front");
    back.rotation.y = 0;
    back.position.z = 0.34;
    return tex;
  }

  private buildDecor(m: MaterialLibrary): void {
    // Stools around the tables.
    const seats: Mesh[] = [];
    const legs: Mesh[] = [];
    for (const t of BOXES.filter((b) => b.id.startsWith("table_"))) {
      for (const dx of [0.65, -0.65]) {
        const seat = MeshBuilder.CreateCylinder(`${t.id}_stool_${dx}`, { diameter: 0.36, height: 0.06, tessellation: 20 }, this.scene);
        seat.position.set(t.center[0] + dx, 0.48, t.center[2]);
        seats.push(seat);
        const leg = MeshBuilder.CreateCylinder(`${t.id}_leg_${dx}`, { diameter: 0.05, height: 0.45, tessellation: 10 }, this.scene);
        leg.position.set(t.center[0] + dx, 0.225, t.center[2]);
        legs.push(leg);
      }
    }
    const seatMesh = mergeGroup("stool_seats", seats, null);
    if (seatMesh) seatMesh.material = m.solid("stool", [0.55, 0.05, 0.05], 0.45);
    const legMesh = mergeGroup("stool_legs", legs, null);
    if (legMesh) legMesh.material = m.solid("chrome", [0.85, 0.85, 0.87], 0.15, 1);
    // Pendant lamps.
    const shades: Mesh[] = [];
    const bulbs: Mesh[] = [];
    for (const [x, z] of [
      [-3.5, -3.0],
      [0, -3.8],
      [3.5, -3.0],
      [-1.5, 2.6],
      [1.2, 2.6],
    ] as const) {
      const sh = MeshBuilder.CreateCylinder(`shade_${x}_${z}`, { diameterTop: 0.12, diameterBottom: 0.38, height: 0.22, tessellation: 20 }, this.scene);
      sh.position.set(x, 2.75, z);
      shades.push(sh);
      const b = MeshBuilder.CreateSphere(`bulb_${x}_${z}`, { diameter: 0.1, segments: 8 }, this.scene);
      b.position.set(x, 2.63, z);
      bulbs.push(b);
    }
    const shadeMesh = mergeGroup("shades", shades, null);
    if (shadeMesh) shadeMesh.material = m.solid("shade", [0.1, 0.25, 0.22], 0.4, 0.3);
    const bulbMesh = mergeGroup("bulbs", bulbs, null);
    if (bulbMesh) bulbMesh.material = m.solid("bulb", [1, 0.9, 0.7], 0.2, 0, [1, 0.78, 0.5]);
    // Heat-lamp glow over the pickup shelf.
    const lamp = MeshBuilder.CreateBox("heat_lamp_glow", { width: 2.0, height: 0.01, depth: 0.3 }, this.scene);
    lamp.position.set(-0.4, 1.645, 0);
    lamp.material = m.solid("heat_glow", [1, 0.5, 0.2], 0.5, 0, [0.9, 0.35, 0.1]);
    lamp.isPickable = false;
    // Register screen.
    const screen = MeshBuilder.CreatePlane("register_screen", { width: 0.3, height: 0.18 }, this.scene);
    screen.position.set(-3.5, 1.35, 0.1);
    screen.rotation.x = -0.4;
    screen.material = m.solid("register_screen", [0.05, 0.1, 0.08], 0.2, 0, [0.1, 0.4, 0.25]);
    screen.isPickable = false;
  }

  private buildExterior(m: MaterialLibrary): void {
    const road = MeshBuilder.CreateBox("road", { width: 30, height: 0.1, depth: 8 }, this.scene);
    road.position.set(0, -0.2, -13.5);
    boxMapUVs(road, m.tileFor("street"));
    road.material = m.forBox("street");
    road.isPickable = false;
    const buildings: Mesh[] = [];
    const lit: Mesh[] = [];
    const dark: Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const b = MeshBuilder.CreateBox(`building_${i}`, { width: 7, height: 9 + (i % 2) * 3, depth: 4 }, this.scene);
      b.position.set(-10.5 + i * 7, 4.5, -20);
      buildings.push(b);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 4; c++) {
          const w = MeshBuilder.CreatePlane(`bw_${i}_${r}_${c}`, { width: 0.9, height: 1.2 }, this.scene);
          w.position.set(-13 + i * 7 + c * 1.7, 2.5 + r * 2.6, -17.98);
          w.rotation.y = Math.PI;
          ((i * 7 + r * 3 + c) % 3 === 0 ? lit : dark).push(w);
        }
      }
    }
    const bm = mergeGroup("buildings", buildings, null);
    if (bm) bm.material = m.solid("facade", [0.16, 0.13, 0.14], 0.9);
    const lm = mergeGroup("windows_lit", lit, null);
    if (lm) lm.material = m.solid("window_lit", [0.9, 0.7, 0.4], 0.5, 0, [0.85, 0.6, 0.3]);
    const dm = mergeGroup("windows_dark", dark, null);
    if (dm) dm.material = m.solid("window_dark", [0.05, 0.06, 0.09], 0.2, 0.2);
    const pole = MeshBuilder.CreateCylinder("lamp_pole", { diameter: 0.12, height: 4.5, tessellation: 10 }, this.scene);
    pole.position.set(4.5, 2.25, -9.2);
    pole.material = m.solid("pole", [0.1, 0.1, 0.11], 0.5, 0.8);
    const head = MeshBuilder.CreateSphere("lamp_head", { diameter: 0.4, segments: 10 }, this.scene);
    head.position.set(4.5, 4.5, -9.2);
    head.material = m.solid("lamp_head", [1, 0.85, 0.6], 0.3, 0, [1, 0.8, 0.5]);
    pole.isPickable = head.isPickable = false;
    const street = new PointLight("street_light", new Vector3(4.5, 4.3, -9.2), this.scene);
    street.diffuse = new Color3(1, 0.75, 0.45);
    street.intensity = 1.2;
    street.range = 10;
    street.falloffType = Light.FALLOFF_STANDARD;
    // Delivery point by the door (Stage 4 deliveries arrive here).
    const crate = MeshBuilder.CreateBox("delivery_crate", { width: 0.5, height: 0.4, depth: 0.4 }, this.scene);
    crate.position.set(1.8, 0.2, -6.8);
    boxMapUVs(crate, m.tileFor("timber"));
    crate.material = m.forBox("timber");
    crate.isPickable = false;
  }

  registerCasters(meshes: Mesh[]): void {
    if (!this.shadows) return;
    for (const mesh of meshes) this.shadows.addShadowCaster(mesh, true);
  }

  update(state: RestaurantState, dt: number): void {
    GRILL_ZONES.forEach((_, i) => {
      const g = state.grill[i];
      if (!g) return;
      const knob = this.knobs[i]!;
      // 0 = off (pointing up), 1 = full (rotated 270°)
      knob.rotation.z = -g.knob * Math.PI * 1.5;
      const heat = Math.max(0, Math.min(1, (g.temp - 60) / 190));
      this.knobLamps[i]!.emissiveColor.set(g.knob > 0.02 ? 1 : 0.02, g.knob > 0.02 ? 0.45 : 0.02, 0.02);
      this.zoneGlow[i]!.emissiveColor.set(heat * 0.12, heat * 0.03, 0);
    });
    this.drawer.position.z = CHILLER_DRAWER.handle[2] - state.drawer * CHILLER_DRAWER.travel;
    this.lever.rotation.x = state.shiftSwitch ? -0.5 : 0.5;
    const open = state.phase === "open";
    this.openSign.emissiveColor.set(open ? 1.4 : 0.06, open ? 0.25 : 0.02, open ? 0.35 : 0.02);

    this.ticketTimer -= dt;
    const orders = [...state.orders.values()].filter((o) => o.status === "open").sort((a, b) => a.number - b.number);
    const key = orders.map((o) => `${o.number}:${o.modifiers.join("+")}`).join("|");
    if (key !== this.ticketKey || this.ticketTimer <= 0) {
      this.ticketKey = key;
      this.ticketTimer = 1;
      this.drawTickets(orders.map((o) => ({ number: o.number, recipe: o.recipe as RecipeId, modifiers: [...o.modifiers] as ModifierId[], wait: state.shiftTime - o.createdAt })));
    }
    const boardKey = `${state.name}|${state.balance}`;
    if (boardKey !== this.boardKey) {
      this.boardKey = boardKey;
      this.drawBoard(state.name);
    }
  }

  private drawTickets(orders: { number: number; recipe: RecipeId; modifiers: ModifierId[]; wait: number }[]): void {
    const ctx = this.ticketTex.getContext() as unknown as CanvasRenderingContext2D;
    const w = 1024;
    const h = 134;
    ctx.clearRect(0, 0, w, h);
    orders.slice(0, 6).forEach((o, i) => {
      const x = 8 + i * 168;
      ctx.fillStyle = "#fbf8ef";
      ctx.fillRect(x, 4, 160, h - 8);
      ctx.fillStyle = o.wait > 180 ? "#c0392b" : o.wait > 120 ? "#d68910" : "#2c2621";
      ctx.font = "bold 34px ui-monospace, monospace";
      ctx.fillText(`#${o.number}`, x + 8, 38);
      ctx.font = "18px ui-monospace, monospace";
      ctx.fillStyle = "#2c2621";
      ctx.fillText(RECIPES[o.recipe].label.replace("Cheeseburger", "Cheese").slice(0, 14), x + 8, 64);
      ctx.fillStyle = "#a93226";
      o.modifiers.forEach((mod, j) => ctx.fillText(MODIFIERS[mod].label.toUpperCase().slice(0, 14), x + 8, 88 + j * 20));
      ctx.fillStyle = "#6e6259";
      ctx.font = "16px ui-monospace, monospace";
      ctx.fillText(`${Math.floor(o.wait / 60)}:${String(Math.floor(o.wait % 60)).padStart(2, "0")}`, x + 106, 38);
    });
    this.ticketTex.update(true);
  }

  private drawBoard(name: string): void {
    const ctx = this.boardTex.getContext() as unknown as CanvasRenderingContext2D;
    const w = 1024;
    const h = 384;
    ctx.fillStyle = "#151312";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#f6d37a";
    ctx.font = "bold 54px Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillText(name || "After Hours Burger", w / 2, 70);
    ctx.textAlign = "left";
    ctx.font = "36px Georgia, serif";
    let y = 150;
    for (const r of Object.values(RECIPES)) {
      ctx.fillStyle = r.enabled ? "#f1ece2" : "#6f6760";
      ctx.fillText(r.label + (r.enabled ? "" : "  (soon)"), 60, y);
      ctx.textAlign = "right";
      ctx.fillText(formatCents(r.priceCents), w - 60, y);
      ctx.textAlign = "left";
      y += 64;
    }
    ctx.fillStyle = "#9a8f84";
    ctx.font = "26px Georgia, serif";
    ctx.fillText("Fries & soft drinks coming soon", 60, h - 30);
    this.boardTex.update(true);
  }
}
