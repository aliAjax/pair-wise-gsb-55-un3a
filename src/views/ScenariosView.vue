<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { operationModes } from '@/data/mock'
import { scenarioMatchesBasis } from '@/services/bypass'
import type { ReviewStatus } from '@/types/domain'

const store = useAppStore()
const { devices, scenarios, activeBatch, activeBasis } = storeToRefs(store)
const selectedId = ref(scenarios.value[0]?.id ?? '')
const compareId = ref(scenarios.value[1]?.id ?? '')
const playbackIndex = ref(-1)
const playing = ref(false)
const createDialog = ref(false)
const stepDialog = ref(false)
let playbackTimer: number | undefined

const form = reactive({
  name: '',
  operationMode: operationModes[0],
  faultDeviceId: '',
  faultType: '单相接地',
  outageDevices: [] as string[],
  notes: '',
})

const stepForm = reactive({ relayId: '', action: '', delayMs: 100 })

const selected = computed(() => scenarios.value.find((item) => item.id === selectedId.value))
const compared = computed(() => scenarios.value.find((item) => item.id === compareId.value))

const selectedBasis = computed(() => {
  if (!selected.value?.freezeBasisId) return undefined
  return store.data.bypassBases.find((basis) => basis.id === selected.value!.freezeBasisId)
})

const selectedBatch = computed(() =>
  selectedBasis.value
    ? store.data.bypassBatches.find((batch) => batch.basisId === selectedBasis.value!.id)
    : undefined,
)

const basisFresh = computed(() =>
  selected.value ? scenarioMatchesBasis(store.data, selected.value) : false,
)

const statusText = (status: ReviewStatus) =>
  ({
    draft: '草稿',
    reviewing: '会签中',
    approved: '已批准',
    locked: '已锁定',
    returned: '已退回',
    invalidated: '已失效待重算',
  })[status]

const statusType = (status: ReviewStatus) =>
  status === 'approved' || status === 'locked'
    ? 'success'
    : status === 'reviewing'
      ? 'warning'
      : status === 'returned'
        ? 'danger'
        : status === 'invalidated'
          ? 'danger'
          : 'info'

const outageDiff = computed(() => {
  if (!selected.value || !compared.value) return { leftOnly: [], rightOnly: [] }
  return {
    leftOnly: selected.value.outageDevices.filter(
      (id) => !compared.value?.outageDevices.includes(id),
    ),
    rightOnly: compared.value.outageDevices.filter(
      (id) => !selected.value?.outageDevices.includes(id),
    ),
  }
})

watch(scenarios, (list) => {
  if (!list.some((item) => item.id === selectedId.value)) selectedId.value = list[0]?.id ?? ''
  if (!list.some((item) => item.id === compareId.value)) {
    compareId.value = list.find((item) => item.id !== selectedId.value)?.id ?? ''
  }
})

function deviceName(id: string) {
  return devices.value.find((item) => item.id === id)?.name ?? id
}

function stopPlayback() {
  if (playbackTimer) window.clearInterval(playbackTimer)
  playbackTimer = undefined
  playing.value = false
}

function replay() {
  stopPlayback()
  if (!selected.value?.steps.length) {
    ElMessage.warning('当前场景尚未配置动作序列')
    return
  }
  playbackIndex.value = -1
  playing.value = true
  playbackTimer = window.setInterval(() => {
    const next = playbackIndex.value + 1
    if (!selected.value || next >= selected.value.steps.length) {
      stopPlayback()
      return
    }
    playbackIndex.value = next
  }, 700)
}

async function changeStatus(status: ReviewStatus) {
  if (!selected.value) return
  await store.updateScenarioStatus(selected.value.id, status)
  ElMessage.success(`场景状态已更新为${statusText(status)}`)
}

async function approve() {
  if (!selected.value) return
  try {
    const decision = await store.approveScenario(
      selected.value.id,
      selectedBatch.value?.basisRevision,
    )
    ElMessage[decision.accepted ? 'success' : 'warning'](decision.reason)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '批准失败')
  }
}

async function recompute() {
  if (!selected.value) return
  try {
    await store.recomputeScenario(selected.value.id)
    ElMessage.success('已按当前冻结依据重算并重新提交会签')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重算失败')
  }
}

async function acknowledgeReReview() {
  if (!selected.value) return
  await store.acknowledgeReReview(selected.value.id)
  ElMessage.success('复议项已确认，原批准结论维持')
}

function openStepDialog() {
  const inScopeRelays = selectedBasis.value
    ? [...new Set(selectedBasis.value.settingsSnapshot.map((item) => item.relayId))]
    : []
  stepForm.relayId = inScopeRelays[0] ?? ''
  stepForm.action = ''
  stepForm.delayMs = 100
  stepDialog.value = true
}

async function submitStep() {
  if (!selected.value || !stepForm.action.trim()) {
    ElMessage.warning('请填写动作描述')
    return
  }
  try {
    await store.addScenarioStep(selected.value.id, {
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

async function createScenario() {
  if (!form.name.trim() || !form.faultDeviceId) {
    ElMessage.warning('请填写场景名称并选择故障设备')
    return
  }
  const created = await store.addScenario({
    name: form.name.trim(),
    operationMode: form.operationMode,
    faultDeviceId: form.faultDeviceId,
    faultType: form.faultType,
    outageDevices: [...form.outageDevices],
    notes: form.notes,
  })
  selectedId.value = created.id
  createDialog.value = false
  Object.assign(form, {
    name: '',
    operationMode: operationModes[0],
    faultDeviceId: '',
    faultType: '单相接地',
    outageDevices: [],
    notes: '',
  })
  ElMessage.success('故障场景已创建')
}

const inScopeRelayIds = computed(() =>
  selectedBasis.value
    ? [...new Set(selectedBasis.value.settingsSnapshot.map((item) => item.relayId))]
    : [],
)

onBeforeUnmount(stopPlayback)
</script>

<template>
  <div>
    <PageHeader
      title="运行方式与故障场景"
      description="建立多个运行方式和故障场景，比较保护动作顺序与停电范围；代路批次下动作序列只能引用冻结依据。"
    >
      <template #actions>
        <el-button :disabled="!selected || playing" @click="replay">异常场景回放</el-button>
        <el-button type="primary" @click="createDialog = true">新建场景</el-button>
      </template>
    </PageHeader>

    <div class="toolbar">
      <el-select v-model="selectedId" placeholder="选择场景" style="width: 330px">
        <el-option v-for="scenario in scenarios" :key="scenario.id" :label="scenario.name" :value="scenario.id" />
      </el-select>
      <span class="muted">对比场景</span>
      <el-select v-model="compareId" clearable placeholder="选择对比场景" style="width: 300px">
        <el-option
          v-for="scenario in scenarios.filter((item) => item.id !== selectedId)"
          :key="scenario.id"
          :label="scenario.name"
          :value="scenario.id"
        />
      </el-select>
      <span class="grow" />
      <el-tag v-if="selected" :type="statusType(selected.status)" effect="plain">
        {{ statusText(selected.status) }}
      </el-tag>
    </div>

    <div v-if="selected" class="two-column">
      <section class="panel">
        <div class="panel-title">
          <div>
            <h3>{{ selected.name }}</h3>
            <span class="muted">{{ selected.operationMode }} · {{ selected.faultType }}</span>
          </div>
          <div>
            <template v-if="selected.freezeBasisId && selectedBatch && selectedBasis">
              <el-button
                v-if="selectedBatch.status === 'active' && ['invalidated', 'draft', 'returned'].includes(selected.status)"
                type="warning"
                @click="recompute"
              >
                按冻结依据重算
              </el-button>
              <el-button
                v-if="selectedBatch.status === 'active' && selected.status === 'reviewing'"
                :type="basisFresh ? 'success' : 'warning'"
                :disabled="!basisFresh"
                @click="approve"
              >
                {{ basisFresh ? `批准场景（R${selectedBatch.basisRevision}）` : '依据已偏离，请重算' }}
              </el-button>
              <el-button v-if="selectedBatch.status === 'active'" @click="openStepDialog">
                补动作步骤
              </el-button>
            </template>
            <template v-else>
              <el-button
                v-if="selected.status === 'draft' || selected.status === 'returned'"
                type="primary"
                @click="changeStatus('reviewing')"
              >
                提交会签
              </el-button>
              <template v-if="selected.status === 'reviewing'">
                <el-button type="success" @click="changeStatus('approved')">批准场景</el-button>
                <el-button type="danger" plain @click="changeStatus('returned')">退回补充</el-button>
              </template>
            </template>
          </div>
        </div>

        <el-alert
          v-if="selected.freezeBasisId && selectedBasis && selectedBatch"
          :title="`当前代路依据：${selectedBatch.code ?? ''} · ${deviceName(selectedBasis.lineId)} · 旁路保护 ${deviceName(selectedBasis.bypassRelayId)}`"
          :description="`定值基线 ${store.data.baselines.find((item) => item.id === selectedBasis?.baselineId)?.version ?? '未绑定'} · 适用方式 ${selectedBasis?.operationMode} · 修订 R${selected.basisRevision ?? 1}/R${selectedBatch?.basisRevision} · 校验码 ${selectedBasis?.checksum}${basisFresh ? '（一致）' : '（已偏离，未会签场景需重算）'}`"
          :type="basisFresh ? 'success' : 'error'"
          :closable="false"
          show-icon
          style="margin-bottom: 14px"
        />
        <el-alert
          v-else-if="activeBasis && activeBatch"
          title="该场景未绑定当前投运中的旁路代路批次，动作序列不引用冻结依据。"
          type="info"
          :closable="false"
          show-icon
          style="margin-bottom: 14px"
        />

        <el-alert
          v-if="selected.status === 'invalidated'"
          title="场景已失效：代路结束、定值改版或运行方式切换后冻结依据已修订，请重算后再会签。"
          type="error"
          :closable="false"
          show-icon
          style="margin-bottom: 14px"
        />

        <el-timeline>
          <el-timeline-item
            v-for="(step, index) in selected.steps"
            :key="`${step.sequence}-${step.relayId}`"
            :timestamp="`${step.delayMs} ms`"
            :type="playbackIndex >= index ? 'success' : 'info'"
            :hollow="playbackIndex < index"
          >
            <div :class="{ 'step-active': playbackIndex === index }">
              <strong>{{ step.sequence }}. {{ deviceName(step.relayId) }}</strong>
              <p>{{ step.action }}</p>
              <el-space>
                <el-tag size="small" effect="plain">
                  {{ step.status === 'executed' ? '已执行' : step.status === 'skipped' ? '跳过' : '待确认' }}
                </el-tag>
                <el-tag
                  v-if="step.basisId"
                  size="small"
                  :type="step.basisId === selectedBasis?.id ? 'success' : 'danger'"
                  effect="plain"
                >
                  依据 {{ step.basisId === selectedBasis?.id ? `${selectedBatch?.code} R${selected.basisRevision ?? 1}` : step.basisId }}
                </el-tag>
              </el-space>
            </div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-if="!selected.steps.length" description="新建场景暂无动作序列，请在后续编辑器中补充" />

        <div v-if="selected.reReview" class="rereview-box">
          <div class="panel-title">
            <h3>已批准原结论保留 · 必须复议清单</h3>
            <el-button type="primary" size="small" @click="acknowledgeReReview">
              已按清单复议完成
            </el-button>
          </div>
          <el-alert :title="selected.reReview.reason" type="warning" :closable="false" show-icon />
          <p style="margin-top: 10px"><strong>必须复议的步骤：</strong></p>
          <el-space wrap>
            <el-tag
              v-for="sequence in selected.reReview.stepSequences"
              :key="sequence"
              type="danger"
              effect="plain"
            >
              步骤 {{ sequence }}：
              {{ selected.steps.find((step) => step.sequence === sequence)?.action ?? '动作待核对' }}
            </el-tag>
            <span v-if="!selected.reReview.stepSequences.length" class="muted">无需调整动作步骤</span>
          </el-space>
          <p style="margin-top: 10px"><strong>必须核对的停电范围（{{ selected.reReview.outageDeviceIds.length }} 台）：</strong></p>
          <el-space wrap>
            <el-tag v-for="id in selected.reReview.outageDeviceIds" :key="id" type="warning" effect="plain">
              {{ deviceName(id) }}
            </el-tag>
          </el-space>
        </div>

        <div class="panel-title" style="margin-top: 20px">
          <h3>停电范围</h3>
          <el-tag type="warning" effect="plain">{{ selected.outageDevices.length }} 台设备</el-tag>
        </div>
        <el-space wrap>
          <el-tag v-for="id in selected.outageDevices" :key="id" effect="plain">
            {{ deviceName(id) }}
          </el-tag>
        </el-space>
        <p class="muted">{{ selected.notes || '暂无审校备注。' }}</p>
      </section>

      <section class="panel">
        <div class="panel-title"><h3>场景差异</h3></div>
        <template v-if="compared">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="当前动作数">{{ selected.steps.length }}</el-descriptions-item>
            <el-descriptions-item label="对比动作数">{{ compared.steps.length }}</el-descriptions-item>
            <el-descriptions-item label="当前停电数">{{ selected.outageDevices.length }}</el-descriptions-item>
            <el-descriptions-item label="对比停电数">{{ compared.outageDevices.length }}</el-descriptions-item>
          </el-descriptions>
          <h4>仅当前场景停电</h4>
          <el-alert
            v-for="id in outageDiff.leftOnly"
            :key="id"
            :title="deviceName(id)"
            type="warning"
            :closable="false"
          />
          <el-empty v-if="!outageDiff.leftOnly.length" description="无差异" :image-size="60" />
          <h4>仅对比场景停电</h4>
          <el-alert
            v-for="id in outageDiff.rightOnly"
            :key="id"
            :title="deviceName(id)"
            type="info"
            :closable="false"
          />
          <el-empty v-if="!outageDiff.rightOnly.length" description="无差异" :image-size="60" />
        </template>
        <el-empty v-else description="请选择对比场景" />
      </section>
    </div>

    <el-dialog v-model="createDialog" title="新建故障场景" width="620px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="场景名称" required>
          <el-input v-model="form.name" placeholder="例如 110kV 母线故障且 1 号主变检修" />
        </el-form-item>
        <el-form-item label="运行方式" required>
          <el-select v-model="form.operationMode" style="width: 100%">
            <el-option v-for="mode in operationModes" :key="mode" :label="mode" :value="mode" />
          </el-select>
        </el-form-item>
        <el-form-item label="故障设备" required>
          <el-select v-model="form.faultDeviceId" filterable style="width: 100%">
            <el-option
              v-for="device in devices.filter((item) => ['line', 'transformer', 'bus'].includes(item.kind))"
              :key="device.id"
              :label="`${device.name} (${device.code})`"
              :value="device.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="故障类型">
          <el-select v-model="form.faultType" style="width: 100%">
            <el-option label="单相接地" value="单相接地" />
            <el-option label="相间短路" value="相间短路" />
            <el-option label="母线短路" value="母线短路" />
            <el-option label="设备拒动" value="设备拒动" />
          </el-select>
        </el-form-item>
        <el-form-item label="停电范围">
          <el-select v-model="form.outageDevices" multiple filterable style="width: 100%">
            <el-option
              v-for="device in devices.filter((item) => item.kind !== 'relay')"
              :key="device.id"
              :label="device.name"
              :value="device.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="审校备注">
          <el-input v-model="form.notes" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" @click="createScenario">创建场景</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="stepDialog" title="补充动作步骤（引用冻结依据）" width="560px">
      <el-form :model="stepForm" label-width="100px">
        <el-form-item label="动作装置" required>
          <el-select v-model="stepForm.relayId" style="width: 100%">
            <el-option
              v-for="id in inScopeRelayIds"
              :key="id"
              :label="deviceName(id)"
              :value="id"
            />
          </el-select>
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
  padding: 14px;
  margin-top: 16px;
  background: #fdf8f0;
  border: 1px solid #e8c98f;
  border-left: 4px solid #d58a27;
  border-radius: 5px;
}
</style>
