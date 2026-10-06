import type {
  AppState,
  AuditEntry,
  BasisRevisionEvent,
  BasisRevisionReason,
  BypassBatch,
  BypassFreezeBasis,
  FaultScenario,
  ProtectionSetting,
  ReReviewItem,
  ReviewStatus,
} from '@/types/domain'

/** 冻结快照范围内的保护装置：被代线路保护 + 旁路保护 */
export function basisRelayIds(basis: BypassFreezeBasis): string[] {
  const relayIds = new Set(basis.settingsSnapshot.map((setting) => setting.relayId))
  relayIds.add(basis.bypassRelayId)
  return [...relayIds]
}

export function basisChecksum(settings: ProtectionSetting[]): string {
  const source = settings
    .map(
      (item) =>
        `${item.id}:${item.currentA}:${item.timeS}:${item.direction}:${item.sensitivity}:${item.recloseEnabled}:${item.recloseDelayS}`,
    )
    .join('|')
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    value = (value * 31 + source.charCodeAt(index)) >>> 0
  }
  return (
    value.toString(16).toUpperCase().padStart(8, '0').match(/.{4}/g)?.join('-') ?? '0000-0000'
  )
}

export function getActiveBatch(state: AppState): BypassBatch | undefined {
  return state.bypassBatches.find((batch) => batch.status === 'active')
}

export function getBatchBasis(state: AppState, batch: BypassBatch): BypassFreezeBasis | undefined {
  return state.bypassBases.find((basis) => basis.id === batch.basisId)
}

export function getScenarioBasis(
  state: AppState,
  scenario: FaultScenario,
): BypassFreezeBasis | undefined {
  return state.bypassBases.find((basis) => basis.id === scenario.freezeBasisId)
}

/** 动作序列只能引用这条冻结依据：装置必须在冻结范围内、依据 ID 必须一致 */
export function validateStepAgainstBasis(
  basis: BypassFreezeBasis,
  step: { relayId: string; basisId?: string },
): string | null {
  if (step.basisId !== basis.id) {
    return '动作序列未引用本批次冻结依据，请按当前冻结依据重算。'
  }
  if (!basisRelayIds(basis).includes(step.relayId)) {
    return '动作装置不在冻结的被代线路保护与旁路保护范围内。'
  }
  return null
}

export function scenarioMatchesBasis(state: AppState, scenario: FaultScenario): boolean {
  const batch = state.bypassBatches.find(
    (item) => item.basisId === scenario.freezeBasisId && item.status === 'active',
  )
  const basis = getScenarioBasis(state, scenario)
  if (!batch || !basis) return false
  if (batch.status !== 'active') return false
  if (scenario.operationMode !== basis.operationMode) return false
  if (scenario.basisRevision !== batch.basisRevision) return false
  return scenario.steps.every((step) => validateStepAgainstBasis(basis, step) === null)
}

/** 收集一次依据变化影响到的动作步骤与停电范围 */
function collectImpact(
  scenario: FaultScenario,
  impactedSettingIds: Set<string> | undefined,
): { sequences: number[]; outage: string[] } {
  const basis = scenario.freezeBasisId
  const sequences: number[] = []
  scenario.steps.forEach((step) => {
    if (step.basisId !== basis) {
      sequences.push(step.sequence)
      return
    }
    if (impactedSettingIds) {
      // 快照中与改版定值同源的步骤需要复议；动作文案含段位的标记为受影响
      const hit = [...impactedSettingIds].some((settingId) => {
        const stage = settingId.split('-').pop()
        return step.action.includes(`${stage} 段`)
      })
      if (hit) sequences.push(step.sequence)
    }
  })
  const outage = impactedSettingIds
    ? scenario.outageDevices
    : [...scenario.outageDevices]
  return { sequences: [...new Set(sequences)].sort((a, b) => a - b), outage }
}

export interface InvalidationResult {
  /** 失效并重置为待重算的场景 ID */
  invalidatedScenarioIds: string[]
  /** 保留原结论、仅登记复议项的场景 ID */
  retainedScenarioIds: string[]
}

/**
 * 冻结依据发生修订时：
 * - 未会签场景（草稿/会签中/退回/已失效）立即失效重算
 * - 已批准/已锁定场景保留原结论，列出必须复议的步骤和停电范围
 */
export function applyBasisRevision(
  state: AppState,
  batch: BypassBatch,
  reason: BasisRevisionReason,
  detail: string,
  impactedSettingIds?: Set<string>,
  nowIso: string = new Date().toISOString(),
): InvalidationResult {
  const event: BasisRevisionEvent = {
    reason,
    fromRevision: batch.basisRevision,
    toRevision: batch.basisRevision + 1,
    at: nowIso,
    detail,
  }
  batch.basisRevision += 1
  batch.revisionEvents.push(event)

  const result: InvalidationResult = { invalidatedScenarioIds: [], retainedScenarioIds: [] }
  state.scenarios.forEach((scenario) => {
    if (scenario.freezeBasisId !== batch.basisId) return
    const approved = scenario.status === 'approved' || scenario.status === 'locked'
    const impact = collectImpact(
      scenario,
      reason === 'setting-change' ? impactedSettingIds : undefined,
    )
    if (approved) {
      const item: ReReviewItem = {
        stepSequences: impact.sequences,
        outageDeviceIds: impact.outage,
        reason:
          reason === 'batch-end'
            ? '代路结束，被代线路保护恢复运行，需核对转回本线定值后的动作序列。'
            : reason === 'setting-change'
              ? '旁路或被代线路定值改版，冻结快照与现定值不一致。'
              : '运行方式已切换，冻结依据仅适用于原运行方式。',
        triggerRevision: event.toRevision,
        at: nowIso,
      }
      scenario.reReview = item
      result.retainedScenarioIds.push(scenario.id)
    } else {
      scenario.status = 'invalidated'
      scenario.basisRevision = event.toRevision
      result.invalidatedScenarioIds.push(scenario.id)
    }
  })
  return result
}

export function nextBatchCode(state: AppState): string {
  const number = state.bypassBatches.length + 1
  return `BP-2026-${String(number).padStart(3, '0')}`
}

/** 投运时冻结被代线路、旁路保护、定值基线和适用运行方式 */
export function buildFrozenBasis(params: {
  lineId: string
  bypassRelayId: string
  bypassBreakerId?: string
  baselineId?: string
  operationMode: string
  settings: ProtectionSetting[]
  note: string
  createdBy: string
  nowIso: string
}): BypassFreezeBasis {
  const inScope = params.settings.filter(
    (setting) =>
      setting.protectedDeviceId === params.lineId || setting.relayId === params.bypassRelayId,
  )
  const snapshot = JSON.parse(JSON.stringify(inScope)) as ProtectionSetting[]
  return {
    id: `basis-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    revision: 1,
    lineId: params.lineId,
    bypassRelayId: params.bypassRelayId,
    bypassBreakerId: params.bypassBreakerId,
    baselineId: params.baselineId,
    operationMode: params.operationMode,
    settingsSnapshot: snapshot,
    checksum: basisChecksum(snapshot),
    frozenAt: params.nowIso,
    createdBy: params.createdBy,
    note: params.note,
  }
}

/** 投运后，被代线路上未会签的场景自动绑定新依据并标记待重算 */
export function bindScenariosOnStart(
  state: AppState,
  basis: BypassFreezeBasis,
): string[] {
  const bound: string[] = []
  state.scenarios.forEach((scenario) => {
    const involvesLine =
      scenario.faultDeviceId === basis.lineId ||
      scenario.outageDevices.includes(basis.lineId)
    if (!involvesLine) return
    const wasApproved = scenario.status === 'approved' || scenario.status === 'locked'
    scenario.freezeBasisId = basis.id
    scenario.basisRevision = basis.revision
    // 旧动作序列不可能引用新冻结依据，未会签场景立即失效重算
    if (!wasApproved) scenario.status = 'invalidated'
    bound.push(scenario.id)
  })
  return bound
}

/** 代路结束：批次关闭、依据修订，未会签场景失效，已批准场景保留结论并登记复议 */
export function applyEndBypass(
  state: AppState,
  batch: BypassBatch,
  nowIso: string = new Date().toISOString(),
): InvalidationResult {
  const result = applyBasisRevision(
    state,
    batch,
    'batch-end',
    '旁路代路结束，被代线路保护恢复运行。',
    undefined,
    nowIso,
  )
  batch.status = 'ended'
  batch.endedAt = nowIso
  return result
}

export interface ApprovalDecision {
  accepted: boolean
  status: ReviewStatus
  reason: string
}

/**
 * 场景批准的乐观并发判断。
 * expectedRevision 为提交窗口读取到的冻结修订号；
 * 与当前冻结修订不一致时（另一个窗口已先完成代路结束/改版/切方式），
 * 后到动作按冻结修订判断，不能覆盖先到结果。
 */
export function decideApprove(
  state: AppState,
  scenario: FaultScenario,
  expectedRevision?: number,
): ApprovalDecision {
  const batch = state.bypassBatches.find(
    (item) => item.basisId === scenario.freezeBasisId,
  )
  if (!scenario.freezeBasisId || !batch) {
    return { accepted: false, status: scenario.status, reason: '场景未绑定旁路代路冻结依据。' }
  }
  if (batch.status === 'ended') {
    return {
      accepted: false,
      status: 'invalidated',
      reason: '代路已结束，冻结依据已修订，场景需按最新依据重算后再会签。',
    }
  }
  if (
    expectedRevision !== undefined &&
    expectedRevision !== batch.basisRevision
  ) {
    return {
      accepted: false,
      status: 'invalidated',
      reason: `冻结修订已由 R${expectedRevision} 变更为 R${batch.basisRevision}，后到批准不能覆盖先到结果，请刷新重算。`,
    }
  }
  const basis = getScenarioBasis(state, scenario)
  if (!basis) {
    return { accepted: false, status: scenario.status, reason: '冻结依据不存在。' }
  }
  if (scenario.operationMode !== basis.operationMode) {
    return {
      accepted: false,
      status: 'invalidated',
      reason: '场景运行方式与冻结依据适用方式不一致，请重算。',
    }
  }
  const invalidStep = scenario.steps
    .map((step) => validateStepAgainstBasis(basis, step))
    .find((message) => message !== null)
  if (invalidStep) {
    return { accepted: false, status: 'invalidated', reason: invalidStep }
  }
  return { accepted: true, status: 'approved', reason: '场景按冻结依据批准，结论保留至依据再次修订。' }
}

/** 幂等写入审计：同一演练回执的同一目标动作只保留一条 */
export function appendAuditIdempotent(
  state: AppState,
  entry: Omit<AuditEntry, 'id' | 'createdAt'> & { createdAt?: string; receiptId?: string },
  idFactory: () => string,
): AuditEntry {
  if (entry.receiptId) {
    const existing = state.audit.find(
      (item) => item.receiptId === entry.receiptId && item.target === entry.target,
    )
    if (existing) return existing
  }
  const created: AuditEntry = {
    id: idFactory(),
    action: entry.action,
    target: entry.target,
    operator: entry.operator,
    detail: entry.detail,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    receiptId: entry.receiptId,
  }
  state.audit.unshift(created)
  return created
}

/** 导出文本中的当前代路依据段落 */
export function describeActiveBasis(state: AppState): string | null {
  const batch = getActiveBatch(state)
  const basis = batch ? getBatchBasis(state, batch) : undefined
  if (!batch || !basis) return null
  const line = state.devices.find((device) => device.id === basis.lineId)?.name ?? basis.lineId
  const relay =
    state.devices.find((device) => device.id === basis.bypassRelayId)?.name ?? basis.bypassRelayId
  const baseline =
    state.baselines.find((item) => item.id === basis.baselineId)?.version ?? '未绑定'
  return [
    '【当前旁路代路依据】',
    `代路批次：${batch.code}（修订 R${batch.basisRevision}）`,
    `被代线路：${line}`,
    `旁路保护：${relay}`,
    `定值基线：${baseline}`,
    `适用运行方式：${basis.operationMode}`,
    `冻结定值：${basis.settingsSnapshot.length} 条，校验码 ${basis.checksum}`,
    `冻结时间：${new Date(basis.frozenAt).toLocaleString('zh-CN')}`,
  ].join('\n')
}
