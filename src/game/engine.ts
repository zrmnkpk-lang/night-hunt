// 游戏主引擎:渲染循环、玩家控制、交互、事件编排、HUD 同步
import * as THREE from 'three'
import { World } from './world'
import type { Cipher, Chair, Gate } from './world'
import { Survivor } from './survivor'
import { Hunter } from './hunter'
import { Qte } from './qte'
import { Input } from './input'
import { AudioEngine } from './audio'
import type { SfxName } from './audio'
import { NavGrid, circleHits, losBlocked } from './navgrid'
import { dist, dist2, clamp } from './types'
import type { NoiseEvent, PlayerRole } from './types'
import { SPEED } from './context'
import type { GameCtx } from './context'
import { getHud, pushToast, resetHud, setHud } from './bridge'
import type { EndResult, MinimapData, Phase, PromptState } from './bridge'
import { loadSettings, saveSettings } from './settings'
import type { Settings } from './settings'

// 求生者毛衣色(参考图风格:鲜亮换色,每人一眼可辨)
const SURV_COLORS = [0xd9a13b, 0x4a8fa8, 0xb0563e, 0x6a9955]
const TERROR_RADIUS = 26
// 杀手情报半径:感知圈 8m / 噪音波及 5m(超出则小地图上看不到求生者)
const HUNTER_SENSE_RADIUS = 8
const HUNTER_NOISE_RADIUS = 5
// 一局硬性时长上限(秒):任何状态机异常都不得导致永不结算
const MATCH_TIME_LIMIT = 600
// AI 名字池(玩家扮演杀手时 4 人全为 AI,需覆盖 id 0..3)
const AI_NAMES = ['阿岚', '老周', '小七', '阿澈']

// 每帧消费一次的输入快照
type InputFrame = ReturnType<Input['endFrame']>

export class Engine implements GameCtx {
  world!: World
  nav!: NavGrid
  survivors: Survivor[] = []
  hunter!: Hunter
  noises: NoiseEvent[] = []
  time = 0
  gatePowered = false
  // 玩家扮演的角色(start 时由菜单选择)
  playerRole: PlayerRole = 'survivor'
  // 用户设置(灵敏度/音量/难度),从 localStorage 加载,运行时可改
  settings: Settings

  private canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene!: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private input: Input
  private audio: AudioEngine
  private qte = new Qte()
  private raf = 0
  private lastT = 0
  private running = false
  private loopId = 0
  private paused = false
  private over = false

  // 玩家/相机状态
  private camYaw = Math.PI
  private camPitch = -0.32
  private playerChannel = 0 // 救人/治疗/开门吟唱进度
  private channelKind: 'none' | 'rescue' | 'heal' | 'gate' = 'none'
  private channelTarget = -1
  private stats = { decode: 0, chaseTime: 0, rescues: 0, downs: 0 }
  private escapedTeammates = 0
  private kills = 0 // 本局淘汰数(杀手主指标;求生者局仅用于结算展示)
  private hunterPrompt: PromptState | null = null // 杀手局底部交互提示
  private chaseMusicOn = false
  private spectating = false // 玩家被淘汰后进入观战模式
  private spectateTargetId = -1 // 当前观战的队友 id
  // HUD survivors 缓存:仅在状态变化时重建,避免每帧 .map 产生 GC
  private hudSurvivorsCache: import('./bridge').SurvivorChip[] = []
  private hudSurvivorsKey = ''

  constructor(canvas: HTMLCanvasElement, input: Input, audio: AudioEngine) {
    this.canvas = canvas
    this.input = input
    this.audio = audio
    this.settings = loadSettings()
    this.applySettingsToAudio()
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.9
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.1, 120)
    this.buildScene()
    this.resize()
    window.addEventListener('resize', this.resize)
    document.addEventListener('pointerlockchange', this.onLockChange)
    // Esc 走独立监听:tick 在 paused 时不跑,靠 endFrame() 读 esc 是条死路(暂停后无法用 Esc 恢复)
    window.addEventListener('keydown', this.escHandler)
  }

  // Esc:playing↔paused。独立于 Input.enabled 与主循环,两条路径都能触发。
  private escHandler = (e: KeyboardEvent): void => {
    if (e.code !== 'Escape') return
    const phase = getHud().phase
    if (phase === 'paused') this.resume()
    else if (phase === 'playing') this.pause()
  }

  dispose(): void {
    this.stop()
    window.removeEventListener('resize', this.resize)
    window.removeEventListener('keydown', this.escHandler)
    document.removeEventListener('pointerlockchange', this.onLockChange)
    this.disposeScene()
    this.renderer.dispose()
  }

  private disposeScene(): void {
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const m = o.material
        if (Array.isArray(m)) m.forEach((x) => this.disposeMaterial(x))
        else this.disposeMaterial(m)
      }
    })
  }

  // 释放材质,但跳过模块级共享材质(如透视轮廓 outlineMat)。
  // 共享材质被 dispose 后,重开一局时受击求生者的穿墙红框高亮会失效 ——
  // 而那正是杀手局定位猎物的核心情报来源,必须保住。
  private disposeMaterial(m: THREE.Material): void {
    if (!(m as THREE.Material & { __shared?: boolean }).__shared) m.dispose()
  }

  private buildScene(): void {
    this.scene = new THREE.Scene()
    this.world = new World(this.scene)
    this.nav = this.world.nav
    this.survivors = []
    const isHunter = this.playerRole === 'hunter'
    // 监管者先就位,再用其位置约束求生者刷新(保证开局距离 > 12m)。
    // 玩家扮演杀手时固定用 normal 难度构造:难度只调节 AI 强度,不该给玩家白送移速加成。
    const HUNTER_X = -8
    const HUNTER_Z = -30
    this.hunter = new Hunter(HUNTER_X, HUNTER_Z, isHunter ? 'normal' : this.settings.difficulty)
    this.hunter.setPlayerControlled(isHunter)
    // 猎灯:猎人本身不带提灯,玩家扮演时必须点亮,否则全场只剩求生者的微弱提灯(近乎全黑)
    if (this.hunter.mesh.huntLight) this.hunter.mesh.huntLight.visible = isHunter
    this.scene.add(this.hunter.mesh.group)
    // 求存者随机刷新:全图 ±30 范围内随机,拒绝墙内/距猎人<12m/彼此<3m 的点
    const spawns = this.rollSurvivorSpawns(HUNTER_X, HUNTER_Z)
    let aiNameIdx = 0
    for (let i = 0; i < 4; i++) {
      // 玩家扮演求生者时 0 号是"你";扮演杀手时 4 人全为 AI
      const isPlayer = !isHunter && i === 0
      const s = new Survivor(
        i,
        isPlayer,
        spawns[i][0],
        spawns[i][1],
        SURV_COLORS[i],
        // 显式传名:避免 Survivor 内部用 AI_NAMES[(id-1)%3] 在 id=0 时取到 undefined
        isPlayer ? '你' : AI_NAMES[aiNameIdx++],
      )
      if (isHunter) {
        // 杀手视角下要能看清猎物:把 AI 提灯调亮。
        // 必须改 lanternBase 而非 intensity —— syncMesh 每帧用 base 重算 intensity 会覆盖直接赋值。
        s.mesh.lanternBase = 3.2
        if (s.mesh.lanternLight) s.mesh.lanternLight.distance = 14
      }
      this.survivors.push(s)
      this.scene.add(s.mesh.group)
    }
    Survivor.staticColliders = this.world.colliders
    // 杀手局:放缓 AI 破译(70s → 95s/台),并让破译产生噪音作为杀手的情报来源。
    // 否则 4 人并行约 110s 就能全员逃脱,杀手根本没有 3 杀的窗口。
    Survivor.staticDecodeTime = isHunter ? 95 : 70
    Survivor.staticDecodeNoise = isHunter
    this.noises = []
    this.time = 0
    this.gatePowered = false
    this.qte = new Qte()
    this.stats = { decode: 0, chaseTime: 0, rescues: 0, downs: 0 }
    this.escapedTeammates = 0
    this.kills = 0
    this.hunterPrompt = null
    this.over = false
    this.spectating = false
    this.spectateTargetId = -1
    this.playerChannel = 0
    this.channelKind = 'none'
    this.camYaw = Math.PI
    this.camPitch = -0.32
  }

  // 随机生成 4 个求生者开局位置:全图随机,远离监管者(>12m)、不重叠(>3m)、不在墙里
  private rollSurvivorSpawns(hunterX: number, hunterZ: number): [number, number][] {
    const result: [number, number][] = []
    const fallback: [number, number][] = [
      [0, 27], [2.5, 28], [-2.5, 28], [0, 30],
    ]
    for (let i = 0; i < 4; i++) {
      let chosen: [number, number] | null = null
      for (let attempt = 0; attempt < 50; attempt++) {
        const x = (Math.random() * 2 - 1) * 30
        const z = (Math.random() * 2 - 1) * 30
        // 不在墙/障碍格内
        if (this.nav.blockedAt(x, z)) continue
        // 远离监管者(留余量,>12m 而非 10m,避免一开始就被发现)
        if (dist(x, z, hunterX, hunterZ) < 12) continue
        // 不与已生成的队友重叠
        let overlap = false
        for (const r of result) {
          if (dist(x, z, r[0], r[1]) < 3) {
            overlap = true
            break
          }
        }
        if (overlap) continue
        chosen = [x, z]
        break
      }
      result.push(chosen ?? fallback[i])
    }
    return result
  }

  // ---- 生命周期 ----
  // role 缺省时沿用上一局的选择(结算页"再来一局"不传参)
  start(role?: PlayerRole): void {
    if (role) this.playerRole = role
    // 丢弃菜单期累积的输入:点"开始游戏"的 mousedown 会被记为攻击,开局瞬间白挥一刀
    this.input.endFrame()
    this.disposeScene()
    this.buildScene()
    resetHud()
    this.audio.ensure()
    setHud({
      phase: 'playing',
      // resetHud() 会把 role 重置回 'survivor',必须在它之后再写入本次选择
      role: this.playerRole,
      hunterState: this.playerRole === 'hunter' ? 'patrol' : null,
      survivors: this.getHudSurvivors(),
      ciphersLeft: 5,
      gatePowered: false,
      muted: this.audio.isMuted,
      kills: 0,
      stats: { decode: 0, chaseTime: 0, rescues: 0, downs: 0, kills: 0 },
    })
    this.input.enabled = true
    this.input.requestLock()
    this.paused = false
    this.running = true
    const myLoop = ++this.loopId
    this.lastT = performance.now()
    cancelAnimationFrame(this.raf)
    const loop = (t: number): void => {
      if (!this.running || myLoop !== this.loopId) return
      this.raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (t - this.lastT) / 1000)
      this.lastT = t
      if (!this.paused) this.tick(dt)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.input.enabled = false
    this.input.exitLock()
    this.audio.setChase(false)
    this.audio.setHum(false)
  }

  // 回到主菜单(结算页"返回菜单"):停掉本局并释放指针锁定,以便重新选择角色。
  // 没有它,玩家想从杀手切回求生者只能刷新页面。
  backToMenu(): void {
    this.stop()
    this.over = true // 冻结本局;下次 start() 会由 buildScene 重置
    this.spectating = false
    resetHud() // 回到 initial,phase 即为 'menu'
  }

  resume(): void {
    if (this.over) return
    this.paused = false
    this.input.enabled = true
    // 丢弃暂停期间累积的输入:点"继续"按钮的 mousedown 会被记成攻击,
    // 恢复后第一帧就消费 → 杀手凭空挥一刀并进入 0.45s 后摇。
    this.input.endFrame()
    setHud({ phase: 'playing' })
    this.input.requestLock()
  }

  pause(): void {
    if (this.over || getHud().phase !== 'playing') return
    this.paused = true
    this.input.enabled = false
    setHud({ phase: 'paused' })
    this.input.exitLock()
    this.audio.setChase(false)
    this.audio.setHum(false)
  }

  toggleMute(): void {
    this.audio.setMuted(!this.audio.isMuted)
    setHud({ muted: this.audio.isMuted })
  }

  // 把当前 settings 应用到音频(音量)
  private applySettingsToAudio(): void {
    this.audio.setVolume(this.settings.volume)
  }

  // 外部(UI)更新设置:即时生效 + 持久化。难度需下局生效(运行中改难度不重建场景)。
  setSettings(s: Settings): void {
    const difficultyChanged = s.difficulty !== this.settings.difficulty
    this.settings = s
    saveSettings(s)
    this.applySettingsToAudio()
    if (difficultyChanged) {
      this.toast(`难度已设为${s.difficulty === 'easy' ? '简单' : s.difficulty === 'hard' ? '困难' : '普通'}(下局生效)`)
    }
  }

  private onLockChange = (): void => {
    if (!this.input.locked && getHud().phase === 'playing' && this.running && !this.over) {
      this.pause()
    }
  }

  private resize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  // ---- GameCtx 回调 ----
  addNoise(x: number, z: number): void {
    this.noises.push({ x, z, ttl: 6 })
  }

  toast(text: string, danger = false): void {
    pushToast(text, danger)
  }

  sfx(name: SfxName): void {
    this.audio[name]()
  }

  // 是否被猎人追杀(驱动 AI 求生者的逃跑/冲刺决策与追击音乐)
  isChased(s: Survivor): boolean {
    const h = this.hunter
    // 玩家扮演杀手时状态机永不进入 'chase',改用"锁定 + 距离"判定 ——
    // 否则 AI 求生者被贴脸也不交冲刺,追击音乐也永远不响。
    if (h.isPlayerControlled) {
      return h.target === s.id && !h.busy() && !h.carrying() && dist2(s.x, s.z, h.x, h.z) < 20 * 20
    }
    return h.state === 'chase' && h.target === s.id
  }

  onCipherDone(c: Cipher): void {
    c.bulb.color.set(0x0a220a)
    c.bulb.emissive.set(0x7fb069)
    c.bulb.emissiveIntensity = 1.8
    c.antennaLight.color.set(0x7fb069)
    this.sfx('cipherDone')
    const left = this.world.ciphers.filter((x) => !x.done).length
    setHud({ ciphersLeft: left })
    if (left > 0) {
      this.toast(`一台密码机破译完成!还剩 ${left} 台`)
    } else {
      this.gatePowered = true
      this.world.powerGates()
      setHud({ gatePowered: true })
      this.toast('全部密码机完成!电闸已通电,去开启大门!', true)
      this.sfx('gateAlarm')
    }
  }

  onSurvivorDowned(s: Survivor): void {
    this.toast(s.isPlayer ? '你被打倒了!' : `${s.name} 被打倒了!`, true)
    if (this.playerRole === 'hunter') this.stats.downs++
    if (s.isPlayer) this.qte.cancel()
  }

  onSurvivorChaired(s: Survivor, _c: Chair): void {
    this.toast(s.isPlayer ? '你被绑上了狂欢之椅!' : `${s.name} 被绑上了狂欢之椅!`, true)
    this.sfx('chairSting')
    if (s.isPlayer) {
      setHud({ chairTimeLeft: s.chairTimer })
    }
    // 第 3 次上椅直接淘汰(阶段机制:1 次 60s → 2 次 40s → 3 次秒杀)
    if (s.chairCount >= 3) {
      this.toast(s.isPlayer ? '第三次上椅 — 直接淘汰!' : `${s.name} 第三次上椅,直接淘汰`, true)
      s.chairTimer = 0
      this.onSurvivorEliminated(s)
    }
  }

  onSurvivorEliminated(s: Survivor): void {
    if (s.status === 'eliminated') return
    s.status = 'eliminated'
    this.kills++ // 放在幂等守卫之后,避免重复计数
    if (s.chairRef >= 0) {
      const ch = this.world.chairs[s.chairRef]
      if (ch) ch.occupiedBy = -1
    }
    this.sfx('eliminated')
    this.toast(s.isPlayer ? '你被狂欢之椅送上了天…' : `${s.name} 被淘汰了`, true)
    if (s.isPlayer) {
      // 玩家被淘汰:进入观战模式(而非立即结束),跟随存活的队友
      this.enterSpectate()
    }
  }

  // 进入观战:选一个存活的 AI 队友作为跟随目标;无存活队友则结算失败
  private enterSpectate(): void {
    const mate = this.pickSpectateTarget()
    if (mate) {
      this.spectating = true
      this.spectateTargetId = mate.id
      this.input.exitLock() // 观战无需锁定鼠标
      setHud({ phase: 'spectating' })
      this.toast(`你被淘汰了,正在观战 ${mate.name}…`)
    } else {
      // 无存活队友:直接结算
      this.endGame(false, '全员被淘汰,猎人获胜。')
    }
  }

  // 选一个存活的 AI 队友作为观战目标
  private pickSpectateTarget(): Survivor | null {
    let best: Survivor | null = null
    let bd = Infinity
    for (const s of this.survivors) {
      if (s.isPlayer || !s.alive) continue
      const d = dist2(s.x, s.z, this.hunter.x, this.hunter.z)
      if (d < bd) {
        bd = d
        best = s
      }
    }
    return best
  }

  onSurvivorRescued(s: Survivor, by: Survivor): void {
    s.status = 'injured'
    s.chairTimer = 0
    if (s.chairRef >= 0) {
      const ch = this.world.chairs[s.chairRef]
      if (ch) {
        // 救下后放在椅子附近的安全点(不在碰撞体内、不与救人者重叠)
        this.placeAfterRescue(s, by, ch.x, ch.z)
        ch.occupiedBy = -1
      }
      s.chairRef = -1
    }
    this.sfx('rescue')
    this.toast(s.isPlayer ? `${by.name} 把你救了下来!` : `${by.name} 救下了 ${s.name}`)
    if (by.isPlayer) this.stats.rescues++
    if (s.isPlayer) setHud({ chairTimeLeft: -1 })
  }

  // 在椅子周围找一个可站立点:导航可走 + 无碰撞 + 远离救人者
  private placeAfterRescue(s: Survivor, by: Survivor, cx: number, cz: number): void {
    const candidates: [number, number][] = [
      [1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4],
      [1.0, 1.0], [-1.0, 1.0], [1.0, -1.0], [-1.0, -1.0],
      [2.0, 0], [0, 2.0], [-2.0, 0], [0, -2.0],
    ]
    for (const [ox, oz] of candidates) {
      const x = cx + ox
      const z = cz + oz
      if (Math.abs(x) > 33.5 || Math.abs(z) > 33.5) continue
      if (this.nav.blockedAt(x, z)) continue
      if (dist(x, z, by.x, by.z) < 0.9) continue
      let hit = false
      for (const c of this.world.colliders) {
        if (circleHits(x, z, 0.42, c)) {
          hit = true
          break
        }
      }
      if (hit) continue
      s.x = x
      s.z = z
      return
    }
    // 兜底:最近可走格中心
    const cell = this.nav.nearestFree(cx + 1.5, cz, 8)
    const w = this.nav.cellToWorld(cell.cx, cell.cz)
    s.x = w.x
    s.z = w.z
  }

  onSurvivorEscaped(s: Survivor): void {
    s.status = 'escaped'
    s.mesh.group.visible = false
    if (s.isPlayer) {
      this.endGame(true, '')
    } else {
      this.escapedTeammates++
      this.toast(`${s.name} 逃出了庄园!`)
    }
  }

  // won 仅对求生者局有意义(玩家逃脱 = 胜);杀手局的胜负由 kills 推导。
  private endGame(won: boolean, reason: string): void {
    if (this.over) return
    this.over = true
    this.audio.setChase(false)
    this.audio.setHum(false)
    this.input.exitLock()

    let result: EndResult
    if (this.playerRole === 'hunter') {
      // 杀手判定:4~3 淘汰 = 狩猎完成,2 淘汰 = 平局,1 及以下 = 失败
      const escaped = this.survivors.filter((s) => s.status === 'escaped').length
      result = this.kills >= 3 ? 'win' : this.kills === 2 ? 'draw' : 'lose'
      reason =
        result === 'win'
          ? `你淘汰了 ${this.kills} 名求生者,狩猎完成。`
          : result === 'draw'
            ? `2 淘汰 · ${escaped} 逃脱,平局。`
            : `只淘汰了 ${this.kills} 人,${escaped} 人逃出了庄园。`
    } else {
      result = won ? 'win' : 'lose'
    }
    if (result === 'win') this.audio.win()
    else this.audio.lose()

    const phase: Phase = result === 'win' ? 'won' : result === 'draw' ? 'draw' : 'lost'
    setHud({
      phase,
      endReason: reason,
      endResult: result,
      escapedTeammates: this.escapedTeammates,
      kills: this.kills,
      stats: {
        decode: Math.round(this.stats.decode * 100),
        chaseTime: Math.round(this.stats.chaseTime),
        rescues: this.stats.rescues,
        downs: this.stats.downs,
        kills: this.kills,
      },
    })
  }

  // ---- 主循环 ----
  private tick(dt: number): void {
    this.time += dt
    const p = this.survivors[0]
    const h = this.hunter
    const isHunter = this.playerRole === 'hunter'

    // 噪音衰减(两角色共用)
    for (let i = this.noises.length - 1; i >= 0; i--) {
      this.noises[i].ttl -= dt
      if (this.noises[i].ttl <= 0) this.noises.splice(i, 1)
    }

    // Esc 已改由独立的 window keydown 监听处理 —— 暂停时 tick 不跑,这里读不到
    const frame = this.input.endFrame()
    if (frame.m) this.toggleMute()

    // 求生者冲刺技能(Q)。杀手的 Q 是瞬移,在 updatePlayerHunter 内消费。
    if (!isHunter && frame.q && p.canDash()) {
      const sin = Math.sin(this.camYaw)
      const cos = Math.cos(this.camYaw)
      // 相机前方 = (sin, cos);取玩家当前移动方向,无输入则用相机前方
      const ax = this.input.axis()
      let dx = -ax.x * cos - ax.z * sin
      let dz = ax.x * sin - ax.z * cos
      if (ax.x === 0 && ax.z === 0) {
        dx = sin
        dz = cos
      }
      p.startDash(this, dx, dz)
    }

    // ── 1. 玩家输入与移动 ──
    // 必须排在 h.update() 之前:playerTryVault 设置的 vaultT 要在本帧就被
    // hunter.update() 开头的插值分支消费,否则玩家在翻窗期间仍会被 Engine 推动。
    if (isHunter) this.updatePlayerHunter(dt, frame)

    // ── 2. 实体更新 ──
    if (!this.over) {
      if (isHunter) {
        // 玩家扮演杀手:4 名求生者【全部】走 AI。不能沿用 i=1 起始,否则漏掉 0 号。
        for (let i = 0; i < this.survivors.length; i++) this.survivors[i].update(this, dt)
        this.updateHunterTarget()
        h.update(this, dt)
      } else {
        this.updatePlayer(p, dt, frame.dx, frame.dy, frame.space)
        for (let i = 1; i < this.survivors.length; i++) this.survivors[i].update(this, dt)
        this.hunter.update(this, dt)
      }
      this.world.update(dt, this.time)
      // 椅子透视高亮:求生者局高亮队友;杀手局高亮所有上椅者(便于守椅)
      for (const ch of this.world.chairs) {
        const occ = ch.occupiedBy >= 0 ? this.survivors[ch.occupiedBy] : null
        const show = !!occ && occ.status === 'chaired' && (isHunter || !occ.isPlayer)
        if (ch.highlight.visible !== show) ch.highlight.visible = show
      }
      // ── 3. 终局判定 ──
      const activeSurvivors = this.survivors.filter((s) => s.alive).length
      if (isHunter) {
        const escaped = this.survivors.filter((s) => s.status === 'escaped').length
        // 全灭即结束;已 3 人逃脱且场上剩 ≤1 人时最多再拿 1 杀(必负),提前结算避免干等
        if (activeSurvivors === 0 || (escaped >= 3 && activeSurvivors <= 1 && !h.carrying())) {
          this.endGame(false, '')
        } else if (this.time > MATCH_TIME_LIMIT) {
          // 保险丝:任何状态机异常(如求生者卡在 carried)都不得导致永不结算
          this.endGame(false, '达到时长上限,本局结束。')
        }
      } else if (activeSurvivors === 0 && !this.over) {
        const playerEliminated = !p.alive
        this.endGame(playerEliminated, playerEliminated ? '全员被淘汰,猎人获胜。' : '')
      }
    }

    // ── 4. 音频层 ──
    let terror = 0
    let chased = false
    if (isHunter) {
      // 杀手没有心跳;terror 通道改传"猎物接近度"(同样 0..1),驱动暗金暗角与追击音乐
      const prey = h.findNearestPrey(this)
      terror = prey && !this.over ? clamp(1 - prey.dist / 16, 0, 1) : 0
      chased = !!prey && prey.dist < 12 && !h.carrying() && !this.over
      this.audio.setHum(false)
    } else {
      const hd = dist(p.x, p.z, h.x, h.z)
      terror = p.alive && !this.over ? clamp(1 - hd / TERROR_RADIUS, 0, 1) : 0
      chased = this.isChased(p) && p.alive && !this.over
      this.audio.setHum(this.isPlayerDecoding(p))
    }
    this.audio.update(dt, terror)
    if (chased !== this.chaseMusicOn) {
      this.chaseMusicOn = chased
      this.audio.setChase(chased)
    }

    // ── 5. 相机 ──
    this.updateCamera(dt)

    // ── 6. HUD 推送(先推共享项,再按角色分流)──
    const overall =
      this.world.ciphers.reduce((acc, c) => acc + (c.done ? 1 : c.progress), 0) / this.world.ciphers.length
    setHud({ overall, terror, chase: chased, survivors: this.getHudSurvivors() })
    if (isHunter) {
      const chair = h.carrying() && h.chairTarget >= 0 ? this.world.chairs[h.chairTarget] : null
      const carried = h.carrying() ? this.survivors[h.carriedId] : null
      setHud({
        role: 'hunter',
        hunterState: h.state,
        attackCd: h.attackCd,
        teleportCd: h.teleportCd,
        chaseBuff: h.chaseBuffPct,
        carryName: carried ? carried.name : null,
        carryChairDist: chair ? dist(h.x, h.z, chair.x, chair.z) : -1,
        kills: this.kills,
        prompt: this.hunterPrompt,
        // 求生者专属项在杀手局一律置空(避免结算前残留上一局的值)
        playerStatus: 'healthy',
        stamina: 1,
        dashCd: 0,
        qte: null,
        chairTimeLeft: -1,
        healProgress: -1,
        stats: { decode: 0, chaseTime: 0, rescues: 0, downs: this.stats.downs, kills: this.kills },
        minimap: this.buildMinimapHunter(),
      })
    } else {
      setHud({
        role: 'survivor',
        hunterState: null,
        playerStatus: p.status,
        stamina: p.stamina,
        dashCd: p.dashCd,
        healProgress: p.healProgress > 0 && p.healProgress < 1 ? p.healProgress : -1,
        chairTimeLeft: p.status === 'chaired' ? Math.max(0, p.chairTimer) : -1,
        qte: this.qte.active
          ? { needle: this.qte.needle, zoneStart: this.qte.zoneStart, zoneSize: this.qte.zoneSize }
          : null,
        stats: {
          decode: Math.round(this.stats.decode * 100),
          chaseTime: Math.round(this.stats.chaseTime),
          rescues: this.stats.rescues,
          downs: this.stats.downs,
          kills: this.kills,
        },
        minimap: this.buildMinimapSurvivor(p, terror),
      })
    }

    // ── 7. 灯光裁剪 + 渲染(杀手视野更广)──
    this.cullLights(isHunter ? h.x : p.x, isHunter ? h.z : p.z, isHunter ? 22 : 18)

    this.renderer.render(this.scene, this.camera)
  }

  // ---- 玩家扮演杀手:输入、移动、提示 ----
  private updatePlayerHunter(dt: number, f: InputFrame): void {
    const h = this.hunter

    // 1) 相机旋转(与求生者一致,受鼠标灵敏度设置影响)
    const sens = this.settings.mouseSens
    this.camYaw -= f.dx * 0.0024 * sens
    this.camPitch = clamp(this.camPitch - f.dy * 0.0022 * sens, -1.15, 0.5)

    // 2) 朝向恒等于视角朝向:保证"攻击方向 = 视角方向",扛人跟随也以 yaw 为准。
    //    移动时【不再】覆盖 yaw,否则攻击朝向会跟着移动方向偏。
    h.yaw = this.camYaw

    // 3) 边沿输入:扛人时 E 语义变为"放下(放血)",其余动作整体禁用
    if (h.carrying()) {
      if (f.e) h.playerDropCarried(this)
    } else if (h.canAct()) {
      if (f.atk) h.playerAttack(this) // 左键:挥刀(内部有 attackCd 守卫)
      if (f.q && h.playerTeleport(this)) this.toast('瞬移!')
      // E 上下文判定:优先扛起倒地者,其次破坏倒下的木板
      if (f.e && !h.playerTryPickup(this)) h.playerTryBreak(this)
      if (f.space) h.playerTryVault(this) // Space:翻窗(倒板只能破坏,不可翻越)
    }

    // 4) 移动:速度倍率随状态机变化
    let mul = 1
    if (h.busy() || h.vaultT > 0) mul = 0 // 眩晕/破板/扛起/挂椅/瞬移/翻窗 → 定身
    else if (h.state === 'attack') mul = 0.5 // 前摇:半速逼近
    else if (h.state === 'recover') mul = 0.6 // 后摇:60% 速

    const ax = this.input.axis()
    const len = Math.hypot(ax.x, ax.z)
    if (len > 0 && mul > 0) {
      const sin = Math.sin(this.camYaw)
      const cos = Math.cos(this.camYaw)
      // 屏幕右 = (-cos, sin);前方 = (sin, cos)
      const wx = (-ax.x * cos - ax.z * sin) / len
      const wz = ax.x * sin - ax.z * cos
      const sp = h.carrying() ? SPEED.hunterPlayerCarry : h.playerMoveSpeed() * mul
      h.moveWithCollision(this, wx * sp * dt, wz * sp * dt)
      h.speedNow = sp
    } else {
      h.speedNow = 0
    }

    // 5) 底部交互提示
    this.updateHunterPrompt(h)
  }

  // 维护 hunter.target:驱动 AI 求生者的逃跑/冲刺决策与追击音乐。
  // 不能在 busy()/扛人时覆盖,否则会打乱攻击与扛人已锁定的目标。
  private updateHunterTarget(): void {
    const h = this.hunter
    if (h.busy() || h.carrying()) return
    let best = -1
    let bd = 22 * 22
    for (const s of this.survivors) {
      if (!s.alive || s.incapacitated) continue
      if (losBlocked(h.x, h.z, s.x, s.z, this.world.tallWalls)) continue
      const d2 = dist2(h.x, h.z, s.x, s.z)
      if (d2 < bd) {
        bd = d2
        best = s.id
      }
    }
    h.target = best
  }

  private updateHunterPrompt(h: Hunter): void {
    const set = (text: string, progress: number | null = null): void => {
      this.hunterPrompt = { text, progress }
    }
    if (h.carrying()) {
      const s = this.survivors[h.carriedId]
      const ch = h.chairTarget >= 0 ? this.world.chairs[h.chairTarget] : null
      set(
        ch
          ? `扛着 ${s ? s.name : '求生者'} — 前往狂欢之椅 (${Math.round(dist(h.x, h.z, ch.x, ch.z))}m) · 按 E 放下(放血)`
          : `扛着 ${s ? s.name : '求生者'} — 附近没有空椅子`,
      )
      return
    }
    if (h.state === 'breakpallet') return set('破坏木板中…', 1 - h.breakT / 2.0)
    if (h.state === 'pickup') return set('扛起中…', 1 - h.pickupT / 1.3)
    if (h.state === 'chair') return set('绑上狂欢之椅…', 1 - h.chairT / 2.0)
    if (h.state === 'stunned') return set(`被木板砸晕 ${h.stunT.toFixed(1)}s`)
    if (h.state === 'teleport') return set(h.teleportPhase === 'windup' ? '瞬移蓄力…' : '瞬移后摇…')
    // 情境提示(优先级:倒地者 > 倒板 > 窗户)
    for (const s of this.survivors) {
      if (s.status === 'downed' && dist2(h.x, h.z, s.x, s.z) < 2.4 * 2.4) return set(`按 E 扛起 ${s.name}`)
    }
    for (const pl of this.world.pallets) {
      if (pl.state === 'down' && dist(h.x, h.z, pl.x, pl.z) < 1.9) return set('按 E 破坏木板')
    }
    for (const w of this.world.windows) {
      if (dist(h.x, h.z, w.x, w.z) < 1.6) return set('按 Space 翻越窗户')
    }
    this.hunterPrompt = null
  }

  // 杀手情报规则:求生者仅在「受击流血中 / 噪音波及 / 近距离感知圈内」才暴露在小地图上。
  // 全图透视会让杀手过强,与"躲藏 — 搜寻"的核心张力冲突。
  private isPreyVisible(s: Survivor): boolean {
    const h = this.hunter
    if (s.revealT > 0) return true // 受击后 5s 透视(同时有穿墙红框)
    if (dist2(s.x, s.z, h.x, h.z) < HUNTER_SENSE_RADIUS * HUNTER_SENSE_RADIUS) return true
    for (const no of this.noises) {
      if (dist2(s.x, s.z, no.x, no.z) < HUNTER_NOISE_RADIUS * HUNTER_NOISE_RADIUS) return true
    }
    return false
  }

  // 灯光裁剪:只保留距镜头 18m(求生者)/ 22m(杀手)内的可裁剪光源,其余关闭
  // (玩家提灯不在此列,始终亮)。限制同时点亮的 PointLight 数量,防远处灯光争抢槽位闪烁。
  // 杀手视野更广:他是主动搜寻的一方,需要看得更远。
  private cullLights(x: number, z: number, maxDist = 18): void {
    const maxDist2 = maxDist * maxDist
    for (const cl of this.world.cullableLights) {
      const on = dist2(x, z, cl.x, cl.z) < maxDist2
      if (cl.light.visible !== on) cl.light.visible = on
    }
  }

  // 获取 HUD 幸存者列表(带缓存):仅在某人状态变化时重建数组,避免每帧 .map 产生 GC。
  // key 里的上椅倒计时取整秒,保证每秒才重建一次(否则浮点每帧变化会让缓存彻底失效)。
  private getHudSurvivors(): import('./bridge').SurvivorChip[] {
    const key = this.survivors
      .map((s) => `${s.status}|${s.chairCount}|${s.status === 'chaired' ? Math.ceil(s.chairTimer) : ''}`)
      .join(',')
    if (key === this.hudSurvivorsKey) return this.hudSurvivorsCache
    this.hudSurvivorsKey = key
    this.hudSurvivorsCache = this.survivors.map((s) => ({
      name: s.name,
      status: s.status,
      isPlayer: s.isPlayer,
      chairCount: s.chairCount,
      chairTimer: s.status === 'chaired' ? Math.ceil(s.chairTimer) : undefined,
    }))
    return this.hudSurvivorsCache
  }

  // 小地图(求生者视角):坐标归一化到 -1..1。监管者仅在心跳范围内显示(避免全图透视)。
  private buildMinimapSurvivor(p: Survivor, terror: number): MinimapData {
    const n = (v: number): number => (v + 35) / 70 * 2 - 1
    return {
      self: p.alive ? { x: n(p.x), z: n(p.z) } : null,
      player: p.alive ? { x: n(p.x), z: n(p.z) } : null,
      mates: this.survivors
        .filter((s) => !s.isPlayer && s.alive)
        .map((s) => ({ x: n(s.x), z: n(s.z) })),
      prey: [],
      noises: [],
      chairTarget: null,
      ciphers: this.world.ciphers.map((c) => ({ x: n(c.x), z: n(c.z), done: c.done, progress: c.progress })),
      chairs: this.world.chairs.map((c) => ({ x: n(c.x), z: n(c.z), occupied: c.occupiedBy !== -1 })),
      gates: this.world.gates.map((g) => ({ x: n(g.x), z: n(g.z), opened: g.opened || g.opening })),
      hunter: terror > 0.1 ? { x: n(this.hunter.x), z: n(this.hunter.z) } : null,
    }
  }

  // 小地图(杀手视角):自己是猎人恒可见;求生者仅在 isPreyVisible 成立时出现。
  // 密码机带 progress 让杀手看出哪台快破完 —— 这是他决定"去哪守"的主要依据。
  private buildMinimapHunter(): MinimapData {
    const n = (v: number): number => (v + 35) / 70 * 2 - 1
    const h = this.hunter
    return {
      self: { x: n(h.x), z: n(h.z) },
      player: null,
      mates: [],
      prey: this.survivors
        .filter((s) => s.alive && this.isPreyVisible(s))
        .map((s) => ({ x: n(s.x), z: n(s.z), bleeding: s.revealT > 0 })),
      noises: this.noises.map((no) => ({ x: n(no.x), z: n(no.z), k: clamp(no.ttl / 6, 0, 1) })),
      chairTarget:
        h.carrying() && h.chairTarget >= 0
          ? { x: n(this.world.chairs[h.chairTarget].x), z: n(this.world.chairs[h.chairTarget].z) }
          : null,
      ciphers: this.world.ciphers.map((c) => ({ x: n(c.x), z: n(c.z), done: c.done, progress: c.progress })),
      chairs: this.world.chairs.map((c) => ({ x: n(c.x), z: n(c.z), occupied: c.occupiedBy !== -1 })),
      gates: this.world.gates.map((g) => ({ x: n(g.x), z: n(g.z), opened: g.opened || g.opening })),
      hunter: null,
    }
  }

  private isPlayerDecoding(p: Survivor): boolean {
    return p.decoding && !this.over
  }

  // ---- 玩家控制 ----
  private updatePlayer(p: Survivor, dt: number, mdx: number, mdy: number, space: boolean): void {
    // 相机旋转
    // 鼠标灵敏度:基础值 × 用户设置倍率
    const sens = this.settings.mouseSens
    this.camYaw -= mdx * 0.0024 * sens
    this.camPitch = clamp(this.camPitch - mdy * 0.0022 * sens, -1.15, 0.5)

    p.update(this, dt) // 通用姿态( chaired/carried 直接返回 )
    if (!p.alive) {
      setHud({ prompt: null })
      return
    }

    if (p.status === 'carried' || p.status === 'chaired') {
      p.decoding = false
      setHud({ prompt: null })
      return
    }

    // 翻越/放板动画中:锁定移动(相机仍可用)
    if (p.actionLocked) return

    const ax = this.input.axis()

    if (p.status === 'downed') {
      // 倒地爬行
      setHud({ prompt: null })
      const len = Math.hypot(ax.x, ax.z)
      if (len > 0) {
        const sin = Math.sin(this.camYaw)
        const cos = Math.cos(this.camYaw)
        // 屏幕右 = (-cos, 0, sin),前方 = (sin, 0, cos)
        const wx = (-ax.x * cos - ax.z * sin) / len
        const wz = (ax.x * sin - ax.z * cos) / len
        p.tryMove(this, wx * SPEED.crawl * dt, wz * SPEED.crawl * dt)
        p.yaw = Math.atan2(wx, wz)
        p.speedNow = SPEED.crawl
      } else {
        p.speedNow = 0
      }
      return
    }

    // 情境动作:Space
    if (space) {
      if (this.qte.active) {
        // 由 QTE 更新消费
      } else if (this.tryPlayerVault(p)) {
        // 翻窗成功
      } else if (this.tryPlayerPallet(p)) {
        // 放板成功
      }
    }

    // 交互:E
    const interacting = this.updateInteraction(p, dt)

    // 移动
    const len = Math.hypot(ax.x, ax.z)
    let sp = 0
    // 被治疗的求生者(healProgress 在 0..1 之间)无法移动:正在接受治疗,需保持静止
    const beingHealed = p.healProgress > 0 && p.healProgress < 1
    if (len > 0 && !interacting && !beingHealed) {
      const wantSprint = ax.sprint && p.stamina > 0.02
      sp = wantSprint ? SPEED.survSprint : SPEED.survWalk
      if (p.boostTimer > 0) sp += SPEED.survInjuredSprintBonus
      if (wantSprint) {
        p.stamina = Math.max(0, p.stamina - dt / 2.75) // 体力上限减半(更快耗尽)
      } else {
        p.stamina = Math.min(1, p.stamina + dt / 7)
      }
      const sin = Math.sin(this.camYaw)
      const cos = Math.cos(this.camYaw)
      // 屏幕右 = (-cos, 0, sin),前方 = (sin, 0, cos)
      const wx = (-ax.x * cos - ax.z * sin) / len
      const wz = (ax.x * sin - ax.z * cos) / len
      p.tryMove(this, wx * sp * dt, wz * sp * dt)
      p.yaw = Math.atan2(wx, wz)
      // 逃脱检测
      this.checkEscape(p)
    } else {
      p.stamina = Math.min(1, p.stamina + dt / 7)
      sp = 0
    }
    p.speedNow = sp

    // QTE(仅破译中)
    const wasActive = this.qte.active
    const res = this.qte.update(dt, p.decoding, space)
    if (!wasActive && this.qte.active) this.sfx('qtePop')
    if (res) {
      if (res.success) {
        this.sfx('qteGood')
        this.toast('检定成功')
      } else {
        this.sfx('qteBad')
        this.toast('检定失败!噪音引来了猎人…', true)
        this.addNoise(p.x, p.z)
      }
    }
    if (this.qte.active && !p.decoding) this.qte.cancel()
  }

  private checkEscape(p: Survivor): void {
    for (const g of this.world.gates) {
      if (!g.opened && !g.opening) continue
      if (Math.abs(p.x - g.x) < 2.0 && Math.abs(p.z - g.z) < 1.4) {
        this.onSurvivorEscaped(p)
        return
      }
    }
  }

  private tryPlayerVault(p: Survivor): boolean {
    // 窗户
    for (const w of this.world.windows) {
      if (dist(p.x, p.z, w.x, w.z) < 1.7) {
        const off = 1.25
        let tx: number
        let tz: number
        // 跨越到另一侧:目标点在与玩家相反的一边
        if (w.axis === 'x') {
          tx = w.x + (p.x > w.x ? -off : off)
          tz = w.z
        } else {
          tx = w.x
          tz = w.z + (p.z > w.z ? -off : off)
        }
        p.startVault(tx, tz, 0.9)
        this.sfx('vault')
        return true
      }
    }
    // 放倒的木板也可翻越:必须垂直于长轴跨越(从板的一侧翻到另一侧)
    for (const pl of this.world.pallets) {
      if (pl.state !== 'down') continue
      if (dist(p.x, p.z, pl.x, pl.z) < 1.6) {
        const off = 1.5
        let tx: number
        let tz: number
        if (pl.axis === 'x') {
          // 长边沿 x → 沿 z 跨越
          tx = pl.x
          tz = pl.z + (p.z > pl.z ? -off : off)
        } else {
          // 长边沿 z → 沿 x 跨越
          tx = pl.x + (p.x > pl.x ? -off : off)
          tz = pl.z
        }
        p.startVault(tx, tz, 0.9)
        this.sfx('vault')
        return true
      }
    }
    return false
  }

  private tryPlayerPallet(p: Survivor): boolean {
    for (const pl of this.world.pallets) {
      if (pl.state !== 'up') continue
      if (dist(p.x, p.z, pl.x, pl.z) < 1.9) {
        pl.state = 'down'
        // 倒下过渡动画:碰撞立即生效,视觉由 world.update 补间 pivot 旋转
        pl.fallT = pl.fallDur
        this.world.colliders.push(pl.collider)
        this.nav.setDynamicAABB(pl.collider, true)
        // 玩家若站在板内,推到较近一侧,避免卡进碰撞体
        if (pl.axis === 'x') {
          if (Math.abs(p.z - pl.z) < 0.7) p.z = pl.z + (p.z >= pl.z ? 0.85 : -0.85)
        } else {
          if (Math.abs(p.x - pl.x) < 0.7) p.x = pl.x + (p.x >= pl.x ? 0.85 : -0.85)
        }
        this.sfx('vault')
        p.startDrop() // 1.2s 放板动画,锁定移动
        // 砸晕判定:猎人位于倒板覆盖区域附近即被砸
        const stunBox = {
          minX: pl.collider.minX - 0.35,
          maxX: pl.collider.maxX + 0.35,
          minZ: pl.collider.minZ - 0.35,
          maxZ: pl.collider.maxZ + 0.35,
        }
        if (circleHits(this.hunter.x, this.hunter.z, 0.45, stunBox)) {
          this.hunter.stun(this)
        }
        return true
      }
    }
    return false
  }

  // E 交互:返回是否在持续交互(用于打断移动)
  private updateInteraction(p: Survivor, dt: number): boolean {
    const e = this.input.eHeld
    p.decoding = false
    let prompt: string | null = null
    let progress: number | null = null
    let busy = false
    let kind: typeof this.channelKind = 'none'
    let target = -1

    // 被治疗中(他人正在治疗本玩家):无法移动/破译,显示提示
    const beingHealed = p.healProgress > 0 && p.healProgress < 1
    // 1) 密码机(被治疗中禁止破译)
    let cipher: Cipher | null = null
    if (!beingHealed) {
      for (const c of this.world.ciphers) {
        if (!c.done && dist2(p.x, p.z, c.x, c.z) < 2.4 * 2.4) {
          cipher = c
          break
        }
      }
    }
    // 2) 上椅队友(救人)
    let chairedMate: Survivor | null = null
    for (const s of this.survivors) {
      if (s.id !== p.id && s.status === 'chaired' && dist2(p.x, p.z, s.x, s.z) < 2.3 * 2.3) {
        chairedMate = s
        break
      }
    }
    // 3) 受伤队友(治疗)——破译中无法被治疗(双向约束)
    let hurtMate: Survivor | null = null
    let hurtMateBusy: Survivor | null = null // 受伤但在破译,用于提示
    for (const s of this.survivors) {
      if (s.id !== p.id && s.status === 'injured' && dist2(p.x, p.z, s.x, s.z) < 2.0 * 2.0) {
        // 双向禁止:对方在破译,或自己正在破译,都不能治疗
        if (s.decoding || p.decoding) {
          hurtMateBusy = s
        } else {
          hurtMate = s
        }
        break
      }
    }
    // 4) 电闸
    let gate: Gate | null = null
    if (this.gatePowered) {
      for (const g of this.world.gates) {
        if (!g.opened && !g.opening && dist2(p.x, p.z, g.switchX, g.switchZ) < 2.2 * 2.2) {
          gate = g
          break
        }
      }
    }

    if (chairedMate) {
      prompt = `按住 E 救援 ${chairedMate.name}`
      kind = 'rescue'
      target = chairedMate.id
    } else if (cipher) {
      prompt = '按住 E 破译密码机'
      kind = 'none'
      if (e) {
        busy = true
        p.decoding = true
        const rate = dt / 70
        cipher.progress = clamp(cipher.progress + rate, 0, 1)
        this.stats.decode += rate
        p.decodeTotal += rate
        progress = cipher.progress
        if (cipher.progress >= 1 && !cipher.done) {
          cipher.done = true
          p.decoding = false
          this.onCipherDone(cipher)
        }
      }
    } else if (hurtMate) {
      prompt = `按住 E 治疗 ${hurtMate.name}`
      kind = 'heal'
      target = hurtMate.id
    } else if (hurtMateBusy) {
      // 受伤但某方正在破译:仅提示,不可治疗
      prompt = hurtMateBusy.decoding
        ? `${hurtMateBusy.name} 正在破译,无法治疗`
        : '正在破译,无法治疗'
    } else if (gate) {
      prompt = '按住 E 开启电闸门'
      kind = 'gate'
      target = gate.id
    } else {
      // 情境提示
      for (const w of this.world.windows) {
        if (dist(p.x, p.z, w.x, w.z) < 1.7) {
          prompt = '按 Space 翻越窗户'
          break
        }
      }
      if (!prompt) {
        for (const pl of this.world.pallets) {
          if (pl.state === 'up' && dist(p.x, p.z, pl.x, pl.z) < 1.9) {
            prompt = '按 Space 放下木板'
            break
          }
          if (pl.state === 'down' && dist(p.x, p.z, pl.x, pl.z) < 1.6) {
            prompt = '按 Space 翻越木板'
            break
          }
        }
      }
    }

    // 吟唱类交互
    if (kind !== 'none' && target >= 0) {
      if (this.channelKind !== kind || this.channelTarget !== target) {
        this.channelKind = kind
        this.channelTarget = target
        this.playerChannel = 0
      }
      if (e) {
        busy = true
        const need = kind === 'rescue' ? 3 : kind === 'heal' ? 4 : 4
        this.playerChannel += dt
        progress = this.playerChannel / need
        if (this.playerChannel >= need) {
          this.playerChannel = 0
          this.completeChannel(kind, target)
        }
      } else {
        this.playerChannel = Math.max(0, this.playerChannel - dt * 2)
        progress = this.playerChannel > 0 ? this.playerChannel / (kind === 'rescue' ? 3 : 4) : null
      }
    } else if (kind === 'none' && !cipher) {
      this.channelKind = 'none'
      this.channelTarget = -1
      this.playerChannel = 0
    }

    if (!e && cipher) p.decoding = false

    setHud({ prompt: prompt ? { text: prompt, progress } : null })
    return busy
  }

  private completeChannel(kind: 'rescue' | 'heal' | 'gate', target: number): void {
    if (kind === 'rescue') {
      const s = this.survivors[target]
      const p = this.survivors[0]
      if (s && s.status === 'chaired') this.onSurvivorRescued(s, p)
    } else if (kind === 'heal') {
      const s = this.survivors[target]
      if (s && s.status === 'injured') {
        s.healOne()
        this.toast(`${s.name} 被你治好了`)
        this.sfx('rescue')
      }
    } else if (kind === 'gate') {
      const g = this.world.gates[target]
      if (g && !g.opening) {
        this.world.openGate(g)
        this.sfx('gateAlarm')
        this.toast('电闸门开了!快逃!', true)
      }
    }
  }

  // 相机三分流:观战 → 杀手 → 求生者
  private updateCamera(dt: number): void {
    // 观战模式:跟随当前观战目标(存活队友),自动旋转角度
    if (this.spectating) {
      const target =
        this.spectateTargetId >= 0 ? this.survivors[this.spectateTargetId] : null
      const focus = target && target.alive ? target : this.pickSpectateTarget() ?? this.hunter
      if (target && (!target.alive)) {
        // 观战目标也死了,换一个
        const next = this.pickSpectateTarget()
        if (next) {
          this.spectateTargetId = next.id
        } else {
          this.endGame(false, '全员被淘汰,猎人获胜。')
          return
        }
      }
      const distBack = 5.5
      const height = 3.0
      // 绕观战目标缓慢旋转
      const a = this.time * 0.3
      const cx = clamp(focus.x - Math.sin(a) * distBack, -34.4, 34.4)
      const cz = clamp(focus.z - Math.cos(a) * distBack, -34.4, 34.4)
      const cam = this.camera
      const k = Math.min(1, dt * 6)
      cam.position.x += (cx - cam.position.x) * k
      cam.position.y += (height - cam.position.y) * k
      cam.position.z += (cz - cam.position.z) * k
      cam.lookAt(focus.x, 1.2, focus.z)
      return
    }
    // 杀手视角:猎人比求生者高(2.3m vs 1.75m),镜头相应拉远抬高
    const isHunter = this.playerRole === 'hunter'
    const focus = isHunter ? this.hunter : this.survivors[0]
    const distBack = isHunter ? 5.2 : 4.6
    const height = isHunter ? 2.5 : 2.1
    const sin = Math.sin(this.camYaw)
    const cos = Math.cos(this.camYaw)
    const pitchLift = Math.sin(-this.camPitch) * 2.2
    const tx = focus.x - sin * distBack
    const tz = focus.z - cos * distBack
    const cx = clamp(tx, -34.4, 34.4)
    const cz = clamp(tz, -34.4, 34.4)
    const cy = Math.max(0.6, height + pitchLift)
    const cam = this.camera
    const k = Math.min(1, dt * 14)
    cam.position.x += (cx - cam.position.x) * k
    cam.position.y += (cy - cam.position.y) * k
    cam.position.z += (cz - cam.position.z) * k
    // 杀手看向平视略高;求生者倒地时压低视线
    const lookY = isHunter ? 1.6 : this.survivors[0].status === 'downed' ? 0.6 : 1.4
    cam.lookAt(focus.x + sin * 1.2, lookY, focus.z + cos * 1.2)
  }
}
