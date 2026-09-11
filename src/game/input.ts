// 键鼠输入(指针锁定第三人称)
export class Input {
  keys = new Set<string>()
  mouseDX = 0
  mouseDY = 0
  spacePressed = false // 边沿触发
  eHeld = false
  escPressed = false
  mPressed = false
  qPressed = false // 技能键:求生者冲刺 / 杀手瞬移
  attackPressed = false // 鼠标左键:杀手攻击
  ePressed = false // E 键边沿(杀手需要:扛起/破坏/放下);求生者继续用持续态 eHeld
  private canvas: HTMLCanvasElement | null = null
  enabled = false
  // 指针锁定不可用标志:嵌入式 webview 中 requestPointerLock 会被直接拒绝
  // ("root document is not valid for pointer lock")。此时降级为无锁定视角,
  // 只要鼠标在画布上移动就照常累积 movementX/Y,保证镜头始终可转。
  private lockUnavailable = false

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return
    const k = e.code
    if (k === 'Space') {
      if (!this.keys.has('Space')) this.spacePressed = true
      e.preventDefault()
    }
    if (k === 'KeyE') {
      if (!this.keys.has('KeyE')) this.ePressed = true
      this.eHeld = true
    }
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
    // 正常路径:已锁定;降级路径:锁定不可用时仅响应画布上的移动(悬停 HUD 按钮不转镜头)
    if (document.pointerLockElement === this.canvas || (this.lockUnavailable && e.target === this.canvas)) {
      this.mouseDX += e.movementX
      this.mouseDY += e.movementY
    }
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled) return
    if (e.button === 0) {
      this.attackPressed = true // 左键:杀手攻击
      // 降级模式下借每次画布点击重新尝试真锁定(浏览器要求用户手势),成功即自动回到锁定模式
      if (this.lockUnavailable && e.target === this.canvas) this.requestLock()
    }
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mousedown', this.onMouseDown)
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mousedown', this.onMouseDown)
  }

  requestLock(): void {
    if (!this.canvas || document.pointerLockElement === this.canvas) return
    try {
      // 新版 Chrome 返回 Promise:失败(如 Esc 后冷却期被拒)走 rejection;
      // 部分嵌入式 webview 不支持 pointer lock:同步抛 WrongDocumentError。
      // 两条失败路径都降级,绝不能让异常打断 start()/resume() 的后续流程。
      const req = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined
      if (req && typeof req.catch === 'function') req.catch(() => (this.lockUnavailable = true))
    } catch {
      this.lockUnavailable = true
    }
  }

  exitLock(): void {
    try {
      if (document.pointerLockElement) document.exitPointerLock()
    } catch {
      // 忽略:个别环境不支持
    }
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
  endFrame(): {
    dx: number
    dy: number
    space: boolean
    esc: boolean
    m: boolean
    q: boolean
    atk: boolean
    e: boolean
  } {
    const out = {
      dx: this.mouseDX,
      dy: this.mouseDY,
      space: this.spacePressed,
      esc: this.escPressed,
      m: this.mPressed,
      q: this.qPressed,
      atk: this.attackPressed,
      e: this.ePressed,
    }
    this.mouseDX = 0
    this.mouseDY = 0
    this.spacePressed = false
    this.escPressed = false
    this.mPressed = false
    this.qPressed = false
    this.attackPressed = false
    this.ePressed = false
    return out
  }
}
