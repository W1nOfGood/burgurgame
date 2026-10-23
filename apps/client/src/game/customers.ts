import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import { CUSTOMER_LOOKS, customerLook, type CustomerLook } from "@ahb/data";
import type { CustomerPose } from "@ahb/simulation";
import type { MaterialLibrary } from "./materials.js";
import { BoneDriver, findNode, loadContainer, mountGltfNode } from "./rig.js";

/**
 * Walk-in customers (people.py builds one rigged model per look). Where they are comes from
 * simulation/customers.ts; this view only turns a pose into a walking, waiting or reaching body
 * with their ticket number floating above them while they wait.
 */

const containers = new Map<string, AssetContainer>();

export async function loadCustomers(scene: Scene): Promise<void> {
  await Promise.all(
    CUSTOMER_LOOKS.map(async (look) => {
      containers.set(look.id, await loadContainer(scene, `customer_${look.id}.gltf`));
    }),
  );
}

/** One full stride (two steps) in metres: the gait is tied to distance, so feet don't slide. */
const STRIDE = 1.3;

interface Rig {
  holder: TransformNode;
  meshes: AbstractMesh[];
  d: Record<string, BoneDriver>;
  bag: AbstractMesh[];
}

export class CustomerView {
  readonly id: string;
  readonly root: TransformNode;
  private readonly scene: Scene;
  private readonly look: CustomerLook;
  private readonly standIn: Mesh[] = [];
  private readonly standInMats: PBRMaterial[] = [];
  private readonly tag: Mesh;
  private readonly tagTex: DynamicTexture;
  private tagKey = "";
  private rig: Rig | null = null;
  private yaw = Number.NaN;
  private idle = Math.random() * 10;

  constructor(scene: Scene, lib: MaterialLibrary, id: string, seed: number) {
    this.id = id;
    this.scene = scene;
    this.look = customerLook(seed);
    this.root = new TransformNode(`customer_${id}`, scene);
    const top = lib.solid(`cust_top_${this.look.id}`, this.look.top, 0.8);
    const bottom = lib.solid(`cust_bottom_${this.look.id}`, this.look.bottom, 0.8);
    const skin = lib.solid(`cust_skin_${this.look.id}`, this.look.skin, 0.55);
    const part = (m: Mesh, mat: PBRMaterial, y: number) => {
      m.material = mat;
      m.position.y = y;
      m.parent = this.root;
      m.isPickable = false;
      this.standIn.push(m);
    };
    part(MeshBuilder.CreateCapsule(`cust_legs_${id}`, { radius: 0.13, height: 0.9, tessellation: 10 }, scene), bottom, 0.45);
    part(MeshBuilder.CreateCapsule(`cust_torso_${id}`, { radius: 0.19, height: 0.66, tessellation: 12 }, scene), top, 1.2);
    part(MeshBuilder.CreateSphere(`cust_head_${id}`, { diameter: 0.22, segments: 12 }, scene), skin, 1.62);

    this.tagTex = new DynamicTexture(`cust_tag_${id}`, { width: 128, height: 64 }, scene, true);
    this.tagTex.hasAlpha = true;
    const tagMat = new PBRMaterial(`cust_tag_mat_${id}`, scene);
    tagMat.albedoTexture = this.tagTex;
    tagMat.emissiveTexture = this.tagTex;
    tagMat.emissiveColor = new Color3(1, 1, 1);
    tagMat.useAlphaFromAlbedoTexture = true;
    tagMat.disableLighting = true;
    tagMat.backFaceCulling = false;
    this.standInMats.push(tagMat);
    this.tag = MeshBuilder.CreatePlane(`cust_tag_plane_${id}`, { width: 0.3, height: 0.15 }, scene);
    this.tag.material = tagMat;
    this.tag.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.tag.position.y = 2.02;
    this.tag.parent = this.root;
    this.tag.isPickable = false;
    this.tag.setEnabled(false);
    this.upgrade();
  }

  get castMeshes(): AbstractMesh[] {
    return this.rig ? this.rig.meshes : this.standIn;
  }

  /** Swaps the stand-in for the rigged model once its file has loaded. */
  upgrade(): boolean {
    const container = containers.get(this.look.id);
    if (this.rig || !container) return false;
    const inst = container.instantiateModelsToScene((n) => `${n}_${this.id}`, false, { doNotInstantiate: true });
    const gltfRoot = inst.rootNodes[0];
    const armature = gltfRoot?.getChildren().find((n) => n.name.startsWith("customer_"));
    if (!gltfRoot || !armature) return false;
    const pos = this.root.position.clone();
    const yaw = this.root.rotation.y;
    this.root.position.setAll(0);
    this.root.rotation.y = 0;
    const holder = new TransformNode(`customer_holder_${this.id}`, this.scene);
    holder.parent = this.root;
    mountGltfNode(armature, holder, this.scene);
    gltfRoot.dispose(true, false);
    for (const n of [holder, ...holder.getDescendants(false)]) (n as TransformNode).computeWorldMatrix?.(true);
    const right = new Vector3(1, 0, 0);
    const fwd = new Vector3(0, 0, 1);
    const back = new Vector3(0, 0, -1);
    const node = (n: string) => findNode(armature, `${n}_${this.id}`) ?? findNode(armature, n);
    const d: Record<string, BoneDriver> = {};
    const drive = (bone: string, child: string | null, axis: Vector3, towards: Vector3) => {
      const b = node(bone);
      if (b) d[bone] = new BoneDriver(b, axis, child ? node(child) : null, towards);
    };
    for (const t of ["l", "r"]) {
      drive(`thigh_${t}`, `shin_${t}`, right, fwd);
      drive(`shin_${t}`, `foot_${t}`, right, back);
      drive(`foot_${t}`, null, right, fwd);
      drive(`upperarm_${t}`, `forearm_${t}`, right, fwd);
      drive(`forearm_${t}`, `hand_${t}`, right, fwd);
    }
    drive("spine", "chest", right, fwd);
    drive("chest", "neck", right, fwd);
    drive("neck", "head", right, fwd);
    drive("head", null, right, fwd);
    const meshes = holder.getChildMeshes(false);
    const bag = meshes.filter((m) => m.name.startsWith("takeaway_"));
    for (const m of meshes) m.isPickable = false;
    for (const m of bag) m.setEnabled(false);
    for (const m of this.standIn) m.setEnabled(false);
    this.root.position.copyFrom(pos);
    this.root.rotation.y = yaw;
    this.rig = { holder, meshes, d, bag };
    return true;
  }

  update(p: CustomerPose, ticket: number | null, dt: number): void {
    this.root.position.set(p.x, 0, p.z);
    // Turn smoothly toward the path heading (routes are rounded, but spots end in a turn).
    if (Number.isNaN(this.yaw)) this.yaw = p.yaw;
    let dy = p.yaw - this.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    this.yaw += dy * Math.min(1, dt * 7);
    this.root.rotation.y = this.yaw;
    this.idle += dt;

    const moving = p.speed > 0;
    const phase = (p.walked / STRIDE) * Math.PI * 2;
    const amt = moving ? Math.min(1, p.speed / 1.2) : 0;
    const swing = Math.sin(phase) * 0.42 * amt;
    if (this.rig) {
      const r = this.rig.d;
      const breathe = Math.sin(this.idle * 1.7) * 0.012;
      r["thigh_l"]?.set(swing);
      r["thigh_r"]?.set(-swing);
      r["shin_l"]?.set(Math.max(0, -Math.sin(phase - 0.9)) * 0.85 * amt + 0.04);
      r["shin_r"]?.set(Math.max(0, Math.sin(phase - 0.9)) * 0.85 * amt + 0.04);
      r["foot_l"]?.set(-Math.max(0, Math.sin(phase + 0.4)) * 0.25 * amt);
      r["foot_r"]?.set(-Math.max(0, -Math.sin(phase + 0.4)) * 0.25 * amt);
      // Arms swing opposite the legs; the right one reaches for the food or carries the bag.
      const reach = p.reach;
      r["upperarm_l"]?.set(-swing * 0.8);
      r["forearm_l"]?.set(0.18 + Math.max(0, -swing) * 0.35);
      if (p.carrying && reach < 0.05) {
        r["upperarm_r"]?.set(swing * 0.35 + 0.05);
        r["forearm_r"]?.set(0.25);
      } else {
        r["upperarm_r"]?.set(swing * 0.8 * (1 - reach) + reach * 1.15);
        r["forearm_r"]?.set(0.18 + Math.max(0, swing) * 0.35 + reach * 0.15);
      }
      r["spine"]?.set(amt * 0.05 + reach * 0.12 + breathe);
      r["chest"]?.set(-breathe * 0.5);
      // While waiting, glance down at the shelf now and then.
      const glance = moving ? 0 : Math.max(0, Math.sin(this.idle * 0.37)) * 0.25;
      r["neck"]?.set(glance * 0.5 + reach * 0.15);
      r["head"]?.set(glance * 0.5 + reach * 0.2);
      this.rig.holder.position.y = moving ? Math.abs(Math.cos(phase)) * 0.018 * amt : 0;
      for (const m of this.rig.bag) m.setEnabled(p.carrying);
    } else {
      this.standIn[0]!.rotation.x = swing * 0.3;
    }

    const label = ticket === null ? "" : `#${ticket}`;
    this.tag.setEnabled(label !== "");
    if (label !== this.tagKey) {
      this.tagKey = label;
      const ctx = this.tagTex.getContext() as unknown as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, 128, 64);
      if (label) {
        // A little paper ticket, like the ones on the rail.
        ctx.fillStyle = "#fbf8ef";
        ctx.beginPath();
        ctx.roundRect(6, 6, 116, 52, 8);
        ctx.fill();
        ctx.fillStyle = "#2c2621";
        ctx.font = "bold 34px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, 64, 34);
      }
      this.tagTex.update(true);
    }
  }

  dispose(): void {
    this.root.dispose(false, false);
    for (const m of this.standInMats) m.dispose(false, false);
    this.tagTex.dispose();
  }
}
