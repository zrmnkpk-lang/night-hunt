// 程序化低多边形人形角色(幸存者/猎人)
import * as THREE from 'three'
import { bevelBox, box, material, dressSurvivor, dressHunter } from './art'

// 透视轮廓共享材质(红色警示,穿墙可见)
// 模块级单例:被所有人形共用,disposeScene 必须跳过它(释放后重开局透视会失效)
const outlineMat = new THREE.MeshBasicMaterial({
  color: 0xff4526,
  transparent: true,
  opacity: 0.45,
  depthTest: false,
  depthWrite: false,
}) as THREE.MeshBasicMaterial & { __shared?: boolean }
outlineMat.__shared = true

export interface Humanoid {
  group: THREE.Group
  body: THREE.Mesh
  head: THREE.Mesh
  armL: THREE.Mesh
  armR: THREE.Mesh
  legL: THREE.Mesh
  legR: THREE.Mesh
  eyeL?: THREE.Mesh
  eyeR?: THREE.Mesh
  weapon?: THREE.Mesh
  lantern?: THREE.Group
  lanternCore?: THREE.MeshStandardMaterial
  lanternLight?: THREE.PointLight
  lanternBase: number
  // 猎灯:仅玩家扮演杀手时点亮(huntLight.visible = true),AI 猎人默认关闭
  huntLight?: THREE.PointLight
  outline: THREE.Mesh[]
  flickerSeed: number
  walkPhase: number
  height: number
}

// 手提灯笼:金属框 + 暖光核心 + 点光源
function makeLantern(): { g: THREE.Group; core: THREE.MeshStandardMaterial; light: THREE.PointLight } {
  const g = new THREE.Group()
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1c1a16, roughness: 0.6, metalness: 0.7 })
  // 上下盖
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.04, 8), frameMat)
  top.position.y = 0.14
  const bottom = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.04, 8), frameMat)
  bottom.position.y = -0.12
  // 立柱
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.24, 4), frameMat)
    post.position.set(Math.cos(a) * 0.09, 0.01, Math.sin(a) * 0.09)
    g.add(post)
  }
  // 提手
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 5, 10, Math.PI), frameMat)
  handle.position.y = 0.17
  // 发光核心
  const core = new THREE.MeshStandardMaterial({
    color: 0xffb35c,
    emissive: 0xffb35c,
    emissiveIntensity: 2.4,
  })
  const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), core)
  g.add(top, bottom, handle, coreMesh)
  g.name = 'Hand_lantern'
  const brass = material('Lantern_brass', 0x967347, 0.6, 0.45)
  box(g, 'Lantern_foot', [0.17, 0.028, 0.17], [0, -0.15, 0], brass)
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.095, 5), core)
  flame.position.y = 0.03
  g.add(flame)
  const light = new THREE.PointLight(0xffb35c, 2.4, 12.5, 1.4)
  light.position.y = 0.05
  g.add(light)
  return { g, core, light }
}

export function makeSurvivorMesh(color: number, isPlayer: boolean): Humanoid {
  const group = new THREE.Group()
  // 参考图风格:方块几何拼装的低多边形小人
  // 毛衣色 = 传入 color(每人不同);裤/鞋/包/肤色统一
  const sweaterMat = new THREE.MeshStandardMaterial({ color, roughness: 0.88 })
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9b48d, roughness: 0.75 })
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x54402e, roughness: 0.95 })
  const pantsMat = new THREE.MeshStandardMaterial({ color: 0x2e3a5c, roughness: 0.9 })
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0xd8d3c8, roughness: 0.85 })
  const bagMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.9 })
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a })

  // 头:低分段球(切角方块感)+ 头发半球盖 + 黑色竖条眼
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 7, 6), skinMat)
  head.position.y = 1.56
  head.scale.set(1, 1.08, 0.95)
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.225, 7, 5, 0, Math.PI * 2, 0, Math.PI * 0.52), hairMat)
  hair.position.set(0, 0.03, -0.015)
  hair.rotation.x = -0.12
  head.add(hair)
  const eyeGeo = new THREE.BoxGeometry(0.045, 0.085, 0.02)
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat)
  eyeL.position.set(-0.075, 0.02, 0.195)
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat)
  eyeR.position.set(0.075, 0.02, 0.195)
  head.add(eyeL, eyeR)

  // 躯干:毛衣 box
  const body = new THREE.Mesh(bevelBox(0.54, 0.6, 0.32, 0.065), sweaterMat)
  body.position.y = 0.96
  // 斜挎包:肩带斜跨胸前 + 包体挂腰侧
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.72, 0.03), bagMat)
  strap.position.set(0.02, 0.06, 0.17)
  strap.rotation.z = 0.62
  body.add(strap)
  const bag = new THREE.Mesh(bevelBox(0.24, 0.28, 0.13), bagMat)
  bag.position.set(-0.28, -0.18, 0.08)
  bag.rotation.y = 0.25
  body.add(bag)

  // 手臂:毛衣袖 box(旋转轴在肩)+ 肤色手
  const armGeo = bevelBox(0.15, 0.52, 0.15)
  armGeo.translate(0, -0.26, 0)
  const armL = new THREE.Mesh(armGeo, sweaterMat)
  armL.position.set(-0.35, 1.24, 0)
  const armR = new THREE.Mesh(armGeo, sweaterMat)
  armR.position.set(0.35, 1.24, 0)
  const handGeo = new THREE.BoxGeometry(0.13, 0.13, 0.13)
  const handL = new THREE.Mesh(handGeo, skinMat)
  handL.position.y = -0.56
  armL.add(handL)
  const handR = new THREE.Mesh(handGeo, skinMat)
  handR.position.y = -0.56
  armR.add(handR)

  // 腿:深蓝裤 box(旋转轴在髋)+ 白鞋
  const legGeo = bevelBox(0.18, 0.56, 0.18)
  legGeo.translate(0, -0.3, 0)
  const legL = new THREE.Mesh(legGeo, pantsMat)
  legL.position.set(-0.14, 0.66, 0)
  const legR = new THREE.Mesh(legGeo, pantsMat)
  legR.position.set(0.14, 0.66, 0)
  const shoeGeo = bevelBox(0.2, 0.12, 0.32)
  const shoeL = new THREE.Mesh(shoeGeo, shoeMat)
  shoeL.position.set(0, -0.62, 0.05)
  legL.add(shoeL)
  const shoeR = new THREE.Mesh(shoeGeo, shoeMat)
  shoeR.position.set(0, -0.62, 0.05)
  legR.add(shoeR)

  // 右手提灯笼:玩家大灯(范围 22m),队友小灯省性能
  const lan = makeLantern()
  if (isPlayer) {
    lan.light.distance = 22
    lan.light.intensity = 5.4
  } else {
    lan.light.distance = 9
    lan.light.intensity = 1.4
  }
  lan.g.position.set(0, -0.62, 0.04)
  armR.add(lan.g)
  dressSurvivor({ group, body, head, armL, armR, legL, legR }, color)

  // 透视轮廓(预建,默认隐藏,切换 visible 即可)
  const outline: THREE.Mesh[] = []
  for (const part of [body, head, armL, armR, legL, legR]) {
    const o = new THREE.Mesh(part.geometry, outlineMat)
    o.scale.set(1.09, 1.09, 1.09)
    o.renderOrder = 999
    o.visible = false
    part.add(o)
    outline.push(o)
  }
  group.add(body, head, armL, armR, legL, legR)
  return {
    group, body, head, armL, armR, legL, legR,
    lantern: lan.g,
    lanternCore: lan.core,
    lanternLight: lan.light,
    lanternBase: lan.light.intensity,
    outline,
    flickerSeed: Math.random() * 100,
    walkPhase: Math.random() * 6,
    height: 1.75,
  }
}

export function makeHunterMesh(): Humanoid {
  const group = new THREE.Group()
  // 参考图风格:黑色斗篷杀手 + 白色圆面具(黑眼洞) + 长刀 + 棕靴
  const robeMat = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.95 })
  const maskMat = new THREE.MeshStandardMaterial({ color: 0xd9d6d0, roughness: 0.55 })
  const holeMat = new THREE.MeshBasicMaterial({ color: 0x0c0c0e })
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x54402e, roughness: 0.9 })
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.3, metalness: 0.85 })

  // 面具头:低分段白球(压扁)+ 黑色眼洞
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6), maskMat)
  head.position.y = 2.02
  head.scale.set(1, 1.12, 0.88)
  const eyeGeo = new THREE.BoxGeometry(0.075, 0.1, 0.03)
  const eyeL = new THREE.Mesh(eyeGeo, holeMat)
  eyeL.position.set(-0.085, 0.04, 0.21)
  const eyeR = new THREE.Mesh(eyeGeo, holeMat)
  eyeR.position.set(0.085, 0.04, 0.21)
  head.add(eyeL, eyeR)

  // 躯干:宽大黑袍 box + 肩部垫块(上宽下窄的斗篷轮廓)
  const body = new THREE.Mesh(bevelBox(0.72, 0.82, 0.44, 0.085), robeMat)
  body.position.y = 1.34
  const shoulderGeo = bevelBox(0.26, 0.3, 0.4, 0.06)
  const shoulderL = new THREE.Mesh(shoulderGeo, robeMat)
  shoulderL.position.set(-0.36, 0.34, 0)
  body.add(shoulderL)
  const shoulderR = new THREE.Mesh(shoulderGeo, robeMat)
  shoulderR.position.set(0.36, 0.34, 0)
  body.add(shoulderR)
  // 袍摆:腰以下略宽的一段,盖到大腿
  const skirt = new THREE.Mesh(bevelBox(0.68, 0.32, 0.40, 0.05), robeMat)
  skirt.position.y = -0.6
  body.add(skirt)

  // 手臂:黑袍袖 box(旋转轴在肩)
  const armGeo = bevelBox(0.18, 0.6, 0.18, 0.045)
  armGeo.translate(0, -0.3, 0)
  const armL = new THREE.Mesh(armGeo, robeMat)
  armL.position.set(-0.46, 1.72, 0)
  const armR = new THREE.Mesh(armGeo, robeMat)
  armR.position.set(0.46, 1.72, 0)

  // 腿:黑裤 box + 棕靴(旋转轴在髋)
  const legGeo = bevelBox(0.2, 0.62, 0.2)
  legGeo.translate(0, -0.34, 0)
  const legL = new THREE.Mesh(legGeo, robeMat)
  legL.position.set(-0.17, 0.9, 0)
  const legR = new THREE.Mesh(legGeo, robeMat)
  legR.position.set(0.17, 0.9, 0)
  const bootGeo = bevelBox(0.24, 0.2, 0.36)
  const bootL = new THREE.Mesh(bootGeo, bootMat)
  bootL.position.set(0, -0.7, 0.06)
  legL.add(bootL)
  const bootR = new THREE.Mesh(bootGeo, bootMat)
  bootR.position.set(0, -0.7, 0.06)
  legR.add(bootR)

  // 武器:长刀(细长宽刃 + 短柄)
  const weapon = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.9, 0.13), bladeMat)
  weapon.position.set(0.5, 0.9, 0.16)
  weapon.rotation.z = 0.22
  const hilt = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.07), bootMat)
  hilt.position.y = -0.52
  weapon.add(hilt)

  group.add(body, head, armL, armR, legL, legR, weapon)
  dressHunter({ group, body, head, armL, armR, legL, legR, weapon })

  // 猎灯:猎人自身不带提灯,但玩家扮演杀手时需要光源,否则全场只剩求生者的微弱提灯(近乎全黑)。
  // 默认 visible=false(AI 猎人靠自身 emissive 已足够),由 Engine.buildScene 在玩家扮演杀手时点亮。
  const huntLight = new THREE.PointLight(0xffd9a0, 3.2, 18, 1.2)
  huntLight.position.set(0, 1.7, 0)
  huntLight.visible = false
  group.add(huntLight)

  return {
    group, body, head, armL, armR, legL, legR, eyeL, eyeR, weapon,
    lanternBase: 0, huntLight, outline: [], flickerSeed: 0, walkPhase: 0, height: 2.3,
  }
}

export type Pose = 'stand' | 'crawl' | 'carried' | 'chaired'

// 步行动画:速度越快摆幅越大;pose 处理特殊姿态。
// injured:受伤姿态——身体前倾,跑动时仅单臂摆动(另一手捂腹)。
export function animateHumanoid(h: Humanoid, dt: number, speed: number, pose: Pose, time: number, injured = false): void {
  const g = h.group
  // Clear offsets left by a previous injured/chaired/carried pose before applying the next pose.
  h.body.rotation.x = 0
  h.body.scale.y = 1
  h.armR.rotation.z = 0
  h.armL.rotation.x = h.armR.rotation.x = 0
  h.legL.rotation.x = h.legR.rotation.x = 0
  if (pose === 'crawl') {
    g.rotation.x = -Math.PI / 2 + 0.12
    g.position.y = 0.25
    h.walkPhase += dt * (2 + speed * 2)
    const s = Math.sin(h.walkPhase)
    h.armL.rotation.x = s * 0.5
    h.armR.rotation.x = -s * 0.5
    h.legL.rotation.x = -s * 0.3
    h.legR.rotation.x = s * 0.3
    return
  }
  if (pose === 'carried') {
    g.rotation.x = -Math.PI / 2
    g.position.y = 1.55
    const w = Math.sin(time * 7) * 0.1
    h.armL.rotation.x = w
    h.armR.rotation.x = -w
    return
  }
  if (pose === 'chaired') {
    g.rotation.x = 0
    g.position.y = -0.35
    h.legL.rotation.x = -1.35
    h.legR.rotation.x = -1.35
    const w = Math.sin(time * 9) * 0.12
    h.armL.rotation.x = -0.6 + w
    h.armR.rotation.x = -0.6 - w
    g.rotation.y += Math.sin(time * 3.1) * 0.001
    return
  }
  // 站立/行走
  g.rotation.x = 0
  g.position.y = 0
  const rate = 2.2 + speed * 1.9
  h.walkPhase += dt * rate
  const amp = Math.min(0.75, speed * 0.16)
  const s = Math.sin(h.walkPhase)
  h.legL.rotation.x = s * amp
  h.legR.rotation.x = -s * amp
  if (injured) {
    // 受伤:身体前倾 + 右手捂腹,只有左臂随跑动摆动
    h.body.rotation.x = 0.3
    h.armL.rotation.x = -s * amp * 1.1
    h.armR.rotation.x = -0.85
    h.armR.rotation.z = -0.35 // 手臂内收贴腹
  } else {
    h.armL.rotation.x = -s * amp * 0.8
    h.armR.rotation.x = s * amp * 0.8
    h.armR.rotation.z = 0
  }
  if (speed < 0.1) {
    // 待机呼吸
    h.body.scale.y = 1 + Math.sin(time * 1.8 + h.walkPhase) * 0.015
    if (injured) {
      h.armL.rotation.x = Math.sin(time * 1.4) * 0.05
      h.armR.rotation.x = -0.85
    } else {
      h.armL.rotation.x = Math.sin(time * 1.4) * 0.05
      h.armR.rotation.x = -Math.sin(time * 1.4) * 0.05
    }
  } else {
    h.body.scale.y = 1
  }
}
