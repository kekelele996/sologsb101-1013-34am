<script setup lang="ts">
/**
 * 模块 3：/sites/:id/belts 样带布设
 * 录长度/朝向/调查日期并回显已录记录数；朝向排序校验，深链访问时站位不存在给出友好空态。
 * 复用 <StatBadge>、<EmptyPanel>。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Right, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import BleachTag from '@/components/common/BleachTag.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { ORIENTATION_ORDER, diffBeltFields, useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { BELT_LENGTH_PRESETS, ORIENTATIONS, normalizeVersion } from '@/types/belt'
import type { Belt, Orientation } from '@/types/belt'
import type { BeltFieldChange } from '@/stores/beltStore'
import { bleachGrade, bleachIndex, coralCoveragePct, fishDensity } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()

const siteId = computed(() => String(route.params.id ?? ''))
const site = computed(() => reefStore.siteById(siteId.value))
const reef = computed(() => (site.value ? reefStore.reefById(site.value.reefId) : null))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  no: '',
  lengthM: 50,
  orientation: '北' as Orientation,
  surveyDate: new Date().toISOString().slice(0, 10),
  observer: ''
})

/** 编辑时打开的样带快照（含看到的版本号），提交时按它做乐观并发检查 */
const editingSeen = ref<Belt | null>(null)
/** 保存冲突时库中的最新行 */
const conflictVisible = ref(false)
const conflictServer = ref<Belt | null>(null)
/** 冲突后只列出被他人更新过的字段（不整条盖回） */
const conflictChanges = ref<BeltFieldChange[]>([])

/** 编辑弹窗开着时，样带是否已被他人先改过（liveQuery 推送后实时可见） */
const editingStale = computed(() => {
  const seen = editingSeen.value
  if (!seen || !dialogVisible.value) return false
  const server = beltStore.beltById(seen.id)
  return !!server && normalizeVersion(server.version) !== normalizeVersion(seen.version)
})

/** 弹窗打开期间实时拉到的「他人改动字段」 */
const editingChanges = computed<BeltFieldChange[]>(() => {
  const seen = editingSeen.value
  if (!seen || !editingStale.value) return []
  const server = beltStore.beltById(seen.id)
  return server ? diffBeltFields(seen, server) : []
})

/** 样带行：回显珊瑚记录数、鱼类记录数、覆盖率与白化指数 */
const rows = computed(() =>
  beltStore.beltsOfSite(siteId.value).map((belt) => {
    const corals = surveyStore.coralsOfBelt(belt.id)
    const fishes = surveyStore.fishesOfBelt(belt.id)
    const coverCmTotal = corals.reduce((sum, coral) => sum + coral.coverCm, 0)
    const index = bleachIndex(corals)
    const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
    return {
      belt,
      coralCount: corals.length,
      fishCount: fishes.length,
      coverCmTotal,
      coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
      bleachIndex: index,
      grade: bleachGrade(index),
      fishDensity: fishDensity(fishTotal, belt.lengthM)
    }
  })
)

const conflicts = computed(() => beltStore.findBeltConflicts(siteId.value))

const stats = computed(() => {
  const belts = beltStore.beltsOfSite(siteId.value)
  const totalLength = belts.reduce((sum, belt) => sum + belt.lengthM, 0)
  const coralCount = belts.reduce((sum, belt) => sum + surveyStore.coralsOfBelt(belt.id).length, 0)
  const fishCount = belts.reduce((sum, belt) => sum + surveyStore.fishesOfBelt(belt.id).length, 0)
  return {
    beltCount: belts.length,
    totalLength,
    coralCount,
    fishCount,
    orientationCount: new Set(belts.map((belt) => belt.orientation)).size
  }
})

function nextNo(): string {
  const numbers = beltStore
    .beltsOfSite(siteId.value)
    .map((belt) => Number(belt.no.replace(/[^0-9]/g, '')))
    .filter((value) => Number.isFinite(value))
  const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1
  return `T-${String(next).padStart(2, '0')}`
}

function openCreate(): void {
  editingId.value = null
  const existing = beltStore.beltsOfSite(siteId.value)
  form.no = nextNo()
  form.lengthM = existing[0]?.lengthM ?? 50
  form.orientation = ORIENTATIONS[existing.length % ORIENTATIONS.length]
  form.surveyDate = new Date().toISOString().slice(0, 10)
  form.observer = existing[0]?.observer ?? ''
  dialogVisible.value = true
}

function openEdit(belt: Belt): void {
  editingId.value = belt.id
  // 拍下打开时的快照（含版本号）：提交时据此做乐观并发检查
  editingSeen.value = { ...belt }
  form.no = belt.no
  form.lengthM = belt.lengthM
  form.orientation = belt.orientation
  form.surveyDate = belt.surveyDate
  form.observer = belt.observer
  conflictVisible.value = false
  conflictServer.value = null
  dialogVisible.value = true
}

/** 采用对方已保存的最新值：刷新表单与看到的版本，不覆盖对方修改 */
function adoptConflict(): void {
  const server = conflictServer.value
  if (!server) return
  form.no = server.no
  form.lengthM = server.lengthM
  form.orientation = server.orientation
  form.surveyDate = server.surveyDate
  form.observer = server.observer
  editingSeen.value = { ...server }
  conflictVisible.value = false
  conflictServer.value = null
  conflictChanges.value = []
  ElMessage.info('已采用对方更新后的值，可在核对后再次保存')
}

/** 保存成功后提示：长度变短会导致部分珊瑚记录超出新长度，需去珊瑚计数页重核 */
function warnOverLengthAfterSave(belt: Belt): void {
  const overLength = surveyStore
    .coralsOfBelt(belt.id)
    .filter((coral) => coral.coverCm > belt.lengthM * 100)
  if (overLength.length > 0) {
    ElMessageBox.alert(
      `样带长度已改为 ${belt.lengthM} m，覆盖度已按新长度重算；有 ${overLength.length} 条珊瑚记录超出新长度（>${belt.lengthM * 100} cm），请到「珊瑚计数」页逐条重核覆盖长度。`,
      '珊瑚记录需重核',
      { type: 'warning', confirmButtonText: '知道了' }
    )
  }
}

async function submitForm(): Promise<void> {
  if (!form.no.trim()) {
    ElMessage.warning('请填写样带编号')
    return
  }
  if (!Number.isFinite(form.lengthM) || form.lengthM <= 0) {
    ElMessage.warning('样带长度应为大于 0 的数字（m）')
    return
  }
  if (!form.surveyDate) {
    ElMessage.warning('请选择调查日期')
    return
  }
  const duplicated = beltStore
    .beltsOfSite(siteId.value)
    .some((belt) => belt.no === form.no.trim() && belt.orientation === form.orientation && belt.id !== editingId.value)
  if (duplicated) {
    ElMessage.warning(`同一朝向（${form.orientation}）下样带编号「${form.no.trim()}」已存在`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      no: form.no.trim(),
      lengthM: form.lengthM,
      orientation: form.orientation,
      surveyDate: form.surveyDate,
      observer: form.observer.trim()
    }
    if (editingId.value && editingSeen.value) {
      // 提交时带上自己看到的版本：别人先动过则只返回被更新的字段，不整条盖回
      const result = await beltStore.saveBeltWithVersion(editingId.value, payload, editingSeen.value)
      if (result.status === 'conflict') {
        conflictServer.value = result.server
        conflictChanges.value = result.changes
        conflictVisible.value = true
        return
      }
      if (result.status === 'missing') {
        ElMessage.warning('该样带已被他人删除')
        dialogVisible.value = false
        return
      }
      ElMessage.success('样带已更新')
      dialogVisible.value = false
      warnOverLengthAfterSave(result.belt)
    } else {
      const created = await beltStore.createBelt(siteId.value, payload)
      beltStore.selectBelt(created.id)
      ElMessage.success(`样带 ${created.no}（${created.orientation}向 ${created.lengthM} m）已布设，可录入底质与珊瑚计数`)
      dialogVisible.value = false
    }
  } finally {
    submitting.value = false
  }
}

async function removeBelt(belt: Belt): Promise<void> {
  const counts = surveyStore.beltRecordCounts[belt.id] ?? { coralCount: 0, fishCount: 0 }
  try {
    await ElMessageBox.confirm(
      `删除样带「${belt.no}」将同时删除其 ${counts.coralCount} 条珊瑚记录与 ${counts.fishCount} 条计数记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await beltStore.removeBelt(belt.id)
  ElMessage.success('样带及其记录已删除')
}

async function applyOrientationOrder(): Promise<void> {
  const belts = beltStore.beltsOfSite(siteId.value)
  if (belts.length === 0) {
    ElMessage.warning('当前站位还没有样带')
    return
  }
  const ordered = [...belts].sort(
    (a, b) => ORIENTATION_ORDER[a.orientation] - ORIENTATION_ORDER[b.orientation]
  )
  ElMessage.success(
    `朝向排序校验通过：${ordered.map((belt) => `${belt.orientation}向 ${belt.no}`).join(' → ')}`
  )
}

function gotoCorals(belt: Belt): void {
  beltStore.selectBelt(belt.id)
  void router.push(`/belts/${belt.id}/corals`)
}

function gotoFishes(belt: Belt): void {
  beltStore.selectBelt(belt.id)
  void router.push(`/belts/${belt.id}/fishes`)
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
  if (site.value) reefStore.selectSite(site.value.id)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!reefStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!site"
      entity-label="站位"
      :missing-id="siteId"
      fallback-path="/reefs"
      fallback-text="返回礁区台账"
      :candidates="
        reefStore.sites.slice(0, 3).map((item) => ({
          id: item.id,
          label: `站位 ${item.no} 的样带`,
          path: `/sites/${item.id}/belts`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/reefs' }">礁区台账</el-breadcrumb-item>
            <el-breadcrumb-item v-if="reef" :to="{ path: `/reefs/${reef.id}/sites` }">{{ reef.name }} 站位</el-breadcrumb-item>
            <el-breadcrumb-item>样带布设</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            站位 {{ site.no }} · 样带布设
            <el-tag size="small" effect="plain">水深 {{ site.depthM }} m</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ site.substrate }}</el-tag>
          </h2>
          <p class="gb-hint">
            布设样带后录入长度、朝向与调查日期；同朝向内样带编号不可重复，列表按北 → 东 → 南 → 西排序。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="Warning" @click="applyOrientationOrder">朝向排序校验</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增样带</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="样带条数" :value="stats.beltCount" suffix="条" icon="Files" />
        <StatBadge label="累计长度" :value="stats.totalLength" suffix="m" tone="info" icon="Odometer" />
        <StatBadge label="珊瑚记录" :value="stats.coralCount" suffix="条" tone="success" icon="Histogram" />
        <StatBadge label="计数记录" :value="stats.fishCount" suffix="条" tone="warning" icon="DataLine" />
      </div>

      <el-alert
        v-if="conflicts.length > 0"
        type="warning"
        show-icon
        :closable="false"
        :title="`朝向排序校验提示：${conflicts.join('、')} 存在重复编号，请调整后再开展普查`"
      />

      <EmptyPanel
        v-if="rows.length === 0"
        title="该站位还没有样带"
        description="新增第一条样带并录入长度与朝向，随后即可录入底质、珊瑚分类覆盖与鱼类计数。"
        action-text="新增样带"
        @action="openCreate"
      />

      <el-table v-else :data="rows" border stripe class="gb-table-compact">
        <el-table-column label="样带编号" width="110">
          <template #default="{ row }">
            {{ row.belt.no }}
            <div class="gb-hint">v{{ normalizeVersion(row.belt.version) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="朝向" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.belt.orientation }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="长度 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.belt.lengthM }}</span>
          </template>
        </el-table-column>
        <el-table-column label="调查日期" width="130">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.belt.surveyDate }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="belt.observer" label="调查人" width="110" />
        <el-table-column label="珊瑚记录" width="120" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoCorals(row.belt)">
              {{ row.coralCount }} 条
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="鱼类计数" width="120" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoFishes(row.belt)">
              {{ row.fishCount }} 条
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="珊瑚覆盖率" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coveragePct }}%</span>
            <div class="gb-hint gb-mono">{{ row.coverCmTotal }} cm</div>
          </template>
        </el-table-column>
        <el-table-column label="白化" width="150">
          <template #default="{ row }">
            <BleachTag :level="row.grade" size="small" />
            <div class="gb-hint gb-mono">指数 {{ row.bleachIndex }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" @click="gotoCorals(row.belt)">珊瑚</el-button>
            <el-button size="small" @click="gotoFishes(row.belt)">鱼类</el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row.belt)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeBelt(row.belt)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无样带" description="点击右上角「新增样带」开始布设。" compact />
        </template>
      </el-table>
    </template>

    <el-dialog v-model="dialogVisible" width="540px" :close-on-click-modal="false">
      <template #title>
        {{ editingId ? '编辑样带' : '布设样带' }}
        <el-tag v-if="editingId && editingSeen" size="small" effect="plain" class="dialog__version-tag">
          v{{ normalizeVersion(editingSeen.version) }}
        </el-tag>
      </template>
      <el-alert
        v-if="editingStale"
        type="warning"
        show-icon
        :closable="false"
        class="dialog__stale"
        title="该样带已被他人更新，继续保存可能覆盖对方刚填的内容"
      >
        <div class="stale-body">
          <div v-for="change in editingChanges" :key="change.field" class="stale-row">
            <span class="stale-field">{{ change.label }}</span>
            <span class="stale-value">{{ change.from }}</span>
            <span class="stale-arrow">→</span>
            <span class="stale-value stale-value--to">{{ change.to }}</span>
          </div>
          <el-button size="small" type="primary" class="stale-adopt" @click="adoptConflict">
            采用对方的值并刷新表单
          </el-button>
        </div>
      </el-alert>
      <el-form label-width="104px">
        <el-form-item label="样带编号" required>
          <el-input v-model="form.no" placeholder="如：T-01" maxlength="24" />
        </el-form-item>
        <el-form-item label="长度" required>
          <el-input-number v-model="form.lengthM" :min="1" :max="1000" :step="1" controls-position="right" />
          <span class="page__unit">m</span>
          <div class="page__presets">
            <el-button
              v-for="preset in BELT_LENGTH_PRESETS"
              :key="preset"
              size="small"
              text
              type="primary"
              @click="form.lengthM = preset"
            >
              {{ preset }} m
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="朝向" required>
          <el-radio-group v-model="form.orientation">
            <el-radio-button v-for="item in ORIENTATIONS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="调查日期" required>
          <el-date-picker v-model="form.surveyDate" type="date" value-format="YYYY-MM-DD" placeholder="选择调查日期" />
        </el-form-item>
        <el-form-item label="调查人">
          <el-input v-model="form.observer" placeholder="如：林之遥" maxlength="20" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '布设并录入记录' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="conflictVisible" title="样带已被他人更新，未覆盖" width="520px" :close-on-click-modal="false">
      <el-alert
        type="warning"
        show-icon
        :closable="false"
        title="提交时发现该样带的版本已领先于你打开时看到的版本，以下字段已被他人先改过"
      />
      <div class="conflict-list">
        <div v-for="change in conflictChanges" :key="change.field" class="conflict-row">
          <span class="conflict-field">{{ change.label }}</span>
          <span class="conflict-from">{{ change.from }}</span>
          <span class="conflict-arrow">→</span>
          <span class="conflict-to">{{ change.to }}</span>
        </div>
      </div>
      <p class="gb-hint">
        为避免整条盖回，本次保存已中止并保留对方的修改。可采用对方的值刷新表单后再核对提交。
      </p>
      <template #footer>
        <el-button @click="conflictVisible = false">关闭</el-button>
        <el-button type="primary" @click="adoptConflict">采用对方的值并刷新表单</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}

.page__presets {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 4px;
}

.dialog__version-tag {
  margin-left: 8px;
}

.dialog__stale {
  margin-bottom: 14px;
}

.stale-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}

.stale-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.stale-field {
  min-width: 64px;
  color: #4c6663;
}

.stale-value {
  color: #7c9995;
}

.stale-value--to {
  color: #b8821f;
  font-weight: 600;
}

.stale-arrow {
  color: #b0c4c1;
}

.stale-adopt {
  align-self: flex-start;
  margin-top: 6px;
}

.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
}

.conflict-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #f7faf9;
  border-radius: 6px;
  font-size: 13px;
}

.conflict-field {
  min-width: 64px;
  color: #4c6663;
}

.conflict-from {
  color: #7c9995;
  text-decoration: line-through;
}

.conflict-arrow {
  color: #b0c4c1;
}

.conflict-to {
  color: #b8821f;
  font-weight: 600;
}
</style>
