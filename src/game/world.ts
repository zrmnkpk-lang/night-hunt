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
  pivot: THREE.Group // 倒下旋转容器(内容以板中心为原点,侧倒 = pivot.rotation.x 0→-π/2)
  fallT: number // 倒下过渡动画剩余时间(>0 表示动画中)
  fallDur: number
  sx: number // 站立点 x(门洞侧边、宽面贴墙处)
  sz: number // 站立点 z
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
  wheel?: THREE.Group // 侧面转轮(破译中缓慢旋转)
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
  doorL: THREE.Group // 左门扇(原点在铰链,旋转即开)
  doorR: THREE.Group // 右门扇(原点在铰链)
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

  // 砖块几何缓存(同尺寸复用,避免重复创建)
  private brickGeoCache = new Map<string, THREE.BoxGeometry>()
  private brickGeo(w: number, h: number, d: number): THREE.BoxGeometry {
    const key = `${w.toFixed(2)}_${h.toFixed(2)}_${d.toFixed(2)}`
    let g = this.brickGeoCache.get(key)
    if (!g) {
      g = new THREE.BoxGeometry(w, h, d)
      this.brickGeoCache.set(key, g)
    }
    return g
  }

  // 视觉风格:plain=整体 box(超长围墙省面) bricks=木柱+砖块阵列 planks=矮墙+斜钉木板(窗)
  private addWallBox(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    h: number,
    blocksSight: boolean,
    visual: 'auto' | 'plain' | 'bricks' | 'planks' = 'auto',
  ): AABB {
    const box: AABB = {
      minX: Math.min(x1, x2),
      maxX: Math.max(x1, x2),
      minZ: Math.min(z1, z2),
      maxZ: Math.max(z1, z2),
    }
    const w = box.maxX - box.minX
    const d = box.maxZ - box.minZ
    const cx = (box.minX + box.maxX) / 2
    const cz = (box.minZ + box.maxZ) / 2
    const long = Math.max(w, d)
    const style = visual === 'auto' ? (h <= LOW_H + 0.01 ? 'planks' : long > 25 ? 'plain' : 'bricks') : visual
    const g = new THREE.Group()
    if (style === 'bricks') {
      // 参考图墙体:两端木柱 + 砖块阵列(缝隙靠块间留白)
      const alongX = w >= d // 墙的走向
      const thick = alongX ? d : w
      const colW = 1.06 // 砖列宽
      const rowH = h / Math.max(2, Math.round(h / 0.92)) // 砖行高
      const cols = Math.max(2, Math.round(long / colW))
      const rows = Math.max(2, Math.round(h / 0.92))
      const bw = long / cols - 0.06
      // 端头木柱
      const postGeo = this.brickGeo(alongX ? 0.24 : thick + 0.06, h + 0.12, alongX ? thick + 0.06 : 0.24)
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, this.woodMat)
        post.position.set(alongX ? cx + (s * (long - 0.24)) / 2 : cx, (h + 0.12) / 2, alongX ? cz : cz + (s * (long - 0.24)) / 2)
        g.add(post)
      }
      // 砖块:奇数行偏移半砖并少一块(居中收边),模拟错缝砌法且不越界
      for (let r = 0; r < rows; r++) {
        const odd = r % 2 === 1
        const n = odd ? cols - 1 : cols
        const step = long / cols
        const start = odd ? -long / 2 + step : -long / 2 + step / 2
        for (let c = 0; c < n; c++) {
          const bx = start + c * step
          const geo = this.brickGeo(alongX ? bw : thick, rowH - 0.05, alongX ? thick : bw)
          const brick = new THREE.Mesh(geo, this.wallMat)
          brick.position.set(
            alongX ? cx + bx : cx,
            (r + 0.5) * rowH,
            alongX ? cz : cz + bx,
          )
          g.add(brick)
        }
      }
    } else if (style === 'planks') {
      // 参考图窗户:矮墙缺口上斜钉两根木板
      const alongX = w >= d
      const baseGeo = this.brickGeo(w, h, d)
      const base = new THREE.Mesh(baseGeo, this.lowWallMat)
      base.position.set(cx, h / 2, cz)
      g.add(base)
      const plankLen = Math.max(w, d) * 0.78
      const plankGeo = this.brickGeo(alongX ? plankLen : 0.12, 0.1, alongX ? 0.12 : plankLen)
      for (const s of [-1, 1]) {
        const plank = new THREE.Mesh(plankGeo, this.woodMat)
        plank.position.set(cx, h + 0.06, cz)
        if (alongX) plank.rotation.z = s * 0.16
        else plank.rotation.x = s * 0.16
        g.add(plank)
      }
    } else {
      // plain:整体 box
      const geo = this.brickGeo(w, h, d)
      const mesh = new THREE.Mesh(geo, h <= LOW_H + 0.01 ? this.lowWallMat : this.wallMat)
      mesh.position.set(cx, h / 2, cz)
      g.add(mesh)
    }
    this.scene.add(g)
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
    // 窗段视觉由 addWallBox 的 planks 风格处理(矮墙 + 斜钉木板);此处只注册翻越点
    const cx = (box.minX + box.maxX) / 2
    const cz = (box.minZ + box.maxZ) / 2
    const g = new THREE.Group()
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
    // 倒下动画容器:内容以板中心为原点建模,侧倒 = pivot.rotation.x 0→-π/2(板面转朝上)
    const pivot = new THREE.Group()
    // 参考图风格:两根竖柱 + 4 根横板条 + 铆钉(加大版)
    const rivetMat = new THREE.MeshStandardMaterial({ color: 0x5a5f66, roughness: 0.5, metalness: 0.6 })
    const LEN = 2.45
    const H = 1.7
    // 两根竖柱(长轴两端,居中)
    const postGeo = new THREE.BoxGeometry(0.18, H, 0.18)
    for (const px of [-LEN / 2 + 0.12, LEN / 2 - 0.12]) {
      const post = new THREE.Mesh(postGeo, this.woodMat)
      post.position.set(px, 0, 0)
      pivot.add(post)
    }
    // 4 根横板条 + 每板 2 颗铆钉(沿高度均布居中)
    const plankGeo = new THREE.BoxGeometry(LEN, 0.2, 0.28)
    const rivetGeo = new THREE.BoxGeometry(0.07, 0.05, 0.05)
    for (let i = 0; i < 4; i++) {
      const py = -0.45 + i * 0.3
      const plank = new THREE.Mesh(plankGeo, this.woodMat)
      plank.position.y = py
      pivot.add(plank)
      for (const rx of [-0.8, 0.8]) {
        const rivet = new THREE.Mesh(rivetGeo, rivetMat)
        rivet.position.set(rx, py, 0.15)
        pivot.add(rivet)
      }
    }
    g.add(pivot)
    if (axis === 'z') g.rotation.y = Math.PI / 2 // 长轴沿 z
    // 站立位:宽边贴靠着门洞短边(缺口两侧的墙端)的墙体侧面,留出门洞过道
    const NOR = 0.5 // 法向偏移:墙端柱半厚 0.33 + 板半厚 0.17 → 宽面紧贴墙
    const LAT = 2.28 // 沿墙偏移:板端(半长 1.225)刚好抵住缺口短边角(门洞半宽 1.1)
    const sx = x + (axis === 'z' ? NOR : LAT)
    const sz = z + (axis === 'x' ? NOR : LAT)
    pivot.position.y = H / 2 + 0.05 // 站立:板底微离地
    g.position.set(sx, 0, sz)
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
    this.pallets.push({ id: this.pallets.length, x, z, axis, state: 'up', mesh: g, pivot, fallT: 0, fallDur: 0.45, sx, sz, colUp, collider })
  }

  private cipher(x: number, z: number): void {
    const g = new THREE.Group()
    // 参考图风格:深灰方盒 + 侧面黄色大转轮 + 正面红色发光圆柱灯 + 顶部双排气管 + 四条腿
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3a3d43, roughness: 0.85 })
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0xc9a635, roughness: 0.6, metalness: 0.3 })
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.15, 1.0), bodyMat)
    body.position.y = 0.95
    g.add(body)
    // 四条腿
    const legGeo = new THREE.BoxGeometry(0.14, 0.4, 0.14)
    for (const [lx, lz] of [
      [-0.5, -0.35],
      [0.5, -0.35],
      [-0.5, 0.35],
      [0.5, 0.35],
    ]) {
      const leg = new THREE.Mesh(legGeo, bodyMat)
      leg.position.set(lx, 0.2, lz)
      g.add(leg)
    }
    // 侧面黄色大转轮:轮圈 + 4 辐条 + 中心轴(未完成时缓慢旋转)
    const wheel = new THREE.Group()
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.085, 6, 14), wheelMat)
    wheel.add(rim)
    const spokeGeo = new THREE.BoxGeometry(0.8, 0.07, 0.06)
    for (const a of [0, Math.PI / 2]) {
      const spoke = new THREE.Mesh(spokeGeo, wheelMat)
      spoke.rotation.z = a
      wheel.add(spoke)
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 8), wheelMat)
    hub.rotation.x = Math.PI / 2
    wheel.add(hub)
    wheel.rotation.y = Math.PI / 2 // 轮面朝 x 方向
    wheel.position.set(-0.78, 0.95, 0)
    g.add(wheel)
    // 正面红色发光圆柱灯(材质即 bulb:破译中闪烁、完成变绿)
    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0x220505,
      emissive: 0xd41d1f,
      emissiveIntensity: 1.4,
    })
    const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.12, 8), bodyMat)
    lampBase.rotation.x = Math.PI / 2
    lampBase.position.set(0.1, 0.95, 0.52)
    g.add(lampBase)
    const bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.3, 10), bulbMat)
    bulb.rotation.x = Math.PI / 2
    bulb.position.set(0.1, 0.95, 0.62)
    g.add(bulb)
    const light = new THREE.PointLight(0xd41d1f, 2.2, 7)
    light.position.set(0.1, 1.25, 0.4)
    g.add(light)
    // 顶部双排气管
    const pipeGeo = new THREE.BoxGeometry(0.1, 0.7, 0.1)
    for (const px of [-0.25, 0.15]) {
      const pipe = new THREE.Mesh(pipeGeo, bodyMat)
      pipe.position.set(px, 1.85, -0.2)
      g.add(pipe)
    }
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
      wheel,
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

  // 路灯:双层方底座 + 折杆 + 灯头盒 + 下垂发光灯罩(参考图风格)
  private streetLamp(x: number, z: number): void {
    const g = new THREE.Group()
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.8, metalness: 0.4 })
    // 双层方底座(下大上小)
    const base1 = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.22, 0.78), postMat)
    base1.position.y = 0.11
    const base2 = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.32, 0.56), postMat)
    base2.position.y = 0.38
    g.add(base1, base2)
    // 杆:下段竖直 + 上段前倾(折角)
    const poleLow = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.6, 0.14), postMat)
    poleLow.position.y = 1.83
    const poleTop = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.55, 0.14), postMat)
    poleTop.position.set(0.17, 3.85, 0)
    poleTop.rotation.z = -0.2
    g.add(poleLow, poleTop)
    // 灯头盒(顶端)+ 下垂发光灯罩
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.52, 0.62), postMat)
    head.position.set(0.46, 4.62, 0)
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.14, 0.72), postMat)
    cap.position.set(0.46, 4.95, 0)
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0x554316,
      emissive: 0xffd68a,
      emissiveIntensity: 2.2,
    })
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.46, 0.44), glowMat)
    glow.position.set(0.46, 4.12, 0)
    g.add(head, cap, glow)
    const light = new THREE.PointLight(0xffd9a0, 3.6, 20, 1.2)
    light.position.set(0.46, 3.9, 0)
    g.add(light)
    g.position.set(x, 0, z)
    this.scene.add(g)
    this.cullableLights.push({ light, x, z })
    this.colliders.push({ minX: x - 0.15, maxX: x + 0.15, minZ: z - 0.15, maxZ: z + 0.15 })
    this.nav.markAABB({ minX: x - 0.15, maxX: x + 0.15, minZ: z - 0.15, maxZ: z + 0.15 }, 0.3)
  }

  private gate(x: number, z: number, switchX: number, switchZ: number, sign: number): void {
    const g = new THREE.Group()
    // 参考图风格门框:双柱(带底座)+ 顶部横梁 + 梁中央发光方块
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.8, metalness: 0.4 })
    const postGeo = new THREE.BoxGeometry(0.55, 4.8, 0.7)
    const baseGeo = new THREE.BoxGeometry(0.78, 0.5, 0.92)
    for (const px of [-2.1, 2.1]) {
      const post = new THREE.Mesh(postGeo, frameMat)
      post.position.set(px, 2.4, 0)
      const base = new THREE.Mesh(baseGeo, frameMat)
      base.position.set(px, 0.25, 0)
      g.add(post, base)
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.55, 0.7), frameMat)
    top.position.set(0, 4.95, 0)
    g.add(top)
    // 警示灯:梁中央发光方块(未通电红 / 通电变绿闪烁,复用 lampMat 逻辑)
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x220505, emissive: 0xd41d1f, emissiveIntensity: 1.6 })
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.18), lampMat)
    lamp.position.set(0, 4.95, 0.36)
    g.add(lamp)
    const light = new THREE.PointLight(0xd41d1f, 2.5, 10)
    light.position.set(0, 4.6, 0.8)
    g.add(light)
    // 双开门扇:原点在铰链侧(旋转即开),门板+边框+上下加固条+红色发光把手
    const buildDoor = (side: -1 | 1): THREE.Group => {
      const d = new THREE.Group()
      d.position.set(side * 1.9, 0, 0) // 铰链位于门洞外缘
      const panelMat = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.75, metalness: 0.45 })
      const trimMat = new THREE.MeshStandardMaterial({ color: 0x3a3e45, roughness: 0.7, metalness: 0.4 })
      // 门板(几何向铰链反方向偏移半宽,使门绕铰链旋转)
      const panelGeo = new THREE.BoxGeometry(1.84, 4.3, 0.14)
      panelGeo.translate(-side * 0.92, 2.25, 0)
      d.add(new THREE.Mesh(panelGeo, panelMat))
      // 外圈边框(左右竖条 + 上下横条)
      const frameSide = new THREE.BoxGeometry(0.13, 4.36, 0.18)
      const fs1 = new THREE.Mesh(frameSide, trimMat)
      fs1.position.set(-side * 0.06, 2.25, 0)
      const fs2 = new THREE.Mesh(frameSide, trimMat)
      fs2.position.set(-side * 1.78, 2.25, 0)
      const frameBar = new THREE.BoxGeometry(1.85, 0.13, 0.18)
      const fb1 = new THREE.Mesh(frameBar, trimMat)
      fb1.position.set(-side * 0.92, 0.1, 0)
      const fb2 = new THREE.Mesh(frameBar, trimMat)
      fb2.position.set(-side * 0.92, 4.4, 0)
      d.add(fs1, fs2, fb1, fb2)
      // 上下两条横向加固条(凸出板面)
      const barGeo = new THREE.BoxGeometry(1.6, 0.24, 0.08)
      for (const by of [1.35, 3.1]) {
        const bar = new THREE.Mesh(barGeo, trimMat)
        bar.position.set(-side * 0.92, by, 0.1)
        d.add(bar)
      }
      // 红色发光把手(靠合缝侧)
      const handle = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.55, 0.09),
        new THREE.MeshStandardMaterial({ color: 0x220505, emissive: 0xd41d1f, emissiveIntensity: 1.8 }),
      )
      handle.position.set(-side * 1.7, 2.25, 0.1)
      d.add(handle)
      return d
    }
    const doorL = buildDoor(-1)
    const doorR = buildDoor(1)
    g.add(doorL, doorR)
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

  // 草叶几何缓存(4 档高度,同丛多棵复用)
  private bladeGeoCache = new Map<number, THREE.ConeGeometry>()
  private bladeGeo(h: number): THREE.ConeGeometry {
    let g = this.bladeGeoCache.get(h)
    if (!g) {
      g = new THREE.ConeGeometry(0.09, h, 4)
      this.bladeGeoCache.set(h, g)
    }
    return g
  }

  // 草丛:六边形底座 + 3-5 棵低多边形尖刺草,每棵方向/倾斜/缩放随机。纯装饰,无碰撞。
  private grassTuft(x: number, z: number): void {
    const g = new THREE.Group()
    const grassMats = [
      new THREE.MeshStandardMaterial({ color: 0x4a6b3a, roughness: 1 }),
      new THREE.MeshStandardMaterial({ color: 0x557a42, roughness: 1 }),
      new THREE.MeshStandardMaterial({ color: 0x608a4a, roughness: 1 }),
    ]
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x3a5230, roughness: 1 })
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.58, 0.07, 6), baseMat)
    base.position.y = 0.035
    g.add(base)
    const n = 3 + Math.floor(Math.random() * 3) // 3-5 棵
    for (let i = 0; i < n; i++) {
      const h = 0.55 + Math.random() * 0.5
      const blade = new THREE.Mesh(this.bladeGeo(Math.round(h * 4) / 4), grassMats[Math.floor(Math.random() * grassMats.length)])
      // 丛内随机散布 + 随机朝向/倾斜/缩放
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * 0.3
      blade.position.set(Math.cos(a) * r, (h / 2) * 1, Math.sin(a) * r)
      blade.rotation.y = Math.random() * Math.PI * 2
      blade.rotation.x = (Math.random() - 0.5) * 0.35
      blade.rotation.z = (Math.random() - 0.5) * 0.35
      const s = 0.75 + Math.random() * 0.65
      blade.scale.set(s, 0.85 + Math.random() * 0.35, s)
      g.add(blade)
    }
    g.position.set(x, 0, z)
    g.rotation.y = Math.random() * Math.PI * 2 // 整丛朝向随机
    this.scene.add(g)
  }

  private tree(x: number, z: number): void {
    const g = new THREE.Group()
    // 参考图风格:深棕锥形树干 + 三分枝 + 三个双层锥形树冠(墨绿)
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3628, roughness: 1 })
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3d5738, roughness: 0.95 })
    // 主干(下粗上细)+ 上段
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.42, 2.1, 6), trunkMat)
    trunk.position.y = 1.05
    const trunkTop = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.19, 1.5, 5), trunkMat)
    trunkTop.position.set(0.05, 2.75, 0)
    trunkTop.rotation.z = -0.07
    g.add(trunk, trunkTop)
    // 左右分枝(斜伸)
    const branchGeo = new THREE.CylinderGeometry(0.06, 0.11, 1.25, 5)
    const branchL = new THREE.Mesh(branchGeo, trunkMat)
    branchL.position.set(-0.5, 2.35, 0)
    branchL.rotation.z = 0.95
    const branchR = new THREE.Mesh(branchGeo, trunkMat)
    branchR.position.set(0.5, 2.25, 0)
    branchR.rotation.z = -0.95
    g.add(branchL, branchR)
    // 双层锥形树冠(底层大锥 + 顶上小锥)
    const canopy = (cx: number, cy: number, s: number): void => {
      const c1 = new THREE.Mesh(new THREE.ConeGeometry(0.8 * s, 1.0 * s, 6), leafMat)
      c1.position.set(cx, cy, 0)
      const c2 = new THREE.Mesh(new THREE.ConeGeometry(0.55 * s, 0.85 * s, 6), leafMat)
      c2.position.set(cx, cy + 0.75 * s, 0)
      g.add(c1, c2)
    }
    canopy(0.12, 3.7, 1.1) // 顶冠
    canopy(-0.95, 2.9, 0.85) // 左冠
    canopy(0.95, 2.8, 0.8) // 右冠
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

    // 草丛:全图随机撒点,避开墙格与关键设施(密码机/椅子/门/板/路灯/树),丛间距 > 4m
    const grassSpots: [number, number][] = []
    let grassPlaced = 0
    let grassGuard = 0
    while (grassPlaced < 26 && grassGuard++ < 500) {
      const gx = (Math.random() * 2 - 1) * 31
      const gz = (Math.random() * 2 - 1) * 31
      if (this.nav.blockedAt(gx, gz)) continue
      let tooClose = false
      const check = (px: number, pz: number, min: number): void => {
        if ((px - gx) * (px - gx) + (pz - gz) * (pz - gz) < min * min) tooClose = true
      }
      for (const c of this.ciphers) check(c.x, c.z, 2.5)
      for (const ch of this.chairs) check(ch.x, ch.z, 2.5)
      for (const gt of this.gates) check(gt.x, gt.z, 5)
      for (const p of this.pallets) check(p.x, p.z, 3)
      for (const [lx, lz] of lamps) check(lx, lz, 2)
      for (const [tx2, tz2] of trees) check(tx2, tz2, 2.5)
      for (const [gx2, gz2] of grassSpots) check(gx2, gz2, 4)
      if (tooClose) continue
      this.grassTuft(gx, gz)
      grassSpots.push([gx, gz])
      grassPlaced++
    }

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
      if (c.wheel) c.wheel.rotation.z += dt * 1.2 // 绕轮盘法向(本地 z,即世界 x)旋转
    }
    // 木板倒下过渡动画:板比过道缺口长,侧倒 45° 后斜卡在门洞里——
    // 板长边两端架在缺口两侧墙沿上,板面与地面约 45°,形成斜面阻挡(非平放)。
    // 放板即生效碰撞,动画仅视觉。
    for (const p of this.pallets) {
      if (p.fallT > 0) {
        p.fallT -= dt
        const k = 1 - Math.max(0, p.fallT) / p.fallDur
        const e = k * k * (3 - 2 * k) // smoothstep 缓动
        p.pivot.rotation.x = -(Math.PI / 4) * e // 只倒 45°:斜卡而不是平躺
        p.pivot.position.y = 0.9 + (0.68 - 0.9) * e // 板心高度:45° 时底棱贴地(半高 0.85×cos45°+板厚)
        p.mesh.position.x = p.sx + (p.x - p.sx) * e
        p.mesh.position.z = p.sz + (p.z - p.sz) * e
      }
    }
    for (const g of this.gates) {
      if (g.opening && !g.opened) {
        g.openProgress = Math.min(1, g.openProgress + dt / 2.2)
        const a = g.openProgress * (Math.PI / 2) * 0.92
        // 双扇绕各自铰链(门洞外缘)向逃生方向外侧打开(sign 区分南北门朝向)
        g.doorL.rotation.y = -g.sign * a
        g.doorR.rotation.y = g.sign * a
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
