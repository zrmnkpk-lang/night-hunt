import { useEffect, useRef } from 'react'
import Hud from '../components/Hud'
import { Engine } from '../game/engine'
import { Input } from '../game/input'
import { AudioEngine } from '../game/audio'
import { setHud } from '../game/bridge'

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const input = new Input()
    const audio = new AudioEngine()
    input.attach(canvas)
    const engine = new Engine(canvas, input, audio)
    engineRef.current = engine
    setHud({ phase: 'menu' })
    return () => {
      engine.dispose()
      input.detach()
      engineRef.current = null
    }
  }, [])

  const actions = {
    onStart: () => engineRef.current?.start(),
    onResume: () => engineRef.current?.resume(),
    onRestart: () => engineRef.current?.start(),
    onMute: () => engineRef.current?.toggleMute(),
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0b0d10]">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <Hud actions={actions} />
    </div>
  )
}
