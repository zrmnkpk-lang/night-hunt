// 键鼠输入(指针锁定第三人称)
export class Input {
  keys = new Set<string>()
  mouseDX = 0
  mouseDY = 0
  spacePressed = false // 边沿触发
  eHeld = false
  escPressed = false
  mPressed = false
  qPressed = false // 技能键:求生者冲刺
  private canvas: HTMLCanvasElement | null = null
  enabled = false

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return
    const k = e.code
    if (k === 'Space') {
      if (!this.keys.has('Space')) this.spacePressed = true
      e.preventDefault()
    }
    if (k === 'KeyE') this.eHeld = true
    if (k === 'Escape') this.escPressed = true
    if (k === 'KeyM') this.mPressed = true
    if (k === 'KeyQ') {
      if (!this.keys.has('KeyQ')) this.qPressed = true
    }
    this.keys.add(k)
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    const k = e.code
    if (k === 'KeyE') this.eHeld = false
    this.keys.delete(k)
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled) return
    if (document.pointerLockElement === this.canvas) {
      this.mouseDX += e.movementX
      this.mouseDY += e.movementY
    }
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('mousemove', this.onMouseMove)
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('mousemove', this.onMouseMove)
  }

  requestLock(): void {
    if (this.canvas && document.pointerLockElement !== this.canvas) {
      this.canvas.requestPointerLock()
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock()
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas
  }

  axis(): { x: number; z: number; sprint: boolean } {
    let x = 0
    let z = 0
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
    return { x, z, sprint }
  }

  // 每帧末尾调用,消费边沿量
  endFrame(): { dx: number; dy: number; space: boolean; esc: boolean; m: boolean; q: boolean } {
    const out = {
      dx: this.mouseDX,
      dy: this.mouseDY,
      space: this.spacePressed,
      esc: this.escPressed,
      m: this.mPressed,
      q: this.qPressed,
    }
    this.mouseDX = 0
    this.mouseDY = 0
    this.spacePressed = false
    this.escPressed = false
    this.mPressed = false
    this.qPressed = false
    return out
  }
}
