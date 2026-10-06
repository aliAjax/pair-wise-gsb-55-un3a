<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { operationModes } from '@/data/mock'
import type { BypassBatch } from '@/types/domain'

const store = useAppStore()
const { data, devices, scenarios, bypassBatches, currentOperationMode } = storeToRefs(store)

const createDialog = ref(false)
const modeSwitch = ref(currentOperationMode.value)
const form = reactive({
  lineId: '',
  bypassRelayId: '',
  baselineId: '',
  operationModes: [] as string[],
  note: '',
})

const deviceName = (id: string) => devices.value.find((device) => device.id === id)?.name ?? id
const baselineVersion = (id: string) =>
  data.value.baselines.find((item) => item.id === id)?.version ?? id

const lineOptions = computed(() => devices.value.filter((device) => device.kind === 'line'))
const relayOptions = computed(() => devices.value.filter((device) => device.kind === 'relay'))
const lockedBaselines = computed(() =>
  data.value.baselines.filter((item) => item.status === 'locked'),
)
const boundScenarioCount = (batchId: string) =>
  scenarios.value.filter((scenario) => scenario.basisBatchId === batchId).length

async function commission() {
  if (!form.lineId || !form.bypassRelayId || !form.baselineId || !form.operationModes.length) {
    ElMessage.warning('请完整选择被代线路、旁路保护、定值基线和适用运行方式')
    return
  }
  try {
    const batch = await store.commissionBypassBatch({
      lineId: form.lineId,
      bypassRelayId: form.bypassRelayId,
      baselineId: form.baselineId,
      operationModes: [...form.operationModes],
      note: form.note.trim(),
    })
    createDialog.value = false
    Object.assign(form, { lineId: '', bypassRelayId: '', baselineId: '', operationModes: [], note: '' })
    ElMessage.success(`批次 ${batch.code} 已投运，冻结依据生效`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '代路批次投运失败')
  }
}

async function endBatch(batch: BypassBatch) {
  try {
    await ElMessageBox.confirm(
      `结束批次 ${batch.code} 后，引用其冻结依据的未会签场景将立即失效重算，已批准场景保留结论并列入复议。`,
      '结束旁路代路',
      { confirmButtonText: '确认结束', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  try {
    const result = await store.endBypassBatch(batch.id, batch.revision)
    ElMessage.success(
      `批次 ${result.code} 已结束：${result.invalidated} 个未会签场景失效重算，${result.reReview} 个已批准场景列入复议`,
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '结束代路被拒绝')
  }
}

async function switchMode() {
  try {
    const result = await store.switchOperationMode(modeSwitch.value)
    ElMessage.success(
      result.invalidated || result.reReview
        ? `运行方式已切换：${result.invalidated} 个未会签场景失效重算，${result.reReview} 个已批准场景列入复议`
        : '运行方式已切换，不影响在役代路批次',
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '运行方式切换失败')
  }
}
</script>

<template>
  <div>
    <PageHeader
      title="旁路代路批次"
      description="线路检修切旁路代路时，投运即冻结被代线路、旁路保护、定值基线和适用运行方式；场景动作序列只能引用该冻结依据。"
    >
      <template #actions>
        <el-button type="primary" @click="createDialog = true">新建代路批次并投运</el-button>
      </template>
    </PageHeader>

    <div class="toolbar">
      <span class="muted">当前运行方式</span>
      <el-tag effect="plain">{{ currentOperationMode }}</el-tag>
      <el-select v-model="modeSwitch" placeholder="切换为" style="width: 180px">
        <el-option
          v-for="mode in operationModes.filter((item) => item !== currentOperationMode)"
          :key="mode"
          :label="mode"
          :value="mode"
        />
      </el-select>
      <el-button :disabled="!modeSwitch || modeSwitch === currentOperationMode" @click="switchMode">
        切换运行方式
      </el-button>
      <span class="grow" />
      <span class="muted">定值修订 R{{ data.settingsRevision }} · 切换超出冻结适用范围将触发场景失效重算</span>
    </div>

    <section class="panel">
      <div class="panel-title">
        <h3>代路批次清单</h3>
        <el-tag effect="plain">{{ bypassBatches.length }} 个批次</el-tag>
      </div>
      <el-table :data="bypassBatches">
        <el-table-column prop="code" label="批次号" width="125" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'commissioned' ? 'success' : 'info'" effect="plain">
              {{ row.status === 'commissioned' ? '投运中' : '已结束' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="被代线路" min-width="150">
          <template #default="{ row }">{{ deviceName(row.lineId) }}</template>
        </el-table-column>
        <el-table-column label="旁路保护" min-width="130">
          <template #default="{ row }">{{ deviceName(row.bypassRelayId) }}</template>
        </el-table-column>
        <el-table-column label="定值基线" width="95">
          <template #default="{ row }">{{ baselineVersion(row.baselineId) }}</template>
        </el-table-column>
        <el-table-column label="适用运行方式" min-width="200">
          <template #default="{ row }">{{ row.operationModes.join('、') }}</template>
        </el-table-column>
        <el-table-column label="冻结修订" width="85">
          <template #default="{ row }"><span class="mono">R{{ row.revision }}</span></template>
        </el-table-column>
        <el-table-column label="引用场景" width="85">
          <template #default="{ row }">{{ boundScenarioCount(row.id) }} 个</template>
        </el-table-column>
        <el-table-column label="投运时间" width="165">
          <template #default="{ row }">{{ new Date(row.frozenAt).toLocaleString('zh-CN') }}</template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'commissioned'"
              link
              type="danger"
              @click="endBatch(row)"
            >
              结束代路
            </el-button>
            <span v-else class="muted">已归档</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!bypassBatches.length" description="暂无代路批次" :image-size="70" />
    </section>

    <el-dialog v-model="createDialog" title="新建旁路代路批次" width="620px">
      <el-alert
        title="投运即冻结被代线路、旁路保护、定值基线和适用运行方式，此后场景动作序列只能引用该冻结依据。"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      />
      <el-form :model="form" label-width="110px">
        <el-form-item label="被代线路" required>
          <el-select v-model="form.lineId" filterable style="width: 100%">
            <el-option
              v-for="device in lineOptions"
              :key="device.id"
              :label="`${device.name} (${device.code})`"
              :value="device.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="旁路保护" required>
          <el-select v-model="form.bypassRelayId" filterable style="width: 100%">
            <el-option
              v-for="device in relayOptions"
              :key="device.id"
              :label="`${device.name} (${device.code})`"
              :value="device.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="定值基线" required>
          <el-select v-model="form.baselineId" style="width: 100%">
            <el-option
              v-for="baseline in lockedBaselines"
              :key="baseline.id"
              :label="`${baseline.version}（${baseline.note}）`"
              :value="baseline.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="适用运行方式" required>
          <el-select v-model="form.operationModes" multiple style="width: 100%">
            <el-option v-for="mode in operationModes" :key="mode" :label="mode" :value="mode" />
          </el-select>
        </el-form-item>
        <el-form-item label="批次备注">
          <el-input v-model="form.note" type="textarea" :rows="3" placeholder="说明检修范围与代路安排" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" @click="commission">投运并冻结依据</el-button>
      </template>
    </el-dialog>
  </div>
</template>
