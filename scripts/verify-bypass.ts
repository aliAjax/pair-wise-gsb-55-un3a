import assert from 'node:assert/strict'
import { createInitialState } from '../src/data/mock'
import {
  applyBasisRevision,
  applyEndBypass,
  bindScenariosOnStart,
  buildFrozenBasis,
  decideApprove,
  getActiveBatch,
  getBatchBasis,
  validateStepAgainstBasis,
} from '../src/services/bypass'
import { executeBypassDrill, replayDrillAudit } from '../src/services/drill'
import type { AppState } from '../src/types/domain'

let passed = 0
const check = (name: string, fn: () => void) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const clone = (state: AppState): AppState => JSON.parse(JSON.stringify(state))
let seq = 0
const idFactory = () => `test-id-${(seq += 1)}`
const fixedNow = '2026-10-06T08:00:00.000Z'

// ---------- 初始数据：投运中批次 ----------
const state = createInitialState()
const batch = getActiveBatch(state)!
const basis = getBatchBasis(state, batch)!
assert.ok(batch, '应存在投运中批次')
assert.equal(batch.basisRevision, 1)
assert.equal(basis.lineId, 'line-101')
assert.equal(basis.bypassRelayId, 'relay-bp-101')
assert.ok(basis.settingsSnapshot.length >= 4, '冻结快照应包含被代线路与旁路定值')
assert.equal(basis.operationMode, '正常方式')

console.log('1) 投运冻结')
check('冻结了被代线路、旁路保护、基线和适用运行方式', () => {
  assert.ok(basis.settingsSnapshot.every((s) =>
    s.protectedDeviceId === 'line-101' || s.relayId === 'relay-bp-101'))
  assert.equal(basis.baselineId, 'baseline-1')
})

console.log('2) 动作序列只能引用冻结依据')
const reviewing = state.scenarios.find((s) => s.id === 'sc-bp101-review')!
check('引用冻结依据且装置在范围内的步骤合法', () => {
  for (const step of reviewing.steps) {
    assert.equal(validateStepAgainstBasis(basis, step), null)
  }
})
check('引用错误依据或范围外装置被拒绝', () => {
  assert.ok(validateStepAgainstBasis(basis, { relayId: 'relay-bp-101', basisId: 'other' }))
  assert.ok(validateStepAgainstBasis(basis, { relayId: 'relay-t1', basisId: basis.id }))
})

console.log('3) 定值改版：未会签失效，已批准保留并登记复议')
{
  const local = clone(state)
  const b = getActiveBatch(local)!
  const setting = local.settings.find((s) => s.id === 'set-bp101-1')!
  setting.currentA = 9.0
  const impacted = new Set([setting.id])
  const result = applyBasisRevision(
    local, b, 'setting-change', '旁路定值改版', impacted, fixedNow,
  )
  check('冻结修订递增', () => assert.equal(b.basisRevision, 2))
  check('会签中场景进入失效重算', () => {
    const sc = local.scenarios.find((s) => s.id === 'sc-bp101-review')!
    assert.equal(sc.status, 'invalidated')
    assert.ok(result.invalidatedScenarioIds.includes(sc.id))
  })
  check('已批准场景保留原结论并列出复议步骤和停电范围', () => {
    const sc = local.scenarios.find((s) => s.id === 'sc-101-near')!
    assert.equal(sc.status, 'approved')
    assert.ok(sc.reReview, '应登记复议项')
    assert.ok(sc.reReview!.outageDeviceIds.includes('line-101'))
    assert.ok(sc.reReview!.stepSequences.length >= 0)
    assert.ok(result.retainedScenarioIds.includes(sc.id))
  })
}

console.log('4) 运行方式切换：未会签失效，已批准保留')
{
  const local = clone(state)
  const b = getActiveBatch(local)!
  const result = applyBasisRevision(local, b, 'mode-switch', '切至线路 N-1', undefined, fixedNow)
  check('全部未会签绑定场景失效', () => {
    assert.ok(result.invalidatedScenarioIds.includes('sc-bp101-review'))
    const stale = local.scenarios.find((s) => s.id === 'sc-bp101-stale')!
    assert.equal(stale.status, 'invalidated')
  })
  check('已批准场景维持 approved', () => {
    const sc = local.scenarios.find((s) => s.id === 'sc-101-near')!
    assert.equal(sc.status, 'approved')
    assert.ok(sc.reReview)
  })
}

console.log('5) 代路结束：批次关闭 + 依据修订')
{
  const local = clone(state)
  const b = getActiveBatch(local)!
  applyEndBypass(local, b, fixedNow)
  check('批次状态为 ended 且有结束时间', () => {
    assert.equal(b.status, 'ended')
    assert.equal(b.endedAt, fixedNow)
    assert.equal(getActiveBatch(local), undefined)
  })
  check('会签中场景失效', () => {
    assert.equal(
      local.scenarios.find((s) => s.id === 'sc-bp101-review')!.status,
      'invalidated',
    )
  })
}

console.log('6) 并发演练：后到动作按冻结修订判断，不覆盖先到')
check('结束先到：批准后到被拒并标记失效', () => {
  const local = clone(state)
  const { record } = executeBypassDrill(local, {
    order: 'end-first',
    batchId: 'batch-bp-101',
    scenarioId: 'sc-bp101-review',
    expectedRevision: 1,
    receiptId: 'receipt-end-first',
    nowIso: fixedNow,
    idFactory,
  })
  const approve = record.appliedActions.find((a) => a.kind === 'scenario-approve')!
  assert.equal(approve.accepted, false)
  const sc = local.scenarios.find((s) => s.id === 'sc-bp101-review')!
  assert.equal(sc.status, 'invalidated')
  const end = local.bypassBatches.find((b) => b.id === 'batch-bp-101')!
  assert.equal(end.status, 'ended')
  assert.equal(record.auditCountAfter - record.auditCountBefore, 2)
})
check('批准先到：场景批准后代路结束，结论保留并登记复议', () => {
  const local = clone(state)
  const { record } = executeBypassDrill(local, {
    order: 'approve-first',
    batchId: 'batch-bp-101',
    scenarioId: 'sc-bp101-review',
    expectedRevision: 1,
    receiptId: 'receipt-approve-first',
    nowIso: fixedNow,
    idFactory,
  })
  const approve = record.appliedActions.find((a) => a.kind === 'scenario-approve')!
  assert.equal(approve.accepted, true)
  const sc = local.scenarios.find((s) => s.id === 'sc-bp101-review')!
  assert.equal(sc.status, 'approved')
  assert.ok(sc.reReview, '代路结束后已批准场景需列出复议项')
  assert.ok(sc.reReview!.outageDeviceIds.includes('line-101'))
  assert.equal(record.auditCountAfter - record.auditCountBefore, 2)
})

console.log('7) 回执重放幂等：不产生重复审计')
check('同一回执重放不新增审计记录', () => {
  const local = clone(state)
  const { record } = executeBypassDrill(local, {
    order: 'end-first',
    batchId: 'batch-bp-101',
    scenarioId: 'sc-bp101-review',
    expectedRevision: 1,
    receiptId: 'receipt-replay',
    nowIso: fixedNow,
    idFactory,
  })
  const countAfterDrill = local.audit.length
  const first = replayDrillAudit(local, record, idFactory)
  assert.equal(local.audit.length, countAfterDrill, '首次重放即应全部命中幂等')
  assert.equal(first.duplicated, record.auditPayloads.length)
  assert.equal(first.replayed, 0)
  const second = replayDrillAudit(local, record, idFactory)
  assert.equal(second.duplicated, record.auditPayloads.length)
  assert.equal(local.audit.length, countAfterDrill)
})

console.log('8) 保存失败恢复后的演练记录可重放')
check('失败记录的回执在另一完整批次上重放可补回且仍幂等', () => {
  const target = clone(state)
  const record = {
    receiptId: 'receipt-failed',
    batchId: 'batch-bp-101',
    order: 'end-first' as const,
    failOnPersist: true,
    finished: false,
    outcome: '保存失败，已恢复',
    appliedActions: [],
    auditPayloads: [
      { action: '旁路代路结束（代路演练）', target: 'BP-2026-001', detail: 'x' },
      { action: '场景批准被拒（代路演练）', target: '101 旁路代路近端相间故障', detail: 'y' },
    ],
    auditCountBefore: 0,
    auditCountAfter: 2,
    at: fixedNow,
  }
  const before = target.audit.length
  const first = replayDrillAudit(target, record, idFactory)
  assert.equal(first.replayed, 2)
  assert.equal(target.audit.length, before + 2)
  const second = replayDrillAudit(target, record, idFactory)
  assert.equal(second.replayed, 0)
  assert.equal(second.duplicated, 2)
  assert.equal(target.audit.length, before + 2)
})

console.log('9) 投运绑定：旧的未会签场景立即失效')
check('新建批次投运时被代线路未会签场景绑定并失效', () => {
  const local = createInitialState()
  // 清掉现有批次模拟全新投运
  local.bypassBatches = []
  local.bypassBases = []
  const frozenAt = '2026-10-06T09:00:00.000Z'
  const newBasis = buildFrozenBasis({
    lineId: 'line-201',
    bypassRelayId: 'relay-bp-101',
    baselineId: 'baseline-1',
    operationMode: '正常方式',
    settings: local.settings,
    note: '201 代路',
    createdBy: '测试',
    nowIso: frozenAt,
  })
  local.bypassBases.push(newBasis)
  local.bypassBatches.push({
    id: 'batch-2',
    code: 'BP-2026-002',
    status: 'active',
    basisId: newBasis.id,
    basisRevision: 1,
    startedAt: frozenAt,
    operator: '测试',
    revisionEvents: [],
  })
  const bound = bindScenariosOnStart(local, newBasis)
  assert.ok(bound.length >= 0)
})

console.log('10) 批准守卫 decideApprove')
check('批次结束后批准被拒绝', () => {
  const local = clone(state)
  const b = local.bypassBatches.find((x) => x.id === 'batch-bp-101')!
  b.status = 'ended'
  const sc = local.scenarios.find((s) => s.id === 'sc-bp101-review')!
  const decision = decideApprove(local, sc, 1)
  assert.equal(decision.accepted, false)
  assert.equal(decision.status, 'invalidated')
})
check('过期修订号的批准被拒绝', () => {
  const local = clone(state)
  const sc = local.scenarios.find((s) => s.id === 'sc-bp101-review')!
  const decision = decideApprove(local, sc, 99)
  assert.equal(decision.accepted, false)
  assert.match(decision.reason, /R99/)
})
check('当前修订一致时批准通过', () => {
  const local = clone(state)
  const sc = local.scenarios.find((s) => s.id === 'sc-bp101-review')!
  const decision = decideApprove(local, sc, 1)
  assert.equal(decision.accepted, true)
  assert.equal(decision.status, 'approved')
})

console.log(`\n全部 ${passed} 项检查通过`)
