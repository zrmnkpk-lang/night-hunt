// 程序化低多边形人形角色(幸存者/猎人)
import * as THREE from 'three'

// 透视轮廓共享材质(红色警示,穿墙可见)
const outlineMat = new THREE.MeshBasicMaterial({
  color: 0xff4526,
  transparent: true,
  opacity: 0.45,
  depthTest: false,
  depthWrite: false,
})

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
  const light = new THREE.PointLight(0xffb35c, 2.4, 12.5, 1.4)
  light.position.y = 0.05
  g.add(light)
  return { g, core, light }
}

export function makeSurvivorMesh(color: number, isPlayer: boolean): Humanoid {
  const group = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xc9b39a, roughness: 0.8 })
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.55, 4, 10), mat)
  body.position.y = 0.95
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 12), skinMat)
  head.position.y = 1.58
  const armGeo = new THREE.CapsuleGeometry(0.07, 0.5, 3, 8)
  armGeo.translate(0, -0.28, 0)
  const armL = new THREE.Mesh(armGeo, mat)
  armL.position.set(-0.36, 1.32, 0)
  const armR = new THREE.Mesh(armGeo, mat)
  armR.position.set(0.36, 1.32, 0)
  const legGeo = new THREE.CapsuleGeometry(0.09, 0.55, 3, 8)
  legGeo.translate(0, -0.32, 0)
  const legMat = new THREE.MeshStandardMaterial({ color: 0x23252b, roughness: 0.9 })
  const legL = new THREE.Mesh(legGeo, legMat)
  legL.position.set(-0.14, 0.72, 0)
  const legR = new THREE.Mesh(legGeo, legMat)
  legR.position.set(0.14, 0.72, 0)
  // 右手提灯笼:玩家大灯(范围 22m),队友小灯省性能
  const lan = makeLantern()
  if (isPlayer) {
    lan.light.distance = 22
    lan.light.intensity = 5.4
  } else {
    lan.light.distance = 9
    lan.light.intensity = 1.4
  }
  lan.g.position.set(0, -0.66, 0.04)
  armR.add(lan.g)
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
  const mat = new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.9 })
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.85, 4, 10), mat)
  body.position.y = 1.25
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 12, 12), mat)
  head.position.y = 2.05
  // 发光红眼
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff2222 })
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), eyeMat)
  eyeL.position.set(-0.09, 2.08, 0.19)
  const eyeR = eyeL.clone()
  eyeR.position.x = 0.09
  // 武器(屠刀)
  const weapon = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.95, 0.16),
    new THREE.MeshStandardMaterial({ color: 0x666c75, roughness: 0.35, metalness: 0.8 }),
  )
  weapon.position.set(0.48, 0.85, 0.15)
  weapon.rotation.z = 0.25
  const armGeo = new THREE.CapsuleGeometry(0.09, 0.62, 3, 8)
  armGeo.translate(0, -0.34, 0)
  const armL = new THREE.Mesh(armGeo, mat)
  armL.position.set(-0.47, 1.7, 0)
  const armR = new THREE.Mesh(armGeo, mat)
  armR.position.set(0.47, 1.7, 0)
  const legGeo = new THREE.CapsuleGeometry(0.11, 0.7, 3, 8)
  legGeo.translate(0, -0.4, 0)
  const legL = new THREE.Mesh(legGeo, mat)
  legL.position.set(-0.18, 0.92, 0)
  const legR = new THREE.Mesh(legGeo, mat)
  legR.position.set(0.18, 0.92, 0)
  // 肩部披风块
  const cape = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.25, 0.4), new THREE.MeshStandardMaterial({ color: 0x101215, roughness: 1 }))
  cape.position.y = 1.78
  group.add(body, head, eyeL, eyeR, armL, armR, legL, legR, weapon, cape)
  return { group, body, head, armL, armR, legL, legR, eyeL, eyeR, weapon, lanternBase: 0, outline: [], flickerSeed: 0, walkPhase: 0, height: 2.3 }
}

export type Pose = 'stand' | 'crawl' | 'carried' | 'chaired'

// 步行动画:速度越快摆幅越大;pose 处理特殊姿态
export function animateHumanoid(h: Humanoid, dt: number, speed: number, pose: Pose, time: number): void {
  const g = h.group
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
  h.armL.rotation.x = -s * amp * 0.8
  h.armR.rotation.x = s * amp * 0.8
  if (speed < 0.1) {
    // 待机呼吸
    h.body.scale.y = 1 + Math.sin(time * 1.8 + h.walkPhase) * 0.015
    h.armL.rotation.x = Math.sin(time * 1.4) * 0.05
    h.armR.rotation.x = -Math.sin(time * 1.4) * 0.05
  } else {
    h.body.scale.y = 1
  }
}
