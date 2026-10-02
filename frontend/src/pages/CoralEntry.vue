<script setup lang="ts">
/**
 * 模块 4：/belts/:id/corals 底质与珊瑚分类计数
 * 按属名与形态分组录入，同一样带叠加多条记录并汇总覆盖率与白化占比；
 * 支持批量粘贴与批量改白化等级，深链访问时样带不存在给出友好空态。
 * 复用 <BleachTag>、<StatBadge>。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, DocumentCopy, Edit, Plus, WarningFilled } from '@element-plus/icons-vue'
import BleachTag from '@/components/common/BleachTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import {
  BLEACH_LEVELS,
  COMMON_GENERA,
  CORAL_FORMS,
  parseCoralPaste
} from '@/types/coralRecord'
import type { BleachLevel, CoralForm, CoralRecord } from '@/types/coralRecord'
import { BLEACH_BG, BLEACH_COLOR, bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, groupByForm, groupByGenus } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'
import { conflictFieldLabel } from '@/utils/versioning'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()

const beltId = computed(() => String(route.params.id ?? ''))
const belt = computed(() => beltStore.beltById(beltId.value))
const site = computed(() => (belt.value ? reefStore.siteById(belt.value.siteId) : null))
const reef = computed(() => (site.value ? reefStore.reefById(site.value.reefId) : null))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const pasteVisible = ref(false)
const pasteText = ref('')
const pasteErrors = ref<string[]>([])
const selectedIds = ref<string[]>([])
/** 打开编辑时看到的版本号，提交时原样报给库做乐观锁比对 */
const baseVersion = ref(1)
type CoralBaseSnapshot = Pick<CoralRecord, 'genus' | 'form' | 'coverCm' | 'bleachLevel' | 'remark'>
const baseSnapshot = ref<CoralBaseSnapshot | null>(null)
const form = reactive({
  genus: '',
  form: '枝状' as CoralForm,
  coverCm: 100,
  bleachLevel: '无' as BleachLevel,
  remark: ''
})

const records = computed(() => surveyStore.coralsOfBelt(beltId.value))

/** 超出当前样带长度、需要重新核对的珊瑚记录 */
const reviewRecords = computed(() => {
  const limitCm = belt.value ? belt.value.lengthM * 100 : Number.POSITIVE_INFINITY
  return records.value.filter((record) => record.needsReview || record.coverCm > limitCm)
})

/**
 * 样带布设页改了长度 / 朝向（版本号变化）时，本页提示覆盖度已重算。
 * liveQuery 会把新版本推到 store，这里仅在「同一 id、版本号变了」时点名。
 */
watch(
  () => belt.value,
  (next, prev) => {
    if (!next || !prev || next.id !== prev.id || next.version === prev.version) return
    const changed: string[] = []
    if (next.lengthM !== prev.lengthM) {
      changed.push(`长度 ${prev.lengthM} m → ${next.lengthM} m，覆盖率已按新长度重算`)
    }
    if (next.orientation !== prev.orientation) changed.push(`朝向 ${prev.orientation} → ${next.orientation}`)
    if (changed.length > 0) {
      ElMessage.warning({
        message: `样带 ${next.no} 已被布设页更新（v${prev.version} → v${next.version}）：${changed.join('；')}`,
        duration: 6000
      })
    }
  }
)

/** 按属名分组汇总 */
const genusGroups = computed(() =>
  groupByGenus(records.value).map((group) => {
    const list = records.value.filter((record) => record.genus === group.genus)
    const index = bleachIndex(list)
    return { ...group, count: list.length, bleachIndex: index, grade: bleachGrade(index) }
  })
)

/** 按形态分组汇总 */
const formGroups = computed(() => groupByForm(records.value))

const stats = computed(() => {
  const list = records.value
  const coverCmTotal = list.reduce((sum, record) => sum + record.coverCm, 0)
  const index = bleachIndex(list)
  return {
    coralCount: list.length,
    coverCmTotal,
    coveragePct: belt.value ? coralCoveragePct(coverCmTotal, belt.value.lengthM) : 0,
    bleachIndex: index,
    grade: bleachGrade(index),
    bleachedSharePct: bleachedSharePct(list),
    maxCoverCm: list.length ? Math.max(...list.map((record) => record.coverCm)) : 0
  }
})

/** 白化等级 → 累计覆盖长度 */
const distribution = computed<Record<BleachLevel, number>>(() => {
  const result: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
  BLEACH_LEVELS.forEach((level) => {
    result[level] = records.value
      .filter((record) => record.bleachLevel === level)
      .reduce((sum, record) => sum + record.coverCm, 0)
  })
  return result
})

/** 进度条宽度（%），总量为 0 时返回 0% */
function barPercent(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%'
  return `${Math.min(100, (value / total) * 100).toFixed(1)}%`
}

function captureBase(record: CoralRecord): void {
  baseVersion.value = record.version
  baseSnapshot.value = {
    genus: record.genus,
    form: record.form,
    coverCm: record.coverCm,
    bleachLevel: record.bleachLevel,
    remark: record.remark
  }
}

function openCreate(): void {
  editingId.value = null
  baseVersion.value = 1
  baseSnapshot.value = null
  form.genus = ''
  form.form = '枝状'
  form.coverCm = 100
  form.bleachLevel = '无'
  form.remark = ''
  dialogVisible.value = true
}

function openEdit(record: CoralRecord): void {
  editingId.value = record.id
  form.genus = record.genus
  form.form = record.form
  form.coverCm = record.coverCm
  form.bleachLevel = record.bleachLevel
  form.remark = record.remark
  captureBase(record)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.genus.trim()) {
    ElMessage.warning('请填写属名')
    return
  }
  if (!Number.isFinite(form.coverCm) || form.coverCm < 0) {
    ElMessage.warning('覆盖长度应为非负数字（cm）')
    return
  }
  if (belt.value && form.coverCm > belt.value.lengthM * 100) {
    ElMessage.warning(`覆盖长度不应超过样带长度（${belt.value.lengthM * 100} cm）`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      genus: form.genus.trim(),
      form: form.form,
      coverCm: form.coverCm,
      bleachLevel: form.bleachLevel,
      remark: form.remark.trim()
    }
    if (editingId.value) {
      const outcome = await surveyStore.saveCoralVersioned(
        editingId.value,
        baseVersion.value,
        baseSnapshot.value ?? {},
        payload
      )
      if (outcome.status === 'not-found' || !outcome.record) {
        ElMessage.error('该珊瑚记录已被删除，无法保存')
        dialogVisible.value = false
        return
      }
      if (outcome.status === 'conflict') {
        // 别人先动过同一行：只指出已被更新的字段，不整条盖回去
        const detail = outcome.conflicts
          .map(
            (item) =>
              `「${conflictFieldLabel(item.key)}」对方已改为 ${String(item.current)}，你填的是 ${String(item.wanted)}`
          )
          .join('；')
        try {
          await ElMessageBox.alert(
            `「${outcome.record.genus}（${outcome.record.form}）」已被另一处先更新（当前版本 v${outcome.record.version}，你打开时为 v${baseVersion.value}）：${detail}。本次未保存，请点「读取最新」在对方数据上重新编辑。`,
            '存在更新冲突，未覆盖',
            { type: 'warning', confirmButtonText: '读取最新', cancelButtonText: '留在本页', showCancelButton: true }
          )
          captureBase(outcome.record)
          form.genus = outcome.record.genus
          form.form = outcome.record.form
          form.coverCm = outcome.record.coverCm
          form.bleachLevel = outcome.record.bleachLevel
          form.remark = outcome.record.remark
        } catch {
          // 留在本页继续修改，不覆盖
        }
        return
      }
      if (outcome.status === 'noop') {
        ElMessage.info('内容无变化，未保存')
        dialogVisible.value = false
        return
      }
      dialogVisible.value = false
      if (outcome.reviewCleared) {
        ElMessage.success('珊瑚记录已更新，覆盖长度已回到样带长度以内，待重核标记已清除')
      } else {
        ElMessage.success(
          outcome.status === 'merged'
            ? '珊瑚记录已更新（检测到对方先改了其他字段，已自动合并）'
            : '珊瑚记录已更新'
        )
      }
    } else {
      await surveyStore.createCoral(beltId.value, payload)
      ElMessage.success('珊瑚记录已新增，覆盖率与白化占比已重算')
      dialogVisible.value = false
    }
  } finally {
    submitting.value = false
  }
}

/** 人工核对完成，清除该行待重核标记 */
async function dismissReview(record: CoralRecord): Promise<void> {
  await surveyStore.clearCoralReviewFlag(record.id)
  ElMessage.success(`「${record.genus}（${record.form}）」已标记为核对完成`)
}

async function removeRecord(record: CoralRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除「${record.genus}（${record.form}）」覆盖 ${record.coverCm} cm 的记录？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await surveyStore.removeCoral(record.id)
  selectedIds.value = selectedIds.value.filter((id) => id !== record.id)
  ElMessage.success('珊瑚记录已删除')
}

function toggleSelect(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleSelectAll(): void {
  selectedIds.value =
    selectedIds.value.length === records.value.length ? [] : records.value.map((record) => record.id)
}

async function bulkSetLevel(level: BleachLevel): Promise<void> {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要批量改级的记录')
    return
  }
  const count = await surveyStore.bulkSetBleachLevel(selectedIds.value, level)
  ElMessage.success(`已批量将 ${count} 条记录的白化等级改为「${level}」`)
  selectedIds.value = []
}

function openPaste(): void {
  pasteText.value = ''
  pasteErrors.value = []
  pasteVisible.value = true
}

function previewPaste(): void {
  const parsed = parseCoralPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    ElMessage.warning('请先粘贴内容，每行格式「属名,形态,覆盖长度[,白化等级]」')
  }
}

async function importPaste(): Promise<void> {
  const parsed = parseCoralPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  if (parsed.rows.length === 0) {
    ElMessage.warning('没有可导入的有效行')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将用 ${parsed.rows.length} 行数据覆盖该样带现有 ${records.value.length} 条珊瑚记录，确认导入？`,
      '批量导入确认',
      { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const result = await surveyStore.importCoralRows(beltId.value, parsed.rows)
  pasteVisible.value = false
  if (result.flagged > 0) {
    ElMessage.warning(`已导入 ${result.count} 条珊瑚记录，其中 ${result.flagged} 条覆盖长度超出样带长度，已标「待重核」`)
  } else {
    ElMessage.success(`已导入 ${result.count} 条珊瑚记录`)
  }
}

function gotoFishes(): void {
  void router.push(`/belts/${beltId.value}/fishes`)
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
  if (belt.value) beltStore.selectBelt(belt.value.id)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!beltStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!belt"
      entity-label="样带"
      :missing-id="beltId"
      fallback-path="/reefs"
      fallback-text="返回礁区台账"
      :candidates="
        beltStore.belts.slice(0, 3).map((item) => ({
          id: item.id,
          label: `样带 ${item.no} 的珊瑚记录`,
          path: `/belts/${item.id}/corals`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/reefs' }">礁区台账</el-breadcrumb-item>
            <el-breadcrumb-item v-if="reef" :to="{ path: `/reefs/${reef.id}/sites` }">{{ reef.name }} 站位</el-breadcrumb-item>
            <el-breadcrumb-item v-if="site" :to="{ path: `/sites/${site.id}/belts` }">站位 {{ site.no }} 样带</el-breadcrumb-item>
            <el-breadcrumb-item>珊瑚分类计数</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            样带 {{ belt.no }} · 底质与珊瑚分类计数
            <el-tag size="small" effect="plain">{{ belt.orientation }}向</el-tag>
            <el-tag size="small" type="info" effect="plain">长 {{ belt.lengthM }} m</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ belt.surveyDate }}</el-tag>
            <el-tag size="small" type="info" effect="plain">样带版本 v{{ belt.version }}</el-tag>
          </h2>
          <p class="gb-hint">
            按属名与形态逐条录入覆盖长度与白化等级；覆盖率 = 覆盖长度合计 / 样带长度，白化指数按覆盖长度加权。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="DocumentCopy" @click="openPaste">批量粘贴</el-button>
          <el-button @click="gotoFishes">鱼类计数 →</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增珊瑚记录</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="珊瑚记录" :value="stats.coralCount" suffix="条" icon="Histogram" />
        <StatBadge label="覆盖长度合计" :value="stats.coverCmTotal" suffix="cm" tone="info" icon="Odometer" />
        <StatBadge label="珊瑚覆盖率" :value="stats.coveragePct" suffix="%" :percent="Math.min(100, stats.coveragePct)" tone="success" icon="PieChart" />
        <StatBadge
          label="白化指数"
          :value="stats.bleachIndex"
          suffix="/ 4"
          :tone="stats.bleachIndex > 1 ? 'warning' : 'success'"
          :icon="stats.bleachIndex > 1 ? 'WarningFilled' : 'DataLine'"
        />
        <StatBadge label="白化占比" :value="stats.bleachedSharePct" suffix="%" tone="warning" icon="TrendCharts" />
      </div>

      <el-alert
        v-if="reviewRecords.length > 0"
        type="warning"
        show-icon
        :closable="false"
        :icon="WarningFilled"
        class="page__review-alert"
        :title="`有 ${reviewRecords.length} 条珊瑚记录超出样带新长度（${belt.lengthM} m / ${belt.lengthM * 100} cm），覆盖率已按新长度重算，请逐条重新核对覆盖长度`"
      >
        <div class="page__review-list">
          <el-tag
            v-for="record in reviewRecords"
            :key="`review-${record.id}`"
            type="warning"
            size="small"
            effect="plain"
            class="page__review-tag"
          >
            {{ record.genus }}（{{ record.form }}）{{ record.coverCm }} cm
            <span v-if="record.reviewReason" class="page__review-reason">— {{ record.reviewReason }}</span>
          </el-tag>
        </div>
      </el-alert>

      <el-card v-if="records.length > 0" shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>汇总视图</h3>
          <div class="page__bulk">
            <span class="gb-hint">批量改白化等级：</span>
            <el-button v-for="level in BLEACH_LEVELS" :key="level" size="small" @click="bulkSetLevel(level)">
              {{ level }}
            </el-button>
          </div>
        </div>
        <div class="page__grid">
          <div>
            <h4 class="page__sub">按属名分组（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="group in genusGroups" :key="group.genus" class="gb-bar">
                <span>{{ group.genus }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: '#0b5d5a', width: barPercent(group.coverCm, stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">
                  {{ group.coverCm }} cm · {{ group.count }} 条
                  <BleachTag :level="group.grade" size="small" :plain="true" />
                </span>
              </div>
            </div>
          </div>
          <div>
            <h4 class="page__sub">按形态分组（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="group in formGroups" :key="group.form" class="gb-bar">
                <span>{{ group.form }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: '#3f9ec4', width: barPercent(group.coverCm, stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">{{ group.coverCm }} cm</span>
              </div>
            </div>
          </div>
          <div>
            <h4 class="page__sub">白化等级分布（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="level in BLEACH_LEVELS" :key="`bar-${level}`" class="gb-bar">
                <span>{{ level }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: BLEACH_COLOR[level], width: barPercent(distribution[level], stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">{{ distribution[level] }} cm</span>
              </div>
            </div>
          </div>
        </div>
      </el-card>

      <EmptyPanel
        v-if="records.length === 0"
        title="该样带还没有珊瑚记录"
        description="按属名与形态逐条录入覆盖长度与白化等级；也可以批量粘贴导入整段摸底数据。"
        action-text="新增珊瑚记录"
        secondary-text="批量粘贴导入"
        @action="openCreate"
        @secondary="openPaste"
      />

      <el-table v-else :data="records" border stripe class="gb-table-compact">
        <el-table-column label="选择" width="70" align="center">
          <template #default="{ row }">
            <el-checkbox :model-value="selectedIds.includes(row.id)" @change="() => toggleSelect(row.id)" />
          </template>
        </el-table-column>
        <el-table-column prop="genus" label="属名" min-width="140">
          <template #default="{ row }">
            <span>{{ row.genus }}</span>
            <el-tag v-if="row.needsReview" size="small" type="warning" effect="dark" class="page__row-flag">待重核</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="form" label="形态" width="100" />
        <el-table-column label="覆盖长度 (cm)" width="150" align="right">
          <template #default="{ row }">
            <span :class="{ 'page__over-limit': row.coverCm > belt.lengthM * 100 }" class="gb-mono">{{ row.coverCm }}</span>
            <div class="gb-hint gb-mono">
              占样带 {{ belt.lengthM > 0 ? ((row.coverCm / (belt.lengthM * 100)) * 100).toFixed(1) : '0.0' }}%
            </div>
          </template>
        </el-table-column>
        <el-table-column label="白化等级" width="150">
          <template #default="{ row }">
            <BleachTag :level="row.bleachLevel" size="small" :plain="true" />
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <span>{{ row.remark }}</span>
            <div v-if="row.needsReview && row.reviewReason" class="page__review-reason">{{ row.reviewReason }}</div>
          </template>
        </el-table-column>
        <el-table-column label="版本" width="70" align="center">
          <template #default="{ row }">
            <el-tag size="small" type="info" effect="plain">v{{ row.version }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="row.needsReview" size="small" type="warning" plain @click="dismissReview(row)">已核对</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRecord(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无珊瑚记录" description="点击右上角「新增珊瑚记录」开始录入。" compact />
        </template>
      </el-table>

      <p v-if="records.length > 0" class="gb-hint">
          <el-button size="small" text type="primary" @click="toggleSelectAll">
            {selectedIds.length === records.length ? '取消全选' : '全选本页'}
          </el-button>
        已选 {{ selectedIds.length }} 条；最大单条覆盖长度 {{ stats.maxCoverCm }} cm。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑珊瑚记录' : '新增珊瑚记录'" width="540px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="属名" required>
          <el-input v-model="form.genus" list="genus-options" placeholder="如：鹿角珊瑚属" maxlength="30" />
          <datalist id="genus-options">
            <option v-for="genus in COMMON_GENERA" :key="genus" :value="genus"></option>
          </datalist>
        </el-form-item>
        <el-form-item label="形态" required>
          <el-radio-group v-model="form.form">
            <el-radio-button v-for="item in CORAL_FORMS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="覆盖长度" required>
          <el-input-number v-model="form.coverCm" :min="0" :max="belt ? belt.lengthM * 100 : 10000" :step="10" controls-position="right" />
          <span class="page__unit">cm（样带全长 {{ belt ? belt.lengthM * 100 : 0 }} cm）</span>
        </el-form-item>
        <el-form-item label="白化等级" required>
          <el-radio-group v-model="form.bleachLevel">
            <el-radio-button v-for="level in BLEACH_LEVELS" :key="level" :value="level">
              {{ level }}
            </el-radio-button>
          </el-radio-group>
          <div class="page__legend">
            <span
              v-for="level in BLEACH_LEVELS"
              :key="`legend-${level}`"
              class="page__legend-item"
              :style="{ background: BLEACH_BG[level], color: BLEACH_COLOR[level], borderColor: BLEACH_COLOR[level] }"
            >
              {{ level }}
            </span>
          </div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" placeholder="如：局部褪色 / 台风扰动后白化" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <span v-if="editingId" class="page__version-hint">
          你打开时为版本 v{{ baseVersion }}，保存时若被对方先更新将只提示冲突、不覆盖
        </span>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增记录' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pasteVisible" title="批量粘贴导入珊瑚记录" width="620px">
      <p class="gb-hint">
        每行一条，格式「属名,形态,覆盖长度(cm)[,白化等级]」，逗号 / 制表符 / 分号均可。示例：<br />
        <span class="gb-mono">鹿角珊瑚属,枝状,860,无</span><br />
        <span class="gb-mono">蔷薇珊瑚属;叶状;720;中</span><br />
        <span class="gb-mono">滨珊瑚属,块状,1120</span>
      </p>
      <el-input v-model="pasteText" type="textarea" :rows="8" placeholder="鹿角珊瑚属,枝状,860,无" />
      <div v-if="pasteErrors.length > 0" class="page__errors">
        <el-alert v-for="(error, index) in pasteErrors" :key="index" type="warning" :title="error" :closable="false" show-icon />
      </div>
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button @click="previewPaste">解析预览</el-button>
        <el-button type="primary" @click="importPaste">覆盖导入</el-button>
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

.page__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

.page__sub {
  margin: 0 0 8px;
  font-size: 13px;
  color: #4c6663;
}

.page__bulk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}

.page__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.page__legend-item {
  padding: 1px 8px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 11px;
}

.page__errors {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  max-height: 160px;
  overflow: auto;
}

.page__review-alert {
  align-items: flex-start;
}

.page__review-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.page__review-tag {
  height: auto;
  padding: 2px 8px;
  white-space: normal;
}

.page__review-reason {
  margin-left: 2px;
  font-weight: normal;
  opacity: 0.85;
}

.page__row-flag {
  margin-left: 6px;
}

.page__over-limit {
  color: #c4561b;
  font-weight: 600;
}

.page__version-hint {
  float: left;
  padding-top: 8px;
  font-size: 12px;
  color: #7c9995;
}
</style>
