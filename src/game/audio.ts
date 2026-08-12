// WebAudio 程序化音频:环境风声、心跳、追击、密码机、QTE、事件音效

// 所有事件音效方法名联合类型,供 sfx 调用做编译期检查(改名即报错)
export type SfxName =
  | 'qtePop'
  | 'qteGood'
  | 'qteBad'
  | 'hit'
  | 'palletStun'
  | 'palletBreak'
  | 'vault'
  | 'dash'
  | 'teleportWindup'
  | 'teleportBlink'
  | 'chairSting'
  | 'eliminated'
  | 'gateAlarm'
  | 'cipherDone'
  | 'rescue'
  | 'spotted'
  | 'win'
  | 'lose'

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private muted = false
  private volume = 0.8

  // 持续音层
  private chaseOsc: OscillatorNode | null = null
  private chaseGain: GainNode | null = null
  private humOsc: OscillatorNode | null = null
  private humGain: GainNode | null = null

  // 心跳调度
  private hbTimer = 0

  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new AC()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.muted ? 0 : this.volume
    this.master.connect(this.ctx.destination)
    this.startAmbient()
  }

  // 设置主音量(0~1),与静音独立;实际 gain = muted ? 0 : volume
  setVolume(v: number): void {
    this.volume = v
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05)
    }
  }

  setMuted(m: boolean): void {
    this.muted = m
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05)
    }
  }

  get isMuted(): boolean {
    return this.muted
  }

  private noiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx as AudioContext
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    return buf
  }

  private startAmbient(): void {
    const ctx = this.ctx as AudioContext
    // 风:过滤噪声,缓慢起伏
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer(4)
    src.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 320
    const g = ctx.createGain()
    g.gain.value = 0.05
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.09
    const lfoG = ctx.createGain()
    lfoG.gain.value = 0.025
    lfo.connect(lfoG)
    lfoG.connect(g.gain)
    src.connect(lp)
    lp.connect(g)
    g.connect(this.master as GainNode)
    src.start()
    lfo.start()
    // 低频 drone
    const dr = ctx.createOscillator()
    dr.type = 'sine'
    dr.frequency.value = 48
    const dg = ctx.createGain()
    dg.gain.value = 0.035
    dr.connect(dg)
    dg.connect(this.master as GainNode)
    dr.start()
  }

  // 每帧驱动心跳
  update(dt: number, terror: number): void {
    if (!this.ctx) return
    if (terror <= 0.02) return
    this.hbTimer -= dt
    if (this.hbTimer <= 0) {
      // 距离越近节奏越快:1.1s -> 0.45s
      this.hbTimer = 1.15 - terror * 0.68
      this.thump(0.16 * terror + 0.05)
      setTimeout(() => this.thump(0.11 * terror + 0.03), 130)
    }
  }

  private thump(vol: number): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(72, ctx.currentTime)
    o.frequency.exponentialRampToValueAtTime(38, ctx.currentTime + 0.14)
    const g = ctx.createGain()
    g.gain.setValueAtTime(vol, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18)
    o.connect(g)
    g.connect(this.master)
    o.start()
    o.stop(ctx.currentTime + 0.2)
  }

  setChase(on: boolean): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    if (on && !this.chaseOsc) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = 96
      const o2 = ctx.createOscillator()
      o2.type = 'sawtooth'
      o2.frequency.value = 96 * 1.02
      const trem = ctx.createOscillator()
      trem.frequency.value = 6.5
      const tremG = ctx.createGain()
      tremG.gain.value = 0.03
      const g = ctx.createGain()
      g.gain.value = 0.0
      g.gain.setTargetAtTime(0.055, ctx.currentTime, 0.4)
      trem.connect(tremG)
      tremG.connect(g.gain)
      o.connect(g)
      o2.connect(g)
      g.connect(this.master)
      o.start()
      o2.start()
      trem.start()
      this.chaseOsc = o
      this.chaseGain = g
      o.onended = () => {
        o2.stop()
        trem.stop()
      }
    } else if (!on && this.chaseOsc) {
      const o = this.chaseOsc
      this.chaseGain?.gain.setTargetAtTime(0, ctx.currentTime, 0.35)
      o.stop(ctx.currentTime + 1.2)
      this.chaseOsc = null
      this.chaseGain = null
    }
  }

  setHum(on: boolean): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    if (on && !this.humOsc) {
      const o = ctx.createOscillator()
      o.type = 'square'
      o.frequency.value = 118
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 400
      const g = ctx.createGain()
      g.gain.value = 0
      g.gain.setTargetAtTime(0.02, ctx.currentTime, 0.2)
      o.connect(lp)
      lp.connect(g)
      g.connect(this.master)
      o.start()
      this.humOsc = o
      this.humGain = g
    } else if (!on && this.humOsc) {
      const o = this.humOsc
      this.humGain?.gain.setTargetAtTime(0, ctx.currentTime, 0.15)
      o.stop(ctx.currentTime + 0.5)
      this.humOsc = null
      this.humGain = null
    }
  }

  private blip(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', slide = 0): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(freq, ctx.currentTime)
    if (slide !== 0) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), ctx.currentTime + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(vol, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)
    o.connect(g)
    g.connect(this.master)
    o.start()
    o.stop(ctx.currentTime + dur + 0.02)
  }

  private noiseHit(dur: number, vol: number, freq: number): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer(dur)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(vol, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)
    src.connect(bp)
    bp.connect(g)
    g.connect(this.master)
    src.start()
  }

  // ---- 事件音效 ----
  qtePop(): void {
    this.blip(880, 0.09, 0.12, 'triangle')
    setTimeout(() => this.blip(880, 0.09, 0.1, 'triangle'), 130)
  }
  qteGood(): void {
    this.blip(660, 0.08, 0.12, 'triangle')
    setTimeout(() => this.blip(990, 0.12, 0.12, 'triangle'), 80)
  }
  qteBad(): void {
    this.blip(220, 0.3, 0.16, 'square', -120)
    this.noiseHit(0.35, 0.2, 900)
  }
  hit(): void {
    this.noiseHit(0.25, 0.28, 300)
    this.blip(140, 0.3, 0.2, 'sawtooth', -60)
  }
  palletStun(): void {
    this.noiseHit(0.3, 0.3, 180)
    this.blip(90, 0.25, 0.2, 'square', -30)
  }
  palletBreak(): void {
    this.noiseHit(0.4, 0.25, 500)
  }
  vault(): void {
    this.noiseHit(0.12, 0.1, 1200)
  }
  // 求生者冲刺:短促上扫 whoosh
  dash(): void {
    this.blip(420, 0.2, 0.16, 'sine', 380)
    this.noiseHit(0.18, 0.08, 1800)
  }
  // 监管者瞬移:蓄能低频 + 瞬移爆点
  teleportWindup(): void {
    this.blip(110, 0.9, 0.18, 'sawtooth', 40)
  }
  teleportBlink(): void {
    this.blip(880, 0.12, 0.22, 'square', -400)
    this.noiseHit(0.3, 0.12, 600)
  }
  chairSting(): void {
    this.blip(440, 0.5, 0.16, 'sawtooth', -220)
    setTimeout(() => this.blip(415, 0.6, 0.14, 'sawtooth', -200), 180)
  }
  eliminated(): void {
    this.blip(330, 0.8, 0.18, 'sawtooth', -260)
    this.noiseHit(0.7, 0.15, 250)
  }
  gateAlarm(): void {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.blip(740, 0.22, 0.14, 'square'), i * 320)
    }
  }
  cipherDone(): void {
    this.blip(523, 0.12, 0.12, 'triangle')
    setTimeout(() => this.blip(659, 0.12, 0.12, 'triangle'), 120)
    setTimeout(() => this.blip(784, 0.22, 0.13, 'triangle'), 240)
  }
  rescue(): void {
    this.blip(520, 0.15, 0.12, 'triangle')
    setTimeout(() => this.blip(700, 0.2, 0.12, 'triangle'), 140)
  }
  spotted(): void {
    this.blip(190, 0.4, 0.2, 'sawtooth', 90)
  }
  win(): void {
    const seq = [392, 494, 587, 784]
    seq.forEach((f, i) => setTimeout(() => this.blip(f, 0.35, 0.14, 'triangle'), i * 200))
  }
  lose(): void {
    const seq = [330, 262, 196, 131]
    seq.forEach((f, i) => setTimeout(() => this.blip(f, 0.5, 0.15, 'sawtooth'), i * 260))
  }
}
