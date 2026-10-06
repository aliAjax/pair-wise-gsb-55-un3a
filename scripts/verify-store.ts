import { setActivePinia, createPinia } from 'pinia'
import { useAppStore } from '../src/stores/app'
import { armNextPersistFailure, isPersistFailureArmed } from '../src/services/storage'

// ---- 浏览器环境桩：window + localStorage ----
const storageMap = new Map<string, string>()
;(globalThis as any).window = {
  setTimeout: (fn: (...args: unknown[]) => unknown, ms: number) =>
    setTimeout(fn, ms) as unknown as number,
  localStorage: {
    getItem: (key: string) => (storageMap.has(key) ? storageMap.get(key)! : null),
    setItem: (key: string, value: string) => storageMap.set(key, String(value)),
    removeItem: (key: string) => storageMap.delete(key),
  },
}

async function main() {
  const nodeAssert = (await import('node:assert/strict')).default
  setActivePinia(createPinia())
  const store = useAppStore()

  const beforeScenario = store.data.scenarios.find((s) => s.id === 'sc-bp101-review')!
  nodeAssert.equal(beforeScenario.status, 'reviewing')
  const auditBefore = store.data.audit.length
  const runsBefore = store.data.drillRuns.length

  console.log('演练保存失败恢复（结束先到 + failOnPersist）')
  let failed = false
  armNextPersistFailure()
  nodeAssert.equal(isPersistFailureArmed(), true)
  try {
    await store.runBypassDrill({
      order: 'end-first',
      scenarioId: 'sc-bp101-review',
      failOnPersist: true,
    })
  } catch (error) {
    failed = true
    nodeAssert.match((error as Error).message, /持久化失败/)
  }
  nodeAssert.ok(failed, '应抛出保存失败')

  nodeAssert.equal(
    store.data.scenarios.find((s) => s.id === 'sc-bp101-review')!.status,
    'reviewing',
    '恢复后场景回到会签中',
  )
  nodeAssert.equal(
    store.data.bypassBatches.find((b) => b.id === 'batch-bp-101')!.status,
    'active',
    '恢复后批次仍投运中',
  )
  nodeAssert.equal(store.data.audit.length, auditBefore, '恢复后审计记录不增加')

  nodeAssert.equal(store.data.drillRuns.length, runsBefore + 1)
  const failedRecord = store.data.drillRuns[0]
  nodeAssert.equal(failedRecord.finished, false)
  nodeAssert.ok(failedRecord.failOnPersist)
  nodeAssert.equal(isPersistFailureArmed(), false, '失败标志已被消费')
  console.log('  ✓ 保存失败后业务状态完整恢复')
  console.log('  ✓ 完整演练批次记录独立留痕')

  console.log('从完整演练批次重放回执')
  const replayResult = await store.replayDrill(failedRecord.receiptId)
  nodeAssert.equal(replayResult.replayed, 2, '应补回 2 条演练审计')
  nodeAssert.equal(replayResult.duplicated, 0)
  const auditAfterReplay = store.data.audit.length
  nodeAssert.equal(auditAfterReplay, auditBefore + 2)

  const replayAgain = await store.replayDrill(failedRecord.receiptId)
  nodeAssert.equal(replayAgain.added, 0, '再次重放不会多出审计记录')
  nodeAssert.equal(replayAgain.duplicated, 2)
  nodeAssert.equal(store.data.audit.length, auditAfterReplay)
  console.log('  ✓ 回执重放补回审计 2 条')
  console.log('  ✓ 重放回执不多出审计记录')

  console.log('正常演练可提交成功（批准先到 / 结束后到）')
  const { record, restored } = await store.runBypassDrill({
    order: 'approve-first',
    scenarioId: 'sc-bp101-review',
    failOnPersist: false,
  })
  nodeAssert.equal(restored, false)
  nodeAssert.equal(record.finished, true)
  nodeAssert.equal(
    store.data.scenarios.find((s) => s.id === 'sc-bp101-review')!.status,
    'approved',
    '批准先到生效',
  )
  nodeAssert.ok(
    store.data.scenarios.find((s) => s.id === 'sc-bp101-review')!.reReview,
    '代路结束后到，已批准场景保留结论并登记复议',
  )
  nodeAssert.equal(
    store.data.bypassBatches.find((b) => b.id === 'batch-bp-101')!.status,
    'ended',
  )
  console.log('  ✓ 先到结果未被覆盖，后到动作按冻结修订 R2 处理')

  console.log('\n集成验证全部通过')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
