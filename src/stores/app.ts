import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  BypassBatch,
  Device,
  DrillRunRecord,
  ProtectionSetting,
  ReviewComment,
  ReviewStatus,
  ScenarioStep,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { validateSettings } from '@/services/validation'
import { persistState } from '@/api/client'
import { armNextPersistFailure, saveState } from '@/services/storage'
import {
  applyBasisRevision,
  applyEndBypass,
  bindScenariosOnStart,
  buildFrozenBasis,
  decideApprove,
  getActiveBatch,
  getBatchBasis,
  nextBatchCode,
  validateStepAgainstBasis,
} from '@/services/bypass'
import { executeBypassDrill, replayDrillAudit, type DrillOrder } from '@/services/drill'

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const now = () => new Date().toISOString()

function checksum(settings: ProtectionSetting[]): string {
  const source = settings
    .map((item) => `${item.id}:${item.currentA}:${item.timeS}:${item.recloseDelayS}`)
    .join('|')
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    value = (value * 31 + source.charCodeAt(index)) >>> 0
  }
  return value.toString(16).toUpperCase().padStart(8, '0').match(/.{4}/g)?.join('-') ?? '0000-0000'
}

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => baseline.id === data.value.activeBaselineId),
  )
  const activeBatch = computed(() => getActiveBatch(data.value))
  const activeBasis = computed(() =>
    activeBatch.value ? getBatchBasis(data.value, activeBatch.value) : undefined,
  )
  const currentOperationMode = computed(() => data.value.currentOperationMode)

  function hydrate(state: AppState) {
    data.value = state
    hydrated.value = true
  }

  async function commit(message: string) {
    saving.value = true
    try {
      const saved = await persistState(JSON.parse(JSON.stringify(data.value)) as AppState)
      data.value = saved
      lastMessage.value = message
    } finally {
      saving.value = false
    }
  }

  function appendAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'>) {
    data.value.audit.unshift({
      ...entry,
      id: createId('audit'),
      createdAt: now(),
    })
  }

  /** 保存失败后从传入的完整快照恢复内存状态 */
  function restoreSnapshot(snapshot: AppState) {
    data.value = snapshot
  }

  async function addDevice(device: Omit<Device, 'id'>) {
    const item = { ...device, id: createId('device') }
    data.value.devices.push(item)
    appendAudit({
      action: '新增设备',
      target: item.name,
      operator: '当前用户',
      detail: `设备类型：${item.kind}，电压等级：${item.voltage}kV。`,
    })
    await commit(`已新增 ${item.name}`)
    return item
  }

  async function updateDevice(device: Device) {
    const index = data.value.devices.findIndex((item) => item.id === device.id)
    if (index < 0) return
    data.value.devices[index] = { ...device, operationModes: [...device.operationModes] }
    appendAudit({
      action: '更新设备',
      target: device.name,
      operator: '当前用户',
      detail: `运行状态调整为 ${device.status}。`,
    })
    await commit(`已更新 ${device.name}`)
  }

  async function saveSetting(setting: ProtectionSetting) {
    const index = data.value.settings.findIndex((item) => item.id === setting.id)
    const next = { ...setting, updatedAt: now() }
    if (index >= 0) data.value.settings[index] = next
    else data.value.settings.push(next)

    // 定值改版命中投运中批次的冻结范围时，冻结依据修订并驱动场景失效/复议
    const batch = getActiveBatch(data.value)
    const basis = batch ? getBatchBasis(data.value, batch) : undefined
    let revisionNote = ''
    if (batch && basis) {
      const inScope = basis.settingsSnapshot.some((item) => item.id === setting.id)
      if (inScope) {
        const result = applyBasisRevision(
          data.value,
          batch,
          'setting-change',
          `定值改版：${setting.relayId} ${setting.stage} 段，电流 ${setting.currentA}A，时限 ${setting.timeS}s。`,
          new Set([setting.id]),
        )
        revisionNote = `；冻结依据修订至 R${batch.basisRevision}，未会签场景失效 ${result.invalidatedScenarioIds.length} 个，已批准场景 ${result.retainedScenarioIds.length} 个保留结论待复议`
      }
    }

    appendAudit({
      action: index >= 0 ? '修改定值' : '新增定值',
      target: `${setting.relayId} ${setting.stage} 段`,
      operator: '当前用户',
      detail: `电流 ${setting.currentA}A，时限 ${setting.timeS}s。${revisionNote}`,
    })
    await commit('定值已保存')
  }

  async function runValidation() {
    data.value.issues = validateSettings(data.value.settings, data.value.devices)
    appendAudit({
      action: '批量校验',
      target: '全部保护定值',
      operator: '当前用户',
      detail: `生成 ${data.value.issues.length} 条待处理问题。`,
    })
    await commit('批量校验完成')
    return data.value.issues
  }

  async function updateIssue(issue: ValidationIssue) {
    const index = data.value.issues.findIndex((item) => item.id === issue.id)
    if (index >= 0) data.value.issues[index] = issue
    appendAudit({
      action: '更新问题状态',
      target: issue.pairLabel,
      operator: '当前用户',
      detail: `状态更新为 ${issue.status}。`,
    })
    await commit('问题状态已更新')
  }

  async function addComment(comment: Omit<ReviewComment, 'id' | 'createdAt'>) {
    data.value.comments.unshift({
      ...comment,
      id: createId('comment'),
      createdAt: now(),
    })
    appendAudit({
      action: '提交会签意见',
      target: comment.targetId,
      operator: comment.author,
      detail: comment.content,
    })
    await commit('意见已提交')
  }

  /** 通用状态流转：旁路批次场景的批准必须走 approveScenario 以执行冻结修订判断 */
  async function updateScenarioStatus(id: string, status: ReviewStatus) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario) return
    scenario.status = status
    appendAudit({
      action: '场景状态流转',
      target: scenario.name,
      operator: '当前用户',
      detail: `状态更新为 ${status}。`,
    })
    await commit('场景状态已更新')
  }

  async function addScenario(
    scenario: Omit<AppState['scenarios'][number], 'id' | 'createdAt' | 'steps' | 'status'>,
  ) {
    const item: AppState['scenarios'][number] = {
      ...scenario,
      id: createId('scenario'),
      status: 'draft',
      steps: [],
      createdAt: now(),
    }
    data.value.scenarios.unshift(item)
    // 投运中的代路批次：新建的被代线路场景必须绑定当前冻结依据
    const batch = getActiveBatch(data.value)
    const basis = batch ? getBatchBasis(data.value, batch) : undefined
    let basisNote = ''
    if (batch && basis && item.operationMode === basis.operationMode) {
      const involvesLine =
        item.faultDeviceId === basis.lineId || item.outageDevices.includes(basis.lineId)
      if (involvesLine) {
        item.freezeBasisId = basis.id
        item.basisRevision = batch.basisRevision
        item.status = 'invalidated'
        basisNote = `，已绑定 ${batch.code} 冻结依据 R${batch.basisRevision}，补全引用该依据的动作序列后方可重算会签`
      }
    }
    appendAudit({
      action: '新增故障场景',
      target: item.name,
      operator: '当前用户',
      detail: `运行方式：${item.operationMode}，故障类型：${item.faultType}${basisNote}。`,
    })
    await commit('故障场景已创建')
    return item
  }

  /** 投运时冻结被代线路、旁路保护、定值基线和适用运行方式 */
  async function startBypassBatch(params: {
    lineId: string
    bypassRelayId: string
    bypassBreakerId?: string
    operationMode: string
    note: string
  }) {
    if (getActiveBatch(data.value)) {
      throw new Error('已有投运中的旁路代路批次，不能重复投运。')
    }
    const frozenAt = now()
    const basis = buildFrozenBasis({
      ...params,
      baselineId: data.value.activeBaselineId,
      settings: data.value.settings,
      createdBy: '当前用户',
      nowIso: frozenAt,
    })
    const batch: BypassBatch = {
      id: createId('batch'),
      code: nextBatchCode(data.value),
      status: 'active',
      basisId: basis.id,
      basisRevision: 1,
      startedAt: frozenAt,
      operator: '当前用户',
      revisionEvents: [],
    }
    data.value.bypassBases.push(basis)
    data.value.bypassBatches.push(batch)
    data.value.currentOperationMode = params.operationMode
    const bound = bindScenariosOnStart(data.value, basis)
    const lineName =
      data.value.devices.find((device) => device.id === params.lineId)?.name ?? params.lineId
    appendAudit({
      action: '旁路代路投运冻结',
      target: `${batch.code} ${lineName}`,
      operator: '当前用户',
      detail:
        `冻结被代线路与旁路保护定值 ${basis.settingsSnapshot.length} 条、定值基线 ` +
        `${data.value.activeBaselineId ?? '无'}、适用运行方式 ${params.operationMode}，` +
        `校验码 ${basis.checksum}；绑定场景 ${bound.length} 个，动作序列只能引用该冻结依据。`,
    })
    await commit('旁路代路批次已投运并冻结依据')
    return batch
  }

  /** 代路结束：冻结依据修订，未会签场景失效重算，已批准场景保留原结论并列出复议步骤 */
  async function endBypassBatch() {
    const batch = getActiveBatch(data.value)
    if (!batch) throw new Error('当前没有投运中的旁路代路批次。')
    const result = applyEndBypass(data.value, batch)
    appendAudit({
      action: '旁路代路结束',
      target: batch.code,
      operator: '当前用户',
      detail:
        `冻结依据修订为 R${batch.basisRevision} 并关闭批次；未会签场景失效 ` +
        `${result.invalidatedScenarioIds.length} 个，已批准场景保留原结论 ${result.retainedScenarioIds.length} 个，` +
        `复议步骤与停电范围已在场景详情列出。`,
    })
    await commit('旁路代路已结束，场景结论已按冻结修订处理')
    return result
  }

  /** 场景批准：后到动作按冻结修订判断，不能覆盖先到结果 */
  async function approveScenario(id: string, expectedRevision?: number) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario) throw new Error('场景不存在。')
    const decision = decideApprove(data.value, scenario, expectedRevision)
    if (decision.accepted) {
      const batch = getActiveBatch(data.value)
      scenario.status = 'approved'
      scenario.approvedAtRevision = batch?.basisRevision
      scenario.basisRevision = batch?.basisRevision
      scenario.reReview = undefined
      appendAudit({
        action: '场景批准',
        target: scenario.name,
        operator: '当前用户',
        detail: `按冻结依据 R${batch?.basisRevision} 批准，动作序列与停电范围结论保留。`,
      })
      await commit('场景已按冻结依据批准')
      return decision
    }
    scenario.status = decision.status
    appendAudit({
      action: '场景批准被拒',
      target: scenario.name,
      operator: '当前用户',
      detail: decision.reason,
    })
    await commit('场景批准被拒绝，已标记为需重算')
    return decision
  }

  /** 动作序列只能引用当前批次的冻结依据 */
  async function addScenarioStep(
    scenarioId: string,
    step: Omit<ScenarioStep, 'sequence' | 'status' | 'basisId'>,
  ) {
    const scenario = data.value.scenarios.find((item) => item.id === scenarioId)
    if (!scenario) throw new Error('场景不存在。')
    const batch = getActiveBatch(data.value)
    const basis = batch ? getBatchBasis(data.value, batch) : undefined
    if (!scenario.freezeBasisId || !batch || !basis || scenario.freezeBasisId !== basis.id) {
      throw new Error('场景未绑定投运中的旁路冻结依据，不能补充动作序列。')
    }
    const candidate: ScenarioStep = {
      ...step,
      sequence: scenario.steps.length + 1,
      status: 'pending',
      basisId: basis.id,
    }
    const invalid = validateStepAgainstBasis(basis, candidate)
    if (invalid) throw new Error(invalid)
    scenario.steps.push(candidate)
    appendAudit({
      action: '补充场景动作序列',
      target: scenario.name,
      operator: '当前用户',
      detail: `步骤 ${candidate.sequence} 引用冻结依据 R${batch.basisRevision}（${basis.checksum}）。`,
    })
    await commit('动作步骤已按冻结依据补充')
    return candidate
  }

  /** 失效场景按当前冻结依据重算并重新进入会签 */
  async function recomputeScenario(id: string) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario) throw new Error('场景不存在。')
    const batch = getActiveBatch(data.value)
    const basis = batch ? getBatchBasis(data.value, batch) : undefined
    if (!batch || !basis || scenario.freezeBasisId !== basis.id) {
      throw new Error('当前批次已结束或场景未绑定冻结依据，不能在该批次内重算。')
    }
    if (scenario.operationMode !== basis.operationMode) {
      throw new Error('场景运行方式与冻结依据适用方式不一致，请切换运行方式后处理。')
    }
    const rejected: number[] = []
    scenario.steps.forEach((step) => {
      const message = validateStepAgainstBasis(basis, {
        relayId: step.relayId,
        basisId: basis.id,
      })
      if (message) {
        rejected.push(step.sequence)
        step.status = 'skipped'
      }
      step.basisId = basis.id
    })
    scenario.basisRevision = batch.basisRevision
    scenario.status = 'reviewing'
    scenario.reReview = undefined
    appendAudit({
      action: '场景失效重算',
      target: scenario.name,
      operator: '当前用户',
      detail:
        `按冻结依据 R${batch.basisRevision} 重算并重新提交会签；` +
        (rejected.length
          ? `步骤 ${rejected.join('、')} 不在冻结保护范围内已置为跳过。`
          : '全部步骤引用当前冻结依据。'),
    })
    await commit('场景已按当前冻结依据重算')
  }

  /** 运行方式切换：偏离冻结方式立即修订依据 */
  async function switchOperationMode(mode: string) {
    if (mode === data.value.currentOperationMode) return
    const previous = data.value.currentOperationMode
    data.value.currentOperationMode = mode
    const batch = getActiveBatch(data.value)
    let note = `运行方式由 ${previous} 切换为 ${mode}。`
    if (batch) {
      const basis = getBatchBasis(data.value, batch)
      if (basis && mode !== basis.operationMode) {
        const result = applyBasisRevision(
          data.value,
          batch,
          'mode-switch',
          `运行方式由 ${previous} 切换为 ${mode}，冻结依据仅适用于 ${basis.operationMode}。`,
        )
        note += ` 冻结依据修订至 R${batch.basisRevision}，未会签场景失效 ${result.invalidatedScenarioIds.length} 个，已批准场景保留结论 ${result.retainedScenarioIds.length} 个。`
      }
    }
    appendAudit({
      action: '切换运行方式',
      target: mode,
      operator: '当前用户',
      detail: note,
    })
    await commit('运行方式已切换')
  }

  /** 已批准场景保留原结论，确认复议项后闭环 */
  async function acknowledgeReReview(id: string) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario || !scenario.reReview) return
    const item = scenario.reReview
    scenario.reReview = undefined
    appendAudit({
      action: '确认场景复议项',
      target: scenario.name,
      operator: '当前用户',
      detail: `已按 R${item.triggerRevision} 核对步骤 ${item.stepSequences.join('、') || '无'} 与停电范围 ${item.outageDeviceIds.length} 台设备，原批准结论维持。`,
    })
    await commit('复议项已确认，原结论保留')
  }

  async function createBaseline(note: string) {
    const nextNumber = data.value.baselines.length + 1
    const baseline: BaselineVersion = {
      id: createId('baseline'),
      version: `V1.${nextNumber - 1}`,
      status: 'reviewing',
      createdAt: now(),
      createdBy: '当前用户',
      note,
      snapshot: JSON.parse(JSON.stringify(data.value.settings)) as ProtectionSetting[],
      checksum: checksum(data.value.settings),
    }
    data.value.baselines.unshift(baseline)
    appendAudit({
      action: '创建基线上会签',
      target: baseline.version,
      operator: '当前用户',
      detail: note,
    })
    await commit('基线已创建并提交会签')
    return baseline
  }

  async function approveBaseline(id: string) {
    const baseline = data.value.baselines.find((item) => item.id === id)
    if (!baseline) return
    if (data.value.issues.some((issue) => issue.level === 'high' && issue.status !== 'closed')) {
      throw new Error('存在未关闭的高风险问题，不能锁定基线')
    }
    baseline.status = 'locked'
    baseline.lockedAt = now()
    data.value.activeBaselineId = baseline.id
    appendAudit({
      action: '锁定基线',
      target: baseline.version,
      operator: '当前用户',
      detail: `校验码 ${baseline.checksum}。`,
    })
    await commit('基线已锁定')
  }

  async function recordExport(format: string, count: number) {
    appendAudit({
      action: '导出定值清单',
      target: `${format} 文件`,
      operator: '当前用户',
      detail: `导出 ${count} 条保护定值，导出文件含当前旁路代路依据。`,
    })
    await commit('导出记录已写入审计')
  }

  /**
   * 完整演练批次：两个窗口同时提交「代路结束」和「场景批准」。
   * 保存失败时从演练前完整快照恢复，演练记录单独留痕；回执重放不会多出审计记录。
   */
  async function runBypassDrill(params: {
    order: DrillOrder
    scenarioId: string
    failOnPersist: boolean
  }): Promise<{ record: DrillRunRecord; restored: boolean }> {
    const batch = getActiveBatch(data.value)
    if (!batch) throw new Error('当前没有投运中的旁路代路批次，无法演练。')
    const snapshot = JSON.parse(JSON.stringify(data.value)) as AppState
    const receiptId = createId('receipt')
    const runAt = now()

    const { record } = executeBypassDrill(data.value, {
      order: params.order,
      batchId: batch.id,
      scenarioId: params.scenarioId,
      expectedRevision: batch.basisRevision,
      receiptId,
      nowIso: runAt,
      idFactory: () => createId('audit'),
    })
    record.failOnPersist = params.failOnPersist

    if (params.failOnPersist) armNextPersistFailure()
    saving.value = true
    try {
      const saved = await persistState(JSON.parse(JSON.stringify(data.value)) as AppState)
      data.value = saved
      data.value.drillRuns.unshift(record)
      // 演练记录必须独立留痕，即使业务保存失败也可据此恢复
      saveState(data.value)
      lastMessage.value = '完整演练批次已提交'
      return { record, restored: false }
    } catch (error) {
      restoreSnapshot(snapshot)
      // 保存失败：只把演练记录与回执落到完整批次，业务状态回到演练前
      const recovered: DrillRunRecord = {
        ...record,
        finished: false,
        outcome: `保存失败，已从完整演练批次快照恢复；${record.outcome}`,
      }
      data.value.drillRuns.unshift(recovered)
      saveState(data.value)
      lastMessage.value = '演练保存失败，已恢复'
      throw error instanceof Error ? error : new Error('演练保存失败')
    } finally {
      saving.value = false
    }
  }

  /** 从完整演练批次恢复 / 重放回执，相同 receiptId 不产生重复审计 */
  async function replayDrill(receiptId: string) {
    const record = data.value.drillRuns.find((item) => item.receiptId === receiptId)
    if (!record) throw new Error('未找到对应的完整演练批次记录。')
    const before = data.value.audit.length
    const { replayed, duplicated } = replayDrillAudit(data.value, record, () => createId('audit'))
    await commit('演练回执已重放')
    return { replayed, duplicated, added: data.value.audit.length - before }
  }

  async function reset() {
    data.value = createInitialState()
    await commit('已恢复演示数据')
  }

  return {
    data,
    hydrated,
    saving,
    lastMessage,
    devices,
    settings,
    issues,
    scenarios,
    activeBaseline,
    activeBatch,
    activeBasis,
    currentOperationMode,
    hydrate,
    addDevice,
    updateDevice,
    saveSetting,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    addScenario,
    startBypassBatch,
    endBypassBatch,
    approveScenario,
    addScenarioStep,
    recomputeScenario,
    switchOperationMode,
    acknowledgeReReview,
    createBaseline,
    approveBaseline,
    recordExport,
    runBypassDrill,
    replayDrill,
    reset,
  }
})
