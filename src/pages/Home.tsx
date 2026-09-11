import { useEffect, useRef, useState } from 'react'
import Hud from '../components/Hud'
import { Engine } from '../game/engine'
import { Input } from '../game/input'
import { AudioEngine } from '../game/audio'
import { setHud } from '../game/bridge'
import type { HudRole } from '../game/bridge'

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  // 当前选中的阵营(菜单期用 React state 维持,开局时传给 engine.start(role))
  const [role, setRole] = useState<HudRole>('survivor')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const input = new Input()
    const audio = new AudioEngine()
    input.attach(canvas)
    const engine = new Engine(canvas, input, audio)
    engineRef.current = engine
    if (import.meta.env.DEV) {
      window.render_game_to_text = () => engine.renderGameToText()
      window.advanceTime = ms => engine.advanceTime(ms)
    }
    setHud({ phase: 'menu' })
    return () => {
      engine.dispose()
      input.detach()
      engineRef.current = null
      if (import.meta.env.DEV) {
        delete window.render_game_to_text
        delete window.advanceTime
      }
    }
  }, [])

  const actions = {
    onStart: () => engineRef.current?.start(role),
    onResume: () => engineRef.current?.resume(),
    onRestart: () => engineRef.current?.start(role),
    onMute: () => engineRef.current?.toggleMute(),
    onBackToMenu: () => engineRef.current?.backToMenu(),
    onSelectRole: (r: HudRole) => setRole(r),
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0b0d10]">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <Hud actions={actions} role={role} />
    </div>
  )
}
