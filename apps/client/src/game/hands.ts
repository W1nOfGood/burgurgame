import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Scene } from "@babylonjs/core/scene";
import type { GripPose } from "@ahb/data";
import type { MaterialLibrary } from "./materials.js";

interface HandPose {
  pos: Vector3;
  rot: Vector3;
  curl: number;
}

const IDLE_R: HandPose = { pos: new Vector3(0.24, -0.28, 0.42), rot: new Vector3(0.2, -0.2, 0.1), curl: 0.3 };
const IDLE_L: HandPose = { pos: new Vector3(-0.24, -0.3, 0.4), rot: new Vector3(0.2, 0.2, -0.1), curl: 0.3 };

/**
 * First-person hands parented to the camera. Placeholder mitten geometry with grip poses per
 * tool type (spec §5: tool-specific grip poses); rigged hero hands replace these in Stage 3.
 */
export class FirstPersonHands {
  private readonly right: TransformNode;
  private readonly left: TransformNode;
  private readonly fingersR: Mesh[] = [];
  private readonly fingersL: Mesh[] = [];
  private targetR: HandPose = IDLE_R;
  private targetL: HandPose = IDLE_L;
  private bobPhase = 0;

  constructor(scene: Scene, camera: Camera, lib: MaterialLibrary) {
    const skin = lib.solid("fp_skin", [0.86, 0.64, 0.5], 0.55);
    const sleeve = lib.solid("fp_sleeve", [0.92, 0.9, 0.86], 0.8);
    const cuff = lib.solid("fp_cuff", [0.75, 0.15, 0.12], 0.7);
    const build = (name: string, side: 1 | -1, fingers: Mesh[]): TransformNode => {
      const root = new TransformNode(name, scene);
      root.parent = camera;
      // Rounded palm.
      const palm = MeshBuilder.CreateSphere(`${name}_palm`, { diameter: 1, segments: 12 }, scene);
      palm.scaling.set(0.085, 0.032, 0.095);
      palm.material = skin;
      palm.parent = root;
      const palmNode = new TransformNode(`${name}_palm_node`, scene);
      palmNode.parent = root;
      // Four two-segment fingers that curl with the grip.
      for (let i = 0; i < 4; i++) {
        const base = MeshBuilder.CreateCapsule(`${name}_f${i}`, { radius: 0.0095, height: 0.042, tessellation: 8 }, scene);
        base.rotation.x = Math.PI / 2;
        base.position.set(-0.029 + i * 0.019, 0.002, 0.058 - Math.abs(i - 1.5) * 0.006);
        base.material = skin;
        base.parent = palmNode;
        const tip = MeshBuilder.CreateCapsule(`${name}_f${i}_tip`, { radius: 0.0088, height: 0.034, tessellation: 8 }, scene);
        tip.position.set(0, 0.026, 0);
        tip.material = skin;
        tip.parent = base;
        fingers.push(base);
      }
      const thumb = MeshBuilder.CreateCapsule(`${name}_thumb`, { radius: 0.0105, height: 0.05, tessellation: 8 }, scene);
      thumb.rotation.set(Math.PI / 2.4, 0, side * 0.9);
      thumb.position.set(side * -0.046, -0.004, 0.018);
      thumb.material = skin;
      thumb.parent = palmNode;
      const wrist = MeshBuilder.CreateCylinder(`${name}_wrist`, { diameterTop: 0.06, diameterBottom: 0.07, height: 0.08, tessellation: 12 }, scene);
      wrist.rotation.x = Math.PI / 2;
      wrist.position.set(0, -0.004, -0.07);
      wrist.material = skin;
      wrist.parent = root;
      const cuffBand = MeshBuilder.CreateCylinder(`${name}_cuff`, { diameter: 0.085, height: 0.03, tessellation: 14 }, scene);
      cuffBand.rotation.x = Math.PI / 2;
      cuffBand.position.set(0, -0.004, -0.11);
      cuffBand.material = cuff;
      cuffBand.parent = root;
      const sleeveMesh = MeshBuilder.CreateCylinder(`${name}_sleeve`, { diameterTop: 0.085, diameterBottom: 0.1, height: 0.22, tessellation: 14 }, scene);
      sleeveMesh.rotation.x = Math.PI / 2;
      sleeveMesh.position.set(0, -0.004, -0.23);
      sleeveMesh.material = sleeve;
      sleeveMesh.parent = root;
      for (const m of root.getChildMeshes()) {
        m.isPickable = false;
        m.metadata = { placeholder: true, hands: true };
      }
      return root;
    };
    this.right = build("fp_right", 1, this.fingersR);
    this.left = build("fp_left", -1, this.fingersL);
    this.right.position.copyFrom(IDLE_R.pos);
    this.left.position.copyFrom(IDLE_L.pos);
  }

  get meshes(): Mesh[] {
    return [...this.right.getChildMeshes(), ...this.left.getChildMeshes()] as Mesh[];
  }

  /**
   * @param heldLocal held object position in camera space, or null.
   * @param grip grip style for the held object.
   */
  update(dt: number, heldLocal: Vector3 | null, grip: GripPose | null, moving: number, bobAmount: number): void {
    if (heldLocal && grip) {
      const near = heldLocal.clone();
      if (grip === "tray") {
        this.targetR = { pos: near.add(new Vector3(0.17, -0.02, -0.05)), rot: new Vector3(0.1, 0, -0.3), curl: 0.6 };
        this.targetL = { pos: near.add(new Vector3(-0.17, -0.02, -0.05)), rot: new Vector3(0.1, 0, 0.3), curl: 0.6 };
      } else if (grip === "tool") {
        this.targetR = { pos: near.add(new Vector3(0.02, 0.0, -0.17)), rot: new Vector3(0.1, 0, 0), curl: 1 };
        this.targetL = IDLE_L;
      } else if (grip === "bottle") {
        this.targetR = { pos: near.add(new Vector3(0.05, -0.02, -0.03)), rot: new Vector3(0.0, 0, 1.2), curl: 0.9 };
        this.targetL = IDLE_L;
      } else {
        this.targetR = { pos: near.add(new Vector3(0.0, 0.035, -0.02)), rot: new Vector3(0.5, 0, 0), curl: 0.8 };
        this.targetL = IDLE_L;
      }
    } else {
      this.targetR = IDLE_R;
      this.targetL = IDLE_L;
    }
    // Clamp so hands stay in frame and never stretch past the arm.
    const clampPose = (p: HandPose): HandPose => ({
      pos: new Vector3(Math.max(-0.4, Math.min(0.4, p.pos.x)), Math.max(-0.45, Math.min(0.1, p.pos.y)), Math.max(0.25, Math.min(0.7, p.pos.z))),
      rot: p.rot,
      curl: p.curl,
    });
    const k = 1 - Math.exp(-dt * 16);
    this.bobPhase += dt * moving * 9;
    const bob = Math.sin(this.bobPhase) * 0.008 * bobAmount * Math.min(1, moving);
    for (const [node, target, fingers] of [
      [this.right, clampPose(this.targetR), this.fingersR],
      [this.left, clampPose(this.targetL), this.fingersL],
    ] as const) {
      Vector3.LerpToRef(node.position, target.pos.add(new Vector3(0, bob, 0)), k, node.position);
      Vector3.LerpToRef(node.rotation, target.rot, k, node.rotation);
      for (const f of fingers) {
        f.rotation.x = Math.PI / 2 + target.curl * 0.8;
        const tip = f.getChildMeshes()[0];
        if (tip) tip.rotation.x = target.curl * 0.9;
      }
    }
  }

  setVisible(on: boolean): void {
    for (const m of this.meshes) m.isVisible = on;
  }
}
