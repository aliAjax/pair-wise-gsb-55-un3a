import type { AppState } from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { describeActiveBasis } from '@/services/bypass'

const STORAGE_KEY = 'grid-protection-review-v2'

/** 完整演练批次要求保存失败后可恢复：由演练流程一次性注入失败 */
let failNextPersist = false

export function armNextPersistFailure(): void {
  failNextPersist = true
}

export function isPersistFailureArmed(): boolean {
  return failNextPersist
}

export function loadState(): AppState {
  if (typeof window === 'undefined') return createInitialState()
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
  try {
    return normalizeState(JSON.parse(raw) as AppState)
  } catch {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
}

export function saveState(state: AppState): void {
  if (failNextPersist) {
    failNextPersist = false
    throw new Error('本地持久化失败：完整演练批次需要从快照恢复')
  }
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetState(): AppState {
  const initial = createInitialState()
  saveState(initial)
  return initial
}

/** 兼容缺少旁路批次字段的旧状态 */
function normalizeState(state: AppState): AppState {
  return {
    ...state,
    bypassBases: state.bypassBases ?? [],
    bypassBatches: state.bypassBatches ?? [],
    drillRuns: state.drillRuns ?? [],
    currentOperationMode: state.currentOperationMode ?? '正常方式',
    scenarios: (state.scenarios ?? []).map((scenario) => ({
      ...scenario,
      steps: (scenario.steps ?? []).map((step) => ({ ...step })),
      outageDevices: [...(scenario.outageDevices ?? [])],
    })),
  }
}

export function exportSettingsText(state: AppState): string {
  const lines = [
    '电网继电保护定值清单',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
  ]
  const basisText = describeActiveBasis(state)
  if (basisText) lines.push(basisText)
  lines.push(
    '装置编号,保护装置,保护对象,段位,电流定值(A),时限(s),方向,灵敏度,重合闸,重合延迟(s),启动条件',
  )
  state.settings.forEach((setting) => {
    const relay = state.devices.find((device) => device.id === setting.relayId)?.name ?? setting.relayId
    const target =
      state.devices.find((device) => device.id === setting.protectedDeviceId)?.name ??
      setting.protectedDeviceId
    lines.push(
      [
        setting.relayId,
        relay,
        target,
        setting.stage,
        setting.currentA,
        setting.timeS,
        setting.direction,
        setting.sensitivity,
        setting.recloseEnabled ? '投入' : '退出',
        setting.recloseDelayS,
        setting.startCondition,
      ].join(','),
    )
  })
  return lines.join('\n')
}
