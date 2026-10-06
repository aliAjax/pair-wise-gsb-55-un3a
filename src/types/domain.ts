export type DeviceKind = 'line' | 'transformer' | 'bus' | 'breaker' | 'relay'
export type DeviceStatus = 'running' | 'maintenance' | 'stopped'
export type IssueType = 'overreach' | 'time-inversion' | 'sensitivity' | 'reclose'
export type IssueLevel = 'high' | 'medium' | 'low'
export type ReviewStatus =
  | 'draft'
  | 'reviewing'
  | 'approved'
  | 'locked'
  | 'returned'
  | 'invalidated'

/** 旁路代路批次生命周期 */
export type BypassBatchStatus = 'active' | 'ended'

/** 导致冻结依据修订的事件类型 */
export type BasisRevisionReason = 'setting-change' | 'mode-switch' | 'batch-end'

/** 冻结依据适用的批次动作，只允许引用冻结快照中的对象 */
export interface BypassFreezeBasis {
  id: string
  revision: number
  lineId: string
  bypassRelayId: string
  bypassBreakerId?: string
  baselineId?: string
  operationMode: string
  /** 冻结的被代线路定值与旁路保护定值，按冻结时刻深拷贝 */
  settingsSnapshot: ProtectionSetting[]
  checksum: string
  frozenAt: string
  createdBy: string
  note: string
}

/** 冻结依据修订事件，用于解释失效重算 */
export interface BasisRevisionEvent {
  reason: BasisRevisionReason
  fromRevision: number
  toRevision: number
  at: string
  detail: string
}

/** 已批准场景在依据变化后必须复议的步骤与停电范围 */
export interface ReReviewItem {
  stepSequences: number[]
  outageDeviceIds: string[]
  reason: string
  triggerRevision: number
  at: string
}

export interface BypassBatch {
  id: string
  code: string
  status: BypassBatchStatus
  basisId: string
  /** 当前冻结修订号，随定值改版、方式切换、代路结束递增 */
  basisRevision: number
  startedAt: string
  endedAt?: string
  operator: string
  revisionEvents: BasisRevisionEvent[]
}

export interface Device {
  id: string
  code: string
  name: string
  kind: DeviceKind
  station: string
  voltage: number
  parentId?: string
  status: DeviceStatus
  operationModes: string[]
}

export interface ProtectionSetting {
  id: string
  relayId: string
  protectedDeviceId: string
  stage: 'I' | 'II' | 'III'
  currentA: number
  timeS: number
  direction: 'forward' | 'reverse' | 'non-directional'
  sensitivity: number
  recloseEnabled: boolean
  recloseDelayS: number
  startCondition: string
  updatedAt: string
}

export interface ValidationIssue {
  id: string
  type: IssueType
  level: IssueLevel
  deviceIds: string[]
  settingIds: string[]
  message: string
  suggestion: string
  pairLabel: string
  status: 'open' | 'replying' | 'closed'
  createdAt: string
}

export interface ScenarioStep {
  sequence: number
  relayId: string
  action: string
  delayMs: number
  status: 'executed' | 'pending' | 'skipped'
  /** 该步骤所依据的旁路冻结依据，动作序列只能引用批次冻结依据 */
  basisId?: string
}

export interface FaultScenario {
  id: string
  name: string
  operationMode: string
  faultDeviceId: string
  faultType: string
  status: ReviewStatus
  steps: ScenarioStep[]
  outageDevices: string[]
  createdAt: string
  notes: string
  /** 场景绑定的旁路代路冻结依据 */
  freezeBasisId?: string
  /** 批准时冻结依据的修订号，已批准场景保留原结论的依据 */
  approvedAtRevision?: number
  /** 依据失效后重算至的修订号 */
  basisRevision?: number
  /** 已批准场景在依据变化后待复议的步骤与停电范围 */
  reReview?: ReReviewItem
}

export interface BaselineVersion {
  id: string
  version: string
  status: ReviewStatus
  createdAt: string
  lockedAt?: string
  createdBy: string
  note: string
  snapshot: ProtectionSetting[]
  checksum: string
}

export interface ReviewComment {
  id: string
  targetType: 'issue' | 'baseline' | 'scenario'
  targetId: string
  author: string
  content: string
  createdAt: string
  status: 'open' | 'resolved'
}

export interface AuditEntry {
  id: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
  /** 完整演练批次的动作回执，回执重放据此幂等去重 */
  receiptId?: string
}

/** 两个窗口并发提交的完整演练批次记录 */
export interface DrillRunRecord {
  receiptId: string
  batchId: string
  order: 'approve-first' | 'end-first'
  failOnPersist: boolean
  finished: boolean
  outcome: string
  appliedActions: Array<{
    kind: 'scenario-approve' | 'bypass-end'
    accepted: boolean
    detail: string
  }>
  /** 完整演练批次的审计回执载荷，重放时据此幂等恢复 */
  auditPayloads: Array<{
    action: string
    target: string
    detail: string
  }>
  auditCountBefore: number
  auditCountAfter: number
  at: string
}

export interface AppState {
  devices: Device[]
  settings: ProtectionSetting[]
  issues: ValidationIssue[]
  scenarios: FaultScenario[]
  baselines: BaselineVersion[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  activeBaselineId?: string
  bypassBases: BypassFreezeBasis[]
  bypassBatches: BypassBatch[]
  /** 当前调度运行方式；切换且与代路冻结方式不一致时冻结依据修订 */
  currentOperationMode: string
  drillRuns: DrillRunRecord[]
}

export interface SettingDiff {
  settingId: string
  relayName: string
  field: keyof ProtectionSetting
  before: string | number | boolean
  after: string | number | boolean
}
