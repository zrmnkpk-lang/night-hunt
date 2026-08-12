// 破译 QTE(技能检定):指针扫过成功区时按 Space
export interface QteResult {
  done: boolean
  success: boolean
}

export class Qte {
  active = false
  needle = 0 // 角度
  zoneStart = 0
  zoneSize = 55
  speed = 260 // 度/秒
  timeLeft = 0
  private cooldown = 0 // 距离下次可能出现

  update(dt: number, decoding: boolean, spacePressed: boolean): QteResult | null {
    if (!this.active) {
      if (decoding) {
        this.cooldown -= dt
        if (this.cooldown <= 0) {
          this.trigger()
        }
      }
      return null
    }
    this.timeLeft -= dt
    this.needle = (this.needle + this.speed * dt) % 360
    if (spacePressed) {
      const n = this.needle
      const inZone =
        this.zoneStart + this.zoneSize <= 360
          ? n >= this.zoneStart && n <= this.zoneStart + this.zoneSize
          : n >= this.zoneStart || n <= (this.zoneStart + this.zoneSize) % 360
      this.active = false
      this.cooldown = 6 + Math.random() * 6
      return { done: true, success: inZone }
    }
    if (this.timeLeft <= 0) {
      this.active = false
      this.cooldown = 6 + Math.random() * 6
      return { done: true, success: false }
    }
    return null
  }

  private trigger(): void {
    this.active = true
    this.needle = 0
    this.zoneStart = 90 + Math.random() * 220
    this.zoneSize = 42 + Math.random() * 26
    this.speed = 230 + Math.random() * 90
    this.timeLeft = 2.0
  }

  cancel(): void {
    this.active = false
    this.cooldown = 4 + Math.random() * 4
  }
}
