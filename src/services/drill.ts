import type {
  AppState,
  DrillRunRecord,
  FaultScenario,
  BypassBatch,
} from '@/types/domain'
import {
  appendAuditIdempotent,
  applyEndBypass,
  decideApprove,
} from '@/services/bypass'

export type DrillOrder = 'approve-first' | 'end-first'

export interface DrillOptions {
  order: DrillOrder
  batchId: string
  scenarioId: string
  /** 两个窗口读取到的同一冻结修订号，模拟并发提交时的乐观锁基线 */
  expectedRevision: number
  receiptId: string
  nowIso: string
  idFactory: () => string
}

export interface DrillOutcome {
  record: DrillRunRecord
  /** 实际生效的业务动作描述，供保存失败恢复使用 */
  summary: string
}

function findContext(state: AppState, options: DrillOptions) {
  const batch = state.bypassBatches.find((item) => item.id === options.batchId)
  const scenario = state.scenarios.find((item) => item.id === options.scenarioId)
  return { batch, scenario }
}

function runApprove(
  state: AppState,
  batch: BypassBatch,
  scenario: FaultScenario,
  options: DrillOptions,
  auditPayloads: DrillRunRecord['auditPayloads'],
  applied: DrillRunRecord['appliedActions'],
): boolean {
  const decision = decideApprove(state, scenario, options.expectedRevision)
  if (decision.accepted) {
    scenario.status = 'approved'
    scenario.approvedAtRevision = batch.basisRevision
    scenario.basisRevision = batch.basisRevision
    scenario.reReview = undefined
    const detail = `两窗口并发演练：场景按冻结依据 R${batch.basisRevision} 批准（先到动作）。`
    auditPayloads.push({ action: '场景批准（代路演练）', target: scenario.name, detail })
    appendAuditIdempotent(
      state,
      {
        action: '场景批准（代路演练）',
        target: scenario.name,
        operator: '当前用户',
        detail,
        createdAt: options.nowIso,
        receiptId: options.receiptId,
      },
      options.idFactory,
    )
    applied.push({ kind: 'scenario-approve', accepted: true, detail })
    return true
  }
  scenario.status = decision.status
  const detail = `两窗口并发演练：场景批准被拒绝——${decision.reason}（后到动作不覆盖先到结果）。`
  auditPayloads.push({ action: '场景批准被拒（代路演练）', target: scenario.name, detail })
  appendAuditIdempotent(
    state,
    {
      action: '场景批准被拒（代路演练）',
      target: scenario.name,
      operator: '当前用户',
      detail,
      createdAt: options.nowIso,
      receiptId: options.receiptId,
    },
    options.idFactory,
  )
  applied.push({ kind: 'scenario-approve', accepted: false, detail })
  return false
}

function runEnd(
  state: AppState,
  batch: BypassBatch,
  scenario: FaultScenario,
  options: DrillOptions,
  auditPayloads: DrillRunRecord['auditPayloads'],
  applied: DrillRunRecord['appliedActions'],
): void {
  const result = applyEndBypass(state, batch, options.nowIso)
  const detail = `两窗口并发演练：代路结束，冻结依据修订为 R${batch.basisRevision}；未会签场景失效 ${result.invalidatedScenarioIds.length} 个，已批准场景保留结论 ${result.retainedScenarioIds.length} 个。`
  auditPayloads.push({ action: '旁路代路结束（代路演练）', target: batch.code, detail })
  appendAuditIdempotent(
    state,
    {
      action: '旁路代路结束（代路演练）',
      target: batch.code,
      operator: '当前用户',
      detail,
      createdAt: options.nowIso,
      receiptId: options.receiptId,
    },
    options.idFactory,
  )
  applied.push({ kind: 'bypass-end', accepted: true, detail })
  // 若场景批准后到：代路结束先到，批准动作按新冻结修订判断为失效
  if (scenario.status !== 'approved' && scenario.status !== 'invalidated') {
    scenario.status = 'invalidated'
  }
}

/**
 * 在给定状态上执行完整演练批次（纯内存变更）：
 * 两个窗口同时提交「代路结束」和「场景批准」，
 * 后到动作按冻结修订判断，不能覆盖先到结果。
 */
export function executeBypassDrill(
  state: AppState,
  options: DrillOptions,
): DrillOutcome {
  const context = findContext(state, options)
  if (!context.batch || !context.scenario) {
    throw new Error('演练批次或场景不存在，无法执行完整演练。')
  }
  if (context.batch.status !== 'active') {
    throw new Error('当前没有投运中的代路批次，无法演练并发提交。')
  }

  const auditCountBefore = state.audit.length
  const auditPayloads: DrillRunRecord['auditPayloads'] = []
  const applied: DrillRunRecord['appliedActions'] = []
  const batch = context.batch
  const scenario = context.scenario

  if (options.order === 'approve-first') {
    runApprove(state, batch, scenario, options, auditPayloads, applied)
    runEnd(state, batch, scenario, options, auditPayloads, applied)
  } else {
    runEnd(state, batch, scenario, options, auditPayloads, applied)
    runApprove(state, batch, scenario, options, auditPayloads, applied)
  }

  const auditCountAfter = state.audit.length
  const approved = applied.find((item) => item.kind === 'scenario-approve')
  const summary =
    options.order === 'approve-first'
      ? `批准先到（R${options.expectedRevision}）：场景已批准${
          approved?.accepted ? '' : '被拒'
        }；代路结束后到，未会签场景失效，已批准场景保留结论并登记复议。`
      : `代路结束先到：冻结修订升至 R${options.expectedRevision + 1}；批准后到按新修订判断为失效，先到结果未被覆盖。`

  const record: DrillRunRecord = {
    receiptId: options.receiptId,
    batchId: options.batchId,
    order: options.order,
    failOnPersist: false,
    finished: true,
    outcome: summary,
    appliedActions: applied,
    auditPayloads,
    auditCountBefore,
    auditCountAfter,
    at: options.nowIso,
  }
  return { record, summary }
}

/** 回执重放：相同 receiptId + target 的审计记录不会重复产生 */
export function replayDrillAudit(
  state: AppState,
  record: DrillRunRecord,
  idFactory: () => string,
): { replayed: number; duplicated: number } {
  let replayed = 0
  let duplicated = 0
  record.auditPayloads.forEach((payload) => {
    const exists = state.audit.some(
      (item) => item.receiptId === record.receiptId && item.target === payload.target,
    )
    if (exists) {
      duplicated += 1
      return
    }
    appendAuditIdempotent(
      state,
      {
        action: payload.action,
        target: payload.target,
        operator: '当前用户（回执重放）',
        detail: payload.detail,
        createdAt: record.at,
        receiptId: record.receiptId,
      },
      idFactory,
    )
    replayed += 1
  })
  return { replayed, duplicated }
}
