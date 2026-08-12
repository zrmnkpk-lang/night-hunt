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
import { NavGrid, circleHits } from './navgrid'
import { dist, dist2, clamp } from './types'
import type { NoiseEvent } from './types'
import { SPEED } from './context'
import type { GameCtx } from './context'
import { getHud, pushToast, resetHud, setHud } from './bridge'
import type { HudState } from './bridge'
import { loadSettings, saveSettings } from './settings'
import type { Settings } from './settings'

const SURV_COLORS = [0xb0b0d8, 0x8a9a5b, 0xb08355, 0x6b8fa3]
const TERROR_RADIUS = 26

export class Engine implements GameCtx {
  world!: World
  nav!: NavGrid
  survivors: Survivor[] = []
  hunter!: Hunter
  noises: NoiseEvent[] = []
  time = 0
  gatePowered = false
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
  private stats = { decode: 0, chaseTime: 0, rescues: 0 }
  private escapedTeammates = 0
  private chaseMusicOn = false
  private spectating = false // 玩家被淘汰后进入观战模式
  private spectateTargetId = -1 // 当前观战的队友 id
  // HUD survivors 缓存:仅在状态变化时重建,避免每帧 .map 产生 GC
  private hudSurvivorsCache: { name: string; status: import('./types').SurvivorStatus; isPlayer: boolean }[] = []
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
  }

  dispose(): void {
    this.stop()
    window.removeEventListener('resize', this.resize)
    document.removeEventListener('pointerlockchange', this.onLockChange)
    this.disposeScene()
    this.renderer.dispose()
  }

  private disposeScene(): void {
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const m = o.material
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m.dispose()
      }
    })
  }

  private buildScene(): void {
    this.scene = new THREE.Scene()
    this.world = new World(this.scene)
    this.nav = this.world.nav
    this.survivors = []
    // 监管者先就位,再用其位置约束求生者刷新(保证开局距离 > 12m)
    const HUNTER_X = -8
    const HUNTER_Z = -30
    this.hunter = new Hunter(HUNTER_X, HUNTER_Z, this.settings.difficulty)
    this.scene.add(this.hunter.mesh.group)
    // 求存者随机刷新:全图 ±30 范围内随机,拒绝墙内/距猎人<12m/彼此<3m 的点
    const spawns = this.rollSurvivorSpawns(HUNTER_X, HUNTER_Z)
    for (let i = 0; i < 4; i++) {
      const s = new Survivor(i, i === 0, spawns[i][0], spawns[i][1], SURV_COLORS[i])
      this.survivors.push(s)
      this.scene.add(s.mesh.group)
    }
    Survivor.staticColliders = this.world.colliders
    this.noises = []
    this.time = 0
    this.gatePowered = false
    this.qte = new Qte()
    this.stats = { decode: 0, chaseTime: 0, rescues: 0 }
    this.escapedTeammates = 0
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
  start(): void {
    this.disposeScene()
    this.buildScene()
    resetHud()
    this.audio.ensure()
    setHud({
      phase: 'playing',
      survivors: this.survivors.map((s) => ({ name: s.name, status: s.status, isPlayer: s.isPlayer })),
      ciphersLeft: 5,
      gatePowered: false,
      muted: this.audio.isMuted,
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

  resume(): void {
    if (this.over) return
    this.paused = false
    setHud({ phase: 'playing' })
    this.input.requestLock()
  }

  pause(): void {
    if (this.over || getHud().phase !== 'playing') return
    this.paused = true
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

  isChased(s: Survivor): boolean {
    return this.hunter.state === 'chase' && this.hunter.target === s.id
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

  private endGame(won: boolean, reason: string): void {
    if (this.over) return
    this.over = true
    this.audio.setChase(false)
    this.audio.setHum(false)
    if (won) this.audio.win()
    else this.audio.lose()
    this.input.exitLock()
    // 结算:队友逃脱数(已逃脱 + 若玩家胜利时仍在场上的视为未逃脱)
    setHud({
      phase: won ? 'won' : 'lost',
      endReason: reason,
      escapedTeammates: this.escapedTeammates,
      stats: {
        decode: Math.round(this.stats.decode * 100),
        chaseTime: Math.round(this.stats.chaseTime),
        rescues: this.stats.rescues,
      },
    })
  }

  // ---- 主循环 ----
  private tick(dt: number): void {
    this.time += dt
    const p = this.survivors[0]

    // 噪音衰减
    for (let i = this.noises.length - 1; i >= 0; i--) {
      this.noises[i].ttl -= dt
      if (this.noises[i].ttl <= 0) this.noises.splice(i, 1)
    }

    const frame = this.input.endFrame()
    if (frame.m) this.toggleMute()
    // Esc:playing↔paused 切换(playing→pause 主要由 pointerlockchange 兜底,这里补 paused→resume)
    if (frame.esc) {
      const phase = getHud().phase
      if (phase === 'paused') this.resume()
    }
    // 玩家冲刺技能(Q):玩家朝相机朝向方向冲(比 yaw 更直观)
    if (frame.q && p.canDash()) {
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

    if (!this.over) {
      this.updatePlayer(p, dt, frame.dx, frame.dy, frame.space)
      for (let i = 1; i < this.survivors.length; i++) this.survivors[i].update(this, dt)
      this.hunter.update(this, dt)
      this.world.update(dt, this.time)
      // 队友上椅的椅子:对玩家透视高亮(自己上椅不高亮)
      for (const ch of this.world.chairs) {
        const occ = ch.occupiedBy >= 0 ? this.survivors[ch.occupiedBy] : null
        const show = !!occ && !occ.isPlayer && occ.status === 'chaired'
        if (ch.highlight.visible !== show) ch.highlight.visible = show
      }
      // 终局判定:场上无存活的求生者(全淘汰/逃脱)→ 猎人胜
      const activeSurvivors = this.survivors.filter((s) => s.alive).length
      if (activeSurvivors === 0 && !this.over) {
        const playerEliminated = !p.alive
        this.endGame(playerEliminated, playerEliminated ? '全员被淘汰,猎人获胜。' : '')
      }
    }

    // 音频层
    const hd = dist(p.x, p.z, this.hunter.x, this.hunter.z)
    const terror = p.alive && !this.over ? clamp(1 - hd / TERROR_RADIUS, 0, 1) : 0
    this.audio.update(dt, terror)
    const chased = this.isChased(p) && p.alive && !this.over
    if (chased !== this.chaseMusicOn) {
      this.chaseMusicOn = chased
      this.audio.setChase(chased)
    }
    this.audio.setHum(this.isPlayerDecoding(p))

    // 相机
    this.updateCamera(p, dt)

    // HUD
    const overall =
      this.world.ciphers.reduce((acc, c) => acc + (c.done ? 1 : c.progress), 0) / this.world.ciphers.length
    setHud({
      terror,
      overall,
      chase: chased,
      playerStatus: p.status,
      stamina: p.stamina,
      dashCd: p.dashCd,
      healProgress: p.healProgress > 0 && p.healProgress < 1 ? p.healProgress : -1,
      chairTimeLeft: p.status === 'chaired' ? Math.max(0, p.chairTimer) : -1,
      survivors: this.getHudSurvivors(),
      qte: this.qte.active
        ? { needle: this.qte.needle, zoneStart: this.qte.zoneStart, zoneSize: this.qte.zoneSize }
        : null,
      stats: {
        decode: Math.round(this.stats.decode * 100),
        chaseTime: Math.round(this.stats.chaseTime),
        rescues: this.stats.rescues,
      },
      minimap: this.buildMinimap(p, terror),
    })

    // 灯光裁剪:距玩家 > 18m 的可裁剪光源关闭,避免超 GPU 光源上限导致远处灯光闪烁
    this.cullLights(p)

    this.renderer.render(this.scene, this.camera)
  }

  // 灯光裁剪:只保留距玩家 18m 内的可裁剪光源,其余关闭
  // (玩家提灯不在此列,始终亮)。限制同时点亮的 PointLight 数量,防远处灯光争抢槽位闪烁。
  private cullLights(p: Survivor): void {
    const MAX_DIST = 18
    const MAX_DIST2 = MAX_DIST * MAX_DIST
    for (const cl of this.world.cullableLights) {
      const on = dist2(p.x, p.z, cl.x, cl.z) < MAX_DIST2
      if (cl.light.visible !== on) cl.light.visible = on
    }
  }

  // 获取 HUD 幸存者列表(带缓存):仅在某人状态变化时重建数组,避免每帧 .map 产生 GC
  private getHudSurvivors(): { name: string; status: import('./types').SurvivorStatus; isPlayer: boolean }[] {
    const key = this.survivors.map((s) => s.status).join(',')
    if (key === this.hudSurvivorsKey) return this.hudSurvivorsCache
    this.hudSurvivorsKey = key
    this.hudSurvivorsCache = this.survivors.map((s) => ({ name: s.name, status: s.status, isPlayer: s.isPlayer }))
    return this.hudSurvivorsCache
  }

  // 构建小地图数据:坐标归一化到 -1..1。监管者仅在心跳范围内显示(避免全图透视)。
  private buildMinimap(p: Survivor, terror: number): NonNullable<HudState['minimap']> {
    const n = (v: number): number => (v + 35) / 70 * 2 - 1
    return {
      player: p.alive ? { x: n(p.x), z: n(p.z) } : null,
      mates: this.survivors
        .filter((s) => !s.isPlayer && s.alive)
        .map((s) => ({ x: n(s.x), z: n(s.z) })),
      ciphers: this.world.ciphers.map((c) => ({ x: n(c.x), z: n(c.z), done: c.done })),
      chairs: this.world.chairs.map((c) => ({ x: n(c.x), z: n(c.z), occupied: c.occupiedBy !== -1 })),
      gates: this.world.gates.map((g) => ({ x: n(g.x), z: n(g.z), opened: g.opened || g.opening })),
      hunter: terror > 0.1 ? { x: n(this.hunter.x), z: n(this.hunter.z) } : null,
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
        p.startVault(tx, tz, 1.2)
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
        p.startVault(tx, tz, 1.2)
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
        // 放倒表现:沿长轴放平为低矮长条屏障,仍横跨门洞
        if (pl.axis === 'z') {
          pl.mesh.rotation.z = Math.PI / 2
        } else {
          pl.mesh.rotation.x = Math.PI / 2
        }
        pl.mesh.position.y = 0.1
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

  private updateCamera(p: Survivor, dt: number): void {
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
    const distBack = 4.6
    const height = 2.1
    const sin = Math.sin(this.camYaw)
    const cos = Math.cos(this.camYaw)
    const pitchLift = Math.sin(-this.camPitch) * 2.2
    const tx = p.x - sin * distBack
    const tz = p.z - cos * distBack
    const cx = clamp(tx, -34.4, 34.4)
    const cz = clamp(tz, -34.4, 34.4)
    const cy = Math.max(0.6, height + pitchLift)
    const cam = this.camera
    const k = Math.min(1, dt * 14)
    cam.position.x += (cx - cam.position.x) * k
    cam.position.y += (cy - cam.position.y) * k
    cam.position.z += (cz - cam.position.z) * k
    const lookY = p.status === 'downed' ? 0.6 : 1.4
    cam.lookAt(p.x + sin * 1.2, lookY, p.z + cos * 1.2)
  }
}
