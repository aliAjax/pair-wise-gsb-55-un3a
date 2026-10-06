import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  BypassBatch,
  Device,
  ProtectionSetting,
  ReviewComment,
  ReviewStatus,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { validateSettings } from '@/services/validation'
import { BasisConflictError, invalidateScenariosForBatches } from '@/services/bypass'
import { persistState } from '@/api/client'
import { loadState } from '@/services/storage'

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const now = () => new Date().toISOString()

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

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

interface MutationReceipt {
  id: string
  label: string
  mutate: (draft: AppState, mutationId: string) => void
}

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')
  const failedReceipt = ref<MutationReceipt | null>(null)

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const bypassBatches = computed(() => data.value.bypassBatches)
  const activeBatches = computed(() =>
    data.value.bypassBatches.filter((batch) => batch.status === 'commissioned'),
  )
  const currentOperationMode = computed(() => data.value.currentOperationMode)
  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => baseline.id === data.value.activeBaselineId),
  )

  function hydrate(state: AppState) {
    data.value = state
    hydrated.value = true
  }

  /** 同一回执（mutationId）重复出现时不再追加审计，保证重放不多出审计记录。 */
  function appendAuditTo(
    state: AppState,
    mutationId: string,
    entry: Omit<AuditEntry, 'id' | 'createdAt' | 'mutationId'>,
  ) {
    const duplicated = state.audit.some(
      (item) =>
        item.mutationId === mutationId && item.action === entry.action && item.target === entry.target,
    )
    if (duplicated) return
    state.audit.unshift({
      ...entry,
      id: createId('audit'),
      mutationId,
      createdAt: now(),
    })
  }

  /**
   * 执行一批变更：业务校验失败直接抛出；保存失败则从完整持久化批次恢复，
   * 并留下回执供重放。atomic 变更基于最新持久化状态执行，用于并发窗口
   * 下按冻结修订裁决，后到动作不能覆盖先到结果。
   */
  async function execute(receipt: MutationReceipt, options: { atomic?: boolean } = {}) {
    saving.value = true
    let draft: AppState
    try {
      draft = clone(options.atomic ? loadState() : data.value)
      receipt.mutate(draft, receipt.id)
    } catch (error) {
      saving.value = false
      throw error
    }
    try {
      const saved = await persistState(draft)
      data.value = saved
      failedReceipt.value = null
      lastMessage.value = receipt.label
    } catch (error) {
      data.value = loadState()
      failedReceipt.value = receipt
      throw error
    } finally {
      saving.value = false
    }
  }

  /** 重放失败回执：已落库的回执直接采用持久化结果，不重复写审计。 */
  async function replayFailedReceipt() {
    const receipt = failedReceipt.value
    if (!receipt) return
    saving.value = true
    try {
      const persisted = loadState()
      if (persisted.audit.some((entry) => entry.mutationId === receipt.id)) {
        data.value = persisted
      } else {
        const draft = clone(persisted)
        receipt.mutate(draft, receipt.id)
        data.value = await persistState(draft)
      }
      failedReceipt.value = null
      lastMessage.value = `${receipt.label}（回执重放完成）`
    } finally {
      saving.value = false
    }
  }

  async function addDevice(device: Omit<Device, 'id'>) {
    const item = { ...device, id: createId('device') }
    await execute({
      id: createId('mutation'),
      label: `已新增 ${item.name}`,
      mutate: (draft, mutationId) => {
        draft.devices.push(item)
        appendAuditTo(draft, mutationId, {
          action: '新增设备',
          target: item.name,
          operator: '当前用户',
          detail: `设备类型：${item.kind}，电压等级：${item.voltage}kV。`,
        })
      },
    })
    return item
  }

  async function updateDevice(device: Device) {
    await execute({
      id: createId('mutation'),
      label: `已更新 ${device.name}`,
      mutate: (draft, mutationId) => {
        const index = draft.devices.findIndex((item) => item.id === device.id)
        if (index < 0) throw new Error('设备不存在或已被移除')
        draft.devices[index] = { ...device, operationModes: [...device.operationModes] }
        appendAuditTo(draft, mutationId, {
          action: '更新设备',
          target: device.name,
          operator: '当前用户',
          detail: `运行状态调整为 ${device.status}。`,
        })
      },
    })
  }

  async function saveSetting(setting: ProtectionSetting) {
    const outcome = { invalidated: 0, reReview: 0 }
    await execute({
      id: createId('mutation'),
      label: '定值已保存',
      mutate: (draft, mutationId) => {
        const index = draft.settings.findIndex((item) => item.id === setting.id)
        const next = { ...setting, updatedAt: now() }
        if (index >= 0) draft.settings[index] = next
        else draft.settings.push(next)
        draft.settingsRevision += 1
        appendAuditTo(draft, mutationId, {
          action: index >= 0 ? '修改定值' : '新增定值',
          target: `${setting.relayId} ${setting.stage} 段`,
          operator: '当前用户',
          detail: `电流 ${setting.currentA}A，时限 ${setting.timeS}s，定值修订升至 R${draft.settingsRevision}。`,
        })
        const staleBatchIds = draft.bypassBatches
          .filter((batch) => batch.status === 'commissioned' && batch.settingsRevision !== draft.settingsRevision)
          .map((batch) => batch.id)
        if (!staleBatchIds.length) return
        const result = invalidateScenariosForBatches(
          draft,
          staleBatchIds,
          `定值改版（修订 R${draft.settingsRevision}），代路冻结依据失效`,
        )
        outcome.invalidated = result.invalidated
        outcome.reReview = result.reReview
        if (result.invalidated || result.reReview) {
          appendAuditTo(draft, mutationId, {
            action: '代路依据失效',
            target: `${staleBatchIds.length} 个在役代路批次`,
            operator: '系统',
            detail: `定值改版触发：${result.invalidated} 个未会签场景失效重算，${result.reReview} 个已批准场景列入复议。`,
          })
        }
      },
    })
    return outcome
  }

  async function runValidation() {
    await execute({
      id: createId('mutation'),
      label: '批量校验完成',
      mutate: (draft, mutationId) => {
        draft.issues = validateSettings(draft.settings, draft.devices)
        appendAuditTo(draft, mutationId, {
          action: '批量校验',
          target: '全部保护定值',
          operator: '当前用户',
          detail: `生成 ${draft.issues.length} 条待处理问题。`,
        })
      },
    })
    return data.value.issues
  }

  async function updateIssue(issue: ValidationIssue) {
    await execute({
      id: createId('mutation'),
      label: '问题状态已更新',
      mutate: (draft, mutationId) => {
        const index = draft.issues.findIndex((item) => item.id === issue.id)
        if (index >= 0) draft.issues[index] = issue
        appendAuditTo(draft, mutationId, {
          action: '更新问题状态',
          target: issue.pairLabel,
          operator: '当前用户',
          detail: `状态更新为 ${issue.status}。`,
        })
      },
    })
  }

  async function addComment(comment: Omit<ReviewComment, 'id' | 'createdAt'>) {
    await execute({
      id: createId('mutation'),
      label: '意见已提交',
      mutate: (draft, mutationId) => {
        draft.comments.unshift({
          ...comment,
          id: createId('comment'),
          createdAt: now(),
        })
        appendAuditTo(draft, mutationId, {
          action: '提交会签意见',
          target: comment.targetId,
          operator: comment.author,
          detail: comment.content,
        })
      },
    })
  }

  async function updateScenarioStatus(id: string, status: ReviewStatus) {
    await execute(
      {
        id: createId('mutation'),
        label: '场景状态已更新',
        mutate: (draft, mutationId) => {
          const scenario = draft.scenarios.find((item) => item.id === id)
          if (!scenario) throw new BasisConflictError('场景不存在或已被移除')
          if (scenario.status === 'invalidated' && status !== 'draft') {
            throw new BasisConflictError('场景已失效，请先重算再提交会签')
          }
          if (status === 'approved' && scenario.basisBatchId) {
            const batch = draft.bypassBatches.find((item) => item.id === scenario.basisBatchId)
            if (!batch || batch.status !== 'commissioned') {
              throw new BasisConflictError('代路批次已结束，批准动作按冻结修订被拒绝，不能覆盖先到结果')
            }
            if (batch.revision !== scenario.basisRevision) {
              throw new BasisConflictError(
                `代路依据已修订为 R${batch.revision}，批准动作按冻结修订被拒绝，不能覆盖先到结果`,
              )
            }
          }
          scenario.status = status
          appendAuditTo(draft, mutationId, {
            action: '场景状态流转',
            target: scenario.name,
            operator: '当前用户',
            detail: `状态更新为 ${status}。`,
          })
        },
      },
      { atomic: true },
    )
  }

  async function addScenario(
    scenario: Omit<AppState['scenarios'][number], 'id' | 'createdAt' | 'steps' | 'status'>,
  ) {
    const item = {
      ...scenario,
      id: createId('scenario'),
      status: 'draft' as const,
      steps: [],
      createdAt: now(),
    }
    await execute({
      id: createId('mutation'),
      label: '故障场景已创建',
      mutate: (draft, mutationId) => {
        const batch = draft.bypassBatches.find(
          (entry) => entry.status === 'commissioned' && entry.lineId === item.faultDeviceId,
        )
        if (batch) {
          if (!batch.operationModes.includes(item.operationMode)) {
            throw new Error(`运行方式「${item.operationMode}」不在代路批次 ${batch.code} 冻结的适用范围内`)
          }
          item.basisBatchId = batch.id
          item.basisRevision = batch.revision
        }
        draft.scenarios.unshift(item)
        appendAuditTo(draft, mutationId, {
          action: '新增故障场景',
          target: item.name,
          operator: '当前用户',
          detail: batch
            ? `运行方式：${item.operationMode}，动作序列引用代路批次 ${batch.code} 冻结依据 R${batch.revision}。`
            : `运行方式：${item.operationMode}，故障类型：${item.faultType}。`,
        })
      },
    })
    return item
  }

  async function recalculateScenario(id: string) {
    await execute({
      id: createId('mutation'),
      label: '场景已重算并回到草稿',
      mutate: (draft, mutationId) => {
        const scenario = draft.scenarios.find((item) => item.id === id)
        if (!scenario) throw new Error('场景不存在或已被移除')
        if (scenario.status !== 'invalidated') throw new Error('仅失效场景需要重算')
        const batch = scenario.basisBatchId
          ? draft.bypassBatches.find((item) => item.id === scenario.basisBatchId)
          : undefined
        if (batch && batch.status === 'commissioned') {
          scenario.basisRevision = batch.revision
        } else {
          scenario.basisBatchId = undefined
          scenario.basisRevision = undefined
        }
        scenario.status = 'draft'
        scenario.invalidatedReason = undefined
        appendAuditTo(draft, mutationId, {
          action: '场景失效重算',
          target: scenario.name,
          operator: '当前用户',
          detail:
            batch && batch.status === 'commissioned'
              ? `重新引用代路批次 ${batch.code} 冻结依据 R${batch.revision}，动作序列待重新确认。`
              : '代路批次已结束，场景解除代路依据绑定，动作序列待重新确认。',
        })
      },
    })
  }

  async function commissionBypassBatch(input: {
    lineId: string
    bypassRelayId: string
    baselineId: string
    operationModes: string[]
    note: string
  }) {
    const batch: BypassBatch = {
      id: createId('bypass'),
      code: '',
      status: 'commissioned',
      lineId: input.lineId,
      bypassRelayId: input.bypassRelayId,
      baselineId: input.baselineId,
      operationModes: [...input.operationModes],
      settingsRevision: 0,
      revision: 1,
      frozenAt: now(),
      note: input.note,
    }
    await execute({
      id: createId('mutation'),
      label: '代路批次已投运',
      mutate: (draft, mutationId) => {
        const line = draft.devices.find((item) => item.id === input.lineId)
        if (!line || line.kind !== 'line') throw new Error('被代线路不存在')
        if (
          draft.bypassBatches.some(
            (item) => item.status === 'commissioned' && item.lineId === input.lineId,
          )
        ) {
          throw new BasisConflictError(`线路 ${line.name} 已存在在役代路批次，不能重复投运`)
        }
        const relay = draft.devices.find((item) => item.id === input.bypassRelayId)
        if (!relay || relay.kind !== 'relay') throw new Error('旁路保护装置不存在')
        const baseline = draft.baselines.find((item) => item.id === input.baselineId)
        if (!baseline || baseline.status !== 'locked') throw new Error('定值基线必须为已锁定版本')
        if (!input.operationModes.length) throw new Error('至少选择一个适用运行方式')
        batch.code = `BL-${new Date().getFullYear()}-${String(draft.bypassBatches.length + 1).padStart(3, '0')}`
        batch.settingsRevision = draft.settingsRevision
        line.status = 'maintenance'
        draft.bypassBatches.unshift(batch)
        appendAuditTo(draft, mutationId, {
          action: '旁路代路投运',
          target: `${batch.code}（${line.name}）`,
          operator: '当前用户',
          detail: `冻结被代线路、旁路保护 ${relay.name}、定值基线 ${baseline.version} 与 ${batch.operationModes.length} 个适用运行方式，冻结修订 R1。`,
        })
      },
    })
    return batch
  }

  async function endBypassBatch(batchId: string, expectedRevision: number) {
    const outcome = { code: '', invalidated: 0, reReview: 0 }
    await execute(
      {
        id: createId('mutation'),
        label: '代路批次已结束',
        mutate: (draft, mutationId) => {
          const batch = draft.bypassBatches.find((item) => item.id === batchId)
          if (!batch) throw new BasisConflictError('代路批次不存在或已被清除')
          if (batch.status !== 'commissioned') {
            throw new BasisConflictError(`批次 ${batch.code} 已结束，后到动作不能覆盖先到结果`)
          }
          if (batch.revision !== expectedRevision) {
            throw new BasisConflictError(
              `批次 ${batch.code} 冻结修订已变更为 R${batch.revision}，本次结束动作按冻结修订被拒绝`,
            )
          }
          batch.status = 'ended'
          batch.endedAt = now()
          batch.revision += 1
          const line = draft.devices.find((item) => item.id === batch.lineId)
          if (line) line.status = 'running'
          const result = invalidateScenariosForBatches(
            draft,
            [batch.id],
            `代路批次 ${batch.code} 已结束`,
          )
          outcome.code = batch.code
          outcome.invalidated = result.invalidated
          outcome.reReview = result.reReview
          appendAuditTo(draft, mutationId, {
            action: '旁路代路结束',
            target: `${batch.code}（${line?.name ?? batch.lineId}）`,
            operator: '当前用户',
            detail: `代路结束，冻结修订升至 R${batch.revision}；${result.invalidated} 个未会签场景失效重算，${result.reReview} 个已批准场景保留结论并列入复议。`,
          })
        },
      },
      { atomic: true },
    )
    return outcome
  }

  async function switchOperationMode(mode: string) {
    const outcome = { invalidated: 0, reReview: 0 }
    await execute({
      id: createId('mutation'),
      label: `运行方式已切换为${mode}`,
      mutate: (draft, mutationId) => {
        if (draft.currentOperationMode === mode) throw new Error('当前已处于该运行方式')
        draft.currentOperationMode = mode
        const affectedIds = draft.bypassBatches
          .filter((batch) => batch.status === 'commissioned' && !batch.operationModes.includes(mode))
          .map((batch) => batch.id)
        if (affectedIds.length) {
          const result = invalidateScenariosForBatches(
            draft,
            affectedIds,
            `运行方式切换为「${mode}」，超出代路冻结适用范围`,
          )
          outcome.invalidated = result.invalidated
          outcome.reReview = result.reReview
        }
        appendAuditTo(draft, mutationId, {
          action: '运行方式切换',
          target: mode,
          operator: '当前用户',
          detail: affectedIds.length
            ? `影响 ${affectedIds.length} 个在役代路批次：${outcome.invalidated} 个未会签场景失效重算，${outcome.reReview} 个已批准场景列入复议。`
            : '不影响在役代路批次的冻结依据。',
        })
      },
    })
    return outcome
  }

  async function createBaseline(note: string) {
    const baseline: BaselineVersion = {
      id: createId('baseline'),
      version: '',
      status: 'reviewing',
      createdAt: now(),
      createdBy: '当前用户',
      note,
      snapshot: [],
      checksum: '',
    }
    await execute({
      id: createId('mutation'),
      label: '基线已创建并提交会签',
      mutate: (draft, mutationId) => {
        baseline.version = `V1.${draft.baselines.length}`
        baseline.snapshot = clone(draft.settings)
        baseline.checksum = checksum(draft.settings)
        draft.baselines.unshift(baseline)
        appendAuditTo(draft, mutationId, {
          action: '创建基线上会签',
          target: baseline.version,
          operator: '当前用户',
          detail: note,
        })
      },
    })
    return baseline
  }

  async function approveBaseline(id: string) {
    await execute({
      id: createId('mutation'),
      label: '基线已锁定',
      mutate: (draft, mutationId) => {
        const baseline = draft.baselines.find((item) => item.id === id)
        if (!baseline) throw new Error('基线不存在或已被移除')
        if (draft.issues.some((issue) => issue.level === 'high' && issue.status !== 'closed')) {
          throw new Error('存在未关闭的高风险问题，不能锁定基线')
        }
        baseline.status = 'locked'
        baseline.lockedAt = now()
        draft.activeBaselineId = baseline.id
        appendAuditTo(draft, mutationId, {
          action: '锁定基线',
          target: baseline.version,
          operator: '当前用户',
          detail: `校验码 ${baseline.checksum}。`,
        })
      },
    })
  }

  async function recordExport(format: string, count: number) {
    await execute({
      id: createId('mutation'),
      label: '导出记录已写入审计',
      mutate: (draft, mutationId) => {
        appendAuditTo(draft, mutationId, {
          action: '导出定值清单',
          target: `${format} 文件`,
          operator: '当前用户',
          detail: `导出 ${count} 条保护定值。`,
        })
      },
    })
  }

  async function reset() {
    const fresh = createInitialState()
    failedReceipt.value = null
    await execute({
      id: createId('mutation'),
      label: '已恢复演示数据',
      mutate: (draft) => {
        Object.assign(draft, fresh)
      },
    })
  }

  return {
    data,
    hydrated,
    saving,
    lastMessage,
    failedReceipt,
    devices,
    settings,
    issues,
    scenarios,
    bypassBatches,
    activeBatches,
    currentOperationMode,
    activeBaseline,
    hydrate,
    replayFailedReceipt,
    addDevice,
    updateDevice,
    saveSetting,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    addScenario,
    recalculateScenario,
    commissionBypassBatch,
    endBypassBatch,
    switchOperationMode,
    createBaseline,
    approveBaseline,
    recordExport,
    reset,
  }
})
