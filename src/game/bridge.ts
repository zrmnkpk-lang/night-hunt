// 游戏 -> React HUD 的状态桥(轻量 pub/sub store)
import type { SurvivorStatus } from './types'

export type Phase = 'menu' | 'playing' | 'paused' | 'won' | 'lost' | 'spectating'

export interface ToastMsg {
  id: number
  text: string
  danger: boolean
  until: number // performance.now() 时间戳
}

export interface SurvivorChip {
  name: string
  status: SurvivorStatus
  isPlayer: boolean
}

export interface PromptState {
  text: string
  progress: number | null // 0..1
}

export interface QteState {
  needle: number // 角度 0..360
  zoneStart: number
  zoneSize: number
}

export interface HudState {
  phase: Phase
  ciphersLeft: number
  ciphersTotal: number
  overall: number // 0..1 全部密码机总进度
  gatePowered: boolean
  survivors: SurvivorChip[]
  prompt: PromptState | null
  qte: QteState | null
  terror: number // 0..1 心跳强度
  chase: boolean // 玩家是否正被追杀
  flash: number // 受击红闪时间戳
  playerStatus: SurvivorStatus
  chairTimeLeft: number // 玩家上椅剩余秒数(-1 表示不在椅上)
  stamina: number // 0..1
  dashCd: number // 玩家冲刺技能剩余冷却(0=就绪)
  healProgress: number // 玩家被治疗的进度 0..1(-1 表示未被治疗)
  toasts: ToastMsg[]
  muted: boolean
  stats: { decode: number; chaseTime: number; rescues: number }
  escapedTeammates: number
  endReason: string
  // 小地图点(归一化坐标 -1..1,屏幕右上角小地图用)
  minimap: {
    player: { x: number; z: number } | null
    mates: { x: number; z: number }[]
    ciphers: { x: number; z: number; done: boolean }[]
    chairs: { x: number; z: number; occupied: boolean }[]
    gates: { x: number; z: number; opened: boolean }[]
    hunter: { x: number; z: number } | null // 仅心跳范围内可见
  } | null
}

const initial: HudState = {
  phase: 'menu',
  ciphersLeft: 5,
  ciphersTotal: 5,
  overall: 0,
  gatePowered: false,
  survivors: [],
  prompt: null,
  qte: null,
  terror: 0,
  chase: false,
  flash: 0,
  playerStatus: 'healthy',
  chairTimeLeft: -1,
  stamina: 1,
  dashCd: 0,
  healProgress: -1,
  toasts: [],
  muted: false,
  stats: { decode: 0, chaseTime: 0, rescues: 0 },
  escapedTeammates: 0,
  endReason: '',
  minimap: null,
}

let state: HudState = { ...initial }
const listeners = new Set<() => void>()
let toastId = 1

export function getHud(): HudState {
  return state
}

export function setHud(p: Partial<HudState>): void {
  state = { ...state, ...p }
  listeners.forEach((l) => l())
}

export function resetHud(): void {
  state = { ...initial, toasts: [], survivors: [] }
  listeners.forEach((l) => l())
}

export function subscribeHud(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function pushToast(text: string, danger = false, ms = 2600): void {
  const t: ToastMsg = { id: toastId++, text, danger, until: performance.now() + ms }
  state = { ...state, toasts: [...state.toasts.slice(-4), t] }
  listeners.forEach((l) => l())
}

export function pruneToasts(): void {
  const now = performance.now()
  if (state.toasts.some((t) => t.until < now)) {
    state = { ...state, toasts: state.toasts.filter((t) => t.until >= now) }
    listeners.forEach((l) => l())
  }
}
