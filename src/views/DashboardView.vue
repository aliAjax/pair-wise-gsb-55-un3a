<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import PageHeader from '@/components/PageHeader.vue'
import IssueTable from '@/components/IssueTable.vue'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const store = useAppStore()
const { data, issues, devices, scenarios, activeBaseline, activeBatches } = storeToRefs(store)

const highIssues = computed(() => issues.value.filter((issue) => issue.level === 'high'))
const runningDevices = computed(() => devices.value.filter((device) => device.status === 'running').length)
const approvedScenarios = computed(
  () => scenarios.value.filter((scenario) => ['approved', 'locked'].includes(scenario.status)).length,
)
const invalidatedScenarios = computed(
  () => scenarios.value.filter((scenario) => scenario.status === 'invalidated').length,
)

const deviceName = (id: string) => devices.value.find((device) => device.id === id)?.name ?? id
const baselineVersion = (id: string) =>
  data.value.baselines.find((item) => item.id === id)?.version ?? id
const batchCode = (id?: string) =>
  id ? (data.value.bypassBatches.find((item) => item.id === id)?.code ?? '—') : '—'

const statusType = (status: string) =>
  status === 'approved' || status === 'locked'
    ? 'success'
    : status === 'reviewing'
      ? 'warning'
      : status === 'returned' || status === 'invalidated'
        ? 'danger'
        : 'info'

const statusText = (status: string) =>
  ({
    draft: '草稿',
    reviewing: '会签中',
    approved: '已批准',
    locked: '已锁定',
    returned: '已退回',
    invalidated: '已失效',
  })[status] ?? status
</script>

<template>
  <div>
    <PageHeader
      title="运行总览"
      description="聚焦保护配合异常、场景验证和当前可执行基线。全部数据保存在当前浏览器。"
    >
      <template #actions>
        <el-button @click="router.push('/coordination')">进入配合校核</el-button>
        <el-button type="primary" @click="router.push('/scenarios')">验证故障场景</el-button>
      </template>
    </PageHeader>

    <section class="metric-grid">
      <div class="metric danger">
        <span>高风险问题</span>
        <strong>{{ highIssues.length }}</strong>
        <small>需在基线锁定前关闭</small>
      </div>
      <div class="metric info">
        <span>运行设备</span>
        <strong>{{ runningDevices }} / {{ devices.length }}</strong>
        <small>线路、变压器、母线、断路器与保护</small>
      </div>
      <div class="metric warning">
        <span>已验证场景</span>
        <strong>{{ approvedScenarios }} / {{ scenarios.length }}</strong>
        <small>含已批准和已锁定场景</small>
      </div>
      <div class="metric">
        <span>当前基线</span>
        <strong>{{ activeBaseline?.version ?? 'V1.0' }}</strong>
        <small>{{ activeBaseline?.checksum ?? 'A5F1-927C' }}</small>
      </div>
    </section>

    <section class="panel">
      <div class="panel-title">
        <h3>旁路代路依据</h3>
        <div>
          <el-tag v-if="invalidatedScenarios" type="danger" effect="plain" style="margin-right: 8px">
            {{ invalidatedScenarios }} 个场景已失效待重算
          </el-tag>
          <el-button text type="primary" @click="router.push('/bypass')">管理代路批次</el-button>
        </div>
      </div>
      <el-table v-if="activeBatches.length" :data="activeBatches">
        <el-table-column prop="code" label="批次号" width="125" />
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
        <el-table-column label="冻结修订" width="90">
          <template #default="{ row }"><span class="mono">R{{ row.revision }}</span></template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="当前无在役代路批次" :image-size="60" />
    </section>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>待处理校验问题</h3>
          <el-button text type="primary" @click="router.push('/coordination')">查看全部</el-button>
        </div>
        <IssueTable
          :issues="issues.slice(0, 6)"
          :devices="devices"
          compact
          @select="router.push('/coordination')"
        />
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>场景审校进度</h3>
          <el-tag effect="plain">{{ scenarios.length }} 个场景</el-tag>
        </div>
        <el-table :data="scenarios" max-height="320">
          <el-table-column prop="name" label="场景" min-width="190" />
          <el-table-column prop="operationMode" label="运行方式" width="120" />
          <el-table-column label="代路依据" width="115">
            <template #default="{ row }">
              <span v-if="row.basisBatchId" class="mono">{{ batchCode(row.basisBatchId) }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="statusType(row.status)" effect="plain">
                {{ statusText(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>

    <section class="panel">
      <div class="panel-title">
        <h3>近期审计轨迹</h3>
        <el-tag effect="plain">只读时间线</el-tag>
      </div>
      <el-timeline>
        <el-timeline-item
          v-for="entry in data.audit.slice(0, 5)"
          :key="entry.id"
          :timestamp="new Date(entry.createdAt).toLocaleString('zh-CN')"
          placement="top"
        >
          <strong>{{ entry.action }}</strong>
          <span class="muted"> · {{ entry.target }} · {{ entry.operator }}</span>
          <p>{{ entry.detail }}</p>
        </el-timeline-item>
      </el-timeline>
    </section>
  </div>
</template>
