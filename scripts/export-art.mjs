import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'art/models')
await mkdir(output, { recursive: true })
await mkdir(resolve(root, 'art/.cache'), { recursive: true })
const bundle = resolve(root, 'art/.cache/catalog.mjs')
await build({ entryPoints: [resolve(root, 'src/game/artCatalog.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
// Browser FileReader counterpart for the texture-free GLB exporter in Node.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.() }) }
  readAsDataURL(blob) { blob.arrayBuffer().then(result => { this.result = `data:${blob.type};base64,${Buffer.from(result).toString('base64')}`; this.onloadend?.() }) }
}
let seed = 9102026
const originalRandom = Math.random
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
const { createArtCatalog } = await import(pathToFileURL(bundle).href)
const catalog = createArtCatalog()
Math.random = originalRandom
const exporter = new GLTFExporter(), manifest = []
for (const asset of catalog) {
  // Keep named rigid animation pivots; remove gameplay lights and hidden highlight clones.
  const copy = asset.object.clone(true), remove = []
  copy.traverse(o => { if (o.isLight || !o.visible || o.name === 'Contact_shadow') remove.push(o) })
  remove.forEach(o => o.removeFromParent())
  const glb = await exporter.parseAsync(copy, { binary: true, onlyVisible: true })
  await writeFile(resolve(output, `${asset.id}.glb`), Buffer.from(glb))
  let triangles = 0, meshes = 0
  copy.traverse(o => { if (o.isMesh) { triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; meshes++ } })
  manifest.push({ id: asset.id, label: asset.label, file: `models/${asset.id}.glb`, bytes: glb.byteLength, triangles, meshes, units: 'metres', up: '+Y', front: '+Z', animations: 'runtime procedural; named pivots retained' })
}
await writeFile(resolve(root, 'art/manifest.json'), JSON.stringify({ generatedFrom: 'src/game/artCatalog.ts', date: '2026-09-10', assets: manifest }, null, 2) + '\n')
console.log(JSON.stringify({ assets: manifest.length, totalBytes: manifest.reduce((n, a) => n + a.bytes, 0), manifest: 'art/manifest.json' }, null, 2))
