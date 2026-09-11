import * as THREE from 'three'
import { World } from './world'
import { makeHunterMesh, makeSurvivorMesh } from './characters'
import type { Humanoid } from './characters'
import { makePalletDebris, material, bevelBox, teleportGeometry } from './art'

export interface ArtAsset { id: string; label: string; object: THREE.Group; humanoid?: Humanoid }

/** The gallery and Blender export use exactly the same builders as gameplay. */
export function createArtCatalog(): ArtAsset[] {
  const scene = new THREE.Scene()
  const world = new World(scene)
  const list: ArtAsset[] = []
  const add = (id: string, label: string, object: THREE.Object3D) => {
    const group = new THREE.Group(); group.name = id
    group.add(object); list.push({ id, label, object: group })
  }
  const cloneAtOrigin = (object: THREE.Object3D) => {
    const clone = object.clone(true); clone.position.set(0, 0, 0); clone.rotation.set(0, 0, 0)
    return clone
  }
  const survivor = makeSurvivorMesh(0xc99b39, false), hunter = makeHunterMesh()
  list.push({ id: 'survivor', label: '01 / 连帽求生者', object: survivor.group, humanoid: survivor })
  list.push({ id: 'hunter', label: '02 / 面具猎人', object: hunter.group, humanoid: hunter })
  add('lantern', '03 / 手提灯笼', cloneAtOrigin(survivor.lantern!))
  add('cipher', '04 / 红灯密码机', cloneAtOrigin(world.ciphers[0].mesh))
  add('chair', '05 / 狂欢之椅', cloneAtOrigin(world.chairs[0].mesh))
  add('gate', '06 / 双扇逃生门', cloneAtOrigin(world.gates[0].mesh))
  add('switch', '07 / 电闸开关', cloneAtOrigin(scene.getObjectByName('Gate_switch')!))
  const up = cloneAtOrigin(world.pallets[0].mesh)
  add('pallet-up', '08 / 竖立木托板', up)
  const down = up.clone(true)
  const pivot = down.getObjectByName('Pallet_pivot')!
  pivot.rotation.x = -Math.PI / 4; pivot.position.y = 0.68
  add('pallet-down', '09 / 放倒木托板', down)
  add('pallet-broken', '10 / 破碎木托板', makePalletDebris())
  add('street-lamp', '11 / 弯曲街灯', cloneAtOrigin(scene.getObjectByName('Bent_street_lamp')!))
  add('tree', '12 / 幽灵树', cloneAtOrigin(scene.getObjectByName('Ghost_tree')!))
  add('grass', '13 / 幽影草丛', cloneAtOrigin(scene.getObjectByName('Ghost_grass')!))
  for (const [id, label, name] of [['wall', '14 / 模块化石墙', 'Modular_stone_wall'], ['low-wall', '15 / 木框矮墙', 'Vault_low_wall']]) {
    const source = scene.children.filter(o => o.name === name).find(o => {
      const s = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()); return Math.max(s.x, s.z) < 9
    })!
    const clone = source.clone(true)
    const center = new THREE.Box3().setFromObject(clone).getCenter(new THREE.Vector3())
    clone.position.set(-center.x, 0, -center.z)
    add(id, label, clone)
  }
  add('ground-tile', '16 / 灰绿地砖', new THREE.Mesh(bevelBox(3, 0.07, 3), material('Slate_sage', 0x555e50)))
  add('manor', '17 / 庄园远景', cloneAtOrigin(scene.getObjectByName('Distant_manor')!))
  const fx = new THREE.Group()
  const glow = new THREE.MeshBasicMaterial({ color: 0xb694ee, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
  const ribbons = new THREE.Mesh(teleportGeometry(), glow); ribbons.position.y = 1.5; fx.add(ribbons)
  for (const r of [0.7, 1.1]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.045, 32), glow)
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; fx.add(ring)
  }
  add('teleport', '18 / 瞬移光带', fx)
  return list
}
