import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createArtCatalog } from '../game/artCatalog'
import type { ArtAsset } from '../game/artCatalog'
import { animateHumanoid } from '../game/characters'
import type { Pose } from '../game/characters'
import './ArtReview.css'

export default function ArtReview() {
  const mount = useRef<HTMLDivElement>(null)
  const controls = useRef<{ choose: (id: string) => void; night: (value: boolean) => void; pose: (value: string) => void } | null>(null)
  const [items, setItems] = useState<{ id: string; label: string }[]>([])
  const [selected, setSelected] = useState('survivor')
  const [night, setNight] = useState(false)
  const [pose, setPose] = useState('stand')
  const [stats, setStats] = useState('')
  useEffect(() => {
    const host = mount.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.4
    renderer.shadowMap.enabled = true
    renderer.domElement.setAttribute('aria-label', '可旋转的三维资产预览')
    host.appendChild(renderer.domElement)
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x25353d)
    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 300)
    const orbit = new OrbitControls(camera, renderer.domElement); orbit.enableDamping = true
    const hemi = new THREE.HemisphereLight(0xc7e3ee, 0x81745b, 2.1); scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffe6c0, 3.4); key.position.set(-4, 7, 5); scene.add(key)
    const rim = new THREE.DirectionalLight(0x8ad2eb, 2.2); rim.position.set(4, 4, -4); scene.add(rim)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x26373d, roughness: 1 }))
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.08; scene.add(floor)
    const catalog = createArtCatalog()
    let active: ArtAsset, animation = 'stand', t = 0, frame = 0
    const choose = (id: string) => {
      if (active) scene.remove(active.object)
      active = catalog.find(a => a.id === id)!
      scene.add(active.object)
      if (active.humanoid) animateHumanoid(active.humanoid, 0, animation === 'walk' ? 3 : 0, (animation === 'walk' || animation === 'injured' ? 'stand' : animation) as Pose, t, animation === 'injured')
      const bounds = new THREE.Box3().setFromObject(active.object)
      const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3())
      const radius = Math.max(size.x, size.y, size.z) * 0.88
      camera.position.copy(center).add(new THREE.Vector3(radius * 1.15, radius * 0.7, radius * 2.3))
      orbit.target.copy(center); orbit.update()
      let tris = 0, meshes = 0
      active.object.traverseVisible(o => {
        if (o instanceof THREE.Mesh) { tris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; meshes++ }
      })
      setStats(`${Math.round(tris).toLocaleString()} 三角面 · ${meshes} 网格`)
    }
    controls.current = {
      choose,
      night(value) { hemi.intensity = value ? 0.65 : 2.1; key.intensity = value ? 1.1 : 3.4; scene.background = new THREE.Color(value ? 0x14272e : 0x25353d) },
      pose(value) { animation = value; choose(active.id) },
    }
    setItems(catalog.map(({ id, label }) => ({ id, label })))
    choose('survivor')
    const resize = () => { const w = host.clientWidth, h = host.clientHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix() }
    const observer = new ResizeObserver(resize); observer.observe(host); resize()
    let last = performance.now()
    const render = (now: number) => {
      frame = requestAnimationFrame(render)
      const dt = Math.min((now - last) / 1000, 0.05); last = now; t += dt
      if (active.humanoid) animateHumanoid(active.humanoid, dt, animation === 'walk' ? 3 : 0, (animation === 'walk' || animation === 'injured' ? 'stand' : animation) as Pose, t, animation === 'injured')
      orbit.update(); renderer.render(scene, camera)
    }
    frame = requestAnimationFrame(render)
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); orbit.dispose(); controls.current = null
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>()
      const collect = (o: THREE.Object3D) => { if (o instanceof THREE.Mesh) { geometries.add(o.geometry); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => materials.add(m)) } }
      catalog.forEach(a => a.object.traverse(collect)); scene.traverse(collect)
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); renderer.dispose(); renderer.domElement.remove()
    }
  }, [])
  return <main className="art-review">
    <aside className="art-sidebar">
      <a href="/" className="art-back">← 返回游戏</a>
      <p className="art-eyebrow">NIGHT HUNT / ART LIBRARY</p>
      <h1>夜猎 · 美术资产</h1>
      <p className="art-description">统一低多边形造型、材质与夜景识别度。拖动旋转，滚轮缩放。</p>
      <nav aria-label="美术资产">{items.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); controls.current?.choose(item.id) }}>{item.label}</button>)}</nav>
    </aside>
    <section className="art-stage">
      <div ref={mount} className="art-canvas" />
      <header className="art-toolbar"><span>资产检视 / {items.find(i => i.id === selected)?.label.split(' / ')[1]}</span><button aria-pressed={night} onClick={() => { setNight(!night); controls.current?.night(!night) }}>{night ? '切换棚拍光' : '切换夜景光'}</button></header>
      <footer className="art-footer"><span>{stats}</span>{['survivor', 'hunter'].includes(selected) && <label>动作 <select aria-label="角色动作" value={pose} onChange={e => { setPose(e.target.value); controls.current?.pose(e.target.value) }}><option value="stand">待机</option><option value="walk">行走</option><option value="injured">受伤</option><option value="crawl">倒地</option><option value="carried">被扛</option><option value="chaired">上椅</option></select></label>}<span>与游戏共用模型生成器</span></footer>
    </section>
  </main>
}
