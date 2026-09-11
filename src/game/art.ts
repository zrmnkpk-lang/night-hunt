import * as THREE from 'three'
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/** Single bevel segment: readable edge highlights without smooth high-poly silhouettes. */
export function bevelBox(w: number, h: number, d: number, radius = 0.035): THREE.BufferGeometry {
  if (radius <= 0) return new THREE.BoxGeometry(w, h, d)
  const r = Math.min(radius, w / 4, h / 4, d / 4)
  const points: THREE.Vector3[] = []
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    points.push(new THREE.Vector3(x * w / 2, y * (h / 2 - r), z * (d / 2 - r)))
    points.push(new THREE.Vector3(x * (w / 2 - r), y * h / 2, z * (d / 2 - r)))
    points.push(new THREE.Vector3(x * (w / 2 - r), y * (h / 2 - r), z * d / 2))
  }
  const geo = new ConvexGeometry(points)
  // Flat shaded 44-triangle chamfer; planar UVs also keep the rigid batch format uniform.
  const pos = geo.attributes.position, uv: number[] = []
  for (let i = 0; i < pos.count; i++) uv.push(pos.getX(i) / w + 0.5, pos.getY(i) / h + 0.5)
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return geo
}

export function material(name: string, color: number, metalness = 0, roughness = 0.88): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, metalness, roughness, flatShading: true })
  m.name = name
  return m
}

export function box(parent: THREE.Object3D, name: string, size: number[], pos: number[], mat: THREE.Material, bevel = 0.025): THREE.Mesh {
  const m = new THREE.Mesh(bevelBox(size[0], size[1], size[2], bevel), mat)
  m.name = name
  m.position.set(pos[0], pos[1], pos[2])
  parent.add(m)
  return m
}

export function beam(parent: THREE.Object3D, name: string, from: number[], to: number[], r1: number, r2: number, mat: THREE.Material): THREE.Mesh {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to)
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r1, a.distanceTo(b), 5), mat)
  m.position.copy(a).add(b).multiplyScalar(0.5)
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize())
  m.name = name
  parent.add(m)
  return m
}

/** Cloth panel / chipped silhouette, extruded along +Z. */
export function panel(points: number[][], depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p[0], p[1])))
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 })
  geo.translate(0, 0, -depth / 2)
  return geo
}

/** Merge only rigid meshes sharing a material, within one local pivot. Never merge animated children. */
export function batchRigid(group: THREE.Group): void {
  const byMat = new Map<THREE.Material, THREE.Mesh[]>()
  for (const child of [...group.children]) {
    if (!(child instanceof THREE.Mesh) || child.children.length || Array.isArray(child.material) || !child.visible) continue
    const list = byMat.get(child.material) ?? []
    list.push(child)
    byMat.set(child.material, list)
  }
  for (const [mat, meshes] of byMat) {
    if (meshes.length < 2) continue
    const parts = meshes.map(m => {
      m.updateMatrix()
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()
      g.applyMatrix4(m.matrix)
      // Basic primitives all provide these attributes; strip others for a stable merge.
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name)
      return g
    })
    const geo = mergeGeometries(parts, false)
    parts.forEach(g => g.dispose())
    if (!geo) continue
    const merged = new THREE.Mesh(geo, mat)
    merged.name = `${group.name}_${mat.name || 'surface'}`
    merged.castShadow = true
    merged.receiveShadow = true
    group.add(merged)
    meshes.forEach(m => group.remove(m))
  }
}

export function contactShadow(parent: THREE.Object3D, rx: number, rz: number): void {
  // Geometry-only soft contact; survives GLB export and works without point-light shadow maps.
  const g = new THREE.Group()
  g.name = 'Contact_shadow'
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(1 - i * 0.16, 20), new THREE.MeshBasicMaterial({ color: 0x080e10, transparent: true, opacity: 0.08 + i * 0.025, depthWrite: false }))
    m.rotation.x = -Math.PI / 2
    m.position.y = 0.012 + i * 0.002
    m.scale.set(rx, rz, 1)
    g.add(m)
  }
  parent.add(g)
}

export function dressSurvivor(parts: { group: THREE.Group; body: THREE.Mesh; head: THREE.Mesh; armL: THREE.Mesh; armR: THREE.Mesh; legL: THREE.Mesh; legR: THREE.Mesh }, color: number): void {
  const { group, body, head, armL, armR, legL, legR } = parts
  group.name = 'Survivor_hoodie'
  const cloth = material('Hoodie_mustard', color)
  const seam = cloth.clone(); seam.color.multiplyScalar(0.70); seam.name = 'Hoodie_seams'
  const leather = material('Satchel_olive', 0x35413a)
  const brass = material('Aged_brass', 0x9b8452, 0.55, 0.48)
  const cream = material('Canvas_laces', 0xc9c2a6)
  const hair = material('Hair_chestnut', 0x403027)
  // Lowered hood wraps shoulders; head and hands remain free for the existing animation pivots.
  const hood = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.074, 4, 9, Math.PI * 1.65), cloth)
  hood.name = 'Lowered_hood'; hood.rotation.x = Math.PI / 2; hood.rotation.z = 0.55
  hood.position.set(0, 0.35, -0.065); body.add(hood)
  box(body, 'Ribbed_hem', [0.52, 0.07, 0.34], [0, -0.265, 0], seam)
  box(body, 'Kangaroo_pocket', [0.31, 0.15, 0.035], [0.025, -0.14, 0.175], seam)
  for (const side of [-1, 1]) {
    beam(body, 'Hood_drawstring', [side * 0.1, 0.28, 0.18], [side * 0.11, 0.06, 0.2], 0.009, 0.009, cream)
    box(body, 'Drawstring_tip', [0.018, 0.035, 0.018], [side * 0.11, 0.045, 0.2], brass)
  }
  // Replace the old small brown pouch material and add a readable flap and clasp.
  body.children.forEach(c => { if (c instanceof THREE.Mesh && c.position.x < -0.2) c.material = leather })
  box(body, 'Satchel_flap', [0.245, 0.10, 0.035], [-0.28, -0.09, 0.165], leather)
  box(body, 'Satchel_clasp', [0.04, 0.045, 0.022], [-0.28, -0.13, 0.19], brass)
  const bun = new THREE.Mesh(new THREE.IcosahedronGeometry(0.095, 0), hair)
  bun.position.set(0.02, 0.16, -0.17); head.add(bun)
  for (const side of [-1, 1]) {
    const lock = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.25, 4), hair)
    lock.rotation.z = Math.PI + side * 0.12; lock.position.set(side * 0.17, -0.005, 0.035); head.add(lock)
    const brow = box(head, 'Eyebrow', [0.065, 0.018, 0.019], [side * 0.075, 0.077, 0.186], hair)
    brow.rotation.z = side * 0.12
  }
  for (const arm of [armL, armR]) box(arm, 'Sleeve_cuff', [0.157, 0.065, 0.16], [0, -0.49, 0], seam)
  for (const leg of [legL, legR]) {
    box(leg, 'Cargo_pocket', [0.195, 0.18, 0.04], [0, -0.20, 0.1], leather)
    box(leg, 'Shoe_sole', [0.21, 0.035, 0.33], [0, -0.665, 0.05], seam)
    for (let i = 0; i < 3; i++) box(leg, 'Shoe_lace', [0.125, 0.015, 0.019], [0, -0.55, 0.025 + i * 0.047], cream)
  }
  for (const [name, obj] of Object.entries(parts)) if (name !== 'group') obj.name = name
}

export function dressHunter(parts: { group: THREE.Group; body: THREE.Mesh; head: THREE.Mesh; armL: THREE.Mesh; armR: THREE.Mesh; legL: THREE.Mesh; legR: THREE.Mesh; weapon: THREE.Mesh }): void {
  const { group, body, head, armL, armR, weapon } = parts
  group.name = 'Hunter_masked'
  const coat = material('Coat_charcoal', 0x292d30)
  const lapel = material('Coat_edge', 0x3a3d3e)
  const dark = material('Mask_vents', 0x080d0e)
  const steel = material('Steel_edge', 0xc1c9c5, 0.72, 0.3)
  for (const side of [-1, 1]) {
    const collar = new THREE.Mesh(panel([[side * 0.08, 0.32], [side * 0.23, 0.57], [side * 0.44, 0.40], [side * 0.22, 0.11]], 0.055), lapel)
    collar.position.z = 0.19; body.add(collar)
    const tail = new THREE.Mesh(panel([[side * 0.08, -0.22], [side * 0.32, -0.2], [side * 0.48, -1.02], [side * 0.3, -0.88], [side * 0.26, -1.07], [side * 0.10, -0.88]], 0.07), coat)
    tail.name = 'Torn_coat_tail'; tail.position.z = -0.16; body.add(tail)
    const front = new THREE.Mesh(panel([[side * 0.09, -0.15], [side * 0.33, -0.18], [side * 0.39, -0.84], [side * 0.25, -0.77], [side * 0.13, -0.96]], 0.035), coat)
    front.name = 'Split_coat_front'; front.position.z = 0.20; body.add(front)
    box(head, 'Mask_rivet', [0.02, 0.02, 0.02], [side * 0.18, 0.11, 0.12], steel)
  }
  for (let i = -1; i <= 1; i++) box(head, 'Mask_vent', [0.024, 0.095, 0.019], [i * 0.052, -0.115, 0.225], dark)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.038, 0.085, 3), lapel)
  nose.rotation.x = Math.PI / 2; nose.position.set(0, -0.025, 0.23); head.add(nose)
  box(body, 'Belt', [0.73, 0.075, 0.46], [0, -0.29, 0], dark)
  box(body, 'Belt_buckle', [0.095, 0.08, 0.025], [0, -0.29, 0.25], steel)
  for (const arm of [armL, armR]) box(arm, 'Glove', [0.17, 0.16, 0.18], [0, -0.62, 0], dark)
  weapon.geometry.dispose()
  weapon.geometry = panel([[-0.055, -0.10], [0.07, -0.10], [0.07, -0.78], [-0.025, -1.01], [-0.055, -0.79]], 0.045)
  weapon.children.forEach(o => { o.position.y = 0.025 })
  box(weapon, 'Blade_guard', [0.22, 0.055, 0.09], [0, -0.10, 0], dark)
  weapon.position.set(0, -0.62, 0.06)
  armR.add(weapon)
  for (const [name, obj] of Object.entries(parts)) if (name !== 'group') obj.name = name
}

export function dressPallet(pivot: THREE.Group): void {
  pivot.name = 'Pallet_pivot'
  const wood = material('Wood_cut_edge', 0x8a7049)
  const grain = material('Wood_grain', 0x3f3324)
  const strap = material('Pallet_iron', 0x424b49, 0.5)
  const brace = box(pivot, 'Diagonal_brace', [2.15, 0.12, 0.10], [0, 0, -0.14], wood)
  brace.rotation.z = 0.48
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      const scar = box(pivot, 'Wood_split', [0.26 + j * 0.13, 0.013, 0.008], [-0.67 + j * 0.63, -0.5 + i * 0.3 + j * 0.035, 0.145], grain, 0)
      scar.rotation.z = (j - 1) * 0.024
    }
  }
  for (const x of [-1.1, 1.1]) for (const y of [-0.63, 0.63]) box(pivot, 'Iron_binding', [0.20, 0.12, 0.21], [x, y, 0], strap)
  batchRigid(pivot)
}

export function dressCipher(g: THREE.Group): void {
  g.name = 'Cipher_machine'
  const dark = material('Machine_insets', 0x182326, 0.4)
  const brass = material('Machine_brass', 0xa88b48, 0.5, 0.55)
  const ivory = material('Gauge_ivory', 0xcac4a6)
  box(g, 'Control_console', [1.02, 0.17, 0.27], [0, 0.66, 0.60], dark)
  for (let i = 0; i < 7; i++) box(g, 'Key', [0.075, 0.035, 0.08], [-0.36 + i * 0.12, 0.758, 0.63], ivory)
  for (let i = 0; i < 5; i++) box(g, 'Vent', [0.035, 0.30, 0.012], [-0.49 + i * 0.065, 1.18, 0.51], dark)
  const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.035, 12), ivory)
  dial.rotation.x = Math.PI / 2; dial.position.set(0.40, 1.28, 0.53); g.add(dial)
  const needle = box(g, 'Gauge_needle', [0.012, 0.08, 0.012], [0.40, 1.29, 0.555], dark)
  needle.rotation.z = -0.6
  for (const x of [-0.55, 0.55]) for (const y of [0.48, 1.42]) box(g, 'Case_fastener', [0.055, 0.055, 0.022], [x, y, 0.515], brass)
  box(g, 'Machine_plinth', [1.20, 0.09, 0.93], [0, 0.05, 0], dark)
  batchRigid(g)
  contactShadow(g, 0.95, 0.7)
}

export function dressChair(g: THREE.Group): void {
  g.name = 'Carnival_chair'
  const red = material('Oxblood_upholstery', 0x6c2830)
  const brass = material('Chair_brass', 0xa18452, 0.5, 0.5)
  const dark = material('Restraint_leather', 0x342b28)
  box(g, 'Seat_cushion', [0.77, 0.11, 0.72], [0, 0.68, 0.03], red)
  box(g, 'Back_cushion', [0.72, 0.92, 0.10], [0, 1.26, -0.285], red)
  for (const x of [-0.49, 0.49]) {
    box(g, 'Armrest', [0.13, 0.09, 0.73], [x, 0.96, 0.04], brass)
    box(g, 'Cuff', [0.14, 0.09, 0.19], [x, 1.02, 0.15], dark)
    beam(g, 'Back_finial', [x * 0.85, 0.6, -0.4], [x * 0.85, 2.03, -0.4], 0.035, 0.024, brass)
  }
  for (const x of [-0.23, 0, 0.23]) for (const y of [1.0, 1.3, 1.6]) box(g, 'Cushion_button', [0.025, 0.025, 0.014], [x, y, -0.226], brass)
  for (const y of [1.0, 1.65, 2.0]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.028, 4, 10), brass)
    ring.rotation.x = Math.PI / 2; ring.position.set(0, y, -0.62); g.add(ring)
  }
  batchRigid(g)
}

export function dressDoor(d: THREE.Group, side: number, lamp: THREE.Material): void {
  d.name = side < 0 ? 'Gate_left_hinge' : 'Gate_right_hinge'
  const iron = material('Gate_iron', 0x535d59, 0.6, 0.6)
  const dark = material('Gate_vents', 0x151f22)
  for (const y of [0.55, 3.75]) box(d, 'Hinge_plate', [0.29, 0.25, 0.06], [-side * 0.18, y, 0.135], iron)
  for (let i = 0; i < 5; i++) box(d, 'Door_vent', [1.05, 0.038, 0.013], [-side * 0.92, 2.85 + i * 0.08, 0.079], dark)
  // Shared live status material: handles turn green with the gate power lamp.
  d.children.forEach(o => { if (o instanceof THREE.Mesh && o.position.y === 2.25 && Math.abs(o.position.x) === 1.7) o.material = lamp })
  batchRigid(d)
}

export function makeGround(): THREE.Group {
  const g = new THREE.Group(); g.name = 'Ground_tiles'
  const mat = material('Slate_sage', 0x465449)
  const tiles = new THREE.InstancedMesh(bevelBox(2.91, 0.055, 2.91, 0.024), mat, 30 * 30)
  const transform = new THREE.Object3D()
  const color = new THREE.Color()
  let i = 0
  for (let z = 0; z < 30; z++) for (let x = 0; x < 30; x++) {
    transform.position.set((x - 14.5) * 3, -0.028, (z - 14.5) * 3)
    transform.updateMatrix(); tiles.setMatrixAt(i, transform.matrix)
    const variation = Math.sin(x * 17.71 + z * 31.31) * 0.5 + 0.5
    color.setHSL(0.28 + variation * 0.03, 0.10, 0.25 + variation * 0.07)
    tiles.setColorAt(i++, color)
  }
  tiles.name = 'Slate_tiles_instanced'; tiles.receiveShadow = true; g.add(tiles)
  return g
}

export function makeDistantManor(): THREE.Group {
  const g = new THREE.Group(); g.name = 'Distant_manor'; g.position.set(0, 0, -46)
  const stone = material('Manor_stone', 0x283337), roof = material('Manor_roof', 0x17262b)
  const glass = material('Distant_amber_windows', 0x92704b)
  glass.emissive.set(0xd49751); glass.emissiveIntensity = 0.7
  box(g, 'Main_hall', [18, 6, 6], [0, 3, 0], stone)
  const mainRoof = new THREE.Mesh(new THREE.CylinderGeometry(0, 1, 1, 4), roof)
  mainRoof.scale.set(14, 4.2, 5.6); mainRoof.rotation.y = Math.PI / 4; mainRoof.position.y = 8.1; g.add(mainRoof)
  for (const x of [-8, 8]) {
    box(g, 'Tower', [4.2, 10, 4.2], [x, 5, 0], stone)
    const spire = new THREE.Mesh(new THREE.ConeGeometry(3.3, 5.5, 4), roof)
    spire.rotation.y = Math.PI / 4; spire.position.set(x, 12.7, 0); g.add(spire)
    box(g, 'Tower_window', [0.6, 1.7, 0.04], [x, 7.7, 2.13], glass)
  }
  for (let x = -6; x <= 6; x += 3) for (const y of [2.2, 4.6]) box(g, 'Hall_window', [0.6, 1.15, 0.04], [x, y, 3.03], glass)
  batchRigid(g)
  return g
}

export function makePalletDebris(): THREE.Group {
  const g = new THREE.Group(); g.name = 'Pallet_broken'
  const wood = material('Splintered_oak', 0x796044), cut = material('Fresh_wood', 0xa88c5d)
  for (let i = 0; i < 8; i++) {
    const shard = new THREE.Mesh(panel([[-0.42, -0.09], [0.38, -0.1], [0.5, 0.01], [0.31, 0.025], [0.42, 0.11], [-0.45, 0.08]], 0.065), i % 3 ? wood : cut)
    shard.position.set((i % 4 - 1.5) * 0.48, 0.07 + i % 2 * 0.04, (Math.floor(i / 4) - 0.5) * 0.55)
    shard.rotation.set(-Math.PI / 2, 0, (i * 1.73) % 2 - 1)
    g.add(shard)
  }
  batchRigid(g)
  return g
}

export function teleportGeometry(): THREE.BufferGeometry {
  // Eight tapered light ribbons; open space between them keeps the character legible.
  const positions: number[] = []
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4
    const p = (offset: number, y: number, r: number) => [Math.cos(a + offset) * r, y, Math.sin(a + offset) * r]
    positions.push(...p(-0.07, -1.5, 0.9), ...p(0.07, -1.5, 0.9), ...p(0.20, 1.5, 0.40))
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.computeVertexNormals()
  return geo
}
