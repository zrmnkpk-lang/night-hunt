// 地图构建:围墙、板区、窗户、密码机、狂欢之椅、电闸门、枯树、雾与灯光
import * as THREE from 'three'
import { NavGrid } from './navgrid'
import type { AABB } from './types'

export interface Pallet {
  id: number
  x: number
  z: number
  axis: 'x' | 'z' // 放倒后阻挡的方向(长边朝向)
  state: 'up' | 'down' | 'broken'
  mesh: THREE.Group
  colUp: AABB // 竖板:与薄板视觉一致的细长 AABB
  collider: AABB // 倒板:低矮平放的长条 AABB(放倒时生效)
}

export interface WindowVault {
  id: number
  x: number
  z: number
  axis: 'x' | 'z' // 跨越方向
  mesh: THREE.Group
}

export interface Cipher {
  id: number
  x: number
  z: number
  progress: number // 0..1
  done: boolean
  mesh: THREE.Group
  bulb: THREE.MeshStandardMaterial
  antennaLight: THREE.PointLight
  seed: number
}

export interface Chair {
  id: number
  x: number
  z: number
  occupiedBy: number // survivor id, -1 空
  mesh: THREE.Group
  highlight: THREE.Group // 透视高亮(队友上椅时对玩家可见)
}

export interface Gate {
  id: number
  x: number
  z: number
  switchX: number
  switchZ: number
  openProgress: number // 0..1 开门动画
  opened: boolean
  opening: boolean
  doorL: THREE.Mesh
  doorR: THREE.Mesh
  lampMat: THREE.MeshStandardMaterial
  mesh: THREE.Group
  axis: 'x' | 'z'
  sign: number // 逃脱方向
}

const WALL_H = 2.9
const LOW_H = 1.05

export class World {
  scene: THREE.Scene
  nav: NavGrid
  colliders: AABB[] = [] // 全部阻挡移动
  tallWalls: AABB[] = [] // 阻挡视线
  pallets: Pallet[] = []
  windows: WindowVault[] = []
  ciphers: Cipher[] = []
  chairs: Chair[] = []
  gates: Gate[] = []
  gatePowered = false
  // 可裁剪的点光源(密码机/椅子/路灯),距玩家较远时关闭以避免超 GPU 光源上限导致闪烁
  cullableLights: { light: THREE.PointLight; x: number; z: number }[] = []

  private wallMat = new THREE.MeshStandardMaterial({ color: 0x383c45, roughness: 0.95 })
  private lowWallMat = new THREE.MeshStandardMaterial({ color: 0x40444d, roughness: 0.9 })
  private woodMat = new THREE.MeshStandardMaterial({ color: 0x5a4936, roughness: 0.9 })
  private metalMat = new THREE.MeshStandardMaterial({ color: 0x484e57, roughness: 0.6, metalness: 0.6 })

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.nav = new NavGrid()
    this.build()
  }

  private addWallBox(x1: number, z1: number, x2: number, z2: number, h: number, blocksSight: boolean): AABB {
    const box: AABB = {
      minX: Math.min(x1, x2),
      maxX: Math.max(x1, x2),
      minZ: Math.min(z1, z2),
      maxZ: Math.max(z1, z2),
    }
    const w = box.maxX - box.minX
    const d = box.maxZ - box.minZ
    const geo = new THREE.BoxGeometry(w, h, d)
    const mesh = new THREE.Mesh(geo, h <= LOW_H + 0.01 ? this.lowWallMat : this.wallMat)
    mesh.position.set((box.minX + box.maxX) / 2, h / 2, (box.minZ + box.maxZ) / 2)
    this.scene.add(mesh)
    this.colliders.push(box)
    if (blocksSight) this.tallWalls.push(box)
    this.nav.markAABB(box, 0.35)
    return box
  }

  private wall(x1: number, z1: number, x2: number, z2: number): void {
    const t = 0.6
    if (Math.abs(x2 - x1) >= Math.abs(z2 - z1)) {
      this.addWallBox(x1, z1 - t / 2, x2, z2 + t / 2, WALL_H, true)
    } else {
      this.addWallBox(x1 - t / 2, z1, x2 + t / 2, z2, WALL_H, true)
    }
  }

  // 窗户墙:整段拆成"中间 2 米可翻矮窗 + 两侧实体高墙"。
  // 沿长轴(x 或 z)取中点 ±1 米做窗,两侧补实体墙挡视线。
  private windowWall(x1: number, z1: number, x2: number, z2: number): void {
    const t = 0.55
    const horizontal = Math.abs(x2 - x1) >= Math.abs(z2 - z1)
    const midX = (x1 + x2) / 2
    const midZ = (z1 + z2) / 2
    const WIN_HALF = 1 // 窗半宽 → 可翻段 2 米
    // 窗段端点
    const w1 = horizontal ? midX - WIN_HALF : x1
    const w2 = horizontal ? midX + WIN_HALF : x2
    const d1 = horizontal ? z1 : midZ - WIN_HALF
    const d2 = horizontal ? z2 : midZ + WIN_HALF
    // 1) 中间可翻矮窗(LOW_H,不挡视线)
    const box: AABB = horizontal
      ? this.addWallBox(w1, d1 - t / 2, w2, d2 + t / 2, LOW_H, false)
      : this.addWallBox(w1 - t / 2, d1, w2 + t / 2, d2, LOW_H, false)
    // 2) 两侧实体高墙(挡视线),填补"原整段 - 窗段"
    if (horizontal) {
      if (x1 < w1 - 0.01) this.addWallBox(x1, z1 - t / 2, w1, z2 + t / 2, WALL_H, true)
      if (w2 < x2 - 0.01) this.addWallBox(w2, z1 - t / 2, x2, z2 + t / 2, WALL_H, true)
    } else {
      if (z1 < d1 - 0.01) this.addWallBox(x1 - t / 2, z1, x2 + t / 2, d1, WALL_H, true)
      if (d2 < z2 - 0.01) this.addWallBox(x1 - t / 2, d2, x2 + t / 2, z2, WALL_H, true)
    }
    const cx = (box.minX + box.maxX) / 2
    const cz = (box.minZ + box.maxZ) / 2
    const g = new THREE.Group()
    // 顶部木框提示可翻越(只覆盖窗段)
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(0.2, box.maxX - box.minX), 0.12, Math.max(0.2, box.maxZ - box.minZ)),
      this.woodMat,
    )
    frame.position.set(cx, LOW_H + 0.06, cz)
    g.add(frame)
    this.scene.add(g)
    this.windows.push({
      id: this.windows.length,
      x: cx,
      z: cz,
      axis: horizontal ? 'z' : 'x',
      mesh: g,
    })
  }

  private pallet(x: number, z: number, axis: 'x' | 'z'): void {
    const g = new THREE.Group()
    // 长条形木板:2.2m 长 × 1.15m 高 × 薄板,横跨门洞
    const plank = new THREE.Mesh(new THREE.BoxGeometry(axis === 'x' ? 2.2 : 0.45, 1.15, axis === 'x' ? 0.45 : 2.2), this.woodMat)
    plank.position.y = 0.62
    g.add(plank)
    // 顶部横条装饰
    const bar = new THREE.Mesh(new THREE.BoxGeometry(axis === 'x' ? 2.2 : 0.5, 0.1, axis === 'x' ? 0.5 : 2.2), this.metalMat)
    bar.position.y = 1.18
    g.add(bar)
    g.position.set(x, 0, z)
    this.scene.add(g)
    // 竖板:与木板视觉完全一致的细长 footprint(2.2 × 0.45)
    const colUp: AABB =
      axis === 'x'
        ? { minX: x - 1.1, maxX: x + 1.1, minZ: z - 0.225, maxZ: z + 0.225 }
        : { minX: x - 0.225, maxX: x + 0.225, minZ: z - 1.1, maxZ: z + 1.1 }
    // 倒板:平放后变宽的长条 footprint(2.2 × 1.15)
    const collider: AABB =
      axis === 'x'
        ? { minX: x - 1.1, maxX: x + 1.1, minZ: z - 0.575, maxZ: z + 0.575 }
        : { minX: x - 0.575, maxX: x + 0.575, minZ: z - 1.1, maxZ: z + 1.1 }
    this.pallets.push({ id: this.pallets.length, x, z, axis, state: 'up', mesh: g, colUp, collider })
  }

  private cipher(x: number, z: number): void {
    const g = new THREE.Group()
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.5, 0.8), this.metalMat)
    body.position.y = 0.75
    g.add(body)
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.5, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.4 }),
    )
    panel.position.set(0, 1.1, 0.42)
    g.add(panel)
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), this.metalMat)
    antenna.position.set(0.35, 2.2, 0)
    g.add(antenna)
    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0x220505,
      emissive: 0xd41d1f,
      emissiveIntensity: 1.4,
    })
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 10), bulbMat)
    bulb.position.set(0.35, 3.0, 0)
    g.add(bulb)
    const light = new THREE.PointLight(0xd41d1f, 2.2, 7)
    light.position.set(0.35, 2.9, 0)
    g.add(light)
    g.position.set(x, 0, z)
    this.scene.add(g)
    this.cullableLights.push({ light, x, z })
    this.colliders.push({ minX: x - 0.55, maxX: x + 0.55, minZ: z - 0.4, maxZ: z + 0.4 })
    this.nav.markAABB({ minX: x - 0.55, maxX: x + 0.55, minZ: z - 0.4, maxZ: z + 0.4 }, 0.35)
    this.ciphers.push({
      id: this.ciphers.length,
      x,
      z,
      progress: 0,
      done: false,
      mesh: g,
      bulb: bulbMat,
      antennaLight: light,
      seed: Math.random() * 10,
    })
  }

  private chair(x: number, z: number): void {
    const g = new THREE.Group()
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.15, 0.9), this.metalMat)
    seat.position.y = 0.55
    g.add(seat)
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 0.14), this.metalMat)
    back.position.set(0, 1.2, -0.4)
    g.add(back)
    for (const [lx, lz] of [
      [-0.35, -0.35],
      [0.35, -0.35],
      [-0.35, 0.35],
      [0.35, 0.35],
    ]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 6), this.metalMat)
      leg.position.set(lx, 0.28, lz)
      g.add(leg)
    }
    // 火箭桶
    const rocket = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.4, 10), this.metalMat)
    rocket.position.set(0, 1.5, -0.62)
    g.add(rocket)
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(0.32, 0.5, 10),
      new THREE.MeshStandardMaterial({ color: 0xd41d1f, roughness: 0.5 }),
    )
    tip.position.set(0, 2.45, -0.62)
    g.add(tip)
    // 束缚带
    const strap = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.08, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x571617, roughness: 0.8 }),
    )
    strap.position.set(0, 0.95, -0.1)
    g.add(strap)
    const light = new THREE.PointLight(0xd41d1f, 1.1, 5)
    light.position.set(0, 2.2, 0)
    g.add(light)
    g.position.set(x, 0, z)
    this.scene.add(g)
    this.cullableLights.push({ light, x, z })
    // 透视高亮覆盖层(克隆共享几何,剔除光源)
    const hl = g.clone(true)
    const toRemove: THREE.Object3D[] = []
    hl.traverse((o) => {
      if (o instanceof THREE.PointLight) toRemove.push(o)
      if (o instanceof THREE.Mesh) {
        o.material = World.chairHlMat
        o.renderOrder = 999
      }
    })
    for (const l of toRemove) l.parent?.remove(l)
    hl.scale.set(1.07, 1.07, 1.07)
    hl.visible = false
    g.add(hl)
    this.colliders.push({ minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.5, maxZ: z + 0.5 })
    this.nav.markAABB({ minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.5, maxZ: z + 0.5 }, 0.35)
    this.chairs.push({ id: this.chairs.length, x, z, occupiedBy: -1, mesh: g, highlight: hl })
  }

  private static chairHlMat = new THREE.MeshBasicMaterial({
    color: 0xff3524,
    transparent: true,
    opacity: 0.5,
    depthTest: false,
    depthWrite: false,
  })

  // 路灯:高杆 + 灯头 + 大范围冷光
  private streetLamp(x: number, z: number): void {
    const g = new THREE.Group()
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 3.8, 8), this.metalMat)
    pole.position.y = 1.9
    g.add(pole)
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.08), this.metalMat)
    arm.position.set(0.3, 3.75, 0)
    g.add(arm)
    const headMat = new THREE.MeshStandardMaterial({
      color: 0x223044,
      emissive: 0xa8c6ff,
      emissiveIntensity: 2.0,
    })
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.2), headMat)
    head.position.set(0.6, 3.7, 0)
    g.add(head)
    const light = new THREE.PointLight(0xa8c6ff, 3.6, 20, 1.2)
    light.position.set(0.6, 3.5, 0)
    g.add(light)
    g.position.set(x, 0, z)
    this.scene.add(g)
    this.cullableLights.push({ light, x, z })
    this.colliders.push({ minX: x - 0.15, maxX: x + 0.15, minZ: z - 0.15, maxZ: z + 0.15 })
    this.nav.markAABB({ minX: x - 0.15, maxX: x + 0.15, minZ: z - 0.15, maxZ: z + 0.15 }, 0.3)
  }

  private gate(x: number, z: number, switchX: number, switchZ: number, sign: number): void {
    const g = new THREE.Group()
    // 门框
    const frameMat = this.metalMat
    const post1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4.6, 0.8), frameMat)
    post1.position.set(-2.1, 2.3, 0)
    const post2 = post1.clone()
    post2.position.x = 2.1
    const top = new THREE.Mesh(new THREE.BoxGeometry(4.7, 0.5, 0.8), frameMat)
    top.position.set(0, 4.6, 0)
    g.add(post1, post2, top)
    // 双开门
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.7, metalness: 0.5 })
    const doorL = new THREE.Mesh(new THREE.BoxGeometry(1.9, 4.2, 0.25), doorMat)
    doorL.position.set(-0.95, 2.1, 0)
    const doorR = doorL.clone()
    doorR.position.x = 0.95
    g.add(doorL, doorR)
    // 警示灯
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x220505, emissive: 0xd41d1f, emissiveIntensity: 1.6 })
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 10), lampMat)
    lamp.position.set(0, 5.0, 0)
    g.add(lamp)
    const light = new THREE.PointLight(0xd41d1f, 2.5, 10)
    light.position.set(0, 4.8, 0)
    g.add(light)
    g.position.set(x, 0, z)
    this.cullableLights.push({ light, x, z })
    this.scene.add(g)
    // 开关台
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.3, 0.4), this.metalMat)
    panel.position.set(switchX, 0.65, switchZ)
    this.scene.add(panel)
    const lever = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.5, 0.12),
      new THREE.MeshStandardMaterial({ color: 0xd41d1f, emissive: 0x550808, emissiveIntensity: 1 }),
    )
    lever.position.set(switchX, 1.35, switchZ)
    this.scene.add(lever)
    // 门未开时阻挡
    this.colliders.push({ minX: x - 2.0, maxX: x + 2.0, minZ: z - 0.4, maxZ: z + 0.4 })
    this.gates.push({
      id: this.gates.length,
      x,
      z,
      switchX,
      switchZ,
      openProgress: 0,
      opened: false,
      opening: false,
      doorL,
      doorR,
      lampMat,
      mesh: g,
      axis: 'x',
      sign,
    })
  }

  private tree(x: number, z: number): void {
    const g = new THREE.Group()
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x211d19, roughness: 1 })
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, 3.4, 7), trunkMat)
    trunk.position.y = 1.7
    g.add(trunk)
    // 枯枝
    for (let i = 0; i < 4; i++) {
      const br = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.08, 1.6, 5), trunkMat)
      const a = (i / 4) * Math.PI * 2 + x
      br.position.set(Math.cos(a) * 0.5, 2.6 + (i % 2) * 0.5, Math.sin(a) * 0.5)
      br.rotation.set(Math.sin(a) * 0.9, 0, Math.cos(a) * 0.9)
      g.add(br)
    }
    g.position.set(x, 0, z)
    this.scene.add(g)
    this.colliders.push({ minX: x - 0.3, maxX: x + 0.3, minZ: z - 0.3, maxZ: z + 0.3 })
    this.nav.markAABB({ minX: x - 0.3, maxX: x + 0.3, minZ: z - 0.3, maxZ: z + 0.3 }, 0.3)
  }

  private build(): void {
    const B = 34.5 // 围墙位置
    // 地面
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 90),
      new THREE.MeshStandardMaterial({ color: 0x1d2027, roughness: 1 }),
    )
    ground.rotation.x = -Math.PI / 2
    this.scene.add(ground)

    // 周边墙(留出电闸门缺口)
    this.wall(-B - 1, -B, -14, -B)
    this.wall(-10, -B, B + 1, -B)
    this.wall(-B - 1, B, 10, B)
    this.wall(14, B, B + 1, B)
    this.wall(-B, -B, -B, B)
    this.wall(B, -B, B, B)

    // 板区 1 西北 (-16,-16):东侧门洞放板
    this.wall(-22, -20, -12, -20)
    this.wall(-22, -12, -17, -12)
    this.windowWall(-17, -12, -12, -12)
    this.wall(-22, -20, -22, -12)
    this.wall(-12, -20, -12, -17.1)
    this.pallet(-12, -16, 'z')
    this.wall(-12, -14.9, -12, -12)

    // 板区 2 东北 (16,-14):西侧门洞放板
    this.wall(11, -18, 21, -18)
    this.wall(11, -10, 16, -10)
    this.windowWall(16, -10, 21, -10)
    this.wall(21, -18, 21, -10)
    this.wall(11, -18, 11, -15.1)
    this.pallet(11, -14, 'z')
    this.wall(11, -12.9, 11, -10)

    // 板区 3 中央 (0,2):东侧门洞放板
    this.wall(-6, -2, -1, -2)
    this.windowWall(-1, -2, 4, -2)
    this.wall(-6, 6, 4, 6)
    this.wall(-6, -2, -6, 6)
    this.wall(4, -2, 4, 1.5)
    this.pallet(4, 2.6, 'z')
    this.wall(4, 3.7, 4, 6)

    // 板区 4 西南 (-14,14):西侧门洞放板
    this.wall(-20, 10, -10, 10)
    this.wall(-20, 18, -15, 18)
    this.windowWall(-15, 18, -10, 18)
    this.wall(-10, 10, -10, 18)
    this.wall(-20, 10, -20, 12.9)
    this.pallet(-20, 14, 'z')
    this.wall(-20, 15.1, -20, 18)

    // 板区 5 东南 (16,16):西侧门洞放板
    this.wall(10, 12, 20, 12)
    this.wall(10, 20, 15, 20)
    this.windowWall(15, 20, 20, 20)
    this.wall(20, 12, 20, 20)
    this.wall(10, 12, 10, 14.9)
    this.pallet(10, 16, 'z')
    this.wall(10, 17.1, 10, 20)

    // 零散断墙
    this.wall(-2, -28, 6, -28)
    this.wall(-28, -2, -28, 6)
    this.wall(26, -4, 26, 4)
    this.wall(-4, 26, 4, 26)
    this.windowWall(8, -24, 14, -24)

    // 密码机
    this.cipher(-26, -27)
    this.cipher(27, -26)
    this.cipher(-1, -15)
    this.cipher(-26, 24)
    this.cipher(26, 26)

    // 狂欢之椅
    this.chair(2, -27)
    this.chair(-9, -7)
    this.chair(12, 4)
    this.chair(-2, 21)
    this.chair(27, 9)
    this.chair(-29, 3)

    // 电闸门(北/南)
    this.gate(-12, -34.5, -8.6, -33.2, -1)
    this.gate(12, 34.5, 8.6, 33.2, 1)

    // 5 处路灯(固定点位,避开墙体/密码机/电闸/椅子)
    const lamps: [number, number][] = [
      [0, -22],
      [-27, -10],
      [16, -2],
      [-8, 23],
      [24, 14],
    ]
    for (const [lx, lz] of lamps) this.streetLamp(lx, lz)

    // 枯树
    const trees: [number, number][] = [
      [-30, -18], [-12, -26], [10, -28], [30, -16], [-30, 12], [-16, 26],
      [6, 14], [30, 18], [14, -6], [-14, 2], [6, -10], [-32, 28], [22, 30], [-6, 32],
    ]
    for (const [tx, tz] of trees) this.tree(tx, tz)

    // 雾与光(适度提亮:雾更薄、环境光/半球光/月光均加强,保留夜战氛围但看清 5m 外)
    this.scene.fog = new THREE.FogExp2(0x11151c, 0.013)
    this.scene.background = new THREE.Color(0x11151c)
    const amb = new THREE.AmbientLight(0x4a5366, 2.6)
    this.scene.add(amb)
    // 半球光:冷天光/暗地面反弹,保证轮廓可读
    const hemi = new THREE.HemisphereLight(0x5a6a8c, 0x2a2e36, 1.6)
    this.scene.add(hemi)
    const moon = new THREE.DirectionalLight(0xb8c8e8, 1.8)
    moon.position.set(-20, 40, -12)
    this.scene.add(moon)
    // 月亮(发光球)
    const moonBall = new THREE.Mesh(
      new THREE.SphereGeometry(2.2, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xdfe6f2, fog: false }),
    )
    moonBall.position.set(-38, 46, -26)
    this.scene.add(moonBall)
  }

  // 每帧动画:密码机灯闪烁、门开动画
  update(dt: number, time: number): void {
    for (const c of this.ciphers) {
      if (c.done) continue
      const blink = Math.sin(time * 6 + c.seed * 7) > 0.2 ? 1.6 : 0.25
      c.bulb.emissiveIntensity = blink
      c.antennaLight.intensity = blink * 1.5
    }
    for (const g of this.gates) {
      if (g.opening && !g.opened) {
        g.openProgress = Math.min(1, g.openProgress + dt / 2.2)
        const a = g.openProgress * (Math.PI / 2) * 0.9
        g.doorL.rotation.y = -a
        g.doorR.rotation.y = a
        // 门绕中心旋转会偏,平移模拟滑开更稳
        g.doorL.position.x = -0.95 - g.openProgress * 1.7
        g.doorR.position.x = 0.95 + g.openProgress * 1.7
        if (g.openProgress >= 1) g.opened = true
      }
      if (this.gatePowered && !g.opened) {
        g.lampMat.emissiveIntensity = Math.sin(time * 8) > 0 ? 1.8 : 0.4
      }
    }
  }

  powerGates(): void {
    this.gatePowered = true
    for (const g of this.gates) {
      g.lampMat.color.set(0x0a220a)
      g.lampMat.emissive.set(0x7fb069)
      g.lampMat.emissiveIntensity = 1.8
    }
  }

  openGate(g: Gate): void {
    if (g.opening) return
    g.opening = true
    g.lampMat.emissive.set(0x7fb069)
    // 移除门体碰撞(原地修改,保持数组引用稳定)
    for (let i = this.colliders.length - 1; i >= 0; i--) {
      const c = this.colliders[i]
      if (Math.abs((c.minX + c.maxX) / 2 - g.x) < 0.1 && Math.abs((c.minZ + c.maxZ) / 2 - g.z) < 0.1) {
        this.colliders.splice(i, 1)
      }
    }
  }

  nearestFreeChair(x: number, z: number): Chair | null {
    let best: Chair | null = null
    let bd = Infinity
    for (const c of this.chairs) {
      if (c.occupiedBy !== -1) continue
      const d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z)
      if (d < bd) {
        bd = d
        best = c
      }
    }
    return best
  }
}
