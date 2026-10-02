/**
 * 样带 store：维护样带布设草稿、朝向排序与站位下的样带列表。
 * 样带按朝向顺序（北→东→南→西）再按编号排序，便于外业按方向逐条普查。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Belt, BeltDraft, Orientation } from '@/types/belt'
import { ORIENTATIONS, createEmptyBeltDraft } from '@/types/belt'
import { INITIAL_RECORD_VERSION, LENGTH_REVIEW_PREFIX } from '@/types/coralRecord'
import {
  resolveVersionedWrite,
  type VersionConflictField,
  type VersionedSaveStatus
} from '@/utils/versioning'

/** 朝向排序权重：北 → 东 → 南 → 西 */
export const ORIENTATION_ORDER: Record<Orientation, number> = {
  北: 0,
  东: 1,
  南: 2,
  西: 3
}

/** 样带可编辑字段（乐观锁冲突判定范围） */
export type BeltEditable = Pick<Belt, 'no' | 'lengthM' | 'orientation' | 'surveyDate' | 'observer'>
export type BeltPatch = Partial<BeltEditable>

/** 乐观保存结果：含样带长度改动后触发的珊瑚记录重核情况 */
export interface BeltSaveOutcome {
  status: VersionedSaveStatus
  conflicts: Array<VersionConflictField<keyof BeltEditable>>
  mergedFields: Array<keyof BeltEditable>
  /** 长度缩短后新标出的「超出新长度」珊瑚记录数 */
  flaggedCorals: number
  /** 长度放宽后清除重核标记的珊瑚记录数 */
  clearedCorals: number
  belt: Belt | undefined
}

export const useBeltStore = defineStore('belt', () => {
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentBeltId = ref<string | null>(null)
  const draft = ref<BeltDraft>(createEmptyBeltDraft())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
      ready.value = true
      error.value = null
    })
  }

  /** 某站位下的样带：先按朝向（北→东→南→西）再按编号排序 */
  function beltsOfSite(siteId: string | null | undefined): Belt[] {
    if (!siteId) return []
    return belts.value
      .filter((belt) => belt.siteId === siteId)
      .sort((a, b) => {
        const orderDiff = ORIENTATION_ORDER[a.orientation] - ORIENTATION_ORDER[b.orientation]
        if (orderDiff !== 0) return orderDiff
        return a.no.localeCompare(b.no, 'zh-Hans-CN')
      })
  }

  const currentBelt = computed<Belt | null>(
    () => belts.value.find((belt) => belt.id === currentBeltId.value) ?? null
  )

  /** 站位 id → 样带数与总长度 */
  const siteBeltStats = computed<Record<string, { count: number; totalLengthM: number }>>(() => {
    const stats: Record<string, { count: number; totalLengthM: number }> = {}
    belts.value.forEach((belt) => {
      const bucket = stats[belt.siteId] ?? { count: 0, totalLengthM: 0 }
      bucket.count += 1
      bucket.totalLengthM += belt.lengthM
      stats[belt.siteId] = bucket
    })
    return stats
  })

  /** 朝向分布统计（按样带条数） */
  const orientationStats = computed<Record<Orientation, number>>(() => {
    const stats: Record<Orientation, number> = { 北: 0, 东: 0, 南: 0, 西: 0 }
    belts.value.forEach((belt) => {
      stats[belt.orientation] += 1
    })
    return stats
  })

  /** 朝向排序校验：同一站位内朝向 + 编号重复时返回提示 */
  function findBeltConflicts(siteId: string | null | undefined): string[] {
    if (!siteId) return []
    const seen = new Map<string, string>()
    const conflicts: string[] = []
    beltsOfSite(siteId).forEach((belt) => {
      const key = `${belt.orientation}-${belt.no}`
      if (seen.has(key)) conflicts.push(`${belt.orientation}向 ${belt.no}`)
      else seen.set(key, belt.id)
    })
    return conflicts
  }

  function resetDraft(no = ''): void {
    draft.value = createEmptyBeltDraft(no)
  }

  function selectBelt(id: string | null): void {
    currentBeltId.value = id
  }

  function beltById(id: string | null | undefined): Belt | null {
    if (!id) return null
    return belts.value.find((belt) => belt.id === id) ?? null
  }

  async function createBelt(
    siteId: string,
    payload: Omit<Belt, 'id' | 'createdAt' | 'updatedAt' | 'siteId' | 'version'>
  ): Promise<Belt> {
    const now = Date.now()
    const row: Belt = {
      ...payload,
      siteId,
      version: INITIAL_RECORD_VERSION,
      id: createId('belt'),
      createdAt: now,
      updatedAt: now
    }
    await db.belts.put(row)
    return row
  }

  /** 无版本校验的字段更新（保留兼容入口；带并发控制的编辑请用 saveBeltVersioned） */
  async function updateBelt(id: string, patch: Partial<Belt>): Promise<void> {
    const current = await db.belts.get(id)
    if (!current) return
    await db.belts.put({
      ...current,
      ...patch,
      version: (current.version ?? INITIAL_RECORD_VERSION) + 1,
      updatedAt: Date.now()
    })
  }

  /**
   * 带版本号保存样带：提交方报告自己看到的版本（expectedVersion）。
   * 别人先改过且字段重叠 → status='conflict'，只指出冲突字段，不写入任何内容；
   * 互不重叠的改动自动合并。长度一旦改动，覆盖度随后按新长度重算，
   * 超出新长度的珊瑚记录置「待重核」，放宽到覆盖长度以内的记录清除标记。
   */
  async function saveBeltVersioned(
    id: string,
    expectedVersion: number,
    base: BeltPatch,
    patch: BeltPatch
  ): Promise<BeltSaveOutcome> {
    let outcome: BeltSaveOutcome = {
      status: 'not-found',
      conflicts: [],
      mergedFields: [],
      flaggedCorals: 0,
      clearedCorals: 0,
      belt: undefined
    }
    await db.transaction('rw', [db.belts, db.corals], async () => {
      const current = await db.belts.get(id)
      if (!current) return
      const now = Date.now()
      const resolved = resolveVersionedWrite<Belt, keyof BeltEditable>(
        current,
        base as Record<string, unknown>,
        expectedVersion,
        patch as Record<string, unknown>,
        () => {
          current.updatedAt = now
        }
      )
      let flaggedCorals = 0
      let clearedCorals = 0
      if (
        (resolved.status === 'ok' || resolved.status === 'merged') &&
        typeof patch.lengthM === 'number' &&
        patch.lengthM !== base.lengthM
      ) {
        const newLengthCm = patch.lengthM * 100
        const affected = await db.corals.where('beltId').equals(id).toArray()
        for (const coral of affected) {
          if (coral.coverCm > newLengthCm) {
            if (!coral.needsReview) flaggedCorals += 1
            const reason = `${LENGTH_REVIEW_PREFIX}${patch.lengthM} m，覆盖长度 ${coral.coverCm} cm 超出新长度，请重新核对`
            await db.corals.update(coral.id, { needsReview: true, reviewReason: reason })
          } else if (coral.reviewReason.startsWith(LENGTH_REVIEW_PREFIX)) {
            clearedCorals += 1
            await db.corals.update(coral.id, { needsReview: false, reviewReason: '' })
          }
        }
      }
      if (resolved.status === 'ok' || resolved.status === 'merged') await db.belts.put(current)
      outcome = {
        status: resolved.status,
        conflicts: resolved.conflicts,
        mergedFields: resolved.mergedFields,
        flaggedCorals,
        clearedCorals,
        belt: resolved.record
      }
    })
    return outcome
  }

  /** 删除样带：级联删除其珊瑚记录与鱼类计数 */
  async function removeBelt(id: string): Promise<void> {
    await db.transaction('rw', [db.belts, db.corals, db.fishes], async () => {
      await db.corals.where('beltId').equals(id).delete()
      await db.fishes.where('beltId').equals(id).delete()
      await db.belts.delete(id)
    })
    if (currentBeltId.value === id) selectBelt(null)
  }

  /** 批量改写朝向（同站位多条样带统一方向）；逐条内容改动，版本号 +1 */
  async function bulkSetOrientation(ids: string[], orientation: Orientation): Promise<number> {
    const now = Date.now()
    await db.belts
      .where('id')
      .anyOf(ids)
      .modify((belt) => {
        if (belt.orientation !== orientation) {
          belt.orientation = orientation
          belt.version = (belt.version ?? INITIAL_RECORD_VERSION) + 1
        }
        belt.updatedAt = now
      })
    return ids.length
  }

  return {
    belts,
    ready,
    error,
    currentBeltId,
    currentBelt,
    draft,
    siteBeltStats,
    orientationStats,
    start,
    beltsOfSite,
    findBeltConflicts,
    resetDraft,
    selectBelt,
    beltById,
    createBelt,
    updateBelt,
    saveBeltVersioned,
    removeBelt,
    bulkSetOrientation,
    orientations: ORIENTATIONS
  }
})
