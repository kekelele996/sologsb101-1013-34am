/**
 * 样带 store：维护样带布设草稿、朝向排序与站位下的样带列表。
 * 样带按朝向顺序（北→东→南→西）再按编号排序，便于外业按方向逐条普查。
 *
 * 样带行带乐观并发版本号（Belt.version）：布设页与珊瑚计数页可能同时打开
 * 同一条样带，提交时各自带上「自己看到的版本」；库中版本已领先则返回冲突，
 * 只列出被他人更新过的字段，不整条覆盖。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Belt, BeltDraft, Orientation } from '@/types/belt'
import { ORIENTATIONS, createEmptyBeltDraft, normalizeVersion } from '@/types/belt'

/** 朝向排序权重：北 → 东 → 南 → 西 */
export const ORIENTATION_ORDER: Record<Orientation, number> = {
  北: 0,
  东: 1,
  南: 2,
  西: 3
}

/** 样带可编辑字段的中文标签（冲突比对与提示用） */
export const BELT_FIELD_LABELS: Record<'no' | 'lengthM' | 'orientation' | 'surveyDate' | 'observer', string> = {
  no: '样带编号',
  lengthM: '长度',
  orientation: '朝向',
  surveyDate: '调查日期',
  observer: '调查人'
}

export type BeltEditableField = keyof typeof BELT_FIELD_LABELS

/** 字段级冲突：被他人更新过的某一列（只指出已被更新的行，不整条盖回） */
export interface BeltFieldChange {
  field: BeltEditableField
  label: string
  /** 我方打开编辑时看到的值 */
  from: string
  /** 对方先一步保存后库中的值 */
  to: string
}

/** 版本检查保存结果：已保存 / 冲突（附库中最新行与被改字段）/ 样带已被删除 */
export type SaveBeltResult =
  | { status: 'saved'; belt: Belt }
  | { status: 'conflict'; server: Belt; changes: BeltFieldChange[] }
  | { status: 'missing' }

/** 把样带字段格式化成可比对、可展示的文本 */
export function formatBeltField(belt: Belt, field: BeltEditableField): string {
  const value = belt[field]
  if (field === 'lengthM') return `${value} m`
  if (field === 'observer') return String(value).trim() || '（未填）'
  return String(value)
}

/**
 * 比对两条样带在可编辑字段上的差异：只返回「别人先动过」的字段，
 * 即我方打开时看到的行（seen）与库中最新行（server）不一致的列。
 */
export function diffBeltFields(seen: Belt, server: Belt): BeltFieldChange[] {
  const fields: BeltEditableField[] = ['no', 'lengthM', 'orientation', 'surveyDate', 'observer']
  return fields
    .filter((field) => formatBeltField(seen, field) !== formatBeltField(server, field))
    .map((field) => ({
      field,
      label: BELT_FIELD_LABELS[field],
      from: formatBeltField(seen, field),
      to: formatBeltField(server, field)
    }))
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
    const row: Belt = { ...payload, siteId, version: 1, id: createId('belt'), createdAt: now, updatedAt: now }
    await db.belts.put(row)
    return row
  }

  async function updateBelt(id: string, patch: Partial<Belt>): Promise<void> {
    const now = Date.now()
    await db.belts
      .where('id')
      .equals(id)
      .modify((belt) => {
        Object.assign(belt, patch, { updatedAt: now, version: normalizeVersion(belt.version) + 1 })
      })
  }

  /**
   * 带乐观并发检查的保存：在事务内读库中最新行，
   * - 库中版本与我方打开时看到的版本一致（或为无版本号的历史行）→ 才写入，版本号 +1；
   * - 库中版本已领先 → 不写入，返回 conflict 与字段级差异（只指出被他人更新的行）；
   * - 样带已被删除 → 返回 missing。
   */
  async function saveBeltWithVersion(
    id: string,
    patch: Pick<Belt, 'no' | 'lengthM' | 'orientation' | 'surveyDate' | 'observer'>,
    seen: Belt
  ): Promise<SaveBeltResult> {
    return await db.transaction('rw', db.belts, async () => {
      const server = await db.belts.get(id)
      if (!server) return { status: 'missing' }
      const currentVersion = normalizeVersion(server.version)
      if (currentVersion !== normalizeVersion(seen.version)) {
        return { status: 'conflict', server, changes: diffBeltFields(seen, server) }
      }
      const now = Date.now()
      const next: Belt = { ...server, ...patch, version: currentVersion + 1, updatedAt: now }
      await db.belts.put(next)
      return { status: 'saved', belt: next }
    })
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

  /** 批量改写朝向（同站位多条样带统一方向），每条版本号 +1 */
  async function bulkSetOrientation(ids: string[], orientation: Orientation): Promise<number> {
    const now = Date.now()
    await db.belts
      .where('id')
      .anyOf(ids)
      .modify((belt) => {
        belt.orientation = orientation
        belt.updatedAt = now
        belt.version = normalizeVersion(belt.version) + 1
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
    saveBeltWithVersion,
    removeBelt,
    bulkSetOrientation,
    orientations: ORIENTATIONS
  }
})
