<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import PageHeader from '@/components/PageHeader.vue'
import IssueTable from '@/components/IssueTable.vue'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const store = useAppStore()
const { data, issues, devices, scenarios, activeBaseline, activeBatch, activeBasis } =
  storeToRefs(store)

const highIssues = computed(() => issues.value.filter((issue) => issue.level === 'high'))
const runningDevices = computed(() => devices.value.filter((device) => device.status === 'running').length)
const approvedScenarios = computed(
  () => scenarios.value.filter((scenario) => ['approved', 'locked'].includes(scenario.status)).length,
)
const invalidatedScenarios = computed(
  () => scenarios.value.filter((scenario) => scenario.status === 'invalidated').length,
)
const pendingReReview = computed(
  () => scenarios.value.filter((scenario) => scenario.reReview).length,
)
const batchScenarios = computed(() =>
  activeBasis.value
    ? scenarios.value.filter((scenario) => scenario.freezeBasisId === activeBasis.value!.id)
    : [],
)

const deviceName = (id: string) => devices.value.find((device) => device.id === id)?.name ?? id

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
    invalidated: '已失效待重算',
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

    <section v-if="activeBatch && activeBasis" class="panel bypass-banner">
      <div class="panel-title">
        <h3>当前旁路代路依据 · {{ activeBatch.code }}</h3>
        <div>
          <el-tag type="danger" effect="plain" v-if="invalidatedScenarios">
            {{ invalidatedScenarios }} 个场景失效待重算
          </el-tag>
          <el-tag type="warning" effect="plain" v-if="pendingReReview" style="margin-left: 8px">
            {{ pendingReReview }} 个已批准场景待复议
          </el-tag>
          <el-button text type="primary" @click="router.push('/bypass')">进入批次处理</el-button>
        </div>
      </div>
      <el-descriptions :column="4" border size="small">
        <el-descriptions-item label="被代线路">
          {{ deviceName(activeBasis.lineId) }}
        </el-descriptions-item>
        <el-descriptions-item label="旁路保护">
          {{ deviceName(activeBasis.bypassRelayId) }}
        </el-descriptions-item>
        <el-descriptions-item label="定值基线">
          {{ data.baselines.find((item) => item.id === activeBasis?.baselineId)?.version ?? '未绑定' }}
        </el-descriptions-item>
        <el-descriptions-item label="适用运行方式">
          {{ activeBasis.operationMode }}
          <span v-if="data.currentOperationMode !== activeBasis.operationMode" class="danger-text">
            （当前 {{ data.currentOperationMode }}）
          </span>
        </el-descriptions-item>
        <el-descriptions-item label="冻结修订">
          R{{ activeBatch.basisRevision }}
        </el-descriptions-item>
        <el-descriptions-item label="冻结定值">
          {{ activeBasis.settingsSnapshot.length }} 条
        </el-descriptions-item>
        <el-descriptions-item label="校验码">
          <span class="mono">{{ activeBasis?.checksum }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="批次场景">
          {{ batchScenarios.length }} 个引用该依据
        </el-descriptions-item>
      </el-descriptions>
    </section>

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
          <el-table-column prop="operationMode" label="运行方式" width="110" />
          <el-table-column label="代路依据" width="110">
            <template #default="{ row }">
              <el-tag v-if="row.freezeBasisId" size="small" type="primary" effect="plain">
                R{{ row.basisRevision ?? 1 }}
              </el-tag>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
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
