import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import * as THREE from 'three'

const root = resolve(import.meta.dirname, '..'), cache = resolve(root, 'art/.cache')
const baselineRef = process.env.NIGHT_HUNT_ART_BASELINE || 'f1e37081ad585c0c947b1a66fc789e546b159586'
await mkdir(cache, { recursive: true })
async function bundle(entry, name) {
  const out = resolve(cache, `${name}.mjs`)
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  return import(pathToFileURL(out).href)
}
const { World } = await bundle(resolve(root, 'src/game/world.ts'), 'world')
const { makeSurvivorMesh, makeHunterMesh, animateHumanoid } = await bundle(resolve(root, 'src/game/characters.ts'), 'characters')
const world = new World(new THREE.Scene())
assert.deepEqual([world.ciphers.length, world.chairs.length, world.pallets.length, world.gates.length], [5, 6, 5, 2])

// Golden gameplay footprint comes from the pre-art Git revision, not a duplicate of the new implementation.
const baselineDir = resolve(cache, 'baseline')
await mkdir(baselineDir, { recursive: true })
for (const file of ['world.ts', 'navgrid.ts', 'types.ts']) {
  await writeFile(resolve(baselineDir, file), execFileSync('git', ['show', `${baselineRef}:src/game/${file}`], { cwd: root }))
}
const { World: OldWorld } = await bundle(resolve(baselineDir, 'world.ts'), 'baseline-world')
const baseline = new OldWorld(new THREE.Scene())
assert.deepEqual(world.colliders, baseline.colliders, 'static collision footprint must be unchanged')
assert.deepEqual(world.tallWalls, baseline.tallWalls, 'line-of-sight blockers must be unchanged')

for (const chair of world.chairs) assert.deepEqual(chair.highlight.position.toArray(), [0, 0, 0], 'highlight uses local chair coordinates')
for (const p of world.pallets) {
  p.state = 'down'; p.fallT = p.fallDur
  world.update(p.fallDur, 0)
  assert.equal(p.pivot.rotation.x, -Math.PI / 4)
  assert.equal(p.mesh.position.x, p.x); assert.equal(p.mesh.position.z, p.z)
  assert.equal(p.debris.visible, false)
  p.state = 'broken'; p.mesh.visible = false; world.update(0, 0)
  assert.equal(p.debris.visible, true)
}
world.powerGates()
for (const gate of world.gates) {
  const hinge = gate.doorL.position.clone()
  const statusMeshes = []
  gate.mesh.traverse(o => { if (o.isMesh && o.material === gate.lampMat) statusMeshes.push(o) })
  assert.ok(statusMeshes.length >= 3, 'both handles and gate lamp share live state')
  world.openGate(gate); world.update(2.3, 3)
  assert.equal(gate.opened, true); assert.ok(Math.abs(gate.doorL.rotation.y) > 1.4)
  assert.deepEqual(gate.doorL.position.toArray(), hinge.toArray(), 'hinge must not move during opening')
}
for (const h of [makeSurvivorMesh(0xc99b39, true), makeHunterMesh()]) {
  for (const pose of ['crawl', 'carried', 'chaired', 'stand']) animateHumanoid(h, 1 / 60, 3, pose, 2, true)
  animateHumanoid(h, 1 / 60, 0, 'stand', 0, false)
  assert.equal(h.body.rotation.x, 0); assert.equal(h.armR.rotation.z, 0)
  assert.ok(Math.abs(h.legL.rotation.x) < 1e-9)
  h.group.updateMatrixWorld(true)
  h.group.traverse(o => { assert.ok(o.matrixWorld.elements.every(Number.isFinite), `${o.name} has non-finite transforms`) })
  if (h.weapon) {
    assert.equal(h.weapon.parent, h.armR, 'weapon follows hand')
    assert.ok(Math.abs(h.weapon.position.y + 0.62) < 0.001)
  }
}
const cipher = world.ciphers[0]
const angle = cipher.wheel.rotation.z
world.update(0.1, 1); assert.notEqual(cipher.wheel.rotation.z, angle)
cipher.done = true; cipher.bulb.emissive.set(0x7fb069)
const doneAngle = cipher.wheel.rotation.z
world.update(0.1, 2); assert.equal(cipher.wheel.rotation.z, doneAngle)

const count = scene => { let meshes = 0, triangles = 0; scene.traverseVisible(o => { if (o.isMesh) { meshes++; triangles += ((o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3) * (o.isInstancedMesh ? o.count : 1) } }); return { meshes, triangles } }
const report = { baselineRef, checks: ['collision parity with pre-art revision', 'sight blocker parity', 'all 5 pallet fall/break states', 'both gate pivots and status handles', 'chair highlight alignment', 'pose reset and hand-held weapon', 'cipher active/completed state'], before: count(baseline.scene), after: count(new World(new THREE.Scene()).scene) }
const manifest = JSON.parse(await readFile(resolve(root, 'art/manifest.json'), 'utf8'))
for (const asset of manifest.assets) {
  const file = await readFile(resolve(root, 'art', asset.file))
  assert.equal(file.readUInt32LE(0), 0x46546c67); assert.equal(file.readUInt32LE(8), file.length)
}
report.exportedAssets = manifest.assets.length
await mkdir(resolve(root, 'art/previews'), { recursive: true })
await writeFile(resolve(root, 'art/previews/verification.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
