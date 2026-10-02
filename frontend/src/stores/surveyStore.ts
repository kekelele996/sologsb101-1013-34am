/**
 * 普查 store：维护珊瑚与鱼类筛选条件、录入草稿与覆盖度派生值。
 * 覆盖 /belts/:id/corals、/belts/:id/fishes 与 /coverage 三页。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { BleachLevel, CoralForm, CoralRecord } from '@/types/coralRecord'
import { BLEACH_LEVELS, INITIAL_RECORD_VERSION, LENGTH_REVIEW_PREFIX } from '@/types/coralRecord'
import {
  resolveVersionedWrite,
  type VersionConflictField,
  type VersionedSaveStatus
} from '@/utils/versioning'
import type { CountCategory, FishCount, SizeClass } from '@/types/fishCount'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 覆盖度汇总页筛选条件 */
export interface SurveyFilterState {
  keyword: string
  reefIds: string[]
  bleachLevels: BleachLevel[]
  /** 是否只看白化指数高于阈值的样带 */
  onlyBleached: boolean
}

export function createEmptySurveyFilter(): SurveyFilterState {
  return {
    keyword: '',
    reefIds: [],
    bleachLevels: [],
    onlyBleached: false
  }
}

/** 覆盖度汇总行 */
export interface CoverageSummaryRow {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  coveragePct: number
  bleachIndex: number
  grade: BleachLevel
  bleachedSharePct: number
  distribution: Record<BleachLevel, number>
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
}

export const useSurveyStore = defineStore('survey', () => {
  const corals = ref<CoralRecord[]>([])
  const fishes = ref<FishCount[]>([])
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<SurveyFilterState>(createEmptySurveyFilter())
  /** 珊瑚录入草稿（跨页面保留） */
  const coralDraft = ref({
    genus: '',
    form: '枝状' as CoralForm,
    coverCm: 100,
    bleachLevel: '无' as BleachLevel,
    remark: ''
  })
  /** 鱼类计数草稿 */
  const fishDraft = ref({
    family: '',
    count: 1,
    sizeClass: '11-20cm' as SizeClass,
    category: '鱼类' as CountCategory
  })

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<CoralRecord>(() => db.corals).subscribe((rows) => {
      corals.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<FishCount>(() => db.fishes).subscribe((rows) => {
      fishes.value = rows
    })
    watchTable<Reef>(() => db.reefs).subscribe((rows) => {
      reefs.value = rows
    })
    watchTable<Site>(() => db.sites).subscribe((rows) => {
      sites.value = rows
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
  }

  /** 某样带的珊瑚记录（按白化等级降序、覆盖长度降序） */
  function coralsOfBelt(beltId: string | null | undefined): CoralRecord[] {
    if (!beltId) return []
    const order: Record<BleachLevel, number> = { 无: 0, 轻: 1, 中: 2, 重: 3, 死亡: 4 }
    return corals.value
      .filter((coral) => coral.beltId === beltId)
      .sort((a, b) => {
        const diff = order[b.bleachLevel] - order[a.bleachLevel]
        if (diff !== 0) return diff
        return b.coverCm - a.coverCm
      })
  }

  /** 某样带的鱼类/无脊椎动物计数 */
  function fishesOfBelt(beltId: string | null | undefined): FishCount[] {
    if (!beltId) return []
    return fishes.value
      .filter((fish) => fish.beltId === beltId)
      .sort((a, b) => b.count - a.count)
  }

  /** 样带 id → 珊瑚记录数 / 鱼类记录数（样带列表回显用） */
  const beltRecordCounts = computed<Record<string, { coralCount: number; fishCount: number }>>(() => {
    const counts: Record<string, { coralCount: number; fishCount: number }> = {}
    belts.value.forEach((belt) => {
      counts[belt.id] = {
        coralCount: corals.value.filter((coral) => coral.beltId === belt.id).length,
        fishCount: fishes.value.filter((fish) => fish.beltId === belt.id).length
      }
    })
    return counts
  })

  /** 覆盖度汇总行（全部样带） */
  const coverageRows = computed<CoverageSummaryRow[]>(() =>
    belts.value
      .map((belt) => {
        const site = sites.value.find((item) => item.id === belt.siteId)
        const reef = site ? reefs.value.find((item) => item.id === site.reefId) : undefined
        const beltCorals = corals.value.filter((coral) => coral.beltId === belt.id)
        const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
        const coverCmTotal = round(
          beltCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
        const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
        BLEACH_LEVELS.forEach((level) => {
          distribution[level] = round(
            beltCorals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
            1
          )
        })
        const index = bleachIndex(beltCorals)
        const fishTotal = beltFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
        return {
          beltId: belt.id,
          beltNo: belt.no,
          reefId: reef?.id ?? '',
          reefName: reef?.name ?? '未知礁区',
          siteId: site?.id ?? '',
          siteNo: site?.no ?? '—',
          lengthM: belt.lengthM,
          orientation: belt.orientation,
          surveyDate: belt.surveyDate,
          observer: belt.observer,
          coralCount: beltCorals.length,
          coverCmTotal,
          coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
          bleachIndex: index,
          grade: bleachGrade(index),
          bleachedSharePct: bleachedSharePct(beltCorals),
          distribution,
          fishTotal,
          invertebrateTotal: beltFishes
            .filter((fish) => fish.category === '无脊椎动物')
            .reduce((sum, fish) => sum + fish.count, 0),
          fishDensity: fishDensity(fishTotal, belt.lengthM)
        }
      })
      .sort((a, b) => b.bleachIndex - a.bleachIndex)
  )

  /** 按筛选条件过滤后的覆盖度行 */
  const filteredCoverageRows = computed<CoverageSummaryRow[]>(() =>
    coverageRows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.reefName}${row.siteNo}${row.beltNo}${row.observer}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.reefIds.length > 0 && !filter.value.reefIds.includes(row.reefId)) return false
      if (filter.value.bleachLevels.length > 0) {
        const matched = filter.value.bleachLevels.some((level) => row.distribution[level] > 0)
        if (!matched) return false
      }
      if (filter.value.onlyBleached && row.bleachedSharePct <= 0) return false
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.reefIds.length > 0 ||
      filter.value.bleachLevels.length > 0 ||
      filter.value.onlyBleached
  )

  /** 全局白化等级分布与总体指数 */
  const globalStats = computed(() => {
    const distribution: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
    BLEACH_LEVELS.forEach((level) => {
      distribution[level] = round(
        corals.value.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
    })
    const index = bleachIndex(corals.value)
    return {
      coralCount: corals.value.length,
      fishCount: fishes.value.length,
      coverCmTotal: round(
        corals.value.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      ),
      bleachIndex: index,
      grade: bleachGrade(index),
      bleachedSharePct: bleachedSharePct(corals.value),
      distribution
    }
  })

  function patchFilter(patch: Partial<SurveyFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptySurveyFilter()
  }

  function patchCoralDraft(patch: Partial<typeof coralDraft.value>): void {
    coralDraft.value = { ...coralDraft.value, ...patch }
  }

  function patchFishDraft(patch: Partial<typeof fishDraft.value>): void {
    fishDraft.value = { ...fishDraft.value, ...patch }
  }

  /* ------------------------------ 珊瑚记录 ------------------------------ */

  type CoralEditable = Pick<CoralRecord, 'genus' | 'form' | 'coverCm' | 'bleachLevel' | 'remark'>
  type CoralPatch = Partial<CoralEditable>

  async function createCoral(
    beltId: string,
    payload: Omit<
      CoralRecord,
      'id' | 'createdAt' | 'updatedAt' | 'beltId' | 'version' | 'needsReview' | 'reviewReason'
    >
  ): Promise<CoralRecord> {
    const now = Date.now()
    const row: CoralRecord = {
      ...payload,
      beltId,
      version: INITIAL_RECORD_VERSION,
      needsReview: false,
      reviewReason: '',
      id: createId('cor'),
      createdAt: now,
      updatedAt: now
    }
    await db.corals.put(row)
    return row
  }

  /** 无版本校验的字段更新（保留兼容入口；带并发控制的编辑请用 saveCoralVersioned） */
  async function updateCoral(id: string, patch: Partial<CoralRecord>): Promise<void> {
    const current = await db.corals.get(id)
    if (!current) return
    await db.corals.put({
      ...current,
      ...patch,
      version: (current.version ?? INITIAL_RECORD_VERSION) + 1,
      updatedAt: Date.now()
    })
  }

  /**
   * 带版本号保存珊瑚记录：提交方报告自己看到的版本（expectedVersion）。
   * 别人先改过同一行且字段重叠 → status='conflict'，只指出冲突行与字段，不覆盖。
   * 保存时覆盖长度若已回到样带长度以内，自动清除「长度变更」类待重核标记。
   */
  async function saveCoralVersioned(
    id: string,
    expectedVersion: number,
    base: CoralPatch,
    patch: CoralPatch
  ): Promise<{
    status: VersionedSaveStatus
    conflicts: Array<VersionConflictField<keyof CoralEditable>>
    mergedFields: Array<keyof CoralEditable>
    reviewCleared: boolean
    record: CoralRecord | undefined
  }> {
    let status: VersionedSaveStatus = 'not-found'
    let conflicts: Array<VersionConflictField<keyof CoralEditable>> = []
    let mergedFields: Array<keyof CoralEditable> = []
    let reviewCleared = false
    let record: CoralRecord | undefined
    await db.transaction('rw', [db.corals, db.belts], async () => {
      const current = await db.corals.get(id)
      if (!current) return
      const belt = await db.belts.get(current.beltId)
      const resolved = resolveVersionedWrite<CoralRecord, keyof CoralEditable>(
        current,
        base as Record<string, unknown>,
        expectedVersion,
        patch as Record<string, unknown>,
        () => {
          current.updatedAt = Date.now()
        }
      )
      if (resolved.status === 'ok' || resolved.status === 'merged') {
        // 覆盖长度重新落入样带长度以内 → 清除长度变更类待重核标记
        const limitCm = belt ? belt.lengthM * 100 : Number.POSITIVE_INFINITY
        if (
          current.needsReview &&
          current.reviewReason.startsWith(LENGTH_REVIEW_PREFIX) &&
          current.coverCm <= limitCm
        ) {
          current.needsReview = false
          current.reviewReason = ''
          reviewCleared = true
        }
        await db.corals.put(current)
      }
      status = resolved.status
      conflicts = resolved.conflicts
      mergedFields = resolved.mergedFields
      record = resolved.record
    })
    return { status, conflicts, mergedFields, reviewCleared, record }
  }

  /** 人工重核后主动清除待重核标记（不改内容也不升版本） */
  async function clearCoralReviewFlag(id: string): Promise<void> {
    await db.corals.update(id, { needsReview: false, reviewReason: '' })
  }

  async function removeCoral(id: string): Promise<void> {
    await db.corals.delete(id)
  }

  /** 批量导入粘贴行（替换该样带原有珊瑚记录）；超出样带长度的行置待重核 */
  async function importCoralRows(
    beltId: string,
    rows: Array<{ genus: string; form: CoralForm; coverCm: number; bleachLevel: BleachLevel }>
  ): Promise<{ count: number; flagged: number }> {
    const now = Date.now()
    const belt = belts.value.find((item) => item.id === beltId) ?? (await db.belts.get(beltId))
    const limitCm = belt ? belt.lengthM * 100 : Number.POSITIVE_INFINITY
    let flagged = 0
    const records: CoralRecord[] = rows.map((row, index) => {
      const overLimit = row.coverCm > limitCm
      if (overLimit) flagged += 1
      return {
        id: createId('cor'),
        beltId,
        genus: row.genus,
        form: row.form,
        coverCm: row.coverCm,
        bleachLevel: row.bleachLevel,
        remark: '',
        version: INITIAL_RECORD_VERSION,
        needsReview: overLimit,
        reviewReason: overLimit
          ? `${LENGTH_REVIEW_PREFIX}${belt?.lengthM ?? '?'} m，覆盖长度 ${row.coverCm} cm 超出样带长度，请重新核对`
          : '',
        createdAt: now + index,
        updatedAt: now + index
      }
    })
    await db.transaction('rw', [db.corals], async () => {
      await db.corals.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.corals.bulkPut(records)
    })
    return { count: records.length, flagged }
  }

  /** 批量改写白化等级；逐条内容改动，版本号 +1 */
  async function bulkSetBleachLevel(ids: string[], bleachLevel: BleachLevel): Promise<number> {
    const now = Date.now()
    await db.corals
      .where('id')
      .anyOf(ids)
      .modify((coral) => {
        if (coral.bleachLevel !== bleachLevel) {
          coral.bleachLevel = bleachLevel
          coral.version = (coral.version ?? INITIAL_RECORD_VERSION) + 1
        }
        coral.updatedAt = now
      })
    return ids.length
  }

  /* ------------------------------ 鱼类计数 ------------------------------ */

  async function createFish(
    beltId: string,
    payload: Omit<FishCount, 'id' | 'createdAt' | 'updatedAt' | 'beltId'>
  ): Promise<FishCount> {
    const now = Date.now()
    const row: FishCount = { ...payload, beltId, id: createId('fsh'), createdAt: now, updatedAt: now }
    await db.fishes.put(row)
    return row
  }

  async function updateFish(id: string, patch: Partial<FishCount>): Promise<void> {
    await db.fishes.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeFish(id: string): Promise<void> {
    await db.fishes.delete(id)
  }

  /** 批量导入粘贴行（替换该样带原有计数） */
  async function importFishRows(
    beltId: string,
    rows: Array<{ family: string; count: number; sizeClass: SizeClass; category: CountCategory }>
  ): Promise<number> {
    const now = Date.now()
    const records: FishCount[] = rows.map((row, index) => ({
      id: createId('fsh'),
      beltId,
      family: row.family,
      count: row.count,
      sizeClass: row.sizeClass,
      category: row.category,
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.fishes], async () => {
      await db.fishes.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.fishes.bulkPut(records)
    })
    return records.length
  }

  /** 按科名与体长段汇总某样带计数 */
  function fishSummaryOfBelt(beltId: string | null | undefined): Array<{
    family: string
    category: CountCategory
    total: number
    bySize: Record<SizeClass, number>
  }> {
    if (!beltId) return []
    const map = new Map<string, { family: string; category: CountCategory; total: number; bySize: Record<SizeClass, number> }>()
    fishesOfBelt(beltId).forEach((fish) => {
      const bucket =
        map.get(fish.family) ??
        { family: fish.family, category: fish.category, total: 0, bySize: { '0-10cm': 0, '11-20cm': 0, '21-30cm': 0, '>30cm': 0 } }
      bucket.total += fish.count
      bucket.bySize[fish.sizeClass] += fish.count
      map.set(fish.family, bucket)
    })
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  }

  return {
    corals,
    fishes,
    reefs,
    sites,
    belts,
    ready,
    error,
    filter,
    coralDraft,
    fishDraft,
    beltRecordCounts,
    coverageRows,
    filteredCoverageRows,
    hasFilter,
    globalStats,
    start,
    coralsOfBelt,
    fishesOfBelt,
    fishSummaryOfBelt,
    patchFilter,
    resetFilter,
    patchCoralDraft,
    patchFishDraft,
    createCoral,
    updateCoral,
    saveCoralVersioned,
    clearCoralReviewFlag,
    removeCoral,
    importCoralRows,
    bulkSetBleachLevel,
    createFish,
    updateFish,
    removeFish,
    importFishRows
  }
})
