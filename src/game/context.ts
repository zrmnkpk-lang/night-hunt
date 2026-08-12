// AI 共享上下文接口(避免循环依赖)
import type { NavGrid } from './navgrid'
import type { World, Cipher, Chair } from './world'
import type { NoiseEvent } from './types'
import type { Survivor } from './survivor'
import type { Hunter } from './hunter'
import type { SfxName } from './audio'

export interface GameCtx {
  world: World
  nav: NavGrid
  survivors: Survivor[]
  hunter: Hunter
  noises: NoiseEvent[]
  time: number
  gatePowered: boolean
  addNoise(x: number, z: number): void
  toast(text: string, danger?: boolean): void
  sfx(name: SfxName): void
  onCipherDone(c: Cipher): void
  onSurvivorDowned(s: Survivor): void
  onSurvivorChaired(s: Survivor, c: Chair): void
  onSurvivorEliminated(s: Survivor): void
  onSurvivorRescued(s: Survivor, by: Survivor): void
  onSurvivorEscaped(s: Survivor): void
  isChased(s: Survivor): boolean
}

export const SPEED = {
  survWalk: 3.9,
  survSprint: 7.69, // 爆发冲刺(+25%),但体力上限减半
  survAiSprint: 6.15, // AI 队友冲刺(保持原速,避免猎人永远追不上)
  survInjuredSprintBonus: 2.2, // 受击后短暂加速
  crawl: 1.1,
  hunterPatrol: 3.7,
  hunterInvestigate: 4.6,
  hunterChase: 6.05,
  hunterCarry: 3.9,
}

