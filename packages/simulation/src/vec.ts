export interface V3 {
  x: number;
  y: number;
  z: number;
}

export function v3(x = 0, y = 0, z = 0): V3 {
  return { x, y, z };
}

export function add(a: V3, b: V3): V3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: V3, b: V3): V3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: V3, s: number): V3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: V3, b: V3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length(a: V3): number {
  return Math.sqrt(dot(a, a));
}

export function distance(a: V3, b: V3): number {
  return length(sub(a, b));
}

export function normalize(a: V3): V3 {
  const len = length(a);
  return len > 1e-9 ? scale(a, 1 / len) : { x: 0, y: 0, z: 0 };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r <= -Math.PI) r += Math.PI * 2;
  if (r > Math.PI) r -= Math.PI * 2;
  return r;
}

/**
 * Look direction for the shared camera convention: yaw 0 faces +Z, positive yaw turns toward
 * +X, positive pitch looks down. This matches Babylon's camera rotation convention.
 */
export function lookDirection(yaw: number, pitch: number): V3 {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: -Math.sin(pitch), z: Math.cos(yaw) * cp };
}

/** Quaternion for a rotation about +Y (x, y, z, w). */
export function yawQuat(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

/** Yaw angle extracted from a quaternion (rotation about +Y component). */
export function quatYaw(qx: number, qy: number, qz: number, qw: number): number {
  return Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qx * qx));
}
