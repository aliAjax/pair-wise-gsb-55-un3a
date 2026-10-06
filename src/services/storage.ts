import type { AppState } from '@/types/domain'
import { createInitialState } from '@/data/mock'

const STORAGE_KEY = 'grid-protection-review-v1'

function migrateState(state: AppState): AppState {
  return {
    ...state,
    bypassBatches: state.bypassBatches ?? [],
    settingsRevision: state.settingsRevision ?? 1,
    currentOperationMode: state.currentOperationMode ?? '正常方式',
  }
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
    return migrateState(JSON.parse(raw) as AppState)
  } catch {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
}

export function saveState(state: AppState): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetState(): AppState {
  const initial = createInitialState()
  saveState(initial)
  return initial
}

export function exportSettingsText(state: AppState): string {
  const lines = [
    '电网继电保护定值清单',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
  ]
  const commissioned = (state.bypassBatches ?? []).filter((batch) => batch.status === 'commissioned')
  if (commissioned.length) {
    commissioned.forEach((batch) => {
      const line = state.devices.find((device) => device.id === batch.lineId)?.name ?? batch.lineId
      const relay =
        state.devices.find((device) => device.id === batch.bypassRelayId)?.name ?? batch.bypassRelayId
      const baseline =
        state.baselines.find((item) => item.id === batch.baselineId)?.version ?? batch.baselineId
      lines.push(
        `当前代路依据：${batch.code} | 被代线路：${line} | 旁路保护：${relay} | 定值基线：${baseline} | 适用运行方式：${batch.operationModes.join('、')} | 冻结修订：R${batch.revision}`,
      )
    })
  } else {
    lines.push('当前代路依据：无在役代路批次')
  }
  lines.push('装置编号,保护装置,保护对象,段位,电流定值(A),时限(s),方向,灵敏度,重合闸,重合延迟(s),启动条件')
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
