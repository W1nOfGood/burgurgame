import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Light } from "@babylonjs/core/Lights/light";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { HDRFiltering } from "@babylonjs/core/Materials/Textures/Filtering/hdrFiltering";
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
  drinkById,
  formatCents,
  type ItemKind,
  type ModifierId,
  type RecipeId,
  type SurfaceKind,
} from "@ahb/data";
import type { RestaurantState } from "@ahb/protocol";
import type { GraphicsPreset } from "../settings.js";
import { MaterialLibrary } from "./materials.js";
import { foodTexture } from "./foodTextures.js";
import { buildProps } from "./props.js";
import { loadBakedEnvironment, type BakedEnvironment } from "./environment.js";
import { ART_BASE } from "./art.js";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Node } from "@babylonjs/core/node";

export type PickInfo =
  | { type: "surface"; kind: SurfaceKind }
  | { type: "item"; id: string }
  | { type: "knob"; zone: number }
  | { type: "drawer" }
  | { type: "dispenser"; id: string; kind: ItemKind }
  | { type: "switch" }
  | { type: "computer" }
  | { type: "register" }
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
  cheese: "CHEDDAR",
  swiss: "SWISS",
  lettuce: "LETTUCE",
  tomato: "TOMATO",
  onion: "ONION",
  pickle: "PICKLE",
  jalapeno: "JALAPEÑO",
  mushroom: "MUSHROOM",
  bacon: "BACON",
  egg: "EGGS",
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
  swiss: [0.95, 0.88, 0.6],
  jalapeno: [0.2, 0.5, 0.15],
  mushroom: [0.7, 0.58, 0.45],
  bacon: [0.8, 0.4, 0.38],
  egg: [0.95, 0.92, 0.85],
  veggie_patty: [0.55, 0.6, 0.35],
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

    // Key light. On baked (lightmapped) surfaces it only contributes shadows: Babylon's
    // LIGHTMAP_SHADOWSONLY mode adds `lightmap * shadow` there, so moving food and players still
    // shadow the baked counters. On dynamic objects it is an ordinary overhead light.
    const key = new DirectionalLight("key", new Vector3(0.18, -1, 0.32).normalize(), scene);
    key.position = new Vector3(-1.5, 6, -1);
    key.diffuse = new Color3(1, 0.93, 0.84);
    key.specular = new Color3(1, 0.93, 0.84);
    key.intensity = 1.25;
    key.lightmapMode = Light.LIGHTMAP_SHADOWSONLY;
    key.shadowMinZ = 0.5;
    key.shadowMaxZ = 12;
    this.key = key;
    // Warm heat-lamp light over the pass, for food sitting there (dynamic objects only).
    const pass = new PointLight("pass_light", new Vector3(-0.4, 1.55, 0), scene);
    pass.diffuse = new Color3(1, 0.55, 0.25);
    pass.intensity = 0.9;
    pass.range = 1.3;
    pass.falloffType = Light.FALLOFF_STANDARD;
    this.dynamicOnly.push(pass);
    if (budget.shadowMapSize > 0) {
      const sg = new ShadowGenerator(budget.shadowMapSize, key);
      sg.usePercentageCloserFiltering = true;
      sg.filteringQuality = budget.shadowMapSize >= 2048 ? ShadowGenerator.QUALITY_HIGH : ShadowGenerator.QUALITY_MEDIUM;
      sg.bias = 0.0015;
      sg.normalBias = 0.012;
      sg.setDarkness(0.35);
      this.shadows = sg;
    } else {
      this.shadows = null;
    }

    // Invisible pick/role proxies from the shared layout (collision lives on the server and in
    // the prediction world; these only answer "what did the player aim at").
    const groups = new Map<string, { meshes: Mesh[]; pick: PickInfo | null }>();
    for (const box of BOXES) {
      const pick: PickInfo | null = box.surface
        ? { type: "surface", kind: box.surface }
        : box.id === "trash"
          ? { type: "trash" }
          : box.id === "office_screen"
            ? { type: "computer" }
            : box.id === "register"
              ? { type: "register" }
              : box.collide
              ? { type: "static" }
              : null;
      if (!pick) continue;
      const mesh = MeshBuilder.CreateBox(`proxy_${box.id}`, { width: box.half[0] * 2, height: box.half[1] * 2, depth: box.half[2] * 2 }, scene);
      mesh.position.set(box.center[0], box.center[1], box.center[2]);
      mesh.bakeCurrentTransformIntoVertices();
      const k = JSON.stringify(pick);
      const g = groups.get(k) ?? { meshes: [], pick };
      g.meshes.push(mesh);
      groups.set(k, g);
    }
    // Never drawn, but Babylon only ray-tests triangles of meshes that have a material: without
    // one it falls back to a bounding-box hit with no picked point, and surfaces stop being targets.
    const pickOnly = m.solid("pick_only", [0, 0, 0], 1);
    for (const [k, g] of groups) {
      const merged = mergeGroup(`proxy_${k}`, g.meshes, g.pick);
      if (merged) {
        merged.material = pickOnly;
        merged.isVisible = false;
        merged.metadata = { ...(merged.metadata ?? {}), placeholder: false, proxy: true };
      }
    }

    this.buildGrill(m);
    this.drawer = this.buildDrawer(m);
    this.buildBins(m);
    this.lever = this.buildSwitch(m);
    this.openSign = this.buildOpenSign(m);
    this.ticketTex = this.buildTicketRail(m);
    this.boardTex = this.buildMenuBoard(m);
    this.preset = preset;
  }

  private readonly key: DirectionalLight;
  private readonly dynamicOnly: Light[] = [];
  private readonly preset: GraphicsPreset;
  /** Set once the Blender-authored environment is in the scene. */
  baked: BakedEnvironment | null = null;
  /** Procedural stand-ins hidden (but still pickable) once authored props arrive. */
  private readonly standIns: Mesh[] = [];
  private readonly knobVisuals: TransformNode[] = [];
  private leverVisual: TransformNode | null = null;
  private neon: PBRMaterial[] = [];
  private neonLevels: number[] = [];

  /** Swaps procedural stand-ins for the Blender-authored props (knobs, drawer, pans, sign). */
  private async loadProps(): Promise<void> {
    const scene = this.scene;
    const container = await LoadAssetContainerAsync("props.gltf", scene, { rootUrl: ART_BASE });
    container.addAllToScene();
    const gltfRoot = container.meshes.find((mm) => mm.name === "__root__");
    if (!gltfRoot) throw new Error("props.gltf: no root");
    const nodes = new Map<string, Node>();
    for (const n of gltfRoot.getChildren()) nodes.set(n.name, n);
    // Each authored group keeps its glTF-space transforms under a handedness converter.
    const mount = (node: Node, holder: TransformNode): void => {
      const conv = new TransformNode(`${node.name}_conv`, scene);
      conv.rotation.y = Math.PI;
      conv.scaling.z = -1;
      conv.parent = holder;
      node.parent = conv;
      const meshes = (node as TransformNode).getChildMeshes(false) as AbstractMesh[];
      if (node instanceof Mesh) meshes.push(node);
      for (const mm of meshes) {
        mm.isPickable = false;
        mm.receiveShadows = this.preset !== "low";
        this.shadows?.addShadowCaster(mm, false);
      }
    };
    const holder = (name: string, x: number, y: number, z: number, ry = 0): TransformNode => {
      const h = new TransformNode(name, scene);
      h.position.set(x, y, z);
      h.rotation.y = ry;
      return h;
    };
    // Grill knobs. The knob has two materials, so the loader may hand back a TransformNode with
    // one child mesh per primitive rather than a single Mesh; clone() copies either form.
    const knob = nodes.get("knob");
    if (knob instanceof TransformNode) {
      GRILL_ZONES.forEach((zone, i) => {
        const h = holder(`knob_vis_${i}`, zone.knob[0], zone.knob[1], 4.157);
        mount(i === 0 ? knob : knob.clone(`knob_authored_${i}`, null)!, h);
        this.knobVisuals.push(h);
      });
    }
    // Drawer: rides on the existing animated drawer node.
    const drawer = nodes.get("drawer");
    if (drawer) mount(drawer, this.drawer);
    // Ingredient pans at each dispenser (lip level with the rail).
    for (const d of DISPENSERS) {
      const n = nodes.get(`bin_${d.id}`) ?? nodes.get(d.id);
      if (!n || d.requiresDrawer !== undefined || d.kind === "tray") continue;
      const lip = d.center[2] > 3 ? 0.972 : 0.952;
      mount(n, holder(`pan_${d.id}`, d.center[0], lip, d.center[2]));
    }
    const trays = nodes.get("tray_stack");
    const td = DISPENSERS.find((d) => d.kind === "tray");
    if (trays && td) mount(trays, holder("tray_stack_vis", td.center[0], td.center[1], td.center[2]));
    // Wall toggle on the kitchen face of the counter, facing the kitchen.
    const plate = nodes.get("switch_plate");
    const lever = nodes.get("switch_lever");
    if (plate && lever) {
      const h = holder("switch_vis", SHIFT_SWITCH[0], SHIFT_SWITCH[1], 0.352, Math.PI);
      mount(plate, h);
      const pivot = new TransformNode("switch_lever_pivot", scene);
      pivot.parent = h;
      pivot.position.set(0, 0, -0.012);
      mount(lever, pivot);
      this.leverVisual = pivot;
    }
    // Neon OPEN sign in the left window.
    const sign = nodes.get("open_sign");
    if (sign) {
      mount(sign, holder("open_sign_vis", -3.6, 1.9, -6.0));
      for (const mm of (sign as TransformNode).getChildMeshes(false)) {
        const mat = mm.material as PBRMaterial | null;
        if (mat && mat.name.startsWith("emit_neon_open") && !this.neon.includes(mat)) {
          this.neon.push(mat);
          this.neonLevels.push(mat.emissiveIntensity);
        }
      }
    }
    for (const mm of this.standIns) mm.isVisible = false;
    gltfRoot.dispose(true, false);
  }

  /**
   * Loads the baked environment (glTF + lightmaps + probes). Falls back to the procedural
   * restaurant if anything is missing, so the game stays playable.
   */
  async load(): Promise<"baked" | "fallback"> {
    try {
      const env = await loadBakedEnvironment(this.scene, this.preset);
      this.baked = env;
      for (const l of this.dynamicOnly) l.excludedMeshes.push(...env.staticMeshes);
      if (this.preset === "medium" || this.preset === "high") {
        const glow = new GlowLayer("glow", this.scene, { mainTextureRatio: 0.25, blurKernelSize: 32 });
        glow.intensity = 0.45;
        for (const mesh of [...env.glowMeshes, ...this.glowMeshes]) glow.addIncludedOnlyMesh(mesh as Mesh);
      }
      this.scene.environmentIntensity = 1.0;
      this.materials.restoreMetalness();
      await this.loadProps().catch((err) => console.warn("Authored props unavailable; keeping stand-ins", err));
      return "baked";
    } catch (err) {
      console.warn("Baked environment unavailable; using the procedural restaurant", err);
      this.buildFallback();
      await this.enableReflections(this.preset);
      return "fallback";
    }
  }

  /** The original procedural restaurant (boxes merged per material, practical lights, props). */
  private buildFallback(): void {
    const scene = this.scene;
    const m = this.materials;
    this.key.lightmapMode = Light.LIGHTMAP_DEFAULT;
    const hemi = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.45;
    hemi.diffuse = new Color3(1, 0.88, 0.74);
    hemi.groundColor = new Color3(0.2, 0.14, 0.1);
    const warm = new Color3(1, 0.82, 0.62);
    for (const [name, pos, color, intensity] of [
      ["kitchen_light", new Vector3(-1.5, 2.9, 2.6), warm, 1.1],
      ["dining_light", new Vector3(0, 2.9, -3.2), new Color3(1, 0.7, 0.45), 0.9],
    ] as const) {
      const l = new PointLight(name, pos, scene);
      l.diffuse = color;
      l.intensity = intensity;
      l.range = 9;
      l.falloffType = Light.FALLOFF_STANDARD;
    }
    const groups = new Map<string, { meshes: Mesh[]; pick: PickInfo | null }>();
    for (const box of BOXES) {
      const mesh = MeshBuilder.CreateBox(box.id, { width: box.half[0] * 2, height: box.half[1] * 2, depth: box.half[2] * 2 }, scene);
      mesh.position.set(box.center[0], box.center[1], box.center[2]);
      boxMapUVs(mesh, m.tileFor(box.material));
      mesh.material = m.forBox(box.material);
      const key = box.material;
      const g = groups.get(key) ?? { meshes: [], pick: null };
      g.meshes.push(mesh);
      groups.set(key, g);
    }
    for (const [key, g] of groups) mergeGroup(`layout_${key}`, g.meshes, null);
    this.buildDecor(m);
    this.buildExterior(m);
    const props = buildProps(scene, m);
    if (this.preset === "medium" || this.preset === "high") {
      const glow = new GlowLayer("glow", scene, { mainTextureRatio: 0.25, blurKernelSize: 32 });
      glow.intensity = 0.55;
      for (const mesh of [...props.glowing, ...this.glowMeshes]) glow.addIncludedOnlyMesh(mesh);
    }
  }

  private readonly glowMeshes: Mesh[] = [];

  /**
   * Captures the restaurant once into a cube map and prefilters it so metals and glossy food get
   * believable reflections. Falls back silently (capped metalness stays) if unsupported.
   */
  async enableReflections(preset: GraphicsPreset): Promise<boolean> {
    if (preset === "low" || preset === "tablet") return false;
    try {
      const probe = new ReflectionProbe("env_probe", preset === "high" ? 256 : 128, this.scene, true, true);
      probe.position.set(-0.6, 1.5, 2.6);
      for (const mesh of this.scene.meshes) {
        if (mesh.isPickable === false && (mesh.name.startsWith("it_") || mesh.name.startsWith("fp_"))) continue;
        if (mesh.name.startsWith("avatar_") || mesh.name.startsWith("it_") || mesh.name.startsWith("fp_")) continue;
        probe.renderList!.push(mesh);
      }
      probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      const cube = probe.cubeTexture;
      await new Promise<void>((resolve) => cube.onAfterRenderObservable.addOnce(() => resolve()));
      const filtering = new HDRFiltering(this.scene.getEngine(), { hdrScale: 1 });
      await filtering.prefilter(cube);
      this.scene.environmentTexture = cube;
      this.scene.environmentIntensity = 0.75;
      this.materials.restoreMetalness();
      return true;
    } catch (err) {
      console.warn("Reflections unavailable; keeping capped metalness", err);
      return false;
    }
  }

  private buildGrill(m: MaterialLibrary): void {
    const knobMat = m.solid("knob", [0.08, 0.08, 0.08], 0.4, 0.2);
    const markMat = m.solid("knob_mark", [0.95, 0.95, 0.95], 0.5);
    // Heat shimmer overlay on each zone: additive and invisible when cold (the plate itself is
    // part of the baked griddle).
    const plate = m.solid("grill_zone", [0, 0, 0], 0.45, 0);
    plate.alpha = 0.999;
    plate.alphaMode = 1; // ALPHA_ADD
    plate.disableLighting = true;
    GRILL_ZONES.forEach((zone, i) => {
      const w = zone.rect.maxX - zone.rect.minX - 0.02;
      const d = zone.rect.maxZ - zone.rect.minZ - 0.02;
      const top = MeshBuilder.CreateBox(`zone_${i}`, { width: w, height: 0.006, depth: d }, this.scene);
      top.position.set((zone.rect.minX + zone.rect.maxX) / 2, zone.y + 0.003, (zone.rect.minZ + zone.rect.maxZ) / 2);
      const glow = plate.clone(`zone_mat_${i}`) as PBRMaterial;
      top.material = glow;
      this.zoneGlow.push(glow);
      setPick(top, { type: "surface", kind: "grill" });

      const knob = MeshBuilder.CreateCylinder(`knob_${i}`, { diameter: 0.07, height: 0.04, tessellation: 20 }, this.scene);
      knob.rotation.x = Math.PI / 2;
      knob.position.set(zone.knob[0], zone.knob[1], zone.knob[2] - 0.0);
      knob.material = knobMat;
      this.standIns.push(knob);
      const mark = MeshBuilder.CreateBox(`knob_mark_${i}`, { width: 0.008, height: 0.012, depth: 0.03 }, this.scene);
      mark.parent = knob;
      mark.position.set(0, -0.021, 0.02);
      mark.material = markMat;
      mark.isPickable = false;
      this.standIns.push(mark);
      setPick(knob, { type: "knob", zone: i });
      this.knobs.push(knob);

      // Pilot lamp sits in the bezel modelled on the griddle's control panel.
      const lamp = MeshBuilder.CreateSphere(`knob_lamp_${i}`, { diameter: 0.016, segments: 10 }, this.scene);
      lamp.scaling.z = 0.5;
      lamp.position.set(zone.knob[0] + 0.1, 0.81, 4.158);
      const lampMat = m.solid(`lamp_${i}`, [0.1, 0.1, 0.1], 0.3, 0, [0, 0, 0]);
      lamp.material = lampMat;
      lamp.isPickable = false;
      this.knobLamps.push(lampMat);
    });
  }

  private buildDrawer(m: MaterialLibrary): TransformNode {
    const root = new TransformNode("drawer", this.scene);
    const [hx, hy, hz] = CHILLER_DRAWER.half;
    const front = MeshBuilder.CreateBox("drawer_front", { width: hx * 2, height: hy * 2 + 0.06, depth: 0.03 }, this.scene);
    front.parent = root;
    front.material = m.forBox("stainless");
    setPick(front, { type: "drawer" });
    const handle = MeshBuilder.CreateCylinder("drawer_handle", { diameter: 0.02, height: hx * 1.4, tessellation: 10 }, this.scene);
    handle.parent = root;
    handle.rotation.z = Math.PI / 2;
    handle.position.set(0, 0.04, -0.03);
    handle.material = m.solid("handle", [0.7, 0.7, 0.72], 0.25, 1);
    setPick(handle, { type: "drawer" });
    // Tub sits low so the patties on top are visible across the whole open drawer.
    const tub = MeshBuilder.CreateBox("drawer_tub", { width: hx * 2 - 0.04, height: 0.2, depth: hz * 2 }, this.scene);
    tub.parent = root;
    tub.position.set(0, -0.06, hz + 0.015);
    tub.material = m.solid("tub", [0.75, 0.76, 0.78], 0.3, 0.35);
    tub.isPickable = false;
    // Two compartments: beef on the left, veggie on the right (matching the dispensers).
    for (const d of DISPENSERS.filter((x) => x.requiresDrawer !== undefined)) {
      const pile = MeshBuilder.CreateBox(`drawer_${d.kind}`, { width: d.half[0] * 2 - 0.04, height: 0.03, depth: hz * 2 - 0.06 }, this.scene);
      pile.parent = root;
      pile.position.set(d.center[0] - CHILLER_DRAWER.handle[0], 0.055, hz + 0.015);
      const mat = m.solid(`pile_${d.kind}`, d.kind === "patty" ? [0.92, 0.5, 0.52] : [0.7, 0.74, 0.48], 0.55);
      if (!mat.albedoTexture) mat.albedoTexture = foodTexture(this.scene, d.kind === "patty" ? "meat" : "veggie", 128, 3);
      pile.material = mat;
      setPick(pile, { type: "dispenser", id: d.id, kind: d.kind });
    }
    root.position.set(CHILLER_DRAWER.handle[0], CHILLER_DRAWER.handle[1], CHILLER_DRAWER.handle[2]);
    this.standIns.push(...(root.getChildMeshes() as Mesh[]));
    return root;
  }

  private buildBins(m: MaterialLibrary): void {
    const rims: Mesh[] = [];
    const binDefs = DISPENSERS.filter((d) => d.requiresDrawer === undefined && d.kind !== "tray");
    for (const d of DISPENSERS) {
      if (d.requiresDrawer !== undefined) continue;
      if (d.kind === "tray") {
        const stack: Mesh[] = [];
        for (let i = 0; i < 6; i++) {
          const t = MeshBuilder.CreateBox(`tray_stack_${i}`, { width: 0.4, height: 0.012, depth: 0.3 }, this.scene);
          t.position.set(d.center[0] + (i % 2) * 0.004, d.center[1] - 0.03 + i * 0.013, d.center[2]);
          t.rotation.y = (i % 3) * 0.01;
          stack.push(t);
        }
        const merged = mergeGroup("tray_stack", stack, { type: "dispenser", id: d.id, kind: "tray" })!;
        merged.material = m.solid("tray_red", [0.66, 0.07, 0.05], 0.38);
        this.standIns.push(merged);
        continue;
      }
      // Ingredient bins: a textured fill of the actual ingredient inside a hollow steel rim.
      const bin = MeshBuilder.CreateBox(`bin_${d.id}`, { width: d.half[0] * 2 - 0.02, height: 0.012, depth: d.half[2] * 2 - 0.02 }, this.scene);
      bin.position.set(d.center[0], d.center[1] + 0.012, d.center[2]);
      bin.material = this.binMaterial(m, d.kind);
      bin.receiveShadows = true;
      setPick(bin, { type: "dispenser", id: d.id, kind: d.kind });
      this.standIns.push(bin);
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
    this.standIns.push(...(rimMerged ? [rimMerged] : []));
    // One label strip per bin row (one texture, one draw call each).
    const rows = new Map<number, typeof binDefs>();
    for (const d of binDefs) rows.set(d.center[2], [...(rows.get(d.center[2]) ?? []), d]);
    for (const [z, row] of rows) {
      const minX = Math.min(...row.map((d) => d.center[0] - d.half[0]));
      const maxX = Math.max(...row.map((d) => d.center[0] + d.half[0]));
      const front = z - row[0]!.half[2] - 0.004;
      const strip = MeshBuilder.CreatePlane(`bin_labels_${z}`, { width: maxX - minX, height: 0.04 }, this.scene);
      strip.position.set((minX + maxX) / 2, row[0]!.center[1] + 0.05, front);
      const labelMaterial = (suffix: string, mirrored: boolean) => {
        const tex = m.signTexture(`bin_labels_tex_${z}${suffix}`, 1024, 40, (ctx, w, h) => {
          ctx.fillStyle = "#f4efe2";
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = "#2b2420";
          ctx.font = `bold ${z > 4 ? 22 : 18}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          for (const d of row) {
            const t = (d.center[0] - minX) / (maxX - minX);
            ctx.fillText(BIN_LABELS[d.kind] ?? ITEMS[d.kind].label.toUpperCase(), (mirrored ? 1 - t : t) * w, h / 2 + 1);
          }
        });
        const lm = new PBRMaterial(`bin_labels_mat_${z}${suffix}`, this.scene);
        lm.albedoTexture = tex;
        lm.emissiveTexture = tex;
        lm.emissiveColor = new Color3(0.3, 0.3, 0.3);
        lm.roughness = 0.8;
        lm.metallic = 0;
        return lm;
      };
      strip.material = labelMaterial("", false);
      strip.isPickable = false;
      if (z < 4) {
        // The cold rail is worked from both sides of the island: label the back edge too.
        const back = strip.clone(`bin_labels_back_${z}`);
        back.position.z = z + row[0]!.half[2] + 0.004;
        back.rotation.y = Math.PI;
        back.material = labelMaterial("_back", true);
      }
    }
    // Trash opening marker.
    const opening = MeshBuilder.CreateCylinder("trash_opening", { diameter: 0.36, height: 0.01, tessellation: 24 }, this.scene);
    opening.position.set((TRASH_ZONE.minX + TRASH_ZONE.maxX) / 2, 0.805, (TRASH_ZONE.minZ + TRASH_ZONE.maxZ) / 2);
    opening.material = this.materials.solid("trash_hole", [0.02, 0.02, 0.02], 0.9);
    opening.isVisible = false;
    setPick(opening, { type: "trash" });
  }

  private binMaterial(m: MaterialLibrary, kind: ItemKind): PBRMaterial {
    const mat = m.solid(`bin_${kind}`, FOOD_BIN_COLORS[kind] ?? [0.5, 0.5, 0.5], kind === "cheese" || kind === "swiss" ? 0.5 : 0.6);
    const tex: Partial<Record<ItemKind, [string, number]>> = {
      lettuce: ["lettuce", 3],
      tomato: ["tomato", 4],
      pickle: ["pickle", 4],
      jalapeno: ["jalapeno", 5],
      bacon: ["bacon", 2],
      swiss: ["swiss", 2],
      bun_bottom: ["crumb", 2],
      bun_top: ["crust", 2],
    };
    const t = tex[kind];
    if (t && !mat.albedoTexture) {
      mat.albedoTexture = foodTexture(this.scene, t[0], 128, t[1]);
      mat.albedoColor = new Color3(1, 1, 1);
      if (kind === "bun_bottom" || kind === "bun_top") mat.albedoColor = new Color3(0.85, 0.6, 0.32);
    }
    return mat;
  }

  private buildSwitch(m: MaterialLibrary): Mesh {
    const plate = MeshBuilder.CreateBox("switch_plate", { width: 0.12, height: 0.16, depth: 0.02 }, this.scene);
    plate.position.set(SHIFT_SWITCH[0], SHIFT_SWITCH[1], SHIFT_SWITCH[2] - 0.01);
    plate.material = m.solid("switch_plate", [0.9, 0.88, 0.84], 0.4);
    setPick(plate, { type: "switch" });
    this.standIns.push(plate);
    const lever = MeshBuilder.CreateBox("switch_lever", { width: 0.03, height: 0.07, depth: 0.03 }, this.scene);
    lever.parent = plate;
    lever.position.set(0, 0, 0.02);
    lever.material = m.solid("switch_lever", [0.12, 0.12, 0.12], 0.4);
    setPick(lever, { type: "switch" });
    this.standIns.push(lever);
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
    this.standIns.push(label);
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
    this.glowMeshes.push(sign);
    this.standIns.push(sign);
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
    const board = MeshBuilder.CreatePlane("menu_board", { width: 2.6, height: 1.1 }, this.scene);
    board.position.set(-3.2, 2.3, 0.418);
    board.rotation.y = Math.PI;
    const tex = m.signTexture("menu_tex", 1024, 434, (ctx, w, h) => ctx.clearRect(0, 0, w, h));
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
    back.position.z = 0.302;
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
    if (bulbMesh) {
      bulbMesh.material = m.solid("bulb", [1, 0.9, 0.7], 0.2, 0, [1, 0.78, 0.5]);
      this.glowMeshes.push(bulbMesh);
    }
    // Heat-lamp glow over the pickup shelf.
    const lamp = MeshBuilder.CreateBox("heat_lamp_glow", { width: 2.0, height: 0.01, depth: 0.3 }, this.scene);
    lamp.position.set(-0.4, 1.645, 0);
    lamp.material = m.solid("heat_glow", [1, 0.5, 0.2], 0.5, 0, [0.9, 0.35, 0.1]);
    lamp.isPickable = false;
    this.glowMeshes.push(lamp);
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

  private doorLeaves: TransformNode[] | null = null;
  private doorLookupAt = 0;

  /**
   * Swings the storefront's double door (0 shut .. 1 open). The leaves are separate nodes of
   * the authored restaurant, pivoted on their hinges at x = ±0.95; both open out to the street.
   */
  setFrontDoor(open: number): void {
    if (!this.doorLeaves) {
      const now = performance.now();
      if (now < this.doorLookupAt) return;
      this.doorLookupAt = now + 1000;
      const leaves = ["door_leaf_0", "door_leaf_1"].map((n) => this.scene.getNodeByName(n));
      if (!leaves.every((n) => n instanceof TransformNode)) return;
      this.doorLeaves = leaves as TransformNode[];
      for (const leaf of this.doorLeaves) {
        leaf.rotationQuaternion = null;
        leaf.metadata = { ...(leaf.metadata ?? {}), restYaw: leaf.rotation.y };
      }
    }
    const ease = open * open * (3 - 2 * open);
    const swing = ease * 1.35;
    // Measured in the game: these signs swing the free edges toward −z, the street.
    this.doorLeaves[0]!.rotation.y = this.doorLeaves[0]!.metadata.restYaw - swing;
    this.doorLeaves[1]!.rotation.y = this.doorLeaves[1]!.metadata.restYaw + swing;
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
      const kv = this.knobVisuals[i];
      if (kv) kv.rotation.z = g.knob * Math.PI * 1.5;
      const heat = Math.max(0, Math.min(1, (g.temp - 60) / 190));
      this.knobLamps[i]!.emissiveColor.set(g.knob > 0.02 ? 1 : 0.02, g.knob > 0.02 ? 0.45 : 0.02, 0.02);
      // Barely-there warmth on a hot plate; heat is read from sound, lamps and smoke, not glow.
      this.zoneGlow[i]!.emissiveColor.set(heat * 0.05, heat * 0.012, 0.002 * heat);
    });
    this.drawer.position.z = CHILLER_DRAWER.handle[2] - state.drawer * CHILLER_DRAWER.travel;
    this.lever.rotation.x = state.shiftSwitch ? -0.5 : 0.5;
    if (this.leverVisual) this.leverVisual.rotation.x = state.shiftSwitch ? 0.45 : -0.45;
    const open = state.phase === "open";
    this.openSign.emissiveColor.set(open ? 1.4 : 0.06, open ? 0.25 : 0.02, open ? 0.35 : 0.02);
    this.neon.forEach((mat, i) => {
      mat.emissiveIntensity = (this.neonLevels[i] ?? 1) * (open ? 1 : 0.03);
    });

    this.ticketTimer -= dt;
    const orders = [...state.orders.values()].filter((o) => o.status === "open").sort((a, b) => a.number - b.number);
    const key = orders.map((o) => `${o.number}:${o.modifiers.join("+")}:${o.side}:${o.drink}`).join("|");
    if (key !== this.ticketKey || this.ticketTimer <= 0) {
      this.ticketKey = key;
      this.ticketTimer = 1;
      this.drawTickets(
        orders.map((o) => ({
          number: o.number,
          customer: o.customer,
          recipe: o.recipe as RecipeId,
          modifiers: [...o.modifiers] as ModifierId[],
          extras: [...(o.side ? ["fries"] : []), ...(o.drink ? [drinkById(o.drink)?.label ?? o.drink] : [])],
          wait: state.shiftTime - o.createdAt,
        })),
      );
    }
    const boardKey = `${state.name}|${state.balance}`;
    if (boardKey !== this.boardKey) {
      this.boardKey = boardKey;
      this.drawBoard(state.name);
    }
  }

  private drawTickets(orders: { number: number; customer: string; recipe: RecipeId; modifiers: ModifierId[]; extras: string[]; wait: number }[]): void {
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
      ctx.fillText(`#${o.number}`, x + 8, 36);
      if (o.customer) {
        ctx.font = "italic 15px ui-monospace, monospace";
        ctx.fillStyle = "#6e6259";
        ctx.fillText(o.customer.slice(0, 16), x + 8, 56);
      }
      ctx.font = "18px ui-monospace, monospace";
      ctx.fillStyle = "#2c2621";
      ctx.fillText(RECIPES[o.recipe].label.replace("Cheeseburger", "Cheese").slice(0, 14), x + 8, 79);
      ctx.fillStyle = "#a93226";
      o.modifiers.forEach((mod, j) => ctx.fillText(MODIFIERS[mod].label.toUpperCase().slice(0, 14), x + 8, 101 + j * 20));
      ctx.fillStyle = "#1f5f8b";
      o.extras.forEach((ex, j) => ctx.fillText(`+ ${ex.toUpperCase()}`.slice(0, 14), x + 8, 101 + (o.modifiers.length + j) * 20));
      ctx.fillStyle = "#6e6259";
      ctx.font = "16px ui-monospace, monospace";
      ctx.fillText(`${Math.floor(o.wait / 60)}:${String(Math.floor(o.wait % 60)).padStart(2, "0")}`, x + 106, 38);
    });
    this.ticketTex.update(true);
  }

  private drawBoard(name: string): void {
    const ctx = this.boardTex.getContext() as unknown as CanvasRenderingContext2D;
    const w = 1024;
    const h = 434;
    ctx.fillStyle = "#151312";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#5a4630";
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.fillStyle = "#f6d37a";
    ctx.font = "bold 46px Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillText(name || "After Hours Burger", w / 2, 58);
    const recipes = Object.values(RECIPES).filter((r) => r.enabled && !r.tutorialOnly);
    const perCol = Math.ceil(recipes.length / 2);
    ctx.font = "25px Georgia, serif";
    recipes.forEach((r, i) => {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      const x0 = 40 + col * (w / 2);
      const y = 106 + row * 40;
      ctx.textAlign = "left";
      ctx.fillStyle = r.tier === 1 ? "#f1ece2" : r.tier === 2 ? "#e8d9bd" : "#d9c3a0";
      ctx.fillText(r.label, x0, y);
      ctx.textAlign = "right";
      ctx.fillStyle = "#f6d37a";
      ctx.fillText(formatCents(r.priceCents), x0 + w / 2 - 80, y);
    });
    ctx.textAlign = "center";
    ctx.fillStyle = "#9a8f84";
    ctx.font = "20px Georgia, serif";
    ctx.fillText("Ask your cook about today's modifiers", w / 2, h - 20);
    this.boardTex.update(true);
  }

}
