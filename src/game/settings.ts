// 用户设置 + localStorage 持久化
// 难度档位影响监管者 AI 强度(参数注入见 engine.ts buildScene)

export type Difficulty = 'easy' | 'normal' | 'hard'

export interface Settings {
  mouseSens: number // 鼠标灵敏度倍率,0.5~3.0,默认 1.0
  volume: number // 主音量,0~1,默认 0.8
  difficulty: Difficulty // 难度,默认 normal
}

const STORAGE_KEY = 'nighthunt-settings'

export const DEFAULT_SETTINGS: Settings = {
  mouseSens: 1.0,
  volume: 0.8,
  difficulty: 'normal',
}

// 读取设置:localStorage 异常或格式错误时回退默认值
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      mouseSens: clampNum(parsed.mouseSens, 0.5, 3.0, DEFAULT_SETTINGS.mouseSens),
      volume: clampNum(parsed.volume, 0, 1, DEFAULT_SETTINGS.volume),
      difficulty:
        parsed.difficulty === 'easy' || parsed.difficulty === 'hard' || parsed.difficulty === 'normal'
          ? parsed.difficulty
          : DEFAULT_SETTINGS.difficulty,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // 忽略写入失败(隐私模式 / 配额满)
  }
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return v < lo ? lo : v > hi ? hi : v
}
