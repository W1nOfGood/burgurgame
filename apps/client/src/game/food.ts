import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { Material } from "@babylonjs/core/Materials/material";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import type { ItemKind } from "@ahb/data";
import { ART_BASE } from "./art.js";

/**
 * Blender-authored food, tools and service items (assets/source/blender/food.py) and the
 * cooking-state shader that makes their appearance a pure function of replicated values.
 *
 * Each cookable material gets a {@link CookPlugin}: it blends the raw albedo towards a cooked
 * texture through a per-pixel 'progress' mask (browning starts on high points and edges and
 * spreads), picks top/bottom/side doneness by comparing the surface normal with the item's own
 * up axis (so a patty flip shows the seared side), and darkens towards char with burn.
 */

const BASE = `${ART_BASE}food/`;

/** Which cooked texture each food material blends towards, and its mode. */
const COOKED: Record<string, { cooked: string; map?: string; mode: number }> = {
  food_patty: { cooked: "beef_seared.webp", map: "beef_cook.webp", mode: 1 },
  food_veggie_patty: { cooked: "veggie_seared.webp", map: "veggie_cook.webp", mode: 1 },
  food_bun_crumb: { cooked: "bun_toasted.webp", map: "bun_crumb_cook.webp", mode: 2 },
  food_bacon: { cooked: "bacon_crisp.webp", map: "bacon_cook.webp", mode: 2 },
  food_mushroom: { cooked: "mushroom_seared.webp", mode: 2 },
  food_egg_white: { cooked: "egg_white_set.webp", mode: 3 },
};

export interface CookUniforms {
  /** Browning of the mesh's local top (+Y) and bottom (-Y) faces, 0..1.5. */
  top: number;
  bottom: number;
  /** Side/edge doneness (patty interior shows here), 0..1. */
  side: number;
  burn: number;
  dirty: number;
  /** Bun toast, cheese melt or generic cook amount for single-state foods. */
  amount: number;
}

class CookPlugin extends MaterialPluginBase {
  readonly state: CookUniforms = { top: 0, bottom: 0, side: 0, burn: 0, dirty: 0, amount: 0 };
  private readonly cooked: Texture | null;
  private readonly map: Texture | null;
  private readonly mode: number;
  private readonly up = new Vector3(0, 1, 0);

  constructor(material: Material, mode: number, cooked: Texture | null, map: Texture | null) {
    super(material, "AhbCook", 210, { AHBCOOK: false, AHBCOOKMAP: false, AHBCOOKMODE: 0 }, true, true);
    this.mode = mode;
    this.cooked = cooked;
    this.map = map;
  }

  override isCompatible(language: ShaderLanguage): boolean {
    return language === ShaderLanguage.GLSL;
  }

  override getClassName(): string {
    return "CookPlugin";
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["AHBCOOK"] = !!this.cooked;
    defines["AHBCOOKMAP"] = !!this.map;
    defines["AHBCOOKMODE"] = this.mode;
  }

  override isReadyForSubMesh(): boolean {
    return (!this.cooked || this.cooked.isReady()) && (!this.map || this.map.isReady());
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("ahbCookedSampler", "ahbCookMapSampler");
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [
        { name: "ahbCook", size: 4, type: "vec4" },
        { name: "ahbMisc", size: 4, type: "vec4" },
        { name: "ahbUp", size: 3, type: "vec3" },
      ],
      fragment: `
uniform vec4 ahbCook;
uniform vec4 ahbMisc;
uniform vec3 ahbUp;
`,
    };
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: unknown, subMesh: SubMesh): void {
    const s = this.state;
    const m = subMesh.getMesh().getWorldMatrix();
    Vector3.TransformNormalToRef(Vector3.UpReadOnly, m, this.up);
    this.up.normalize();
    ubo.updateFloat4("ahbCook", s.top, s.bottom, s.side, s.burn);
    ubo.updateFloat4("ahbMisc", s.dirty, s.amount, 0, 0);
    ubo.updateFloat3("ahbUp", this.up.x, this.up.y, this.up.z);
    if (this.cooked) ubo.setTexture("ahbCookedSampler", this.cooked);
    if (this.map) ubo.setTexture("ahbCookMapSampler", this.map);
  }

  override getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef AHBCOOK
uniform sampler2D ahbCookedSampler;
#endif
#ifdef AHBCOOKMAP
uniform sampler2D ahbCookMapSampler;
#endif
float ahbProgress(vec2 uv) {
#ifdef AHBCOOKMAP
  return texture2D(ahbCookMapSampler, uv).r;
#else
  return 0.5;
#endif
}
float ahbLevel(vec3 nW) {
#if AHBCOOKMODE == 1
  float d = dot(normalize(nW), normalize(ahbUp));
  float top = smoothstep(0.25, 0.75, d);
  float bottom = smoothstep(-0.25, -0.75, d);
  return mix(mix(ahbCook.z, ahbCook.x, top), ahbCook.y, bottom);
#else
  return ahbMisc.y;
#endif
}
float ahbAmount(vec2 uv, vec3 nW) {
  float c = ahbLevel(nW);
  float p = ahbProgress(uv);
  return smoothstep(p - 0.3, p + 0.05, c * 1.2);
}
`,
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
#if defined(AHBCOOK) && defined(MAINUV1)
{
  float k = ahbAmount(vMainUV1, vNormalW);
  vec3 cookedTex = toLinearSpace(texture2D(ahbCookedSampler, vMainUV1).rgb);
#if AHBCOOKMODE == 3
  surfaceAlbedo = mix(surfaceAlbedo * 0.8, cookedTex, k);
#else
  surfaceAlbedo = mix(surfaceAlbedo, cookedTex, k);
#endif
  float over = clamp(ahbLevel(vNormalW) - 1.0, 0.0, 1.0);
  float burnMask = smoothstep(ahbProgress(vMainUV1) + 0.2, ahbProgress(vMainUV1) - 0.3, ahbCook.w + over * 0.6);
  surfaceAlbedo = mix(surfaceAlbedo, vec3(0.012, 0.009, 0.007), clamp((1.0 - burnMask) * 0.95, 0.0, 0.95));
}
#endif
#ifdef AHBCOOK
surfaceAlbedo = mix(surfaceAlbedo, surfaceAlbedo * vec3(0.55, 0.5, 0.45), ahbMisc.x);
#endif
`,
      CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: `
#if defined(AHBCOOKMAP) && defined(MAINUV1)
{
  vec3 cm = texture2D(ahbCookMapSampler, vMainUV1).rgb;
  float k = ahbAmount(vMainUV1, vNormalW);
  metallicRoughness.g = mix(cm.g, cm.b, k);
}
#endif
`,
    };
  }
}

export interface FoodVisual {
  root: Mesh;
  meshes: Mesh[];
  cook: CookUniforms | null;
  /** Materials cloned for this item (dispose them with the item; textures are shared). */
  materials: Material[];
  /** Cheese only: base vertex positions for melt deformation. */
  meltBase: Float32Array | null;
}

let registered = false;

/** Loaded food templates; {@link create} clones one item with its own state materials. */
export class FoodLibrary {
  private readonly templates = new Map<string, Mesh>();
  private readonly cookedTextures = new Map<string, { cooked: Texture; map: Texture | null; mode: number }>();
  private readonly scene: Scene;

  private constructor(scene: Scene) {
    this.scene = scene;
  }

  static async load(scene: Scene): Promise<FoodLibrary> {
    if (!registered) {
      registerBuiltInLoaders();
      registered = true;
    }
    const lib = new FoodLibrary(scene);
    const container: AssetContainer = await LoadAssetContainerAsync("food.gltf", scene, { rootUrl: ART_BASE });
    container.addAllToScene();
    const root = container.meshes.find((m) => m.name === "__root__");
    // Bake the glTF handedness conversion into each item's vertices so clones can be posed
    // directly by gameplay code.
    for (const node of root?.getChildren() ?? []) {
      const parts = [node, ...node.getChildMeshes(false)].filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
      if (parts.length === 0) continue;
      const merged = parts.length === 1 ? parts[0]! : null;
      const kind = node.name;
      let template: Mesh;
      if (merged) {
        template = merged;
        const world = template.computeWorldMatrix(true).clone();
        template.setParent(null);
        template.position.setAll(0);
        template.rotationQuaternion = null;
        template.rotation.setAll(0);
        template.scaling.setAll(1);
        template.bakeTransformIntoVertices(world);
      } else {
        // Multi-material items: keep one parent with each primitive baked in item space.
        template = new Mesh(kind, scene);
        for (const p of parts) {
          const world = p.computeWorldMatrix(true).clone();
          p.setParent(null);
          p.position.setAll(0);
          p.rotationQuaternion = null;
          p.rotation.setAll(0);
          p.scaling.setAll(1);
          p.bakeTransformIntoVertices(world);
          p.parent = template;
        }
      }
      template.name = kind;
      template.setEnabled(false);
      for (const m of [template, ...template.getChildMeshes(false)]) m.isPickable = false;
      lib.templates.set(kind, template);
    }
    root?.dispose(true, false);
    for (const [mat, def] of Object.entries(COOKED)) {
      const cooked = new Texture(`${BASE}${def.cooked}`, scene, { invertY: false });
      const map = def.map ? new Texture(`${BASE}${def.map}`, scene, { invertY: false }) : null;
      if (map) map.gammaSpace = false;
      lib.cookedTextures.set(mat, { cooked, map, mode: def.mode });
    }
    return lib;
  }

  has(kind: ItemKind): boolean {
    return this.templates.has(kind);
  }

  /** Non-item meshes in the food file (e.g. the sauce drizzle), cloned with their own material. */
  createExtra(name: string, cloneName: string): Mesh | null {
    const t = this.templates.get(name);
    if (!t) return null;
    const m = t.clone(cloneName, null, false)!;
    m.setEnabled(true);
    m.rotationQuaternion = null;
    if (m.material) m.material = m.material.clone(`${m.material.name}_${cloneName}`);
    return m;
  }

  /** Clones an item; every cookable material is cloned too so its state is per item. */
  create(kind: ItemKind, name: string): FoodVisual | null {
    const t = this.templates.get(kind);
    if (!t) return null;
    const root = t.clone(name, null, false)!;
    root.setEnabled(true);
    root.rotationQuaternion = null;
    const meshes = [root, ...(root.getChildMeshes(false) as Mesh[])];
    let cook: CookUniforms | null = null;
    const materials: Material[] = [];
    for (const m of meshes) {
      m.setEnabled(true);
      const mat = m.material as PBRMaterial | null;
      if (!mat) continue;
      const def = this.cookedTextures.get(mat.name);
      if (def) {
        const c = mat.clone(`${mat.name}_${name}`) as PBRMaterial;
        const plugin = new CookPlugin(c, def.mode, def.cooked, def.map);
        cook = plugin.state;
        m.material = c;
        materials.push(c);
      }
    }
    const meltBase = kind === "cheese" || kind === "swiss" ? new Float32Array(root.getVerticesData("position") ?? []) : null;
    if (meltBase) root.markVerticesDataAsUpdatable("position", true);
    return { root, meshes, cook, meltBase, materials };
  }
}
