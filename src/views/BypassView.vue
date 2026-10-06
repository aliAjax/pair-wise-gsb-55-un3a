<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { operationModes } from '@/data/mock'
import { scenarioMatchesBasis } from '@/services/bypass'
import type { DrillOrder } from '@/services/drill'
import type { FaultScenario } from '@/types/domain'

const store = useAppStore()
const {
  data,
  devices,
  activeBatch,
  activeBasis,
  currentOperationMode,
} = storeToRefs(store)

const startDialog = ref(false)
const stepDialog = ref(false)
const stepScenarioId = ref('')
const running = ref(false)

const startForm = reactive({
  lineId: '',
  bypassRelayId: '',
  bypassBreakerId: '',
  operationMode: operationModes[0],
  note: '',
})

const drillForm = reactive<{
  order: DrillOrder
  scenarioId: string
  failOnPersist: boolean
}>({
  order: 'end-first',
  scenarioId: '',
  failOnPersist: false,
})

const stepForm = reactive({ relayId: '', action: '', delayMs: 100 })

const lineDevices = computed(() => devices.value.filter((device) => device.kind === 'line'))
const relayDevices = computed(() => devices.value.filter((device) => device.kind === 'relay'))
const breakerDevices = computed(() => devices.value.filter((device) => device.kind === 'breaker'))

const batchScenarios = computed(() =>
  activeBasis.value
    ? data.value.scenarios.filter((scenario) => scenario.freezeBasisId === activeBasis.value!.id)
    : [],
)

const drillCandidates = computed(() =>
  batchScenarios.value.filter((scenario) => scenario.status === 'reviewing'),
)

const batchHistory = computed(() =>
  [...data.value.bypassBatches].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
)

const statusText = (status: string) =>
  ({
    draft: '草稿',
    reviewing: '会签中',
    approved: '已批准',
    locked: '已锁定',
    returned: '已退回',
    invalidated: '已失效待重算',
  })[status] ?? status

const statusType = (status: string) =>
  status === 'approved' || status === 'locked'
    ? 'success'
    : status === 'reviewing'
      ? 'warning'
      : status === 'invalidated'
        ? 'danger'
        : 'info'

function deviceName(id: string) {
  return devices.value.find((device) => device.id === id)?.name ?? id
}

function isFresh(scenario: FaultScenario) {
  return scenarioMatchesBasis(data.value, scenario)
}

async function openStart() {
  Object.assign(startForm, {
    lineId: lineDevices.value[0]?.id ?? '',
    bypassRelayId: relayDevices.value.find((item) => item.code.includes('BP'))?.id ?? '',
    bypassBreakerId: breakerDevices.value.find((item) => item.code.includes('BP'))?.id ?? '',
    operationMode: currentOperationMode.value,
    note: '',
  })
  startDialog.value = true
}

async function submitStart() {
  if (!startForm.lineId || !startForm.bypassRelayId) {
    ElMessage.warning('请选择被代线路与旁路保护')
    return
  }
  try {
    await store.startBypassBatch({ ...startForm })
    startDialog.value = false
    ElMessage.success('旁路代路批次已投运，冻结依据生成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '投运失败')
  }
}

async function finishBatch() {
  try {
    await store.endBypassBatch()
    ElMessage.success('代路已结束：未会签场景失效，已批准场景保留结论并登记复议')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '结束失败')
  }
}

async function switchMode(mode: string) {
  await store.switchOperationMode(mode)
  if (activeBatch.value && activeBasis.value && mode !== activeBasis.value.operationMode) {
    ElMessage.warning('运行方式已偏离冻结方式，未会签场景已失效重算')
  } else {
    ElMessage.success('运行方式已切换')
  }
}

function openStepDialog(scenarioId: string) {
  stepScenarioId.value = scenarioId
  const inScopeRelays = activeBasis.value
    ? [...new Set(activeBasis.value.settingsSnapshot.map((item) => item.relayId))]
    : []
  stepForm.relayId = inScopeRelays.find((id) => id === activeBasis.value?.bypassRelayId) ??
    inScopeRelays[0] ??
    ''
  stepForm.action = ''
  stepForm.delayMs = 100
  stepDialog.value = true
}

async function submitStep() {
  if (!stepForm.action.trim()) {
    ElMessage.warning('请填写动作描述')
    return
  }
  try {
    await store.addScenarioStep(stepScenarioId.value, {
      relayId: stepForm.relayId,
      action: stepForm.action.trim(),
      delayMs: stepForm.delayMs,
    })
    stepDialog.value = false
    ElMessage.success('动作步骤已补充，引用当前冻结依据')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '步骤保存失败')
  }
}

async function approve(scenario: FaultScenario) {
  try {
    const decision = await store.approveScenario(scenario.id, activeBatch.value?.basisRevision)
    ElMessage.success(decision.reason)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '批准失败')
  }
}

async function recompute(scenario: FaultScenario) {
  try {
    await store.recomputeScenario(scenario.id)
    ElMessage.success('已按当前冻结依据重算并重新提交会签')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重算失败')
  }
}

async function acknowledge(scenario: FaultScenario) {
  await store.acknowledgeReReview(scenario.id)
  ElMessage.success('复议项已确认，原批准结论维持')
}

async function runDrill() {
  if (!drillForm.scenarioId) {
    ElMessage.warning('请选择并发演练用例会签场景')
    return
  }
  running.value = true
  try {
    const { record, restored } = await store.runBypassDrill({
      order: drillForm.order,
      scenarioId: drillForm.scenarioId,
      failOnPersist: drillForm.failOnPersist,
    })
    if (restored) ElMessage.warning('演练保存失败，已从完整批次恢复')
    else ElMessage.success(`演练完成：审计记录 ${record.auditCountBefore} → ${record.auditCountAfter}`)
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '演练保存失败，已恢复')
  } finally {
    running.value = false
  }
}

async function replay(receiptId: string) {
  try {
    const result = await store.replayDrill(receiptId)
    if (result.added === 0) {
      ElMessage.info(`回执重放完成：${result.duplicated} 条审计记录已存在，未产生重复记录`)
    } else {
      ElMessage.success(`回执重放恢复 ${result.replayed} 条审计记录`)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重放失败')
  }
}
</script>

<template>
  <div>
    <PageHeader
      title="旁路代路批次"
      description="投运时冻结被代线路、旁路保护、定值基线与适用运行方式；动作序列只能引用这条冻结依据。"
    >
      <template #actions>
        <el-button :disabled="!!activeBatch" @click="openStart">投运旁路代路</el-button>
        <el-button type="primary" :disabled="!activeBatch" @click="finishBatch">代路结束</el-button>
      </template>
    </PageHeader>

    <section v-if="activeBatch && activeBasis" class="panel">
      <div class="panel-title">
        <h3>当前代路依据 · {{ activeBatch.code }}</h3>
        <div>
          <el-tag type="success" effect="dark">投运中 · 冻结修订 R{{ activeBatch.basisRevision }}</el-tag>
        </div>
      </div>
      <el-descriptions :column="3" border>
        <el-descriptions-item label="被代线路">
          {{ deviceName(activeBasis.lineId) }}
        </el-descriptions-item>
        <el-descriptions-item label="旁路保护">
          {{ deviceName(activeBasis.bypassRelayId) }}
        </el-descriptions-item>
        <el-descriptions-item label="旁路断路器">
          {{ activeBasis?.bypassBreakerId ? deviceName(activeBasis.bypassBreakerId) : '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="定值基线">
          {{ data.baselines.find((item) => item.id === activeBasis?.baselineId)?.version ?? '未绑定' }}
        </el-descriptions-item>
        <el-descriptions-item label="适用运行方式">
          <el-tag type="warning" effect="plain">{{ activeBasis.operationMode }}</el-tag>
          <span v-if="currentOperationMode !== activeBasis.operationMode" class="muted">
            （当前方式：{{ currentOperationMode }}，依据已修订）
          </span>
        </el-descriptions-item>
        <el-descriptions-item label="冻结校验码">
          <span class="mono">{{ activeBasis.checksum }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="投运时间" :span="2">
          {{ new Date(activeBatch.startedAt).toLocaleString('zh-CN') }}
        </el-descriptions-item>
        <el-descriptions-item label="冻结说明">{{ activeBasis.note }}</el-descriptions-item>
      </el-descriptions>

      <div class="panel-title" style="margin-top: 16px">
        <h3>冻结定值快照（{{ activeBasis.settingsSnapshot.length }} 条）</h3>
        <span class="muted">改版不影响快照，仅推动冻结修订递增</span>
      </div>
      <el-table :data="activeBasis.settingsSnapshot" size="small">
        <el-table-column label="保护装置" min-width="150">
          <template #default="{ row }">{{ deviceName(row.relayId) }}</template>
        </el-table-column>
        <el-table-column prop="stage" label="段位" width="70" />
        <el-table-column prop="currentA" label="电流(A)" width="90" />
        <el-table-column prop="timeS" label="时限(s)" width="90" />
        <el-table-column prop="direction" label="方向" width="110" />
        <el-table-column label="保护对象" min-width="140">
          <template #default="{ row }">{{ deviceName(row.protectedDeviceId) }}</template>
        </el-table-column>
      </el-table>

      <div v-if="activeBatch.revisionEvents.length" class="panel-title" style="margin-top: 16px">
        <h3>冻结修订轨迹</h3>
      </div>
      <el-timeline v-if="activeBatch.revisionEvents.length">
        <el-timeline-item
          v-for="(event, index) in activeBatch.revisionEvents"
          :key="`${event.fromRevision}-${event.toRevision}-${index}`"
          :timestamp="new Date(event.at).toLocaleString('zh-CN')"
          type="warning"
        >
          <strong>R{{ event.fromRevision }} → R{{ event.toRevision }}</strong>
          <span class="muted">
            · {{ event.reason === 'batch-end' ? '代路结束' : event.reason === 'setting-change' ? '定值改版' : '运行方式切换' }}
          </span>
          <p>{{ event.detail }}</p>
        </el-timeline-item>
      </el-timeline>
    </section>

    <el-alert
      v-else
      title="当前没有投运中的旁路代路批次"
      description="点击「投运旁路代路」冻结被代线路、旁路保护、定值基线与适用运行方式。历史批次见下方清单。"
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 16px"
    />

    <div class="toolbar">
      <span class="muted">当前调度运行方式</span>
      <el-radio-group :model-value="currentOperationMode" @change="switchMode">
        <el-radio-button v-for="mode in operationModes" :key="mode" :value="mode">
          {{ mode }}
        </el-radio-button>
      </el-radio-group>
      <span class="grow" />
      <span class="muted">切换偏离冻结方式时，未会签场景立即失效重算</span>
    </div>

    <section class="panel">
      <div class="panel-title">
        <h3>批次下场景会签</h3>
        <el-tag effect="plain">{{ batchScenarios.length }} 个场景引用冻结依据</el-tag>
      </div>
      <el-table :data="batchScenarios">
        <el-table-column prop="name" label="场景" min-width="210" />
        <el-table-column label="依据修订" width="150">
          <template #default="{ row }">
            <el-tag :type="isFresh(row) ? 'success' : 'danger'" effect="plain" size="small">
              R{{ row.basisRevision ?? '—' }} / R{{ activeBatch?.basisRevision ?? '—' }}
              {{ isFresh(row) ? ' 一致' : ' 已偏离' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" effect="plain">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="270">
          <template #default="{ row }">
            <el-button
              v-if="activeBatch && row.status === 'reviewing' && isFresh(row)"
              type="success"
              size="small"
              @click="approve(row)"
            >
              批准（R{{ activeBatch.basisRevision }}）
            </el-button>
            <el-button
              v-if="activeBatch && ['invalidated', 'draft', 'returned'].includes(row.status)"
              type="warning"
              size="small"
              @click="recompute(row)"
            >
              失效重算
            </el-button>
            <el-button v-if="activeBatch" size="small" @click="openStepDialog(row.id)">
              补动作步骤
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div
        v-for="scenario in batchScenarios.filter((item) => item.reReview)"
        :key="`rr-${scenario.id}`"
        class="panel rereview-box"
      >
        <div class="panel-title">
          <h3>{{ scenario.name }} · 已批准结论保留（{{ statusText(scenario.status) }}）</h3>
          <el-button type="primary" size="small" @click="acknowledge(scenario)">
            已按清单复议完成
          </el-button>
        </div>
        <el-alert
          :title="scenario.reReview!.reason"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom: 10px"
        />
        <p><strong>必须复议的步骤：</strong></p>
        <el-space wrap>
          <el-tag
            v-for="sequence in scenario.reReview!.stepSequences"
            :key="sequence"
            type="danger"
            effect="plain"
          >
            步骤 {{ sequence }}：
            {{ scenario.steps.find((step) => step.sequence === sequence)?.action ?? '动作待核对' }}
          </el-tag>
          <span v-if="!scenario.reReview!.stepSequences.length" class="muted">无需调整动作步骤</span>
        </el-space>
        <p style="margin-top: 10px"><strong>必须核对的停电范围（{{ scenario.reReview!.outageDeviceIds.length }} 台）：</strong></p>
        <el-space wrap>
          <el-tag
            v-for="id in scenario.reReview!.outageDeviceIds"
            :key="id"
            type="warning"
            effect="plain"
          >
            {{ deviceName(id) }}
          </el-tag>
        </el-space>
      </div>
    </section>

    <section class="panel">
      <div class="panel-title">
        <h3>两窗口并发演练</h3>
        <span class="muted">同时提交「代路结束」与「场景批准」，后到动作按冻结修订判断</span>
      </div>
      <div class="toolbar" style="margin-bottom: 12px">
        <span class="muted">到达顺序</span>
        <el-radio-group v-model="drillForm.order">
          <el-radio-button value="end-first">代路结束先到 / 批准后到</el-radio-button>
          <el-radio-button value="approve-first">批准先到 / 代路结束后到</el-radio-button>
        </el-radio-group>
        <el-select v-model="drillForm.scenarioId" placeholder="选择会签中场景" style="width: 260px">
          <el-option
            v-for="scenario in drillCandidates"
            :key="scenario.id"
            :label="scenario.name"
            :value="scenario.id"
          />
        </el-select>
        <el-checkbox v-model="drillForm.failOnPersist">模拟保存失败（从完整演练批次恢复）</el-checkbox>
        <span class="grow" />
        <el-button type="primary" :loading="running" :disabled="!activeBatch" @click="runDrill">
          两窗口同时提交
        </el-button>
      </div>
      <el-table :data="data.drillRuns" size="small">
        <el-table-column prop="receiptId" label="回执号" min-width="180">
          <template #default="{ row }"><span class="mono">{{ row.receiptId }}</span></template>
        </el-table-column>
        <el-table-column label="到达顺序" width="180">
          <template #default="{ row }">
            {{ row.order === 'end-first' ? '结束先到' : '批准先到' }}
          </template>
        </el-table-column>
        <el-table-column label="审计记录" width="110">
          <template #default="{ row }">{{ row.auditCountBefore }} → {{ row.auditCountAfter }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.finished ? 'success' : 'danger'" effect="plain" size="small">
              {{ row.finished ? '已提交' : '失败已恢复' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="outcome" label="结果（先到结果未被覆盖）" min-width="320" />
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button size="small" @click="replay(row.receiptId)">重放回执</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!data.drillRuns.length" description="尚未执行并发演练" :image-size="70" />
    </section>

    <section class="panel">
      <div class="panel-title"><h3>代路批次台账</h3></div>
      <el-table :data="batchHistory" size="small">
        <el-table-column prop="code" label="批次号" width="130" />
        <el-table-column label="被代线路" min-width="150">
          <template #default="{ row }">
            {{ deviceName(data.bypassBases.find((basis) => basis.id === row.basisId)?.lineId ?? '') }}
          </template>
        </el-table-column>
        <el-table-column label="冻结修订" width="100">
          <template #default="{ row }">R{{ row.basisRevision }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain" size="small">
              {{ row.status === 'active' ? '投运中' : '已结束' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="投运/结束时间" min-width="260">
          <template #default="{ row }">
            {{ new Date(row.startedAt).toLocaleString('zh-CN') }}
            <template v-if="row.endedAt">
              → {{ new Date(row.endedAt).toLocaleString('zh-CN') }}
            </template>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="startDialog" title="投运旁路代路批次" width="600px">
      <el-form :model="startForm" label-width="110px">
        <el-form-item label="被代线路" required>
          <el-select v-model="startForm.lineId" filterable style="width: 100%">
            <el-option
              v-for="device in lineDevices"
              :key="device.id"
              :label="`${device.name} (${device.code})`"
              :value="device.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="旁路保护" required>
          <el-select v-model="startForm.bypassRelayId" filterable style="width: 100%">
            <el-option
              v-for="device in relayDevices"
              :key="device.id"
              :label="`${device.name} (${device.code})`"
              :value="device.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="旁路断路器">
          <el-select v-model="startForm.bypassBreakerId" clearable filterable style="width: 100%">
            <el-option
              v-for="device in breakerDevices"
              :key="device.id"
              :label="`${device.name} (${device.code})`"
              :value="device.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="适用运行方式" required>
          <el-select v-model="startForm.operationMode" style="width: 100%">
            <el-option v-for="mode in operationModes" :key="mode" :label="mode" :value="mode" />
          </el-select>
        </el-form-item>
        <el-form-item label="冻结说明">
          <el-input v-model="startForm.note" type="textarea" :rows="3" placeholder="例如 101 线路秋检，旁路代路期间按冻结定值执行" />
        </el-form-item>
        <el-form-item>
          <span class="muted">
            投运即冻结：被代线路与旁路保护定值取当前快照，定值基线取当前锁定版本，
            适用运行方式一并冻结；批次内动作序列只能引用该冻结依据。
          </span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="startDialog = false">取消</el-button>
        <el-button type="primary" @click="submitStart">确认投运并冻结</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="stepDialog" title="补充动作步骤（引用冻结依据）" width="560px">
      <el-form :model="stepForm" label-width="100px">
        <el-form-item label="动作装置" required>
          <el-select v-model="stepForm.relayId" style="width: 100%">
            <el-option
              v-for="id in new Set(activeBasis?.settingsSnapshot.map((item) => item.relayId) ?? [])"
              :key="id"
              :label="deviceName(id)"
              :value="id"
            />          </el-select>
        </el-form-item>
        <el-form-item label="动作描述" required>
          <el-input v-model="stepForm.action" placeholder="例如 II 段延时动作，跳开旁路断路器" />
        </el-form-item>
        <el-form-item label="动作延时(ms)">
          <el-input-number v-model="stepForm.delayMs" :min="0" :step="50" />
        </el-form-item>
        <el-alert
          title="步骤将强制标记为当前冻结依据，装置不在冻结范围内时拒绝保存。"
          type="info"
          :closable="false"
          :inline-title="false"
        />
      </el-form>
      <template #footer>
        <el-button @click="stepDialog = false">取消</el-button>
        <el-button type="primary" @click="submitStep">保存步骤</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.rereview-box {
  margin-top: 14px;
  border-left: 4px solid #d58a27;
}
</style>
