// Remaining inventory assets. Existing reference-styled characters and props stay intact.
import * as THREE from 'three'

export function artPart(parent: THREE.Object3D, name: string, geometry: THREE.BufferGeometry,
  material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = name
  mesh.position.set(x, y, z)
  parent.add(mesh)
  return mesh
}

export function makeCourtyardGround(): THREE.Group {
  const root = new THREE.Group()
  root.name = 'courtyard-ground'
  const soil = new THREE.MeshStandardMaterial({ color: 0x30382f, roughness: 1 })
  const base = artPart(root, 'earth-bed', new THREE.PlaneGeometry(90, 90), soil)
  base.rotation.x = -Math.PI / 2
  // One instanced draw for all paving. Tops remain at y=0: navigation heights stay valid.
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97 })
  const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, 2025)
  tiles.name = 'grey-green-paving'
  const transform = new THREE.Object3D()
  const color = new THREE.Color()
  let seed = 617
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let row = 0; row < 45; row++) {
    for (let col = 0; col < 45; col++) {
      transform.position.set(-44 + col * 2, -0.041, -44 + row * 2)
      transform.scale.set(1.89 + random() * 0.05, 0.08, 1.89 + random() * 0.05)
      transform.updateMatrix()
      const index = row * 45 + col
      tiles.setMatrixAt(index, transform.matrix)
      color.setHSL(0.23 + random() * 0.035, 0.07 + random() * 0.055, 0.22 + random() * 0.08)
      tiles.setColorAt(index, color)
    }
  }
  // Slightly lower the soil to reveal narrow dark joints without coplanar flicker.
  base.position.y = -0.012
  tiles.computeBoundingSphere()
  root.add(tiles)
  return root
}

export function addChairDetails(root: THREE.Group, metal: THREE.Material): void {
  root.name = 'restraint-chair'
  const leather = new THREE.MeshStandardMaterial({ color: 0x682d2c, roughness: 0.94 })
  const brass = new THREE.MeshStandardMaterial({ color: 0x9c8453, roughness: 0.57, metalness: 0.65 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x25292d, roughness: 0.8, metalness: 0.45 })
  artPart(root, 'seat-cushion', new THREE.BoxGeometry(0.77, 0.08, 0.74), leather, 0, 0.66, 0.02)
  artPart(root, 'back-cushion', new THREE.BoxGeometry(0.69, 1.04, 0.09), leather, 0, 1.23, -0.28)
  artPart(root, 'head-rest', new THREE.BoxGeometry(0.55, 0.22, 0.19), leather, 0, 1.94, -0.34)
  for (const side of [-1, 1]) {
    artPart(root, `arm-support-${side}`, new THREE.BoxGeometry(0.07, 0.37, 0.07), metal, side * 0.42, 0.79, 0.2)
    artPart(root, `arm-rest-${side}`, new THREE.BoxGeometry(0.12, 0.09, 0.67), dark, side * 0.42, 1, -0.03)
    artPart(root, `wrist-restraint-${side}`, new THREE.BoxGeometry(0.13, 0.05, 0.09), brass, side * 0.42, 1.055, 0.18)
    artPart(root, `back-rail-${side}`, new THREE.BoxGeometry(0.07, 1.5, 0.1), brass, side * 0.4, 1.26, -0.29)
    const band = artPart(root, `rocket-band-${side}`, new THREE.TorusGeometry(0.325, 0.025, 4, 10), brass, 0, 1.5 + side * 0.43, -0.62)
    band.rotation.x = Math.PI / 2
  }
  artPart(root, 'strap-buckle', new THREE.BoxGeometry(0.15, 0.12, 0.035), brass, 0, 0.95, 0.016)
  artPart(root, 'foot-rest', new THREE.BoxGeometry(0.76, 0.07, 0.28), dark, 0, 0.21, 0.36)
}

export function makePalletDebris(): THREE.Group {
  const root = new THREE.Group()
  root.name = 'broken-pallet'
  const wood = new THREE.MeshStandardMaterial({ color: 0x5a4936, roughness: 0.95 })
  const cut = new THREE.MeshStandardMaterial({ color: 0x8b7353, roughness: 1 })
  // Low, non-blocking fragments, confined to the original board area.
  for (let i = 0; i < 8; i++) {
    const fragment = artPart(root, `splinter-${i}`, new THREE.BoxGeometry(0.48 + (i % 3) * 0.12, 0.055, 0.14),
      i % 3 === 0 ? cut : wood, (i % 4 - 1.5) * 0.48, 0.035 + (i % 2) * 0.025, Math.floor(i / 4) * 0.43 - 0.22)
    fragment.rotation.y = (i % 3 - 1) * 0.34
  }
  root.visible = false
  return root
}
