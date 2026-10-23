import { Quaternion, Vector3, Matrix } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import { ART_BASE } from "./art.js";

/**
 * Helpers for the Blender-authored skinned characters (assets/source/blender/characters.py).
 * Bones are driven procedurally: each {@link BoneDriver} rotates a joint about an axis given in
 * world space at rest, converted once into the bone's own space and sign-checked against the
 * direction the child should move, so the code never depends on exporter bone-roll conventions.
 */

let registered = false;

export async function loadContainer(scene: Scene, file: string): Promise<AssetContainer> {
  if (!registered) {
    registerBuiltInLoaders();
    registered = true;
  }
  return LoadAssetContainerAsync(file, scene, { rootUrl: ART_BASE });
}

/** Parents a glTF node under ``holder`` through a handedness converter (like glTF __root__). */
export function mountGltfNode(node: Node, holder: TransformNode, scene: Scene): TransformNode {
  const conv = new TransformNode(`${node.name}_conv`, scene);
  conv.rotation.y = Math.PI;
  conv.scaling.z = -1;
  conv.parent = holder;
  node.parent = conv;
  return conv;
}

export function findNode(root: Node, name: string): TransformNode | null {
  if (root.name === name && root instanceof TransformNode) return root;
  for (const c of root.getDescendants(false)) if (c.name === name && c instanceof TransformNode) return c;
  return null;
}

export class BoneDriver {
  readonly node: TransformNode;
  private readonly rest: Quaternion;
  private readonly axis: Vector3;
  private readonly tmp = new Quaternion();

  /**
   * @param axisWorld rotation axis in world space at rest.
   * @param child a node whose world position should move along ``towards`` for positive angles.
   */
  constructor(node: TransformNode, axisWorld: Vector3, child: TransformNode | null, towards: Vector3) {
    this.node = node;
    if (!node.rotationQuaternion) node.rotationQuaternion = Quaternion.FromEulerVector(node.rotation);
    this.rest = node.rotationQuaternion.clone();
    node.computeWorldMatrix(true);
    // Axis into the bone's local frame (the node's world matrix maps local -> world).
    const inv = new Matrix();
    node.getWorldMatrix().invertToRef(inv);
    this.axis = Vector3.TransformNormal(axisWorld, inv).normalize();
    if (child) {
      const before = child.getAbsolutePosition().clone();
      this.set(0.3);
      node.computeWorldMatrix(true);
      child.computeWorldMatrix(true);
      const after = child.getAbsolutePosition();
      if (Vector3.Dot(after.subtract(before), towards) < 0) this.axis.scaleInPlace(-1);
      this.set(0);
      node.computeWorldMatrix(true);
    }
  }

  set(angle: number): void {
    Quaternion.RotationAxisToRef(this.axis, angle, this.tmp);
    this.rest.multiplyToRef(this.tmp, this.node.rotationQuaternion!);
  }
}
