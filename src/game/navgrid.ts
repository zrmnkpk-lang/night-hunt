// 导航网格 + A* 寻路 + 碰撞/视线工具
import { GRID_SIZE, MAP_HALF, clamp } from './types'
import type { AABB } from './types'

export class NavGrid {
  readonly size = GRID_SIZE
  readonly half = MAP_HALF
  private staticBlocked = new Uint8Array(GRID_SIZE * GRID_SIZE)
  private dynamicBlocked = new Uint8Array(GRID_SIZE * GRID_SIZE)
  // A* 复用缓冲 —— 全部用 TypedArray + 版本化(searchId),避免每次寻路整图 fill 与 Map 分配
  private gScore = new Float32Array(GRID_SIZE * GRID_SIZE)
  private fScore = new Float32Array(GRID_SIZE * GRID_SIZE)
  private cameFrom = new Int32Array(GRID_SIZE * GRID_SIZE)
  // touchedAt[i] === searchId 表示该格本帧已被打开(fScore/gScore 有效),免去整图 clear
  private touchedAt = new Uint32Array(GRID_SIZE * GRID_SIZE)
  private closedAt = new Uint32Array(GRID_SIZE * GRID_SIZE)
  private searchId = 0

  worldToCell(x: number, z: number): { cx: number; cz: number } {
    const cx = clamp(Math.floor(x + this.half), 0, this.size - 1)
    const cz = clamp(Math.floor(z + this.half), 0, this.size - 1)
    return { cx, cz }
  }

  cellToWorld(cx: number, cz: number): { x: number; z: number } {
    return { x: cx - this.half + 0.5, z: cz - this.half + 0.5 }
  }

  idx(cx: number, cz: number): number {
    return cz * this.size + cx
  }

  markAABB(box: AABB, expand: number): void {
    // 只阻挡"格子中心"落在外扩盒内的格子——门洞两侧的墙不会把通道口封死
    const min = this.worldToCell(box.minX - expand, box.minZ - expand)
    const max = this.worldToCell(box.maxX + expand, box.maxZ + expand)
    for (let cz = min.cz; cz <= max.cz; cz++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        const wx = cx - this.half + 0.5
        const wz = cz - this.half + 0.5
        if (wx >= box.minX - expand && wx <= box.maxX + expand && wz >= box.minZ - expand && wz <= box.maxZ + expand) {
          this.staticBlocked[this.idx(cx, cz)] = 1
        }
      }
    }
  }

  unblockAABB(box: AABB): void {
    const min = this.worldToCell(box.minX, box.minZ)
    const max = this.worldToCell(box.maxX, box.maxZ)
    for (let cz = min.cz; cz <= max.cz; cz++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        this.staticBlocked[this.idx(cx, cz)] = 0
      }
    }
  }

  setDynamic(x: number, z: number, blocked: boolean): void {
    const { cx, cz } = this.worldToCell(x, z)
    this.dynamicBlocked[this.idx(cx, cz)] = blocked ? 1 : 0
  }

  // 按 AABB 范围设置动态阻挡(放倒的木板覆盖多格)
  setDynamicAABB(box: AABB, blocked: boolean): void {
    const min = this.worldToCell(box.minX, box.minZ)
    const max = this.worldToCell(box.maxX, box.maxZ)
    for (let cz = min.cz; cz <= max.cz; cz++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        this.dynamicBlocked[this.idx(cx, cz)] = blocked ? 1 : 0
      }
    }
  }

  blockedCell(cx: number, cz: number): boolean {
    if (cx < 0 || cz < 0 || cx >= this.size || cz >= this.size) return true
    const i = this.idx(cx, cz)
    return this.staticBlocked[i] === 1 || this.dynamicBlocked[i] === 1
  }

  blockedAt(x: number, z: number): boolean {
    const { cx, cz } = this.worldToCell(x, z)
    return this.blockedCell(cx, cz)
  }

  // 找最近的可走格子(螺旋搜索),已触地图边界即早退避免无效迭代
  nearestFree(x: number, z: number, maxR = 6): { cx: number; cz: number } {
    const { cx, cz } = this.worldToCell(x, z)
    if (!this.blockedCell(cx, cz)) return { cx, cz }
    const limLeft = Math.min(maxR, cx)
    const limRight = Math.min(maxR, this.size - 1 - cx)
    const limUp = Math.min(maxR, cz)
    const limDown = Math.min(maxR, this.size - 1 - cz)
    const maxReachable = Math.max(limLeft, limRight, limUp, limDown, 0)
    for (let r = 1; r <= maxReachable; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          const nx = cx + dx
          const nz = cz + dz
          if (!this.blockedCell(nx, nz)) return { cx: nx, cz: nz }
        }
      }
    }
    return { cx, cz }
  }

  // A* 八方向寻路,返回世界坐标路径点(不含起点)
  // 关键实现细节(性能向):
  //   - 全部用 TypedArray,fScore/gScore/closed 都做 searchId 版本化,免去每次寻路 4 次整图 fill
  //   - 堆比较直接索引 fScore 数组(原 Map.get 实测慢 5-10× 且每帧产生 GC)
  //   - 启发式加微小乘子 (1 + 1/(2N)) 打破等价路径平局,偏好直线、减少扩展节点
  findPath(sx: number, sz: number, tx: number, tz: number): { x: number; z: number }[] {
    const s = this.nearestFree(sx, sz)
    const t = this.nearestFree(tx, tz)
    const start = this.idx(s.cx, s.cz)
    const goal = this.idx(t.cx, t.cz)
    if (start === goal) return [{ x: tx, z: tz }]

    // 新一次搜索:版本号 +1,所有 touchedAt/closedAt < searchId 即视为"未访问"
    const sid = (this.searchId = (this.searchId + 1) >>> 0)
    const N = this.size
    const gScore = this.gScore
    const fScore = this.fScore
    const touchedAt = this.touchedAt
    const closedAt = this.closedAt
    const cameFrom = this.cameFrom

    // tie-break 启发式:octile 距离 × (1 + ε),让等价路径里更直的那条优先 pop
    const HB = 1 + 1 / (2 * N)
    const h = (i: number): number => {
      const dx = Math.abs((i % N) - t.cx)
      const dz = Math.abs((i / N | 0) - t.cz)
      return (Math.max(dx, dz) + 0.4142 * Math.min(dx, dz)) * HB
    }

    // 简单二叉堆(索引数组,比较用 fScore 直读)
    const heap: number[] = []
    const push = (i: number): void => {
      heap.push(i)
      let c = heap.length - 1
      const fi = fScore[i]
      while (c > 0) {
        const p = (c - 1) >> 1
        if (fScore[heap[p]] <= fi) break
        const tmp = heap[p]
        heap[p] = heap[c]
        heap[c] = tmp
        c = p
      }
    }
    const pop = (): number => {
      const top = heap[0]
      const last = heap.pop() as number
      if (heap.length > 0) {
        heap[0] = last
        let c = 0
        for (;;) {
          const l = c * 2 + 1
          const r = l + 1
          let m = c
          // 取父/左/右三者中 fScore 最小者;直接读数组,无 Map 开销
          if (l < heap.length && fScore[heap[l]] < fScore[heap[m]]) m = l
          if (r < heap.length && fScore[heap[r]] < fScore[heap[m]]) m = r
          if (m === c) break
          const tmp = heap[m]
          heap[m] = heap[c]
          heap[c] = tmp
          c = m
        }
      }
      return top
    }

    gScore[start] = 0
    fScore[start] = h(start)
    touchedAt[start] = sid
    push(start)

    const DIRS = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, 1.4142],
      [1, -1, 1.4142],
      [-1, 1, 1.4142],
      [-1, -1, 1.4142],
    ]

    let found = false
    let guard = 0
    while (heap.length > 0 && guard++ < 20000) {
      const cur = pop()
      if (cur === goal) {
        found = true
        break
      }
      if (closedAt[cur] === sid) continue
      closedAt[cur] = sid
      const cx = cur % N
      const cz = (cur / N) | 0
      const gcur = gScore[cur]
      for (let k = 0; k < 8; k++) {
        const dx = DIRS[k][0]
        const dz = DIRS[k][1]
        const cost = DIRS[k][2]
        const nx = cx + dx
        const nz = cz + dz
        if (this.blockedCell(nx, nz)) continue
        // 防止斜穿墙角
        if (dx !== 0 && dz !== 0) {
          if (this.blockedCell(cx + dx, cz) || this.blockedCell(cx, cz + dz)) continue
        }
        const ni = nz * N + nx
        if (closedAt[ni] === sid) continue
        const ng = gcur + cost
        // 版本化判空:未触摸或新 g 更优才更新
        if (touchedAt[ni] !== sid || ng < gScore[ni]) {
          gScore[ni] = ng
          cameFrom[ni] = cur
          fScore[ni] = ng + h(ni)
          touchedAt[ni] = sid
          push(ni)
        }
      }
    }

    if (!found) {
      // 返回直线期望(调用方退化为直接 steering)
      return [{ x: tx, z: tz }]
    }
    const cells: number[] = []
    let cur = goal
    while (cur !== -1 && cur !== start) {
      cells.push(cur)
      cur = cameFrom[cur]
    }
    cells.reverse()
    const path = cells.map((i) => this.cellToWorld(i % N, (i / N) | 0))
    if (path.length > 0) {
      path[path.length - 1] = { x: tx, z: tz }
    }
    return path
  }
}

// 圆形 vs AABB 碰撞检测
export function circleHits(x: number, z: number, r: number, box: AABB): boolean {
  const cx = clamp(x, box.minX, box.maxX)
  const cz = clamp(z, box.minZ, box.maxZ)
  const dx = x - cx
  const dz = z - cz
  return dx * dx + dz * dz < r * r
}

// 线段 vs AABB(用于视线检测)
export function segmentHitsAABB(x1: number, z1: number, x2: number, z2: number, box: AABB): boolean {
  // 快速排除
  if (Math.max(x1, x2) < box.minX || Math.min(x1, x2) > box.maxX) return false
  if (Math.max(z1, z2) < box.minZ || Math.min(z1, z2) > box.maxZ) return false
  // slab 法
  const dx = x2 - x1
  const dz = z2 - z1
  let tmin = 0
  let tmax = 1
  if (Math.abs(dx) < 1e-8) {
    if (x1 < box.minX || x1 > box.maxX) return false
  } else {
    let t1 = (box.minX - x1) / dx
    let t2 = (box.maxX - x1) / dx
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return false
  }
  if (Math.abs(dz) < 1e-8) {
    if (z1 < box.minZ || z1 > box.maxZ) return false
  } else {
    let t1 = (box.minZ - z1) / dz
    let t2 = (box.maxZ - z1) / dz
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return false
  }
  return true
}

// 视线是否被墙阻挡
export function losBlocked(x1: number, z1: number, x2: number, z2: number, walls: AABB[]): boolean {
  for (const w of walls) {
    if (segmentHitsAABB(x1, z1, x2, z2, w)) return true
  }
  return false
}
