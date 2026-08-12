// 游戏 HUD(React + Tailwind):状态芯片、提示、QTE、心跳红晕、菜单与结算
import { useEffect, useSyncExternalStore } from 'react'
import { getHud, subscribeHud, pruneToasts } from '../game/bridge'
import type { HudState } from '../game/bridge'
import type { SurvivorStatus } from '../game/types'

const STATUS_TEXT: Record<SurvivorStatus, string> = {
  healthy: '健康',
  injured: '受伤',
  downed: '倒地',
  carried: '被扛',
  chaired: '上椅',
  eliminated: '淘汰',
  escaped: '逃脱',
}

function statusColor(s: SurvivorStatus): string {
  switch (s) {
    case 'healthy':
      return 'text-[#E4E8E9] border-[#3a3f46]'
    case 'injured':
      return 'text-[#d41d1f] border-[#d41d1f]'
    case 'downed':
    case 'carried':
      return 'text-[#d41d1f] border-[#d41d1f] bg-[#d41d1f]/10'
    case 'chaired':
      return 'text-[#d41d1f] border-[#d41d1f] bg-[#d41d1f]/20 animate-pulse'
    case 'eliminated':
      return 'text-[#555] border-[#333] line-through'
    case 'escaped':
      return 'text-[#7fb069] border-[#7fb069]'
  }
}

export interface HudActions {
  onStart: () => void
  onResume: () => void
  onRestart: () => void
  onMute: () => void
}

function QteDial({ qte }: { qte: NonNullable<HudState['qte']> }) {
  const r = 70
  const cx = 90
  const cy = 90
  const zoneEnd = qte.zoneStart + qte.zoneSize
  const polar = (deg: number, rad: number) => {
    const a = ((deg - 90) * Math.PI) / 180
    return { x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) }
  }
  const s0 = polar(qte.zoneStart, r)
  const s1 = polar(zoneEnd, r)
  const large = qte.zoneSize > 180 ? 1 : 0
  const n = polar(qte.needle, r - 6)
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
      <svg width="180" height="180">
        <circle cx={cx} cy={cy} r={r} fill="rgba(11,13,16,0.75)" stroke="#3a3f46" strokeWidth="2" />
        <path
          d={`M ${s0.x} ${s0.y} A ${r} ${r} 0 ${large} 1 ${s1.x} ${s1.y}`}
          stroke="#7fb069"
          strokeWidth="10"
          fill="none"
          strokeLinecap="round"
        />
        <line x1={cx} y1={cy} x2={n.x} y2={n.y} stroke="#E4E8E9" strokeWidth="3" />
        <circle cx={cx} cy={cy} r="5" fill="#E4E8E9" />
        <text x={cx} y={cy + r + 24} textAnchor="middle" fill="#E4E8E9" fontSize="14">
          按 Space 完成检定
        </text>
      </svg>
    </div>
  )
}

// 冲刺技能槽:就绪时亮,冷却中显示剩余秒数 + 灰罩
function DashSlot({ cd }: { cd: number }) {
  const ready = cd <= 0
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        className={`relative flex h-12 w-12 items-center justify-center rounded-md border-2 ${
          ready
            ? 'border-[#6bb4ff] bg-[#1a2a44] shadow-[0_0_8px_#6bb4ff]'
            : 'border-[#3a3f48] bg-[#1a1d24]'
        }`}
      >
        {/* 闪电图标(纯 SVG) */}
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill={ready ? '#9fd0ff' : '#5a6068'}>
          <path d="M13 2 L4 14 h6 l-1 8 9-12 h-6 z" />
        </svg>
        {/* 冷却灰罩 */}
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/55">
            <span className="text-sm font-bold tabular-nums text-[#cfd6dd]">{Math.ceil(cd)}</span>
          </div>
        )}
      </div>
      <span className={`text-[10px] font-bold ${ready ? 'text-[#9fd0ff]' : 'text-[#5a6068]'}`}>Q</span>
    </div>
  )
}

// 小地图尺寸常量(归一化坐标 -1..1 → 0..SIZE)
const MINIMAP_SIZE = 120
const MINIMAP_HALF = MINIMAP_SIZE / 2
const miniPx = (v: number): number => MINIMAP_HALF + v * MINIMAP_HALF

// 小地图上的圆点(模块级组件,避免在渲染期间创建组件)
function MiniDot({ x, z, color, size = 3 }: { x: number; z: number; color: string; size?: number }) {
  return <circle cx={miniPx(x)} cy={miniPx(z)} r={size} fill={color} />
}

// 小地图:左上角 120px,归一化坐标 -1..1 映射。监管者仅心跳范围内显示。
function Minimap({ mm }: { mm: NonNullable<HudState['minimap']> }) {
  return (
    <div className="absolute left-3 top-3 rounded-md border border-[#2a2e36] bg-[#0e1014]/80 p-1">
      <svg width={MINIMAP_SIZE} height={MINIMAP_SIZE} className="block">
        {/* 边框 */}
        <rect x={0} y={0} width={MINIMAP_SIZE} height={MINIMAP_SIZE} fill="none" stroke="#2a2e36" strokeWidth={1} />
        {/* 密码机:未完成红 / 完成绿 */}
        {mm.ciphers.map((c, i) => (
          <MiniDot key={`c${i}`} x={c.x} z={c.z} color={c.done ? '#7fb069' : '#d41d1f'} size={2.5} />
        ))}
        {/* 椅子:占用时橙 */}
        {mm.chairs.map((c, i) => (
          <MiniDot key={`ch${i}`} x={c.x} z={c.z} color={c.occupied ? '#ff8a3a' : '#4a4f58'} size={2} />
        ))}
        {/* 大门:开绿 / 未开灰 */}
        {mm.gates.map((g, i) => (
          <MiniDot key={`g${i}`} x={g.x} z={g.z} color={g.opened ? '#7fb069' : '#5a6068'} size={3} />
        ))}
        {/* AI 队友 */}
        {mm.mates.map((m, i) => (
          <MiniDot key={`m${i}`} x={m.x} z={m.z} color="#9aa3ab" size={2.5} />
        ))}
        {/* 监管者:仅心跳范围可见 */}
        {mm.hunter && <MiniDot x={mm.hunter.x} z={mm.hunter.z} color="#ff2626" size={3.5} />}
        {/* 玩家:蓝圈 + 蓝点(最上层) */}
        {mm.player && (
          <>
            <circle cx={miniPx(mm.player.x)} cy={miniPx(mm.player.z)} r={5} fill="none" stroke="#6bb4ff" strokeWidth={1.5} />
            <MiniDot x={mm.player.x} z={mm.player.z} color="#6bb4ff" size={3} />
          </>
        )}
      </svg>
    </div>
  )
}

export default function Hud({ actions }: { actions: HudActions }) {
  const hud = useSyncExternalStore(subscribeHud, getHud)

  useEffect(() => {
    const t = setInterval(pruneToasts, 500)
    return () => clearInterval(t)
  }, [])

  const injuredLike = hud.playerStatus === 'injured' || hud.playerStatus === 'downed'
  const vignetteOpacity = Math.min(1, hud.terror * 0.85 + (injuredLike ? 0.35 : 0))

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-sans text-[#E4E8E9]">
      {/* 心跳 / 受伤红晕 */}
      {(hud.phase === 'playing' || hud.phase === 'paused') && vignetteOpacity > 0.02 && (
        <div
          className="absolute inset-0"
          style={{
            opacity: vignetteOpacity,
            background: 'radial-gradient(ellipse at center, transparent 52%, rgba(212,29,31,0.55) 100%)',
            animation: hud.terror > 0.05 ? `heartbeatPulse ${Math.max(0.45, 1.15 - hud.terror * 0.68)}s ease-in-out infinite` : undefined,
          }}
        />
      )}

      {/* 观战模式提示 */}
      {hud.phase === 'spectating' && (
        <div className="absolute left-1/2 top-10 -translate-x-1/2 rounded-md bg-black/60 px-4 py-2 text-center">
          <div className="text-sm text-[#9aa3ab]">你已被淘汰 · 正在观战队友</div>
          <div className="mt-1 text-xs text-[#6b7480]">等待队友完成破译逃脱,或全员淘汰则游戏结束</div>
        </div>
      )}

      {/* 顶部中央:密码机 */}
      {hud.phase === 'playing' && (
        <div className="absolute left-1/2 top-4 -translate-x-1/2 text-center">
          <div className="text-sm tracking-widest text-[#9aa3ab]">剩余密码机</div>
          <div className="text-3xl font-bold tabular-nums">{hud.ciphersLeft} / {hud.ciphersTotal}</div>
          <div className="mt-1 h-1.5 w-56 overflow-hidden rounded bg-[#23262c]">
            <div className="h-full bg-[#C9C9F2] transition-all duration-300" style={{ width: `${hud.overall * 100}%` }} />
          </div>
          {hud.gatePowered && (
            <div className="mt-2 rounded border border-[#7fb069] px-3 py-1 text-sm text-[#7fb069]">
              电闸已通电 — 去寻找大门开关!
            </div>
          )}
        </div>
      )}

      {/* 左上:小地图 */}
      {hud.phase === 'playing' && hud.minimap && <Minimap mm={hud.minimap} />}

      {/* 右上:幸存者状态 */}
      {hud.phase === 'playing' && (
        <div className="absolute right-4 top-4 flex flex-col gap-2">
          {hud.survivors.map((s) => (
            <div
              key={s.name}
              className={`flex w-32 items-center justify-between rounded border px-2.5 py-1.5 text-sm backdrop-blur-sm bg-black/40 ${statusColor(s.status)}`}
            >
              <span>{s.isPlayer ? '你' : s.name}</span>
              <span className="text-xs">{STATUS_TEXT[s.status]}</span>
            </div>
          ))}
        </div>
      )}

      {/* 底部中央:交互提示 */}
      {hud.phase === 'playing' && hud.prompt && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 text-center">
          <div className="rounded border border-[#C9C9F2]/60 bg-black/60 px-5 py-2 text-base text-[#C9C9F2]">
            {hud.prompt.text}
          </div>
          {hud.prompt.progress !== null && (
            <div className="mx-auto mt-2 h-1.5 w-48 overflow-hidden rounded bg-[#23262c]">
              <div className="h-full bg-[#C9C9F2]" style={{ width: `${Math.min(100, hud.prompt.progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {/* 体力条 */}
      {hud.phase === 'playing' && hud.playerStatus !== 'downed' && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2">
          <div className="h-1 w-40 overflow-hidden rounded bg-[#23262c]">
            <div
              className={`h-full ${hud.stamina < 0.25 ? 'bg-[#d41d1f]' : 'bg-[#9aa3ab]'}`}
              style={{ width: `${hud.stamina * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* 冲刺技能槽(Q) */}
      {hud.phase === 'playing' && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
          <DashSlot cd={hud.dashCd} />
        </div>
      )}

      {/* 被治疗进度条:他人正在治疗玩家时显示 */}
      {hud.phase === 'playing' && hud.healProgress >= 0 && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 translate-y-16 text-center">
          <div className="mb-1 text-xs text-[#7fb069]">正在被治疗…</div>
          <div className="h-1.5 w-32 overflow-hidden rounded bg-[#1f2a1f]">
            <div className="h-full bg-[#7fb069]" style={{ width: `${hud.healProgress * 100}%` }} />
          </div>
        </div>
      )}

      {/* 上椅倒计时 */}
      {hud.phase === 'playing' && hud.chairTimeLeft >= 0 && (
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 text-center">
          <div className="text-lg text-[#d41d1f]">你被绑在狂欢之椅上</div>
          <div className="text-5xl font-bold tabular-nums text-[#d41d1f]">{Math.ceil(hud.chairTimeLeft)}</div>
          <div className="mt-1 text-sm text-[#9aa3ab]">等待队友救援…</div>
        </div>
      )}

      {/* QTE */}
      {hud.phase === 'playing' && hud.qte && <QteDial qte={hud.qte} />}

      {/* Toast */}
      {hud.phase === 'playing' && (
        <div className="absolute left-1/2 top-24 flex -translate-x-1/2 flex-col items-center gap-1.5">
          {hud.toasts.map((t) => (
            <div
              key={t.id}
              className={`rounded px-4 py-1.5 text-sm backdrop-blur-sm ${
                t.danger ? 'bg-[#d41d1f]/25 text-[#ff6b6c] border border-[#d41d1f]/60' : 'bg-black/55 text-[#E4E8E9] border border-[#3a3f46]'
              }`}
            >
              {t.text}
            </div>
          ))}
        </div>
      )}

      {/* 静音提示 */}
      {hud.phase === 'playing' && hud.muted && (
        <div className="absolute left-4 top-4 rounded border border-[#3a3f46] bg-black/50 px-2 py-1 text-xs text-[#9aa3ab]">
          已静音 (M)
        </div>
      )}

      {/* 开始菜单 */}
      {hud.phase === 'menu' && (
        <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center bg-[#0b0d10]">
          <div className="text-xs tracking-[0.5em] text-[#d41d1f]">1 名猎人 · 4 名幸存者</div>
          <h1 className="mt-3 text-6xl font-bold tracking-wider">夜猎庄园</h1>
          <div className="mt-1 text-lg tracking-[0.3em] text-[#9aa3ab]">NIGHT HUNT</div>
          <p className="mt-6 max-w-md text-center text-sm leading-6 text-[#9aa3ab]">
            浓雾笼罩的哥特庄园里,猎人正在巡逻。与 3 名队友协作破译 5 台密码机,
            通电后拉开电闸门逃出生天。被抓住两次,狂欢之椅就会送你上天。
          </p>
          <button
            onClick={actions.onStart}
            className="mt-8 rounded border border-[#d41d1f] bg-[#d41d1f]/15 px-10 py-3 text-lg tracking-widest text-[#E4E8E9] transition-colors hover:bg-[#d41d1f]/35"
          >
            开 始 游 戏
          </button>
          <div className="mt-10 grid grid-cols-2 gap-x-10 gap-y-2 text-sm text-[#9aa3ab]">
            <span><kbd className="text-[#E4E8E9]">W A S D</kbd> 移动</span>
            <span><kbd className="text-[#E4E8E9]">鼠标</kbd> 视角(点击锁定)</span>
            <span><kbd className="text-[#E4E8E9]">Shift</kbd> 奔跑(消耗体力)</span>
            <span><kbd className="text-[#E4E8E9]">E</kbd> 破译 / 救援 / 治疗 / 开闸</span>
            <span><kbd className="text-[#E4E8E9]">Space</kbd> 翻窗 / 放板 / 技能检定</span>
            <span><kbd className="text-[#E4E8E9]">Esc</kbd> 暂停 &nbsp; <kbd className="text-[#E4E8E9]">M</kbd> 静音</span>
          </div>
        </div>
      )}

      {/* 暂停菜单 */}
      {hud.phase === 'paused' && (
        <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center bg-black/70">
          <h2 className="text-4xl font-bold tracking-widest">已暂停</h2>
          <button
            onClick={actions.onResume}
            className="mt-8 rounded border border-[#C9C9F2] px-8 py-2.5 tracking-widest text-[#C9C9F2] hover:bg-[#C9C9F2]/15"
          >
            继 续
          </button>
          <button
            onClick={actions.onRestart}
            className="mt-3 rounded border border-[#3a3f46] px-8 py-2.5 tracking-widest text-[#9aa3ab] hover:bg-white/5"
          >
            重新开始
          </button>
          <button
            onClick={actions.onMute}
            className="mt-3 rounded border border-[#3a3f46] px-8 py-2.5 tracking-widest text-[#9aa3ab] hover:bg-white/5"
          >
            {hud.muted ? '取消静音' : '静 音'}
          </button>
        </div>
      )}

      {/* 结算 */}
      {(hud.phase === 'won' || hud.phase === 'lost') && (
        <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center bg-[#0b0d10]/95">
          <h2 className={`text-5xl font-bold tracking-widest ${hud.phase === 'won' ? 'text-[#7fb069]' : 'text-[#d41d1f]'}`}>
            {hud.phase === 'won' ? '逃 脱 成 功' : '游 戏 结 束'}
          </h2>
          {hud.phase === 'won' ? (
            <p className="mt-4 text-[#9aa3ab]">
              你逃出了夜猎庄园。另有 <span className="text-[#E4E8E9]">{hud.escapedTeammates}</span> / 3 名队友成功逃脱。
            </p>
          ) : (
            <p className="mt-4 text-[#9aa3ab]">{hud.endReason}</p>
          )}
          <div className="mt-8 grid grid-cols-3 gap-6 text-center">
            <div>
              <div className="text-3xl font-bold tabular-nums text-[#C9C9F2]">{hud.stats.decode}%</div>
              <div className="mt-1 text-xs text-[#9aa3ab]">破译贡献</div>
            </div>
            <div>
              <div className="text-3xl font-bold tabular-nums text-[#C9C9F2]">{hud.stats.chaseTime}s</div>
              <div className="mt-1 text-xs text-[#9aa3ab]">牵制猎人</div>
            </div>
            <div>
              <div className="text-3xl font-bold tabular-nums text-[#C9C9F2]">{hud.stats.rescues}</div>
              <div className="mt-1 text-xs text-[#9aa3ab]">救援次数</div>
            </div>
          </div>
          <button
            onClick={actions.onRestart}
            className="mt-10 rounded border border-[#d41d1f] bg-[#d41d1f]/15 px-10 py-3 tracking-widest hover:bg-[#d41d1f]/35"
          >
            再 来 一 局
          </button>
        </div>
      )}

      <style>{`
        @keyframes heartbeatPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }
        kbd { border: 1px solid #3a3f46; border-radius: 4px; padding: 1px 6px; font-family: inherit; }
      `}</style>
    </div>
  )
}
