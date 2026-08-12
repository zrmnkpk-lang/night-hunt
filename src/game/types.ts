// 共享类型定义
export type SurvivorStatus =
  | 'healthy' // 健康
  | 'injured' // 受伤
  | 'downed' // 倒地
  | 'carried' // 被扛起
  | 'chaired' // 上椅
  | 'eliminated' // 淘汰
  | 'escaped' // 逃脱

export type HunterState =
  | 'patrol'
  | 'investigate'
  | 'chase'
  | 'attack'
  | 'recover' // 攻击后原地恢复
  | 'stunned'
  | 'breakpallet'
  | 'pickup'
  | 'carry'
  | 'chair'
  | 'vault'
  | 'teleport' // 瞬移技能(1s 蓄力 + 瞬移 + 1s 后摇)

export interface AABB {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export interface NoiseEvent {
  x: number
  z: number
  ttl: number
}

export const MAP_HALF = 35
export const GRID_SIZE = 70

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx
  const dz = az - bz
  return dx * dx + dz * dz
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt(dist2(ax, az, bx, bz))
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
