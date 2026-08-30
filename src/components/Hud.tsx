// 游戏 HUD(React + Tailwind):状态芯片、提示、QTE、暗角、菜单与结算
import { useEffect, useSyncExternalStore } from 'react'
import { getHud, subscribeHud, pruneToasts } from '../game/bridge'
import type { HudState, HudRole } from '../game/bridge'
import type { SurvivorStatus } from '../game/types'
import menuBg from '../assets/menu-bg.png'

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
  onBackToMenu: () => void
  onSelectRole: (r: HudRole) => void
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

// 通用技能冷却槽:就绪时亮,冷却中显示剩余秒数 + 灰罩。accent 控制主题色。
function SkillSlot({
  cd,
  label,
  accent,
  glyph,
}: {
  cd: number
  label: string
  accent: string // 主题色(边框/发光/图标)如 '#6bb4ff'
  glyph: React.ReactNode
}) {
  const ready = cd <= 0
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        className="relative flex h-12 w-12 items-center justify-center rounded-md border-2 border-[#3a3f48] bg-[#1a1d24]"
        style={
          ready
            ? { borderColor: accent, boxShadow: `0 0 8px ${accent}`, backgroundColor: `${accent}22` }
            : undefined
        }
      >
        <span style={{ color: ready ? accent : '#5a6068' }}>{glyph}</span>
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/55">
            <span className="text-sm font-bold tabular-nums text-[#cfd6dd]">{Math.ceil(cd)}</span>
          </div>
        )}
      </div>
      <span
        className={`text-[10px] font-bold ${ready ? '' : 'text-[#5a6068]'}`}
        style={ready ? { color: accent } : undefined}
      >
        {label}
      </span>
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

// 小地图:左上角 120px,归一化坐标 -1..1 映射。
// 求生者局:显示队友 + 心跳范围内的监管者;杀手局:显示已暴露的猎物 + 噪音 + 扛人时的目标椅子。
function Minimap({ mm, isHunter }: { mm: NonNullable<HudState['minimap']>; isHunter: boolean }) {
  return (
    <div className="absolute left-3 top-3 rounded-md border border-[#2a2e36] bg-[#0e1014]/80 p-1">
      <svg width={MINIMAP_SIZE} height={MINIMAP_SIZE} className="block">
        <rect x={0} y={0} width={MINIMAP_SIZE} height={MINIMAP_SIZE} fill="none" stroke="#2a2e36" strokeWidth={1} />
        {/* 密码机:未完成红 / 完成绿,杀手局额外显示进度(决定去哪守) */}
        {mm.ciphers.map((c, i) =>
          isHunter ? (
            <g key={`c${i}`}>
              <MiniDot x={c.x} z={c.z} color={c.done ? '#7fb069' : '#d41d1f'} size={2.5} />
              {!c.done && (
                <circle cx={miniPx(c.x)} cy={miniPx(c.z)} r={2 + c.progress * 4} fill="none" stroke="#d41d1f" strokeWidth={0.8} opacity={0.5} />
              )}
            </g>
          ) : (
            <MiniDot key={`c${i}`} x={c.x} z={c.z} color={c.done ? '#7fb069' : '#d41d1f'} size={2.5} />
          ),
        )}
        {/* 椅子:占用时橙 */}
        {mm.chairs.map((c, i) => (
          <MiniDot key={`ch${i}`} x={c.x} z={c.z} color={c.occupied ? '#ff8a3a' : '#4a4f58'} size={2} />
        ))}
        {/* 大门:开绿 / 未开灰 */}
        {mm.gates.map((g, i) => (
          <MiniDot key={`g${i}`} x={g.x} z={g.z} color={g.opened ? '#7fb069' : '#5a6068'} size={3} />
        ))}
        {/* 求生者局:AI 队友 */}
        {!isHunter &&
          mm.mates.map((m, i) => <MiniDot key={`m${i}`} x={m.x} z={m.z} color="#9aa3ab" size={2.5} />)}
        {/* 杀手局:噪音事件(环形,半径随强度收缩) */}
        {isHunter &&
          mm.noises.map((no, i) => (
            <circle
              key={`n${i}`}
              cx={miniPx(no.x)}
              cy={miniPx(no.z)}
              r={3 + no.k * 9}
              fill="none"
              stroke="#ffcf6b"
              strokeWidth={1}
              opacity={0.25 + no.k * 0.55}
            />
          ))}
        {/* 杀手局:扛人时的目标椅子(金点) */}
        {isHunter && mm.chairTarget && <MiniDot x={mm.chairTarget.x} z={mm.chairTarget.z} color="#ffcf6b" size={3.5} />}
        {/* 杀手局:已暴露猎物(流血者带脉冲红环) */}
        {isHunter &&
          mm.prey.map((p, i) => (
            <g key={`p${i}`}>
              <MiniDot x={p.x} z={p.z} color="#ff2626" size={3.5} />
              {p.bleeding && (
                <circle cx={miniPx(p.x)} cy={miniPx(p.z)} r={6} fill="none" stroke="#ff2626" strokeWidth={1} opacity={0.6} className="animate-ping" />
              )}
            </g>
          ))}
        {/* 求生者局:心跳范围内的监管者 */}
        {!isHunter && mm.hunter && <MiniDot x={mm.hunter.x} z={mm.hunter.z} color="#ff2626" size={3.5} />}
        {/* 自己:蓝圈 + 点(求生者局=玩家;杀手局=猎人) */}
        {mm.self && (
          <>
            <circle cx={miniPx(mm.self.x)} cy={miniPx(mm.self.z)} r={5} fill="none" stroke={isHunter ? '#ff5a5c' : '#6bb4ff'} strokeWidth={1.5} />
            <MiniDot x={mm.self.x} z={mm.self.z} color={isHunter ? '#ff5a5c' : '#6bb4ff'} size={3} />
          </>
        )}
      </svg>
    </div>
  )
}

export default function Hud({ actions, role }: { actions: HudActions; role: HudRole }) {
  const hud = useSyncExternalStore(subscribeHud, getHud)
  const isHunter = hud.role === 'hunter'
  const isMenu = hud.phase === 'menu'

  useEffect(() => {
    const t = setInterval(pruneToasts, 500)
    return () => clearInterval(t)
  }, [])

  const injuredLike = hud.playerStatus === 'injured' || hud.playerStatus === 'downed'
  // 求生者:心跳/受伤红晕。杀手:terror 表示猎物接近度,改用暗金警示(接近即意味可出手)。
  const vignetteOpacity = Math.min(1, hud.terror * 0.85 + (isHunter ? 0 : injuredLike ? 0.35 : 0))
  const vignetteColor = isHunter ? 'rgba(255,90,60,0.45)' : 'rgba(212,29,31,0.55)'

  // 结算页文案与配色(按角色 + 结果分支)
  const endPhase = hud.phase === 'won' || hud.phase === 'lost' || hud.phase === 'draw' ? hud.phase : null

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-sans text-[#E4E8E9]">
      {/* 暗角(心跳 / 猎物接近) */}
      {(hud.phase === 'playing' || hud.phase === 'paused') && vignetteOpacity > 0.02 && (
        <div
          className="absolute inset-0"
          style={{
            opacity: vignetteOpacity,
            background: `radial-gradient(ellipse at center, transparent 52%, ${vignetteColor} 100%)`,
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

      {/* 顶部中央 */}
      {hud.phase === 'playing' && (
        <div className="absolute left-1/2 top-4 -translate-x-1/2 text-center">
          {isHunter ? (
            <>
              <div className="text-sm tracking-widest text-[#9aa3ab]">淘汰求生者</div>
              <div className="text-3xl font-bold tabular-nums text-[#ff5a5c]">
                {hud.kills} <span className="text-lg text-[#6b7480]">/ 4</span>
              </div>
              <div className="mt-1 h-1.5 w-56 overflow-hidden rounded bg-[#23262c]">
                <div className="h-full bg-[#d41d1f] transition-all duration-300" style={{ width: `${hud.overall * 100}%` }} />
              </div>
              <div className="mt-0.5 text-[10px] text-[#6b7480]">密码机进度(满则通电开门)</div>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      )}

      {/* 左上:小地图 */}
      {hud.phase === 'playing' && hud.minimap && <Minimap mm={hud.minimap} isHunter={isHunter} />}

      {/* 右上:幸存者状态(仅求生者局显示,杀手局用 HUD 顶部 kills 代替) */}
      {hud.phase === 'playing' && !isHunter && (
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

      {/* 底部中央:交互提示(求生者/杀手共用 prompt 通道) */}
      {hud.phase === 'playing' && hud.prompt && (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2 text-center">
          <div
            className={`rounded border px-5 py-2 text-base ${
              isHunter ? 'border-[#ff5a5c]/60 bg-black/60 text-[#ff8a8b]' : 'border-[#C9C9F2]/60 bg-black/60 text-[#C9C9F2]'
            }`}
          >
            {hud.prompt.text}
          </div>
          {hud.prompt.progress !== null && (
            <div className="mx-auto mt-2 h-1.5 w-48 overflow-hidden rounded bg-[#23262c]">
              <div className={isHunter ? 'h-full bg-[#ff5a5c]' : 'h-full bg-[#C9C9F2]'} style={{ width: `${Math.min(100, hud.prompt.progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {/* 体力条(仅求生者;杀手无体力) */}
      {hud.phase === 'playing' && !isHunter && hud.playerStatus !== 'downed' && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2">
          <div className="h-1 w-40 overflow-hidden rounded bg-[#23262c]">
            <div
              className={`h-full ${hud.stamina < 0.25 ? 'bg-[#d41d1f]' : 'bg-[#9aa3ab]'}`}
              style={{ width: `${hud.stamina * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* 底部技能槽 */}
      {hud.phase === 'playing' && (
        <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-end gap-3">
          {isHunter ? (
            <>
              {/* 攻击(鼠标左键)冷却 */}
              <SkillSlot
                cd={hud.attackCd}
                label="左键"
                accent="#ff5a5c"
                glyph={
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="#ff5a5c">
                    <path d="M5 3 L14 11 L11 13 L13 19 L10 20 L8 14 L5 16 Z" />
                  </svg>
                }
              />
              {/* Q 瞬移冷却 */}
              <SkillSlot
                cd={hud.teleportCd}
                label="Q"
                accent="#ffcf6b"
                glyph={
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="#ffcf6b">
                    <path d="M12 2 L15 9 L22 12 L15 15 L12 22 L9 15 L2 12 L9 9 Z" />
                  </svg>
                }
              />
              {/* 追击加成指示 */}
              {hud.chaseBuff > 0.001 && (
                <div className="mb-1 rounded border border-[#ffcf6b]/50 bg-black/50 px-2 py-1 text-[11px] font-bold text-[#ffcf6b]">
                  追击 +{Math.round(hud.chaseBuff * 100)}%
                </div>
              )}
            </>
          ) : (
            <SkillSlot
              cd={hud.dashCd}
              label="Q"
              accent="#6bb4ff"
              glyph={
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="#9fd0ff">
                  <path d="M13 2 L4 14 h6 l-1 8 9-12 h-6 z" />
                </svg>
              }
            />
          )}
        </div>
      )}

      {/* 被治疗进度条(求生者局,他人正在治疗玩家时显示) */}
      {hud.phase === 'playing' && !isHunter && hud.healProgress >= 0 && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 translate-y-16 text-center">
          <div className="mb-1 text-xs text-[#7fb069]">正在被治疗…</div>
          <div className="h-1.5 w-32 overflow-hidden rounded bg-[#1f2a1f]">
            <div className="h-full bg-[#7fb069]" style={{ width: `${hud.healProgress * 100}%` }} />
          </div>
        </div>
      )}

      {/* 上椅倒计时(求生者局) */}
      {hud.phase === 'playing' && !isHunter && hud.chairTimeLeft >= 0 && (
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 text-center">
          <div className="text-lg text-[#d41d1f]">你被绑在狂欢之椅上</div>
          <div className="text-5xl font-bold tabular-nums text-[#d41d1f]">{Math.ceil(hud.chairTimeLeft)}</div>
          <div className="mt-1 text-sm text-[#9aa3ab]">等待队友救援…</div>
        </div>
      )}

      {/* 顶部中央统计:杀手局扛人时额外显示"距离目标椅子" */}
      {hud.phase === 'playing' && isHunter && hud.carryName && (
        <div className="absolute left-1/2 top-24 -translate-x-1/2 rounded border border-[#ffcf6b]/50 bg-black/50 px-3 py-1 text-sm text-[#ffcf6b]">
          扛着 {hud.carryName}
          {hud.carryChairDist >= 0 && ` · 距椅子 ${Math.round(hud.carryChairDist)}m`}
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

      {/* ============ 开始菜单(含角色选择) ============ */}
      {isMenu && (
        <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center">
          <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${menuBg})` }} />
          <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-black/55 to-black/75" />

          <div className="relative flex flex-col items-center">
            <div className="text-xs tracking-[0.5em] text-[#ff5a5c] drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]">1 名猎人 · 4 名幸存者</div>
            <h1 className="mt-3 text-6xl font-bold tracking-wider text-[#f2f0ea] drop-shadow-[0_2px_12px_rgba(0,0,0,0.95)]">夜猎庄园</h1>
            <div className="mt-1 text-lg tracking-[0.3em] text-[#cfd3da] drop-shadow-[0_1px_6px_rgba(0,0,0,0.9)]">NIGHT HUNT</div>

            {/* 角色选择双卡 */}
            <div className="mt-7 grid grid-cols-2 gap-4">
              <button
                onClick={() => actions.onSelectRole('survivor')}
                className={`w-56 rounded-lg border-2 px-4 py-4 text-left transition-all ${
                  role === 'survivor'
                    ? 'border-[#6bb4ff] bg-[#6bb4ff]/15 shadow-[0_0_14px_rgba(107,180,255,0.5)]'
                    : 'border-[#2a2e36] bg-black/40 hover:border-[#6bb4ff]/60'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-lg font-bold text-[#cfe2ff]">求生者</span>
                  <span className={`text-xs ${role === 'survivor' ? 'text-[#6bb4ff]' : 'text-[#555]'}`}>
                    {role === 'survivor' ? '● 已选择' : '选择'}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-[#aeb6bf]">
                  与 3 名队友协作破译 5 台密码机,通电后拉开电闸门逃出生天。被抓住两次就上椅。
                </p>
              </button>

              <button
                onClick={() => actions.onSelectRole('hunter')}
                className={`w-56 rounded-lg border-2 px-4 py-4 text-left transition-all ${
                  role === 'hunter'
                    ? 'border-[#ff5a5c] bg-[#ff5a5c]/15 shadow-[0_0_14px_rgba(255,90,92,0.5)]'
                    : 'border-[#2a2e36] bg-black/40 hover:border-[#ff5a5c]/60'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-lg font-bold text-[#ffb3b4]">杀手</span>
                  <span className={`text-xs ${role === 'hunter' ? 'text-[#ff5a5c]' : 'text-[#555]'}`}>
                    {role === 'hunter' ? '● 已选择' : '选择'}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-[#aeb6bf]">
                  独自狩猎 4 名求生者。挥刀击倒、瞬移追击、扛人上椅。淘汰 3 人即狩猎完成。
                </p>
              </button>
            </div>

            <p className="mt-6 max-w-md text-center text-sm leading-6 text-[#e2e5ea] drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]">
              {role === 'hunter'
                ? '浓雾笼罩的哥特庄园里,你是游荡的猎人。用你的速度、力量与瞬移,将落单的求生者一个个送上狂欢之椅。'
                : '浓雾笼罩的哥特庄园里,猎人正在巡逻。与 3 名队友协作破译 5 台密码机,通电后拉开电闸门逃出生天。'}
            </p>

            <button
              onClick={actions.onStart}
              className={`mt-7 rounded border px-10 py-3 text-lg tracking-widest shadow-[0_2px_14px_rgba(0,0,0,0.6)] backdrop-blur-sm transition-colors ${
                role === 'hunter'
                  ? 'border-[#ff5a5c] bg-[#ff5a5c]/25 text-[#ffffff] hover:bg-[#ff5a5c]/50'
                  : 'border-[#d41d1f] bg-[#d41d1f]/25 text-[#ffffff] hover:bg-[#d41d1f]/50'
              }`}
            >
              {role === 'hunter' ? '以 杀 手 身 份 开 始' : '开 始 游 戏'}
            </button>

            {/* 操作键位(随角色联动) */}
            <div className="mt-9 grid grid-cols-2 gap-x-10 gap-y-2 text-sm text-[#d5d9df] drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]">
              {role === 'hunter' ? (
                <>
                  <span><kbd className="text-white">W A S D</kbd> 移动</span>
                  <span><kbd className="text-white">鼠标</kbd> 视角(点击锁定)</span>
                  <span><kbd className="text-white">左键</kbd> 挥刀攻击</span>
                  <span><kbd className="text-white">E</kbd> 扛起倒地者 / 破坏木板(扛人时=放下放血)</span>
                  <span><kbd className="text-white">Space</kbd> 翻越窗户</span>
                  <span><kbd className="text-white">Q</kbd> 瞬移 &nbsp; <kbd className="text-white">Esc</kbd> 暂停 &nbsp; <kbd className="text-white">M</kbd> 静音</span>
                </>
              ) : (
                <>
                  <span><kbd className="text-white">W A S D</kbd> 移动</span>
                  <span><kbd className="text-white">鼠标</kbd> 视角(点击锁定)</span>
                  <span><kbd className="text-white">Shift</kbd> 奔跑(消耗体力)</span>
                  <span><kbd className="text-white">E</kbd> 破译 / 救援 / 治疗 / 开闸</span>
                  <span><kbd className="text-white">Space</kbd> 翻窗 / 放板 / 技能检定</span>
                  <span><kbd className="text-white">Q</kbd> 冲刺 &nbsp; <kbd className="text-white">Esc</kbd> 暂停 &nbsp; <kbd className="text-white">M</kbd> 静音</span>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============ 暂停菜单 ============ */}
      {hud.phase === 'paused' && (
        <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center bg-black/70">
          <h2 className="text-4xl font-bold tracking-widest">已暂停</h2>
          <button onClick={actions.onResume} className="mt-8 rounded border border-[#C9C9F2] px-8 py-2.5 tracking-widest text-[#C9C9F2] hover:bg-[#C9C9F2]/15">
            继 续
          </button>
          <button onClick={actions.onRestart} className="mt-3 rounded border border-[#3a3f46] px-8 py-2.5 tracking-widest text-[#9aa3ab] hover:bg-white/5">
            重新开始
          </button>
          <button onClick={actions.onBackToMenu} className="mt-3 rounded border border-[#3a3f46] px-8 py-2.5 tracking-widest text-[#9aa3ab] hover:bg-white/5">
            返回主菜单
          </button>
          <button onClick={actions.onMute} className="mt-3 rounded border border-[#3a3f46] px-8 py-2.5 tracking-widest text-[#9aa3ab] hover:bg-white/5">
            {hud.muted ? '取消静音' : '静 音'}
          </button>
        </div>
      )}

      {/* ============ 结算 ============ */}
      {endPhase && (
        <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center bg-[#0b0d10]/95">
          {(() => {
            // 文案 + 配色按角色与结果分支
            let title = ''
            let color = '#E4E8E9'
            if (isHunter) {
              if (endPhase === 'won') { title = '狩 猎 完 成'; color = '#ff5a5c' }
              else if (endPhase === 'draw') { title = '势 均 力 敌'; color = '#ffcf6b' }
              else { title = '猎 物 逃 脱'; color = '#9aa3ab' }
            } else {
              if (endPhase === 'won') { title = '逃 脱 成 功'; color = '#7fb069' }
              else { title = '游 戏 结 束'; color = '#d41d1f' }
            }
            return <h2 className="text-5xl font-bold tracking-widest" style={{ color }}>{title}</h2>
          })()}

          <p className="mt-4 text-[#9aa3ab]">{hud.endReason}</p>

          {isHunter ? (
            <div className="mt-8 grid grid-cols-3 gap-6 text-center">
              <div>
                <div className="text-3xl font-bold tabular-nums text-[#ff5a5c]">{hud.kills}</div>
                <div className="mt-1 text-xs text-[#9aa3ab]">淘汰求生者</div>
              </div>
              <div>
                <div className="text-3xl font-bold tabular-nums text-[#ffcf6b]">{hud.stats.downs}</div>
                <div className="mt-1 text-xs text-[#9aa3ab]">击倒次数</div>
              </div>
              <div>
                <div className="text-3xl font-bold tabular-nums text-[#9aa3ab]">{hud.escapedTeammates}</div>
                <div className="mt-1 text-xs text-[#9aa3ab]">逃脱人数</div>
              </div>
            </div>
          ) : (
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
          )}

          <div className="mt-10 flex gap-3">
            <button
              onClick={actions.onRestart}
              className="rounded border px-8 py-3 tracking-widest hover:bg-white/10"
              style={{ borderColor: isHunter ? '#ff5a5c' : '#d41d1f', color: '#fff', background: isHunter ? 'rgba(255,90,92,0.15)' : 'rgba(212,29,31,0.15)' }}
            >
              再 来 一 局
            </button>
            <button
              onClick={actions.onBackToMenu}
              className="rounded border border-[#3a3f46] px-8 py-3 tracking-widest text-[#9aa3ab] hover:bg-white/5"
            >
              返回主菜单
            </button>
          </div>
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
