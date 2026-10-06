import type { AppState, BypassBatch } from '@/types/domain'

/**
 * 冻结修订冲突：两个窗口并发提交时，后到动作按当前冻结修订裁决，
 * 抛出该错误后不得覆盖先到动作已写入的结果。
 */
export class BasisConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BasisConflictError'
  }
}

export function activeBatchForLine(state: AppState, lineId: string): BypassBatch | undefined {
  return state.bypassBatches.find((item) => item.status === 'commissioned' && item.lineId === lineId)
}

/**
 * 代路结束、定值改版或运行方式切换后，对引用冻结依据的场景做失效处理：
 * - 未会签场景（草稿/会签中/已退回）立即失效，动作序列标记为待重算；
 * - 已批准/已锁定场景保留原结论，登记必须复议的步骤和停电范围。
 */
export function invalidateScenariosForBatches(
  state: AppState,
  batchIds: string[],
  reason: string,
): { invalidated: number; reReview: number } {
  let invalidated = 0
  let reReview = 0
  const createdAt = new Date().toISOString()
  state.scenarios.forEach((scenario) => {
    if (!scenario.basisBatchId || !batchIds.includes(scenario.basisBatchId)) return
    if (scenario.status === 'approved' || scenario.status === 'locked') {
      scenario.reReview = {
        reason,
        stepSequences: scenario.steps.map((step) => step.sequence),
        outageDevices: [...scenario.outageDevices],
        createdAt,
      }
      reReview += 1
      return
    }
    if (scenario.status === 'invalidated') return
    scenario.status = 'invalidated'
    scenario.invalidatedReason = reason
    scenario.steps = scenario.steps.map((step) => ({ ...step, status: 'pending' as const }))
    invalidated += 1
  })
  return { invalidated, reReview }
}
