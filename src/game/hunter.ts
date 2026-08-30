// 猎人实体 + AI(巡逻/调查/追击/攻击/搬运/挂椅)
import * as THREE from 'three'
import { makeHunterMesh, animateHumanoid } from './characters'
import type { Humanoid } from './characters'
import { dist, dist2, clamp, lerp } from './types'
import type { HunterState } from './types'
import { losBlocked, circleHits, segmentHitsAABB } from './navgrid'
import { SPEED } from './context'
import type { GameCtx } from './context'
import type { Survivor } from './survivor'

const ATTACK_RANGE = 2.86 // 攻击触发距离(+30% 原 2.2),命中判定自动跟随
const ATTACK_WINDUP = 0.22 // 攻击前摇(大幅加快,期间可半速移动)
const SIGHT_RANGE = 19
const HEAR_RANGE = 30

// ===== AI 参数类型 + 难度工厂 =====
// 监管者 AI 调参区:按难度生成实例参数,注入 Hunter。
export interface HunterAI {
  LEAD_TIME: number
  LEAD_MAX: number
  LEAD_SMOOTH: number
  REPATH_SEEN_NEAR: number
  REPATH_SEEN_FAR: number
  REPATH_BLIND: number
  REPATH_STATIC: number
  CHASE_DIRECT_RANGE: number
  STUCK_LATERAL_IMPULSE: number
  TELEPORT_CD: number
  TELEPORT_WINDUP: number
  TELEPORT_AFTER: number
  TELEPORT_MIN_DIST: number
  TELEPORT_MIN_CHASE: number
  TELEPORT_RECENT_SEEN: number
  TELEPORT_LEAD_OFFSET: number
  CHASE_BUFF_RANGE: number
  CHASE_BUFF_INTERVAL: number
  CHASE_BUFF_STEP: number
  CHASE_BUFF_MAX_STEPS: number
  CHASE_BUFF_DECAY: number
}

// normal 档基准值(easy/hard 在此基础上调整关键参数)
const AI_NORMAL: HunterAI = {
  LEAD_TIME: 0.35,
  LEAD_MAX: 4.5,
  LEAD_SMOOTH: 0.3,
  REPATH_SEEN_NEAR: 0.3,
  REPATH_SEEN_FAR: 0.55,
  REPATH_BLIND: 0.75,
  REPATH_STATIC: 1.0,
  CHASE_DIRECT_RANGE: 9,
  STUCK_LATERAL_IMPULSE: 0.6,
  TELEPORT_CD: 60,
  TELEPORT_WINDUP: 1.0,
  TELEPORT_AFTER: 1.0,
  TELEPORT_MIN_DIST: 12,
  TELEPORT_MIN_CHASE: 4,
  TELEPORT_RECENT_SEEN: 2,
  TELEPORT_LEAD_OFFSET: 2.5,
  CHASE_BUFF_RANGE: 10,
  CHASE_BUFF_INTERVAL: 5,
  CHASE_BUFF_STEP: 0.02,
  CHASE_BUFF_MAX_STEPS: 5,
  CHASE_BUFF_DECAY: 1,
}

// 按难度生成 AI 参数(easy 弱 / normal 基准 / hard 强)
export function makeHunterAI(difficulty: 'easy' | 'normal' | 'hard'): HunterAI {
  if (difficulty === 'easy') {
    return {
      ...AI_NORMAL,
      LEAD_TIME: 0.25, // 预测更弱,容易被绕
      TELEPORT_CD: 90, // 瞬移更稀
      TELEPORT_MIN_CHASE: 6, // 更不倾向交技能
      CHASE_BUFF_STEP: 0.012, // 速度叠加更慢(+1.2%/档)
      CHASE_BUFF_MAX_STEPS: 4, // 上限更低(+4.8%)
    }
  }
  if (difficulty === 'hard') {
    return {
      ...AI_NORMAL,
      LEAD_TIME: 0.45, // 预测更强,擅抄近路
      TELEPORT_CD: 45, // 瞬移更勤
      TELEPORT_MIN_CHASE: 3,
      TELEPORT_MIN_DIST: 10, // 更近就交
      CHASE_BUFF_STEP: 0.03, // 速度叠加更快(+3%/档)
      CHASE_BUFF_MAX_STEPS: 7, // 上限更高(+21%)
    }
  }
  return { ...AI_NORMAL }
}

export class Hunter {
  x: number
  z: number
  yaw = 0
  mesh: Humanoid
  state: HunterState = 'patrol'
  // AI 参数(按难度注入)
  readonly ai: HunterAI
  // 监管者速度倍率(按难度):easy<1, hard>1,只作用于猎人自身速度
  private readonly speedMul: number
  speedNow = 0
  target: number = -1 // survivor id
  path: { x: number; z: number }[] = []
  pathI = 0
  repathT = 0
  attackCd = 0
  attackWindup = 0
  stunT = 0
  breakT = 0
  breakPalletId = -1
  pickupT = 0
  chairT = 0
  carriedId = -1
  chairTarget = -1
  patrolI = 0
  investigatePos = { x: 0, z: 0 }
  investigateT = 0
  loseT = 0 // 丢失目标计时
  vaultT = 0
  vaultFrom = { x: 0, z: 0 }
  vaultTo = { x: 0, z: 0 }
  vaultDur = 1.7
  spottedToastDone = false
  recoverT = 0
  // 瞬移技能(全图,1s 蓄力 + 瞬移 + 1s 后摇,60s 冷却)。AI 自动判断追击时使用。
  teleportCd = 0
  teleportPhase: 'none' | 'windup' | 'after' = 'none'
  teleportT = 0
  teleportTarget = { x: 0, z: 0 }
  // 追击计时:用于判断"是否值得交瞬移"(追逐超过阈值才用)
  chaseDurationT = 0
  // 追击速度叠加:目标 10m 内时每 5s +2%,上限 +10%(即 5 档),脱离范围则衰减
  private chaseSpeedBuff = 0 // 当前叠加档数(0..5)
  private chaseBuffT = 0 // 距离上次叠加的计时
  // 最近一次见到目标的时间(瞬移要求不能盲传)
  lastSeenT = 0
  // 卡墙检测
  private stuckT = 0
  private lastX = 0
  private lastZ = 0
  // 目标速度估计(lead targeting):用上一帧目标位置差分 + 指数平滑,
  // 不污染 Survivor 接口。target 为 -1 或切换目标时重置。
  private lastTargetX = 0
  private lastTargetZ = 0
  private targetVX = 0
  private targetVZ = 0
  private targetTracked = false // 当前目标是否已有过一次采样(用于丢弃首帧巨大差分)
  // 警示红光扇形(身前 60° 地面贴花)
  private sector: THREE.Mesh
  private sectorMat: THREE.MeshBasicMaterial
  private sectorFlashT = 0
  // 瞬移特效:windup 期间向上的聚光柱,after 期间地面散光环
  private teleportPillar: THREE.Mesh
  private teleportPillarMat: THREE.MeshBasicMaterial
  private teleportRing: THREE.Mesh
  private teleportRingMat: THREE.MeshBasicMaterial

  constructor(x: number, z: number, difficulty: 'easy' | 'normal' | 'hard' = 'normal') {
    this.x = x
    this.z = z
    this.ai = makeHunterAI(difficulty)
    this.speedMul = difficulty === 'easy' ? 0.9 : difficulty === 'hard' ? 1.08 : 1.0
    this.mesh = makeHunterMesh()
    this.mesh.group.position.set(x, 0, z)
    // 60° 扇形,半径 2m,朝向本地 +z(面朝方向)
    const geo = new THREE.CircleGeometry(2, 24, -Math.PI / 2 - Math.PI / 6, Math.PI / 3)
    this.sectorMat = new THREE.MeshBasicMaterial({
      color: 0x7a1010,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.sector = new THREE.Mesh(geo, this.sectorMat)
    this.sector.rotation.x = -Math.PI / 2
    this.sector.position.y = 0.04
    this.sector.renderOrder = 2
    this.mesh.group.add(this.sector)
    // 瞬移蓄力光柱:细圆柱,AdditiveBlending,windup 时从下往上渐显
    this.teleportPillarMat = new THREE.MeshBasicMaterial({
      color: 0x9b6dff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.teleportPillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 3.0, 16, 1, true), this.teleportPillarMat)
    this.teleportPillar.position.y = 1.5
    this.teleportPillar.renderOrder = 3
    this.teleportPillar.visible = false
    this.mesh.group.add(this.teleportPillar)
    // 瞬移后摇地面环:扁平圆环,after 时扩散
    this.teleportRingMat = new THREE.MeshBasicMaterial({
      color: 0xc09bff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.teleportRing = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.7, 24), this.teleportRingMat)
    this.teleportRing.rotation.x = -Math.PI / 2
    this.teleportRing.position.y = 0.05
    this.teleportRing.renderOrder = 3
    this.teleportRing.visible = false
    this.mesh.group.add(this.teleportRing)
  }

  busy(): boolean {
    return (
      this.state === 'stunned' ||
      this.state === 'breakpallet' ||
      this.state === 'pickup' ||
      this.state === 'chair' ||
      this.state === 'attack' ||
      this.state === 'teleport' ||
      this.vaultT > 0
    )
  }

  carrying(): boolean {
    return this.state === 'carry' && this.carriedId >= 0
  }

  // 玩家扮演杀手时为 true:AI 寻路/巡逻/追击逻辑关闭,移动与朝向由 Engine 驱动
  isPlayerControlled = false
  setPlayerControlled(v: boolean): void {
    this.isPlayerControlled = v
  }

  // 玩家杀手的自由移动速度(Engine 移动时取用):含追击叠加,与 AI 同规则
  playerMoveSpeed(): number {
    return SPEED.hunterPlayerChase * this.speedMul * (1 + this.chaseBuffPct)
  }

  update(ctx: GameCtx, dt: number): void {
    this.attackCd = Math.max(0, this.attackCd - dt)
    this.sectorFlashT = Math.max(0, this.sectorFlashT - dt)
    this.teleportCd = Math.max(0, this.teleportCd - dt)

    // 翻窗中
    if (this.vaultT > 0) {
      this.vaultT -= dt
      const t = 1 - Math.max(0, this.vaultT) / this.vaultDur
      this.x = this.vaultFrom.x + (this.vaultTo.x - this.vaultFrom.x) * t
      this.z = this.vaultFrom.z + (this.vaultTo.z - this.vaultFrom.z) * t
      this.speedNow = 1.2
      this.syncMesh(dt, ctx.time)
      return
    }

    // 玩家扮演:只跑动作状态机(攻击/恢复/扛起/挂椅/破坏/瞬移),移动朝向由 Engine 驱动
    if (this.isPlayerControlled) {
      this.updateAsPlayer(ctx, dt)
      this.syncMesh(dt, ctx.time)
      return
    }

    switch (this.state) {
      case 'stunned':
        this.stunT -= dt
        this.speedNow = 0
        if (this.stunT <= 0) this.state = 'patrol'
        break
      case 'breakpallet': {
        this.breakT -= dt
        this.speedNow = 0
        if (this.breakT <= 0) {
          const p = ctx.world.pallets[this.breakPalletId]
          if (p && p.state === 'down') {
            p.state = 'broken'
            p.mesh.visible = false
            ctx.nav.setDynamicAABB(p.collider, false)
            // 移除碰撞
            const cols = ctx.world.colliders
            for (let i = cols.length - 1; i >= 0; i--) {
              if (cols[i] === p.collider) cols.splice(i, 1)
            }
            ctx.sfx('palletBreak')
          }
          this.state = 'patrol'
        }
        break
      }
      case 'attack': {
        this.attackWindup -= dt
        // 前摇期间可继续移动:半速朝目标逼近(边冲边挥),不再原地站桩。
        // 玩家扮演时移动由 Engine 驱动(50% 速),这里只跑前摇计时。
        const ts = this.target >= 0 ? ctx.survivors[this.target] : null
        if (!this.isPlayerControlled && ts && ts.alive) {
          const sp = SPEED.hunterChase * this.speedMul * 0.5
          const dx = ts.x - this.x
          const dz = ts.z - this.z
          const dl = Math.hypot(dx, dz) || 1
          this.moveWithCollision(ctx, (dx / dl) * sp * dt, (dz / dl) * sp * dt)
          this.yaw = Math.atan2(dx, dz)
          this.speedNow = sp
        } else if (!this.isPlayerControlled) {
          this.speedNow = 0
        }
        if (this.attackWindup <= 0) {
          this.resolveAttack(ctx)
          // resolveAttack 可能已切换到 pickup(击倒目标)
          if (this.state === 'attack') {
            // 命中或落空:进入短暂恢复(后摇)
            this.state = 'recover'
            this.recoverT = 0.45
          }
        }
        break
      }
      case 'recover': {
        this.recoverT -= dt
        // 命中/落空后的恢复期不再定身:垂刀动画照播,AI 以 60% 速继续逼近(消除停滞感)。
        // 玩家扮演时移动由 Engine 驱动(60% 速)。
        if (!this.isPlayerControlled) {
          const rs = this.target >= 0 ? ctx.survivors[this.target] : null
          if (rs && rs.alive && !rs.incapacitated) {
            const sp = SPEED.hunterChase * this.speedMul * 0.6
            const dx = rs.x - this.x
            const dz = rs.z - this.z
            const dl = Math.hypot(dx, dz) || 1
            this.moveWithCollision(ctx, (dx / dl) * sp * dt, (dz / dl) * sp * dt)
            this.yaw = Math.atan2(dx, dz)
            this.speedNow = sp
          } else {
            this.speedNow = 0
          }
        }
        if (this.recoverT <= 0) {
          const s = this.target >= 0 ? ctx.survivors[this.target] : null
          this.state = s && s.alive && !s.incapacitated && !this.isPlayerControlled ? 'chase' : 'patrol'
          this.path = []
          this.repathT = 0
        }
        break
      }
      case 'pickup': {
        this.pickupT -= dt
        this.speedNow = 0
        if (this.pickupT <= 0) {
          const s = ctx.survivors[this.target]
          if (s && s.status === 'downed') {
            s.status = 'carried'
            this.carriedId = s.id
            const chair = ctx.world.nearestFreeChair(this.x, this.z)
            if (chair) {
              this.chairTarget = chair.id
              this.state = 'carry'
              this.path = []
              this.repathT = 0
            } else {
              // 没有空椅子:直接淘汰(极端兜底)
              ctx.onSurvivorEliminated(s)
              this.carriedId = -1
              this.state = 'patrol'
            }
          } else {
            this.state = 'patrol'
          }
        }
        break
      }
      case 'carry': {
        const s = ctx.survivors[this.carriedId]
        const chair = ctx.world.chairs[this.chairTarget]
        if (!s || !chair || chair.occupiedBy !== -1) {
          // 椅子失效(已被占用/不存在):必须先放人再回 patrol,否则该求生者永久卡 carried
          // (incapacitated 恒 true → activeSurvivors 永不为 0 → 游戏永不结算)
          this.dropCarried(s)
          this.state = 'patrol'
          this.path = []
          break
        }
        const d = dist(this.x, this.z, chair.x, chair.z)
        if (d < 2.0) {
          this.state = 'chair'
          this.chairT = 2.0
          this.speedNow = 0
        } else {
          // AI 自动寻路走向椅子;玩家扮演时自己扛着走,只同步被扛者位置
          if (!this.isPlayerControlled) this.seek(ctx, chair.x, chair.z, SPEED.hunterCarry * this.speedMul, dt)
          // 被扛者跟随
          s.x = this.x - Math.sin(this.yaw) * 0.5
          s.z = this.z - Math.cos(this.yaw) * 0.5
        }
        break
      }
      case 'chair': {
        this.chairT -= dt
        this.speedNow = 0
        if (this.chairT <= 0) {
          const s = ctx.survivors[this.carriedId]
          const chair = ctx.world.chairs[this.chairTarget]
          if (s && chair) {
            s.status = 'chaired'
            s.chairCount++
            // 上椅阶段递进:第1次 60s,第2次 40s,第3次(count>=3)由 engine 判定秒杀
            s.chairTimer = s.chairCount >= 3 ? 0 : s.chairCount === 2 ? 40 : 60
            s.chairRef = chair.id
            s.x = chair.x
            s.z = chair.z + 0.1
            chair.occupiedBy = s.id
            ctx.onSurvivorChaired(s, chair)
          }
          this.carriedId = -1
          this.target = -1
          this.state = 'patrol'
          this.path = []
        }
        break
      }
      case 'investigate': {
        const d = dist(this.x, this.z, this.investigatePos.x, this.investigatePos.z)
        if (this.tryAcquire(ctx)) break
        if (d < 1.6) {
          this.investigateT -= dt
          this.speedNow = 0
          this.yaw += dt * 1.6 // 原地环顾
          if (this.investigateT <= 0) this.state = 'patrol'
        } else {
          this.seek(ctx, this.investigatePos.x, this.investigatePos.z, SPEED.hunterInvestigate * this.speedMul, dt)
        }
        break
      }
      case 'chase':
        this.chase(ctx, dt)
        break
      case 'teleport': {
        // 瞬移技能:windup 蓄力 → 瞬移 → after 后摇。期间完全定身。
        this.teleportT -= dt
        this.speedNow = 0
        if (this.teleportPhase === 'windup' && this.teleportT <= 0) {
          // 蓄力结束:实际瞬移
          this.x = this.teleportTarget.x
          this.z = this.teleportTarget.z
          this.path = []
          this.pathI = 0
          this.repathT = 0
          this.teleportPhase = 'after'
          this.teleportT = this.ai.TELEPORT_AFTER
          ctx.sfx('teleportBlink')
        } else if (this.teleportPhase === 'after' && this.teleportT <= 0) {
          // 后摇结束:回到追击(目标有效)或巡逻
          this.teleportPhase = 'none'
          const s = this.target >= 0 ? ctx.survivors[this.target] : null
          if (s && s.alive && !s.incapacitated) {
            this.state = 'chase'
          } else {
            this.target = -1
            this.state = 'patrol'
          }
        }
        break
      }
      default:
        this.patrol(ctx, dt)
    }

    // 噪音吸引
    if (this.state === 'patrol' || this.state === 'investigate') {
      for (const n of ctx.noises) {
        if (dist2(this.x, this.z, n.x, n.z) < HEAR_RANGE * HEAR_RANGE) {
          n.ttl = 0
          this.investigatePos = { x: n.x, z: n.z }
          this.investigateT = 2.5
          this.state = 'investigate'
          this.path = []
          this.repathT = 0
          break
        }
      }
    }

    // 卡墙检测:期望移动却几乎原地不动超过 1s → 强制重寻路 + 侧向脱困推力
    // 单纯清路径常导致"重算→再撞同一墙角"的死循环;额外给一次法向推力,
    // 让监管者从墙角侧面绕过去(沿当前朝向的左右法向,取不撞墙的那一侧)。
    if (this.speedNow > 0.5) {
      const expected = this.speedNow * dt
      const actual = dist(this.x, this.z, this.lastX, this.lastZ)
      if (actual < expected * 0.3) {
        this.stuckT += dt
        if (this.stuckT > 1.0) {
          this.stuckT = 0
          this.path = []
          this.pathI = 0
          this.repathT = 0
          // 侧向脱困:试左右两个法向,选第一个能走进去的方向推一小步
          this.applyLateralEscape(ctx, dt)
          // 巡逻兜底:当前目标不可达时换下一个巡逻点,绝不许永久卡住
          if (this.state === 'patrol') {
            this.patrolI = (this.patrolI + 1) % Math.max(1, ctx.world.ciphers.length)
          }
        }
      } else {
        this.stuckT = Math.max(0, this.stuckT - dt * 2)
      }
    } else {
      this.stuckT = 0
    }
    this.lastX = this.x
    this.lastZ = this.z

    this.syncMesh(dt, ctx.time)
  }

  // ===== 玩家扮演杀手:动作状态机子集(移动/朝向由 Engine 驱动) =====
  private updateAsPlayer(ctx: GameCtx, dt: number): void {
    // 追击加成与 AI 同规则(目标 10m 内每 5s +1 档),否则玩家平地追不上 AI 冲刺
    const prey = this.findNearestPrey(ctx)
    this.updateChaseBuff(prey ? prey.dist : null, dt)
    switch (this.state) {
      case 'stunned':
        this.stunT -= dt
        this.speedNow = 0
        if (this.stunT <= 0) this.state = 'patrol'
        break
      case 'breakpallet': {
        this.breakT -= dt
        this.speedNow = 0
        if (this.breakT <= 0) {
          const p = ctx.world.pallets[this.breakPalletId]
          if (p && p.state === 'down') {
            p.state = 'broken'
            p.mesh.visible = false
            ctx.nav.setDynamicAABB(p.collider, false)
            const cols = ctx.world.colliders
            for (let i = cols.length - 1; i >= 0; i--) {
              if (cols[i] === p.collider) cols.splice(i, 1)
            }
            ctx.sfx('palletBreak')
          }
          this.state = 'patrol'
        }
        break
      }
      case 'recover': {
        // 后摇计时(移动由 Engine,60% 速);垂刀动画由 syncMesh 播放,speedNow 保持 Engine 设置值
        this.recoverT -= dt
        if (this.recoverT <= 0) this.state = 'patrol'
        break
      }
      case 'pickup': {
        this.pickupT -= dt
        this.speedNow = 0
        if (this.pickupT <= 0) {
          const s = ctx.survivors[this.target]
          if (s && s.status === 'downed') {
            s.status = 'carried'
            this.carriedId = s.id
            const chair = ctx.world.nearestFreeChair(this.x, this.z)
            if (chair) {
              this.chairTarget = chair.id
              this.state = 'carry'
              this.path = []
              this.repathT = 0
            } else {
              ctx.onSurvivorEliminated(s)
              this.carriedId = -1
              this.state = 'patrol'
            }
          } else {
            this.state = 'patrol'
          }
        }
        break
      }
      case 'carry': {
        // 移动由 Engine;这里只负责被扛者跟随与到椅自动绑
        const s = ctx.survivors[this.carriedId]
        const chair = ctx.world.chairs[this.chairTarget]
        if (!s || !chair || chair.occupiedBy !== -1) {
          // 椅子失效(已被占用/不存在):必须先放人再回 patrol,否则该求生者永久卡 carried
          // (incapacitated 恒 true → activeSurvivors 永不为 0 → 游戏永不结算)
          this.dropCarried(s)
          this.state = 'patrol'
          this.path = []
          break
        }
        if (dist(this.x, this.z, chair.x, chair.z) < 2.0) {
          this.state = 'chair'
          this.chairT = 2.0
          this.speedNow = 0
        } else {
          s.x = this.x - Math.sin(this.yaw) * 0.5
          s.z = this.z - Math.cos(this.yaw) * 0.5
        }
        break
      }
      case 'chair': {
        this.chairT -= dt
        this.speedNow = 0
        if (this.chairT <= 0) {
          const s = ctx.survivors[this.carriedId]
          const chair = ctx.world.chairs[this.chairTarget]
          if (s && chair) {
            s.status = 'chaired'
            s.chairCount++
            s.chairTimer = s.chairCount >= 3 ? 0 : s.chairCount === 2 ? 40 : 60
            s.chairRef = chair.id
            s.x = chair.x
            s.z = chair.z + 0.1
            chair.occupiedBy = s.id
            ctx.onSurvivorChaired(s, chair)
          }
          this.carriedId = -1
          this.target = -1
          this.state = 'patrol'
          this.path = []
        }
        break
      }
      case 'teleport':
      case 'attack': {
        // teleport:蓄力→瞬移→后摇(逻辑与 AI 完全一致);attack:前摇计时(移动由 Engine)
        if (this.state === 'teleport') {
          this.teleportT -= dt
          this.speedNow = 0
          if (this.teleportPhase === 'windup' && this.teleportT <= 0) {
            this.x = this.teleportTarget.x
            this.z = this.teleportTarget.z
            this.path = []
            this.pathI = 0
            this.repathT = 0
            this.teleportPhase = 'after'
            this.teleportT = this.ai.TELEPORT_AFTER
            ctx.sfx('teleportBlink')
          } else if (this.teleportPhase === 'after' && this.teleportT <= 0) {
            this.teleportPhase = 'none'
            this.state = 'patrol'
          }
        } else {
          this.attackWindup -= dt
          if (this.attackWindup <= 0) {
            this.resolveAttack(ctx)
            if (this.state === 'attack') {
              this.state = 'recover'
              this.recoverT = 0.45
            }
          }
        }
        break
      }
      default: {
        // 空闲('patrol' 占位)。玩家局【不】自动扛起 —— 由玩家按 E 决定,保留放血战术
        this.speedNow = 0
      }
    }
    // 野状态兜底:既非 patrol/carry,也不在任何定时动作中 → 强制回 patrol,防状态机死锁
    if (this.state !== 'patrol' && this.state !== 'carry' && !this.busy()) this.state = 'patrol'
  }

  // 玩家攻击(左键):朝视角方向,选攻击范围内最近的可打目标(无则空挥,同样进冷却)
  playerAttack(ctx: GameCtx): boolean {
    // busy() 不含 'carry',这里显式排除扛人状态(扛着人时不能挥刀)
    if (this.attackCd > 0 || this.busy() || this.carrying()) return false
    let best: number = -1
    let bd = (ATTACK_RANGE + 0.4) * (ATTACK_RANGE + 0.4)
    for (const s of ctx.survivors) {
      if (!s.alive || s.incapacitated) continue
      const d2 = dist2(this.x, this.z, s.x, s.z)
      if (d2 < bd && this.segmentClear(ctx, this.x, this.z, s.x, s.z)) {
        bd = d2
        best = s.id
      }
    }
    this.target = best
    this.state = 'attack'
    this.attackWindup = ATTACK_WINDUP
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw)) // 保持当前视角朝向
    return true
  }

  // 玩家瞬移(Q):瞬移到最近存活求生者身前(沿其朝向前方),冷却与后摇同 AI
  playerTeleport(ctx: GameCtx): boolean {
    if (this.teleportCd > 0 || this.busy() || this.carrying()) return false
    let best: import('./survivor').Survivor | null = null
    let bd = Infinity
    for (const s of ctx.survivors) {
      if (!s.alive || s.incapacitated) continue
      const d2 = dist2(this.x, this.z, s.x, s.z)
      if (d2 < bd) {
        bd = d2
        best = s
      }
    }
    if (!best) return false
    const fx = Math.sin(best.yaw)
    const fz = Math.cos(best.yaw)
    let tx = best.x + fx * this.ai.TELEPORT_LEAD_OFFSET
    let tz = best.z + fz * this.ai.TELEPORT_LEAD_OFFSET
    if (ctx.nav.blockedAt(tx, tz)) {
      const cell = ctx.nav.nearestFree(tx, tz, 4)
      const w = ctx.nav.cellToWorld(cell.cx, cell.cz)
      tx = w.x
      tz = w.z
    }
    for (const c of ctx.world.colliders) {
      if (circleHits(tx, tz, 0.45, c)) {
        const cell = ctx.nav.nearestFree(best.x + 1.2, best.z, 4)
        const w = ctx.nav.cellToWorld(cell.cx, cell.cz)
        tx = w.x
        tz = w.z
        break
      }
    }
    this.startTeleport(ctx, tx, tz)
    return true
  }

  // 玩家破坏倒板(E):附近有放倒的木板则进入破坏
  playerTryBreak(ctx: GameCtx): boolean {
    if (this.busy() || this.carrying()) return false
    for (const p of ctx.world.pallets) {
      if (p.state !== 'down') continue
      if (dist(this.x, this.z, p.x, p.z) < 1.9) {
        this.state = 'breakpallet'
        this.breakT = 2.0
        this.breakPalletId = p.id
        return true
      }
    }
    return false
  }

  // 玩家翻窗(Space)
  playerTryVault(ctx: GameCtx): boolean {
    if (this.busy() || this.carrying()) return false
    for (const w of ctx.world.windows) {
      if (dist(this.x, this.z, w.x, w.z) < 1.6) {
        const off = 1.2
        const tx = w.axis === 'x' ? w.x + (this.x > w.x ? -off : off) : w.x
        const tz = w.axis === 'x' ? w.z : w.z + (this.z > w.z ? -off : off)
        this.vaultT = this.vaultDur
        this.vaultFrom = { x: this.x, z: this.z }
        this.vaultTo = { x: tx, z: tz }
        ctx.sfx('vault')
        return true
      }
    }
    return false
  }

  // 玩家扛起(E):2.4m 内倒地的求生者 → 进入 1.3s 扛起动作。
  // 玩家局刻意不做"击倒即自动扛起",保留放血(slugging)战术选择。
  playerTryPickup(ctx: GameCtx): boolean {
    if (this.busy() || this.carrying()) return false
    let best: import('./survivor').Survivor | null = null
    let bd = Infinity
    for (const s of ctx.survivors) {
      if (s.status !== 'downed') continue
      const d2 = dist2(this.x, this.z, s.x, s.z)
      if (d2 < bd) {
        bd = d2
        best = s
      }
    }
    if (!best || bd > 2.4 * 2.4) return false
    this.target = best.id
    this.state = 'pickup'
    this.pickupT = 1.3
    this.speedNow = 0
    return true
  }

  // 玩家主动放下(放血):倒地者持续流血且会爬行,逼队友来救 —— 换杀手去追其他人
  playerDropCarried(ctx: GameCtx): boolean {
    if (!this.carrying()) return false
    this.dropCarried(ctx.survivors[this.carriedId])
    this.state = 'patrol'
    this.path = []
    ctx.sfx('vault')
    return true
  }

  // 放人通用清理:状态回 downed(可继续爬行),清 id 与目标椅子。
  // 所有中断扛人的路径(椅子失效 / 被砸板 / 主动放下)都必须走这里,否则求生者永久卡 carried。
  private dropCarried(s?: Survivor | null): void {
    if (s && s.status === 'carried') s.status = 'downed'
    this.carriedId = -1
    this.chairTarget = -1
  }

  // 最近的活跃猎物(未被击倒/淘汰/逃脱),用于追击加成、音频与 AI 逃跑判定
  findNearestPrey(ctx: GameCtx): { id: number; dist: number } | null {
    let best: number = -1
    let bd = Infinity
    for (const s of ctx.survivors) {
      if (!s.alive || s.incapacitated) continue
      const d = dist(this.x, this.z, s.x, s.z)
      if (d < bd) {
        bd = d
        best = s.id
      }
    }
    return best >= 0 ? { id: best, dist: bd } : null
  }

  // 追击速度叠加:目标 10m 内每 5s +1 档(每档 +2%,上限 +10%),脱离范围则按秒衰减。
  // 从 AI 的 chase() 抽出,玩家操控时同样生效 —— 否则玩家平地追不上 AI 冲刺(6.15 > 6.05)。
  updateChaseBuff(d: number | null, dt: number): void {
    if (d !== null && d < this.ai.CHASE_BUFF_RANGE) {
      this.chaseBuffT += dt
      if (this.chaseBuffT >= this.ai.CHASE_BUFF_INTERVAL && this.chaseSpeedBuff < this.ai.CHASE_BUFF_MAX_STEPS) {
        this.chaseBuffT = 0
        this.chaseSpeedBuff++
      }
    } else {
      this.chaseBuffT = 0
      this.chaseSpeedBuff = Math.max(0, this.chaseSpeedBuff - dt * this.ai.CHASE_BUFF_DECAY)
    }
  }

  get chaseBuffPct(): number {
    return this.chaseSpeedBuff * this.ai.CHASE_BUFF_STEP
  }

  // 玩家可自由行动(不受状态机定身、未扛人、不在翻窗中)
  canAct(): boolean {
    return !this.busy() && !this.carrying() && this.vaultT <= 0
  }

  private patrol(ctx: GameCtx, dt: number): void {
    if (this.tryAcquire(ctx)) return
    // 附近有倒地幸存者 → 去扛
    for (const s of ctx.survivors) {
      if (s.status === 'downed' && dist2(this.x, this.z, s.x, s.z) < 14 * 14) {
        this.target = s.id
        this.state = 'chase'
        return
      }
    }
    const pts = ctx.world.ciphers
    const wp = pts[this.patrolI % pts.length]
    const d = dist(this.x, this.z, wp.x, wp.z)
    if (d < 3) {
      this.patrolI = (this.patrolI + 1) % pts.length
      return
    }
    this.seek(ctx, wp.x, wp.z, SPEED.hunterPatrol * this.speedMul, dt)
  }

  // 侦测幸存者:半径 + 视线
  private tryAcquire(ctx: GameCtx): boolean {
    let best: Survivor | null = null
    let bd = Infinity
    for (const s of ctx.survivors) {
      if (!s.alive || s.incapacitated) continue
      const d2 = dist2(this.x, this.z, s.x, s.z)
      if (d2 > SIGHT_RANGE * SIGHT_RANGE) continue
      if (losBlocked(this.x, this.z, s.x, s.z, ctx.world.tallWalls)) continue
      if (d2 < bd) {
        bd = d2
        best = s
      }
    }
    if (best) {
      // 切换目标时清空上一目标的速度估计(若有),避免 lead 预测串味
      if (this.target !== best.id) {
        this.resetTargetTracking()
        this.chaseDurationT = 0 // 新目标重新计时
      }
      this.target = best.id
      this.state = 'chase'
      this.path = []
      this.repathT = 0
      this.loseT = 0
      if (best.isPlayer && !this.spottedToastDone) {
        ctx.toast('被猎人发现了!', true)
        ctx.sfx('spotted')
        this.spottedToastDone = true
        setTimeout(() => (this.spottedToastDone = false), 6000)
      }
      return true
    }
    return false
  }

  private chase(ctx: GameCtx, dt: number): void {
    const s = ctx.survivors[this.target]
    if (!s || !s.alive || (s.incapacitated && s.status !== 'downed')) {
      this.resetTargetTracking()
      this.resetChaseBuff()
      this.target = -1
      this.state = 'patrol'
      return
    }
    // 目标倒地:靠近后扛起(倒地目标位置基本静止,直接追当前位置即可)
    if (s.status === 'downed') {
      this.resetTargetTracking()
      const dd = dist(this.x, this.z, s.x, s.z)
      if (dd < 2.0) {
        this.state = 'pickup'
        this.pickupT = 1.3
        this.speedNow = 0
      } else {
        this.seek(ctx, s.x, s.z, SPEED.hunterChase * this.speedMul, dt, this.ai.REPATH_BLIND)
      }
      return
    }
    const d = dist(this.x, this.z, s.x, s.z)
    // ---- 追击速度叠加:逻辑已抽到 updateChaseBuff,玩家操控时共用同一套规则 ----
    this.updateChaseBuff(d, dt)
    const seen = !losBlocked(this.x, this.z, s.x, s.z, ctx.world.tallWalls)
    // 移动视线:包含矮墙/窗户等全部碰撞体,用于转向与攻击判定(防止隔墙推墙/隔窗打人)
    const seenMove = this.segmentClear(ctx, this.x, this.z, s.x, s.z)
    if (s.isPlayer) s.chaseTime += dt
    // 追击计时 + 视线记忆(供瞬移 AI 判断使用)
    this.chaseDurationT += dt
    if (seen) this.lastSeenT = 0
    else this.lastSeenT += dt

    if (d > 26 && !seen) {
      this.loseT += dt
      if (this.loseT > 3.5) {
        this.resetTargetTracking()
        this.resetChaseBuff()
        this.target = -1
        this.state = 'patrol'
        this.path = []
        this.loseT = 0
        this.chaseDurationT = 0
        return
      }
    } else {
      this.loseT = 0
    }

    // ---- lead targeting:估计目标速度 → 预测其未来位置,追向预测点而非当前位置 ----
    // 仅在能看见目标时预测(看不见时速度估计不可靠,且本就要靠记忆路径走)。
    // 穿墙兜底:若预测点连目标自己都看不到(穿墙),退化为当前位置。
    const leadPos = seen ? this.estimateLead(ctx, s, dt) : { x: s.x, z: s.z }

    // ---- 瞬移技能 AI 判断:目标远 + 追了一阵 + 近期见过 → 瞬移到目标身前拦截 ----
    if (this.tryTeleport(ctx, s, d, leadPos)) return

    // 攻击:仍以真实位置判定(避免隔空打预测点)
    if (d < ATTACK_RANGE && this.attackCd <= 0 && seenMove) {
      this.state = 'attack'
      this.attackWindup = ATTACK_WINDUP
      this.yaw = Math.atan2(s.x - this.x, s.z - this.z)
      return
    }

    // 窗户:目标在窗另一侧且很近 → 慢翻(用真实位置判定窗户情境)
    if (d < 7) {
      for (const w of ctx.world.windows) {
        const wd = dist(this.x, this.z, w.x, w.z)
        if (wd < 1.6) {
          const across =
            w.axis === 'x'
              ? (s.x - w.x) * (this.x - w.x) < 0
              : (s.z - w.z) * (this.z - w.z) < 0
          if (across || wd < 0.9) {
            const off = 1.2
            const tx = w.axis === 'x' ? w.x + (this.x > w.x ? -off : off) : w.x
            const tz = w.axis === 'x' ? w.z : w.z + (this.z > w.z ? -off : off)
            this.vaultT = this.vaultDur
            this.vaultFrom = { x: this.x, z: this.z }
            this.vaultTo = { x: tx, z: tz }
            ctx.sfx('vault')
            return
          }
        }
      }
    }

    // 放倒的木板"挡路就破坏":猎人贴板 + 板挡在自身到目标之间(线段穿过板碰撞体)
    // 不再用模糊的 between 启发式,改为真正的几何挡路判定。
    for (const p of ctx.world.pallets) {
      if (p.state !== 'down') continue
      if (dist(this.x, this.z, p.x, p.z) >= 1.9) continue
      if (d <= 1.5) continue // 已贴脸目标,不必破坏
      // 猎人→目标连线是否穿过板的碰撞体(板真正挡路)
      const blockedByPallet = segmentHitsAABB(this.x, this.z, s.x, s.z, p.collider)
      if (blockedByPallet) {
        this.state = 'breakpallet'
        this.breakT = 2.0
        this.breakPalletId = p.id
        return
      }
    }

    // 追击速度:基础 + 叠加 buff(每档 +2%,上限 +10%)
    const sp = SPEED.hunterChase * this.speedMul * (1 + this.chaseSpeedBuff * this.ai.CHASE_BUFF_STEP)
    // 直接 steering 判定用 leadPos(预测拦截);但要求对真实位置 seenMove(避免隔墙冲撞)
    if (seenMove && d < this.ai.CHASE_DIRECT_RANGE) {
      const dx = (leadPos.x - this.x)
      const dz = (leadPos.z - this.z)
      const dl = Math.hypot(dx, dz) || 1
      this.moveWithCollision(ctx, (dx / dl) * sp * dt, (dz / dl) * sp * dt)
      // 朝向预测点(让监管者"看向"未来位置,视觉上也更像在拦截)
      this.yaw = Math.atan2(dx, dz)
      this.speedNow = sp
      this.path = []
    } else {
      // 远距离或隔墙:走 A*,目标用 leadPos。repath 间隔按可见性动态化。
      const repath = seen
        ? (d < this.ai.CHASE_DIRECT_RANGE ? this.ai.REPATH_SEEN_NEAR : this.ai.REPATH_SEEN_FAR)
        : this.ai.REPATH_BLIND
      this.seek(ctx, leadPos.x, leadPos.z, sp, dt, repath)
    }
  }

  // 估计目标速度(指数平滑)并给出预测落点。仅在调用方确保 seen 时使用。
  private estimateLead(ctx: GameCtx, s: Survivor, dt: number): { x: number; z: number } {
    // 目标切换或首帧:无历史可差分,直接用当前位置初始化采样,不预测
    if (!this.targetTracked) {
      this.lastTargetX = s.x
      this.lastTargetZ = s.z
      this.targetVX = 0
      this.targetVZ = 0
      this.targetTracked = true
      return { x: s.x, z: s.z }
    }
    const safeDt = dt > 1e-4 ? dt : 1e-4
    const rawVX = (s.x - this.lastTargetX) / safeDt
    const rawVZ = (s.z - this.lastTargetZ) / safeDt
    this.lastTargetX = s.x
    this.lastTargetZ = s.z
    // 指数平滑:过滤单帧抖动(如 AI 路径拐点造成的速度跳变)
    const a = this.ai.LEAD_SMOOTH
    this.targetVX = lerp(this.targetVX, rawVX, a)
    this.targetVZ = lerp(this.targetVZ, rawVZ, a)
    // 位移预测 + 单轴上限(防止极端外推穿到墙后)
    const ox = clamp(this.targetVX * this.ai.LEAD_TIME, -this.ai.LEAD_MAX, this.ai.LEAD_MAX)
    const oz = clamp(this.targetVZ * this.ai.LEAD_TIME, -this.ai.LEAD_MAX, this.ai.LEAD_MAX)
    const lx = s.x + ox
    const lz = s.z + oz
    // 穿墙兜底:目标自己看不到的预测点不可信,退化为当前位置
    if (losBlocked(s.x, s.z, lx, lz, ctx.world.tallWalls)) return { x: s.x, z: s.z }
    return { x: lx, z: lz }
  }

  // 切换/丢失目标时清空速度估计,避免把上一目标的位移误当作新目标的速度
  private resetTargetTracking(): void {
    this.targetTracked = false
    this.targetVX = 0
    this.targetVZ = 0
  }

  // 退出追击(丢失/切换目标)时清零速度叠加 buff,避免带进下一次追击
  private resetChaseBuff(): void {
    this.chaseSpeedBuff = 0
    this.chaseBuffT = 0
  }

  // 瞬移技能 AI 判断:满足全部条件才触发,返回 true 表示已切到 teleport 状态。
  // 设计意图:只在"确实追不上"时才交技能——目标够远、追了够久、近期还见过(不是盲传)。
  private tryTeleport(ctx: GameCtx, s: Survivor, distToTarget: number, leadPos: { x: number; z: number }): boolean {
    if (this.teleportCd > 0) return false
    if (this.state !== 'chase') return false
    // 距离不够远:近距离不值得浪费技能
    if (distToTarget < this.ai.TELEPORT_MIN_DIST) return false
    // 追击时间不够:刚发现就交技能不公平,先追一会
    if (this.chaseDurationT < this.ai.TELEPORT_MIN_CHASE) return false
    // 近期必须见过目标(不能盲传到没视野的地方)
    if (this.lastSeenT > this.ai.TELEPORT_RECENT_SEEN) return false
    // 落点:目标"前方"(沿目标速度方向再向前)偏移一点,形成拦截位
    // 用 leadPos 作为目标未来位置基准(它已含穿墙兜底)
    const dirX = leadPos.x - s.x
    const dirZ = leadPos.z - s.z
    const dl = Math.hypot(dirX, dirZ)
    let tx: number
    let tz: number
    if (dl > 0.01) {
      // lead 方向有效:沿该方向再前推 OFFSET 米
      tx = leadPos.x + (dirX / dl) * this.ai.TELEPORT_LEAD_OFFSET
      tz = leadPos.z + (dirZ / dl) * this.ai.TELEPORT_LEAD_OFFSET
    } else {
      tx = leadPos.x
      tz = leadPos.z
    }
    // 落点验证:必须在可走格 + 不与碰撞体重叠(防穿墙)
    if (ctx.nav.blockedAt(tx, tz)) {
      const cell = ctx.nav.nearestFree(tx, tz, 4)
      const w = ctx.nav.cellToWorld(cell.cx, cell.cz)
      tx = w.x
      tz = w.z
    }
    const r = 0.45
    for (const c of ctx.world.colliders) {
      if (circleHits(tx, tz, r, c)) return false // 落点仍在碰撞体内,放弃
    }
    this.startTeleport(ctx, tx, tz)
    return true
  }

  // 启动瞬移:进入 windup 阶段,记录落点。实际位移在 windup 结束时发生。
  private startTeleport(ctx: GameCtx, tx: number, tz: number): void {
    this.state = 'teleport'
    this.teleportPhase = 'windup'
    this.teleportT = this.ai.TELEPORT_WINDUP
    this.teleportTarget = { x: tx, z: tz }
    this.teleportCd = this.ai.TELEPORT_CD
    this.path = []
    this.pathI = 0
    this.speedNow = 0
    ctx.sfx('teleportWindup')
  }

  private resolveAttack(ctx: GameCtx): void {
    this.attackCd = 0.45 // 与后摇时长一致(后摇结束即可再次攻击)
    const s = ctx.survivors[this.target]
    if (!s) return
    const d = dist(this.x, this.z, s.x, s.z)
    if (d < ATTACK_RANGE + 0.5 && s.alive && !s.incapacitated) {
      s.hurt(ctx)
      this.sectorFlashT = 0.4 // 命中红光爆闪
      if (s.status === 'downed') {
        if (this.isPlayerControlled) {
          // 玩家局:只提示,不自动扛起 —— 玩家可以继续追别人,或稍后回来扛(放血战术)
          ctx.toast(`按 E 扛起 ${s.name}`)
        } else {
          this.state = 'pickup'
          this.pickupT = 1.3
          this.speedNow = 0
        }
      }
    }
  }

  // 通用寻路接近。repath 决定多久重算一次路径(动态:seen/blind/static)。
  private seek(ctx: GameCtx, tx: number, tz: number, sp: number, dt: number, repath = this.ai.REPATH_STATIC): void {
    this.repathT -= dt
    if (this.repathT <= 0 || this.pathI >= this.path.length) {
      this.repathT = repath
      // 路径超长时截断(保留首尾各 12 点),封顶 smoothPath 的 O(N²) 开销
      const raw = ctx.nav.findPath(this.x, this.z, tx, tz)
      const trimmed = raw.length > 26 ? [...raw.slice(0, 13), ...raw.slice(-13)] : raw
      this.path = this.smoothPath(ctx, trimmed)
      this.pathI = 0
    }
    if (this.pathI >= this.path.length) {
      this.speedNow = 0
      return
    }
    const wp = this.path[this.pathI]
    // 动态障碍(倒下的木板)挡路 → 立即重寻,而不是硬推
    // 注意:末点(精确目标,如密码机/椅子位置)本身常落在阻挡格内,豁免检查,
    // 由 moveWithCollision 滑到碰撞边缘,交给上层状态机的距离判定收尾
    if (this.pathI < this.path.length - 1 && ctx.nav.blockedAt(wp.x, wp.z)) {
      this.repathT = 0
      this.path = []
      return
    }
    const d = dist(this.x, this.z, wp.x, wp.z)
    if (d < 0.9) {
      this.pathI++
      return
    }
    const dx = ((wp.x - this.x) / d) * sp * dt
    const dz = ((wp.z - this.z) / d) * sp * dt
    this.moveWithCollision(ctx, dx, dz)
    this.yaw = Math.atan2(wp.x - this.x, wp.z - this.z)
    this.speedNow = sp
  }

  // 路径拉直:从当前位置起,尽量跳到视线(无碰撞)可达的最远路点,避免贴角
  private smoothPath(ctx: GameCtx, raw: { x: number; z: number }[]): { x: number; z: number }[] {
    if (raw.length <= 1) return raw
    const out: { x: number; z: number }[] = []
    let cx = this.x
    let cz = this.z
    let i = 0
    let guard = 0
    while (i < raw.length && guard++ < 40) {
      let j = raw.length - 1
      while (j > i && !this.segmentClear(ctx, cx, cz, raw[j].x, raw[j].z)) j--
      out.push(raw[j])
      cx = raw[j].x
      cz = raw[j].z
      i = j + 1
    }
    return out
  }

  // 线段是否无碰撞(考虑身体半径,对所有碰撞体做外扩检测)
  private segmentClear(ctx: GameCtx, x1: number, z1: number, x2: number, z2: number): boolean {
    const pad = 0.32
    for (const c of ctx.world.colliders) {
      const box = {
        minX: c.minX - pad,
        maxX: c.maxX + pad,
        minZ: c.minZ - pad,
        maxZ: c.maxZ + pad,
      }
      if (segmentHitsAABB(x1, z1, x2, z2, box)) return false
    }
    return true
  }

  // 碰撞移动:标准 "联合优先 + 分轴滑墙" 算法,修复凹墙角穿透 bug。
  // 旧实现把 X/Z 分开独立检测,斜向撞向凹角时两轴各自都能过 → 角色被推进墙缝。
  // 新实现:先试联合位移(斜向移动顺畅),撞了才退化到单轴滑墙。
  // 带碰撞的位移(玩家操控杀手时由 Engine 驱动移动,需对外暴露)
  moveWithCollision(ctx: GameCtx, dx: number, dz: number): void {
    const r = 0.45
    const cols = ctx.world.colliders
    // 判断目标位置是否与任何碰撞体相撞(且当前位置未重叠——重叠时允许脱离)
    const blockedAt = (px: number, pz: number): boolean => {
      for (const c of cols) {
        if (circleHits(px, pz, r, c) && !circleHits(this.x, this.z, r, c)) return true
      }
      return false
    }
    // 1) 先试联合位移:斜向移动最顺畅
    const ux = this.x + dx
    const uz = this.z + dz
    if (!blockedAt(ux, uz)) {
      this.x = clamp(ux, -34, 34)
      this.z = clamp(uz, -34, 34)
      return
    }
    // 2) 联合撞墙 → 试只走 X 轴(贴墙滑行)
    if (!blockedAt(this.x + dx, this.z)) {
      this.x = clamp(this.x + dx, -34, 34)
      return
    }
    // 3) X 轴也撞 → 试只走 Z 轴
    if (!blockedAt(this.x, this.z + dz)) {
      this.z = clamp(this.z + dz, -34, 34)
      return
    }
    // 4) 都撞 → 完全堵死,不动
  }

  // 卡墙脱困:沿当前朝向的左右法向各试一步,取第一个能走进去的方向推一小步。
  // 碰撞系统修复后,真正的"卡进墙缝"已很少发生;此函数作为 stuck 检测的二次保险,
  // 处理"贴着长墙走时寻路点在墙另一侧"这类边缘情况——强行沿法向挪开一点让 repath 接管。
  private applyLateralEscape(ctx: GameCtx, dt: number): void {
    const step = this.ai.STUCK_LATERAL_IMPULSE * dt
    // 朝向 yaw 的运动方向 (sin(yaw), cos(yaw));左右法向各试一次
    const fx = Math.sin(this.yaw)
    const fz = Math.cos(this.yaw)
    const dirs = [
      [fz, -fx],
      [-fz, fx],
    ]
    const beforeX = this.x
    const beforeZ = this.z
    for (const dir of dirs) {
      this.moveWithCollision(ctx, dir[0] * step, dir[1] * step)
      if (this.x !== beforeX || this.z !== beforeZ) return // 找到出路
      // 没动:回到原位试另一侧
      this.x = beforeX
      this.z = beforeZ
    }
    // 两侧都走不动:原地不动,交给上层 repath 兜底
  }

  // 被砸板
  stun(ctx: GameCtx): void {
    if (this.state === 'stunned') return
    if (this.state === 'teleport') return // 瞬移期间霸体,不被砸晕
    this.state = 'stunned'
    this.stunT = 2.5
    this.speedNow = 0
    ctx.sfx('palletStun')
    ctx.toast(this.isPlayerControlled ? '你被木板砸晕了!' : '猎人被木板砸晕了!')
    // 扛着人时掉落。必须走 dropCarried 保证 status 回 downed 且 chairTarget 一并清空 ——
    // 只清 carriedId 会留下 chairTarget,下次重新锁定目标时视觉上像"粘住"刚放下的人。
    if (this.carrying()) this.dropCarried(ctx.survivors[this.carriedId])
    this.target = -1
  }

  private syncMesh(dt: number, time: number): void {
    const g = this.mesh.group
    g.position.x = this.x
    g.position.z = this.z
    let dy = this.yaw - g.rotation.y
    while (dy > Math.PI) dy -= Math.PI * 2
    while (dy < -Math.PI) dy += Math.PI * 2
    g.rotation.y += dy * Math.min(1, dt * 8)
    animateHumanoid(this.mesh, dt, this.state === 'stunned' ? 0 : this.speedNow, 'stand', time)
    // 眩晕摇晃
    if (this.state === 'stunned') {
      g.rotation.z = Math.sin(time * 10) * 0.06
    } else {
      g.rotation.z = 0
    }
    // 攻击动作:挥砍幅度加大(刀从高举到劈下),动作更明显
    if (this.state === 'attack') {
      const k = 1 - Math.max(0, this.attackWindup) / ATTACK_WINDUP
      // k: 0→1 对应蓄力→劈下。前半段举刀蓄力,后半段猛劈
      const swing = k < 0.45 ? k / 0.45 : 1
      const chop = k < 0.45 ? 0 : (k - 0.45) / 0.55
      this.mesh.armR.rotation.x = -0.3 - 1.4 * swing + 2.6 * chop
      this.mesh.armL.rotation.x = -0.4 * swing
      if (this.mesh.weapon) this.mesh.weapon.rotation.z = 0.25 + 1.8 * swing - 2.4 * chop
      this.mesh.body.rotation.x = -0.25 * chop // 前倾劈砍
    } else if (this.state === 'recover') {
      const b = Math.sin(time * 2.4) * 0.06
      this.mesh.armR.rotation.x = 0.35 + b
      this.mesh.armL.rotation.x = 0.15 + b
      if (this.mesh.weapon) this.mesh.weapon.rotation.z = 0.02
      this.mesh.body.rotation.x = 0.16 + b * 0.5
    } else {
      if (this.mesh.weapon) this.mesh.weapon.rotation.z = 0.25
      this.mesh.body.rotation.x = 0
    }
    // 警示扇形:命中时扩张亮红;攻击蓄力期间持续高亮预警(让求生者看到要挨打)
    const flashK = this.sectorFlashT / 0.4
    const attacking = this.state === 'attack'
    if (flashK > 0) {
      const s = 1 + 0.5 * flashK
      this.sector.scale.set(s, s, 1)
      this.sectorMat.color.setHex(0xff2626)
      this.sectorMat.opacity = 0.32 + 0.38 * flashK
    } else if (attacking) {
      // 攻击预警:扇形扩张到 1.8x、亮红,随挥砍进度脉动
      const ak = 1 - Math.max(0, this.attackWindup) / ATTACK_WINDUP
      const pulse = 0.9 + 0.1 * Math.sin(time * 20)
      const s = 1.4 + 0.4 * ak
      this.sector.scale.set(s, s, 1)
      this.sectorMat.color.setHex(0xff3030)
      this.sectorMat.opacity = (0.4 + 0.3 * ak) * pulse
    } else {
      this.sector.scale.set(1, 1, 1)
      this.sectorMat.color.setHex(0x7a1010)
      this.sectorMat.opacity = this.state === 'recover' ? 0.1 : 0.32
    }

    // 瞬移特效:windup 光柱渐显 + 旋转,after 地面环扩散
    if (this.state === 'teleport' && this.teleportPhase === 'windup') {
      const k = 1 - Math.max(0, this.teleportT) / this.ai.TELEPORT_WINDUP // 0→1
      this.teleportPillar.visible = true
      this.teleportPillar.rotation.y = time * 4
      this.teleportPillarMat.opacity = 0.3 + 0.5 * k
      this.teleportPillar.scale.set(0.6 + 0.4 * k, 1, 0.6 + 0.4 * k)
    } else {
      this.teleportPillar.visible = false
    }
    if (this.state === 'teleport' && this.teleportPhase === 'after') {
      const k = 1 - Math.max(0, this.teleportT) / this.ai.TELEPORT_AFTER // 0→1
      this.teleportRing.visible = true
      const s = 1 + 3 * k
      this.teleportRing.scale.set(s, s, 1)
      this.teleportRingMat.opacity = 0.6 * (1 - k)
    } else {
      this.teleportRing.visible = false
    }
  }
}
