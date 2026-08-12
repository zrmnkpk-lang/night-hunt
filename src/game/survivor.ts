// 幸存者实体 + AI(玩家之外的 3 名队友)
import { makeSurvivorMesh, animateHumanoid } from './characters'
import type { Humanoid, Pose } from './characters'
import { dist, dist2, clamp } from './types'
import type { SurvivorStatus } from './types'
import { losBlocked, circleHits } from './navgrid'
import { SPEED } from './context'
import type { GameCtx } from './context'
import type { Cipher, Gate } from './world'

type AiMode = 'decode' | 'flee' | 'rescue' | 'heal' | 'escape' | 'openGate' | 'idle'

const AI_NAMES = ['阿岚', '老周', '小七']

export class Survivor {
  id: number
  name: string
  isPlayer: boolean
  status: SurvivorStatus = 'healthy'
  x: number
  z: number
  yaw = 0
  mesh: Humanoid
  speedNow = 0
  stamina = 1
  chairTimer = 0
  chairCount = 0
  chairRef: number = -1 // 所在椅子 id
  healProgress = 0 // 被治疗进度(由他人累计)
  boostTimer = 0 // 受击加速
  // AI
  mode: AiMode = 'idle'
  path: { x: number; z: number }[] = []
  pathI = 0
  repathT = 0
  targetCipher: number = -1
  rescueTarget: number = -1
  healTargetId: number = -1
  gateTarget: number = -1
  channelT = 0 // 救人/开门吟唱
  decoding = false
  fleeUntil = 0
  vaultT = 0 // 翻窗动画剩余
  vaultFrom = { x: 0, z: 0 }
  vaultTo = { x: 0, z: 0 }
  vaultDur = 1.2
  dropT = 0 // 放板动画剩余(锁定移动)
  dropDur = 1.2
  decodeTotal = 0 // 统计:破译贡献
  chaseTime = 0 // 统计:被追击时长
  rescues = 0 // 统计:救援次数
  revealT = 0 // 受击后透视高亮剩余时间
  bleedT = 0 // 受伤流血噪音计时:injured 移动时周期性产生噪音供猎人追踪
  // 冲刺技能(Q):沿朝向瞬移 3m,40s 冷却。玩家手动触发,AI 被追时自动触发。
  dashCd = 0 // 剩余冷却(秒)
  dashT = 0 // 冲刺动画剩余(秒)
  dashFrom = { x: 0, z: 0 }
  dashTo = { x: 0, z: 0 }
  dashDur = 0.22
  private outlineOn = false
  private thinkT = 0

  constructor(id: number, isPlayer: boolean, x: number, z: number, color: number, name?: string) {
    this.id = id
    this.isPlayer = isPlayer
    this.x = x
    this.z = z
    this.name = name ?? (isPlayer ? '你' : AI_NAMES[(id - 1) % AI_NAMES.length])
    this.mesh = makeSurvivorMesh(color, isPlayer)
    this.mesh.group.position.set(x, 0, z)
  }

  get alive(): boolean {
    return this.status !== 'eliminated' && this.status !== 'escaped'
  }

  get incapacitated(): boolean {
    return this.status === 'downed' || this.status === 'carried' || this.status === 'chaired'
  }

  pose(): Pose {
    if (this.status === 'downed') return 'crawl'
    if (this.status === 'carried') return 'carried'
    if (this.status === 'chaired') return 'chaired'
    return 'stand'
  }

  // ---- 受到伤害 ----
  hurt(ctx: GameCtx): void {
    // 队友被打后对玩家透视高亮 5 秒
    if (!this.isPlayer) this.revealT = 5
    if (this.status === 'healthy') {
      this.status = 'injured'
      this.boostTimer = 1.8
      ctx.sfx('hit')
      if (this.isPlayer) ctx.toast('你受伤了!快跑!', true)
    } else if (this.status === 'injured') {
      this.status = 'downed'
      this.decoding = false
      ctx.sfx('hit')
      ctx.onSurvivorDowned(this)
    }
  }

  healOne(): void {
    if (this.status === 'injured') {
      this.status = 'healthy'
      this.healProgress = 0
    }
  }

  startVault(toX: number, toZ: number, dur: number): void {
    this.vaultT = dur
    this.vaultDur = dur
    this.vaultFrom = { x: this.x, z: this.z }
    this.vaultTo = { x: toX, z: toZ }
  }

  startDrop(): void {
    this.dropT = this.dropDur
  }

  // 冲刺技能是否可用:冷却完毕 + 未在硬直(翻窗/放板/倒地/被控)
  canDash(): boolean {
    if (this.dashCd > 0) return false
    if (this.dashT > 0 || this.vaultT > 0 || this.dropT > 0) return false
    if (this.status === 'downed' || this.status === 'carried' || this.status === 'chaired') return false
    return true
  }

  // 触发冲刺:沿当前朝向瞬移 3m。穿墙则二分缩短到可走的最远点(<1m 则取消)。
  // dir override:可指定方向(默认 null=沿 yaw)。返回是否成功触发。
  startDash(ctx: GameCtx, dirX?: number, dirZ?: number): boolean {
    if (!this.canDash()) return false
    const DASH_DIST = 3
    const MIN_DIST = 1
    let dx: number
    let dz: number
    if (dirX !== undefined && dirZ !== undefined) {
      const l = Math.hypot(dirX, dirZ) || 1
      dx = dirX / l
      dz = dirZ / l
    } else {
      // 沿朝向:本工程 yaw 运动方向 = (sin, cos)
      dx = Math.sin(this.yaw)
      dz = Math.cos(this.yaw)
    }
    const cols = (ctx.world?.colliders ?? Survivor.staticColliders) as import('./types').AABB[]
    const r = 0.42
    // 线段沿路径采样检测,找最远可达距离(二分)
    const blockedAt = (px: number, pz: number): boolean => {
      for (const c of cols) {
        if (circleHits(px, pz, r, c)) return true
      }
      return ctx.nav.blockedAt(px, pz)
    }
    let best = 0
    // 粗扫 0.5m 步长
    for (let d = 0.5; d <= DASH_DIST + 0.01; d += 0.5) {
      if (blockedAt(this.x + dx * d, this.z + dz * d)) break
      best = d
    }
    if (best < MIN_DIST) {
      // 近距离就撞墙:尝试更细的步长挽救
      for (let d = 0.2; d < MIN_DIST + 0.01; d += 0.2) {
        if (blockedAt(this.x + dx * d, this.z + dz * d)) break
        best = d
      }
      if (best < MIN_DIST) return false // 真的走不动,取消(不进冷却)
    }
    const tx = clamp(this.x + dx * best, -34, 34)
    const tz = clamp(this.z + dz * best, -34, 34)
    this.dashFrom = { x: this.x, z: this.z }
    this.dashTo = { x: tx, z: tz }
    this.dashT = this.dashDur
    this.dashCd = 40
    this.yaw = Math.atan2(dx, dz)
    this.decoding = false
    ctx.sfx('dash')
    return true
  }

  get actionLocked(): boolean {
    return this.vaultT > 0 || this.dropT > 0 || this.dashT > 0
  }

  // 主更新(玩家由 engine 驱动,这里处理通用表现 + AI)
  update(ctx: GameCtx, dt: number): void {
    this.boostTimer = Math.max(0, this.boostTimer - dt)
    this.revealT = Math.max(0, this.revealT - dt)
    this.dashCd = Math.max(0, this.dashCd - dt)
    if (this.status === 'eliminated' || this.status === 'escaped') {
      this.mesh.group.visible = this.status === 'eliminated' ? false : this.mesh.group.visible
      return
    }
    // 冲刺中:插值移动到目标点,期间锁移动
    if (this.dashT > 0) {
      this.dashT -= dt
      const t = 1 - Math.max(0, this.dashT) / this.dashDur
      this.x = this.dashFrom.x + (this.dashTo.x - this.dashFrom.x) * t
      this.z = this.dashFrom.z + (this.dashTo.z - this.dashFrom.z) * t
      this.speedNow = 14
      this.syncMesh(dt, ctx.time)
      // 冲刺视觉:身体前倾 + 拖尾高度
      this.mesh.group.position.y = Math.sin(t * Math.PI) * 0.2
      this.mesh.body.rotation.x = 0.5
      return
    }
    if (this.status === 'chaired') {
      this.chairTimer -= dt
      if (this.chairTimer <= 0) {
        ctx.onSurvivorEliminated(this)
      }
      this.syncMesh(dt, ctx.time)
      return
    }
    if (this.status === 'carried') {
      this.syncMesh(dt, ctx.time)
      return
    }
    if (this.vaultT > 0) {
      this.vaultT -= dt
      const t = 1 - Math.max(0, this.vaultT) / this.vaultDur
      this.x = this.vaultFrom.x + (this.vaultTo.x - this.vaultFrom.x) * t
      this.z = this.vaultFrom.z + (this.vaultTo.z - this.vaultFrom.z) * t
      this.yaw = Math.atan2(this.vaultTo.x - this.vaultFrom.x, this.vaultTo.z - this.vaultFrom.z)
      this.speedNow = 0
      this.syncMesh(dt, ctx.time)
      // 翻越动画:小弧线越过 + 前倾 + 摆腿摆臂
      const arc = Math.sin(t * Math.PI)
      this.mesh.group.position.y = arc * 0.5
      this.mesh.body.rotation.x = 0.55 * arc
      this.mesh.legL.rotation.x = 1.15 * arc
      this.mesh.legR.rotation.x = -0.45 * arc
      this.mesh.armL.rotation.x = -0.9 * arc
      this.mesh.armR.rotation.x = 0.7 * arc
      return
    }
    if (this.dropT > 0) {
      this.dropT -= dt
      this.speedNow = 0
      this.syncMesh(dt, ctx.time)
      // 放板动画:下蹲前倾 + 双臂下压
      const t = 1 - Math.max(0, this.dropT) / this.dropDur
      const bend = Math.sin(Math.min(1, t * 1.15) * Math.PI)
      this.mesh.group.position.y = -0.28 * bend
      this.mesh.body.rotation.x = 0.38 * bend
      this.mesh.armL.rotation.x = -1.15 * bend
      this.mesh.armR.rotation.x = -1.35 * bend
      this.mesh.legL.rotation.x = 0.5 * bend
      this.mesh.legR.rotation.x = 0.5 * bend
      return
    }
    if (this.status === 'downed') {
      if (!this.isPlayer) this.downedCrawl(ctx, dt)
      this.syncMesh(dt, ctx.time)
      return
    }
    if (!this.isPlayer) {
      // 被治疗中(healProgress 在 0..1):无法移动/破译,保持静止等治疗完成
      const beingHealed = this.healProgress > 0 && this.healProgress < 1
      if (beingHealed) {
        this.speedNow = 0
        this.path = []
      } else {
        this.think(ctx, dt)
        this.moveAlongPath(ctx, dt)
      }
    }
    // 受伤流血:injured 且正在移动时,每 ~3 秒产生一次噪音(血迹/呻吟),供猎人追踪
    if (this.status === 'injured' && this.speedNow > 0.5) {
      this.bleedT -= dt
      if (this.bleedT <= 0) {
        this.bleedT = 3
        ctx.addNoise(this.x, this.z)
      }
    } else {
      this.bleedT = 0
    }
    this.syncMesh(dt, ctx.time)
  }

  private downedCrawl(ctx: GameCtx, dt: number): void {
    // 缓慢爬离猎人
    const h = ctx.hunter
    const d = dist(this.x, this.z, h.x, h.z)
    if (d < 8) {
      const dx = (this.x - h.x) / (d || 1)
      const dz = (this.z - h.z) / (d || 1)
      this.tryMove(ctx, dx * SPEED.crawl * dt, dz * SPEED.crawl * dt)
      this.speedNow = SPEED.crawl
    } else {
      this.speedNow = 0
    }
  }

  // ---- AI 决策 ----
  private think(ctx: GameCtx, dt: number): void {
    this.thinkT -= dt
    this.repathT -= dt
    const h = ctx.hunter
    const hd = dist(this.x, this.z, h.x, h.z)
    const hunterNear = hd < 13 && !h.busy()

    // 1) 逃跑优先
    if (hunterNear && h.state !== 'stunned') {
      if (this.mode !== 'flee') {
        this.mode = 'flee'
        this.decoding = false
        this.channelT = 0
        this.repathT = 0
      }
      this.fleeUntil = ctx.time + 3.5
    }
    if (this.mode === 'flee') {
      if (ctx.time > this.fleeUntil && hd > 17) {
        this.mode = 'idle'
        this.path = []
      } else {
        this.flee(ctx, dt)
        return
      }
    }

    if (this.thinkT > 0) {
      this.continueMode(ctx, dt)
      return
    }
    this.thinkT = 0.6 + Math.random() * 0.4

    // 2) 救援:有队友上椅且猎人离椅子远
    const chaired = ctx.survivors.find((s) => s.status === 'chaired')
    if (chaired && chaired.id !== this.id) {
      const chairD = dist(h.x, h.z, chaired.x, chaired.z)
      if (chairD > 15 && !h.carrying()) {
        this.mode = 'rescue'
        this.rescueTarget = chaired.id
        this.continueMode(ctx, dt)
        return
      }
    }

    // 3) 大门通电后:去开门/逃脱
    if (ctx.gatePowered) {
      const gate = this.pickGate(ctx)
      if (gate) {
        this.gateTarget = gate.id
        this.mode = gate.opened || gate.opening ? 'escape' : 'openGate'
        this.continueMode(ctx, dt)
        return
      }
    }

    // 4) 治疗附近受伤队友(安全时)——双向约束:任意一方破译中都不能治疗
    if (this.status === 'healthy' && hd > 20 && !this.decoding) {
      const hurtMate = ctx.survivors.find(
        (s) =>
          s.id !== this.id &&
          s.status === 'injured' &&
          !s.decoding && // 对方在破译则跳过
          dist2(s.x, s.z, this.x, this.z) < 36,
      )
      if (hurtMate) {
        this.mode = 'heal'
        this.healTargetId = hurtMate.id
        this.continueMode(ctx, dt)
        return
      }
    }

    // 5) 破译
    if (this.status === 'healthy' || this.status === 'injured') {
      const c = this.pickCipher(ctx)
      if (c) {
        this.targetCipher = c.id
        this.mode = 'decode'
      } else {
        this.mode = 'idle'
      }
      this.continueMode(ctx, dt)
    }
  }

  private continueMode(ctx: GameCtx, dt: number): void {
    switch (this.mode) {
      case 'decode': {
        const c = ctx.world.ciphers[this.targetCipher]
        if (!c || c.done) {
          this.mode = 'idle'
          this.decoding = false
          return
        }
        const d = dist(this.x, this.z, c.x, c.z)
        if (d < 2.3) {
          this.path = []
          this.decoding = true
          this.speedNow = 0
          const rate = dt / 70
          c.progress = clamp(c.progress + rate, 0, 1)
          this.decodeTotal += rate
          if (c.progress >= 1 && !c.done) {
            c.done = true
            ctx.onCipherDone(c)
          }
        } else {
          this.decoding = false
          this.ensurePath(ctx, c.x, c.z)
        }
        break
      }
      case 'rescue': {
        const t = ctx.survivors[this.rescueTarget]
        if (!t || t.status !== 'chaired') {
          this.mode = 'idle'
          this.channelT = 0
          return
        }
        const hd = dist(ctx.hunter.x, ctx.hunter.z, t.x, t.z)
        if (hd < 11 || ctx.hunter.carrying()) {
          this.mode = 'flee'
          this.fleeUntil = ctx.time + 2.5
          this.channelT = 0
          return
        }
        const d = dist(this.x, this.z, t.x, t.z)
        if (d < 2.2) {
          this.path = []
          this.speedNow = 0
          this.channelT += dt
          if (this.channelT >= 3) {
            this.channelT = 0
            this.rescues++
            ctx.onSurvivorRescued(t, this)
          }
        } else {
          this.channelT = 0
          this.ensurePath(ctx, t.x, t.z)
        }
        break
      }
      case 'heal': {
        const t = ctx.survivors[this.healTargetId]
        if (!t || t.status !== 'injured') {
          this.mode = 'idle'
          return
        }
        // 双向约束:任意一方开始破译 → 中断治疗(状态变更由 think 下轮重新决策)
        if (t.decoding || this.decoding) {
          this.mode = 'idle'
          return
        }
        const d = dist(this.x, this.z, t.x, t.z)
        if (d < 1.8) {
          this.path = []
          this.speedNow = 0
          t.healProgress += dt / 5
          if (t.healProgress >= 1) {
            t.healOne()
            ctx.toast(`${t.name} 被治疗了`)
            this.mode = 'idle'
          }
        } else {
          this.ensurePath(ctx, t.x, t.z)
        }
        break
      }
      case 'openGate': {
        const g = ctx.world.gates[this.gateTarget]
        if (!g) {
          this.mode = 'idle'
          return
        }
        if (g.opened || g.opening) {
          this.mode = 'escape'
          return
        }
        const d = dist(this.x, this.z, g.switchX, g.switchZ)
        if (d < 2.0) {
          this.path = []
          this.speedNow = 0
          this.channelT += dt
          if (this.channelT >= 4) {
            this.channelT = 0
            ctx.world.openGate(g)
            ctx.sfx('gateAlarm')
            ctx.toast('一扇电闸门被打开了!')
            this.mode = 'escape'
          }
        } else {
          this.channelT = 0
          this.ensurePath(ctx, g.switchX, g.switchZ)
        }
        break
      }
      case 'escape': {
        const g = ctx.world.gates[this.gateTarget]
        if (!g || !(g.opened || g.opening)) {
          this.mode = 'idle'
          return
        }
        // 走过门线
        this.ensurePath(ctx, g.x, g.z + g.sign * 2.5)
        if (Math.abs(this.z - g.z) < 1.2 && Math.abs(this.x - g.x) < 2.0) {
          ctx.onSurvivorEscaped(this)
        }
        break
      }
      default:
        this.speedNow = 0
    }
  }

  private pickCipher(ctx: GameCtx): Cipher | null {
    let best: Cipher | null = null
    let bd = Infinity
    for (const c of ctx.world.ciphers) {
      if (c.done) continue
      const d = dist2(this.x, this.z, c.x, c.z) + Math.random() * 120
      if (d < bd) {
        bd = d
        best = c
      }
    }
    return best
  }

  private pickGate(ctx: GameCtx): Gate | null {
    let best: Gate | null = null
    let bd = Infinity
    for (const g of ctx.world.gates) {
      const d = dist2(this.x, this.z, g.switchX, g.switchZ)
      if (d < bd) {
        bd = d
        best = g
      }
    }
    return best
  }

  private flee(ctx: GameCtx, dt: number): void {
    const h = ctx.hunter
    this.decoding = false
    // 被追且猎人逼近(<8m):有冲刺就交,朝远离猎人方向冲
    if (this.canDash()) {
      const hd = dist(this.x, this.z, h.x, h.z)
      if (hd < 8 && ctx.isChased(this)) {
        const ax = (this.x - h.x) / (hd || 1)
        const az = (this.z - h.z) / (hd || 1)
        if (this.startDash(ctx, ax, az)) return
      }
    }
    if (this.repathT <= 0 || this.path.length === 0) {
      this.repathT = 0.7
      // 选远离猎人的板区/角落
      const spots: [number, number][] = [
        [-16, -16], [16, -14], [0, 2], [-14, 14], [16, 16],
        [-28, -28], [28, -28], [-28, 28], [28, 28], [0, -30], [0, 30],
      ]
      let bx = 0
      let bz = 0
      let bs = -Infinity
      for (const [sx, sz] of spots) {
        const dh = dist(sx, sz, h.x, h.z)
        const dm = dist(sx, sz, this.x, this.z)
        const score = dh - dm * 0.55 + Math.random() * 6
        if (score > bs) {
          bs = score
          bx = sx
          bz = sz
        }
      }
      this.path = ctx.nav.findPath(this.x, this.z, bx, bz)
      this.pathI = 0
    }
    this.followPath(dt, true)
  }

  private ensurePath(ctx: GameCtx, tx: number, tz: number): void {
    if (this.repathT <= 0 || this.path.length === 0 || this.pathI >= this.path.length) {
      this.repathT = 1.0
      this.path = ctx.nav.findPath(this.x, this.z, tx, tz)
      this.pathI = 0
    }
  }

  private moveAlongPath(ctx: GameCtx, dt: number): void {
    if (this.mode === 'flee') return // flee 内部自行移动
    this.followPath(dt, false)
    void ctx
  }

  private followPath(dt: number, sprint: boolean): void {
    if (this.pathI >= this.path.length) {
      this.speedNow = 0
      return
    }
    const wp = this.path[this.pathI]
    const d = dist(this.x, this.z, wp.x, wp.z)
    if (d < 0.6) {
      this.pathI++
      return
    }
    const sp = sprint ? SPEED.survAiSprint : SPEED.survWalk
    const dx = ((wp.x - this.x) / d) * sp * dt
    const dz = ((wp.z - this.z) / d) * sp * dt
    this.tryMove(null, dx, dz)
    this.yaw = Math.atan2(wp.x - this.x, wp.z - this.z)
    this.speedNow = sp
  }

  // 碰撞移动(供 AI 与倒地爬行使用);"联合优先 + 分轴滑墙",修复凹墙角穿透。
  // 已与碰撞体重叠时(出生点/被挤入)允许朝任意方向脱离。
  tryMove(ctx: GameCtx | null, dx: number, dz: number): void {
    const colliders = (ctx?.world.colliders ?? Survivor.staticColliders) as import('./types').AABB[]
    const r = 0.42
    const blockedAt = (px: number, pz: number): boolean => {
      for (const c of colliders) {
        if (circleHits(px, pz, r, c) && !circleHits(this.x, this.z, r, c)) return true
      }
      return false
    }
    // 1) 先试联合位移(斜向移动顺畅)
    if (!blockedAt(this.x + dx, this.z + dz)) {
      this.x = clamp(this.x + dx, -34, 34)
      this.z = clamp(this.z + dz, -34, 34)
      return
    }
    // 2) 撞墙 → 试只走 X 轴(贴墙滑行)
    if (!blockedAt(this.x + dx, this.z)) {
      this.x = clamp(this.x + dx, -34, 34)
      return
    }
    // 3) X 也撞 → 试只走 Z 轴
    if (!blockedAt(this.x, this.z + dz)) {
      this.z = clamp(this.z + dz, -34, 34)
      return
    }
    // 4) 都撞 → 不动
  }

  static staticColliders: import('./types').AABB[] = []

  canSee(ctx: GameCtx, tx: number, tz: number): boolean {
    return !losBlocked(this.x, this.z, tx, tz, ctx.world.tallWalls)
  }

  private syncMesh(dt: number, time: number): void {
    const g = this.mesh.group
    g.position.x = this.x
    g.position.z = this.z
    if (this.status !== 'chaired') {
      const targetYaw = this.yaw
      let dy = targetYaw - g.rotation.y
      while (dy > Math.PI) dy -= Math.PI * 2
      while (dy < -Math.PI) dy += Math.PI * 2
      g.rotation.y += dy * Math.min(1, dt * 10)
    }
    // 灯笼暖光闪烁(两层正弦叠加,微妙不稳)
    if (this.mesh.lanternLight) {
      const s = this.mesh.flickerSeed
      const f = Math.sin(time * 9.2 + s) * 0.5 + Math.sin(time * 23.7 + s * 1.7) * 0.5
      const base = this.mesh.lanternBase
      this.mesh.lanternLight.intensity = base * (1 + f * 0.14)
      if (this.mesh.lanternCore) {
        this.mesh.lanternCore.emissiveIntensity = 2.4 + f * 0.5
      }
    }
    // 受击透视轮廓(仅队友,玩家看自己无意义)
    const wantOutline = this.revealT > 0 && !this.isPlayer
    if (wantOutline !== this.outlineOn) {
      this.outlineOn = wantOutline
      for (const o of this.mesh.outline) o.visible = wantOutline
    }
    animateHumanoid(this.mesh, dt, this.speedNow, this.pose(), time)
    // 受伤姿态:略微弯腰
    if (this.status === 'injured') {
      this.mesh.body.rotation.x = 0.18
    } else {
      this.mesh.body.rotation.x = 0
    }
  }
}
