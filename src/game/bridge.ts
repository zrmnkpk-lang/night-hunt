// 游戏 -> React HUD 的状态桥(轻量 pub/sub store)
import type { SurvivorStatus, HunterState } from './types'

export type Phase = 'menu' | 'playing' | 'paused' | 'won' | 'lost' | 'draw' | 'spectating'

// 玩家扮演的角色(菜单选择)
export type HudRole = 'survivor' | 'hunter'

// 结算结果:胜 / 平 / 负
// 杀手判定:淘汰 4~3 人 = win,2 人 = draw,1 人及以下 = lose
export type EndResult = 'win' | 'draw' | 'lose'

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
  chairCount?: number // 上椅次数(1 / 2 / 3)
  chairTimer?: number // 上椅剩余秒(整秒;杀手据此判断要不要守椅)
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

// 小地图数据(归一化坐标 -1..1,屏幕角落小地图用)
export interface MinimapData {
  // 自己的位置:求生者局 = 玩家;杀手局 = 猎人(恒可见)
  self: { x: number; z: number } | null
  // 求生者局:玩家位置(与 self 相同,保留以兼容既有渲染逻辑)
  player: { x: number; z: number } | null
  // 求生者局:存活队友;杀手局恒空
  mates: { x: number; z: number }[]
  // 杀手局:已暴露的猎物 —— 仅受击流血 / 噪音 / 近距离感知圈内才出现
  prey: { x: number; z: number; bleeding: boolean }[]
  // 杀手局:噪音事件点,k = 剩余强度 0..1(半径随 k 收缩)
  noises: { x: number; z: number; k: number }[]
  // 杀手局扛人时:目标狂欢之椅;否则 null
  chairTarget: { x: number; z: number } | null
  // progress:0..1,杀手据此判断哪台快破完(决定去哪守)
  ciphers: { x: number; z: number; done: boolean; progress: number }[]
  chairs: { x: number; z: number; occupied: boolean }[]
  gates: { x: number; z: number; opened: boolean }[]
  // 求生者局:心跳范围内的猎人;杀手局恒 null
  hunter: { x: number; z: number } | null
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
  // 求生者 = 心跳强度(猎人距离);杀手 = 猎物接近度(最近求生者距离)。语义随 role 切换
  terror: number // 0..1
  chase: boolean // 是否处于追击状态(驱动追击音乐)
  flash: number // 受击红闪时间戳
  playerStatus: SurvivorStatus // 杀手局不读(占位 healthy)
  role: HudRole // 玩家扮演的角色(影响 HUD 布局与文案)
  chairTimeLeft: number // 玩家上椅剩余秒数(-1 表示不在椅上);杀手局恒 -1
  stamina: number // 0..1;杀手无体力,恒 1 且 HUD 隐藏
  dashCd: number // 玩家冲刺技能剩余冷却(0=就绪);杀手局恒 0
  teleportCd: number // 杀手瞬移技能剩余冷却(0=就绪);求生者局恒 0
  healProgress: number // 玩家被治疗的进度 0..1(-1 表示未被治疗);杀手局恒 -1
  toasts: ToastMsg[]
  muted: boolean
  // downs:击倒次数(杀手统计);kills:淘汰数(杀手主指标)
  stats: { decode: number; chaseTime: number; rescues: number; downs: number; kills: number }
  escapedTeammates: number // 求生者局 = 逃脱的队友数;杀手局 = 逃脱的求生者数
  endReason: string
  minimap: MinimapData | null

  // ---- 以下为玩家扮演杀手新增 ----
  endResult: EndResult // 结算结果;非结算阶段为占位值
  hunterState: HunterState | null // 杀手状态机状态(驱动中央提示);求生者局恒 null
  attackCd: number // 挥刀剩余冷却秒(0=就绪);求生者局恒 0
  chaseBuff: number // 追击速度加成 0..0.1(每档 +2%,最多 5 档);求生者局恒 0
  carryName: string | null // 当前扛着的求生者名字(null = 未扛人)
  carryChairDist: number // 扛人时到目标椅子的距离(米);-1 = 未扛人
  kills: number // 本局淘汰数(顶部大字与结算页主指标)
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
  role: 'survivor',
  chairTimeLeft: -1,
  stamina: 1,
  dashCd: 0,
  teleportCd: 0,
  healProgress: -1,
  toasts: [],
  muted: false,
  stats: { decode: 0, chaseTime: 0, rescues: 0, downs: 0, kills: 0 },
  escapedTeammates: 0,
  endReason: '',
  minimap: null,

  endResult: 'lose',
  hunterState: null,
  attackCd: 0,
  chaseBuff: 0,
  carryName: null,
  carryChairDist: -1,
  kills: 0,
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
