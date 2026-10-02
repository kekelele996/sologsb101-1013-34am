/**
 * 乐观锁：提交时带上「自己看到的版本号」。
 * - 版本一致或本次未改别人动过的字段 → 写入并把版本号 +1；
 * - 版本落后且字段重叠 → 报冲突（status: 'conflict'），不覆盖任何字段；
 * - 版本落后但改动互不重叠 → 合并（status: 'merged'）。
 *
 * 样带布设页与珊瑚计数页在同一台平板上同时编辑同一条样带 / 珊瑚记录时，
 * 后提交的一方只指出已被对方更新的行与字段，绝不整条盖回去。
 */

/** 带乐观锁版本号的记录（Belt / CoralRecord 等） */
export interface VersionedRecord {
  id: string
  version?: number
}

/** 版本落后时指出的单个冲突字段 */
export interface VersionConflictField<K extends string = string> {
  key: K
  /** 自己本次想写入的值 */
  wanted: unknown
  /** 库里（别人先改后）的现值 */
  current: unknown
}

/**
 * 乐观写入结果。
 * - ok：版本一致，正常写入
 * - merged：版本落后，但改动字段互不重叠，已合并并 +1
 * - conflict：版本落后且字段重叠，未写入任何内容
 * - noop：与当前内容完全一致，未写入、版本不变
 * - not-found：记录已被删除（由调用方在事务外判定）
 */
export type VersionedSaveStatus = 'ok' | 'merged' | 'conflict' | 'noop' | 'not-found'

export interface VersionedSaveResult<T, K extends string = string> {
  status: VersionedSaveStatus
  /** 冲突涉及的字段（页面据此点名已被更新的行） */
  conflicts: Array<VersionConflictField<K>>
  /** 合并时对方先行改动的字段 */
  mergedFields: K[]
  /** 写入后的最新记录（conflict 时为库里的现值） */
  record: T | undefined
}

const META_KEYS = new Set(['version', 'updatedAt', 'createdAt'])

function asMap(record: unknown): Record<string, unknown> {
  return record as Record<string, unknown>
}

/**
 * 事务内执行乐观锁判定并就地修改记录。
 * 必须在对该表的 'rw' 事务中、拿到库内现值后调用（由调用方负责随后 put 落库）。
 *
 * @param current 库内读出的当前记录（ok / merged 时已被就地改写）
 * @param base 提交方打开编辑时看到的快照（用于判断别人改了哪些字段）
 * @param expectedVersion 提交方看到的版本号
 * @param patch 本次想写入的字段
 * @param apply 真正落库前的附加回调（如刷新 updatedAt），仅 ok / merged 时调用
 */
export function resolveVersionedWrite<T extends VersionedRecord, K extends string = string>(
  current: T,
  base: Partial<Record<K, unknown>>,
  expectedVersion: number,
  patch: Partial<Record<K, unknown>>,
  apply: (next: T) => void
): VersionedSaveResult<T, K> {
  const currentMap = asMap(current)
  const currentVersion = typeof current.version === 'number' ? current.version : 1

  // 对方相对我打开时的快照改过的字段
  const changedByOther = (Object.keys(base) as K[]).filter((key) => {
    if (META_KEYS.has(key)) return false
    return currentMap[key] !== base[key]
  })
  // 我本次实际想改、且与现值不同的字段
  const changedByMe = (Object.keys(patch) as K[]).filter((key) => {
    if (META_KEYS.has(key)) return false
    return currentMap[key] !== patch[key]
  })

  // 与现值完全一致 → 无需写入
  if (changedByMe.length === 0) {
    return { status: 'noop', conflicts: [], mergedFields: [], record: current }
  }

  if (currentVersion !== expectedVersion) {
    const overlap = changedByOther.filter((key) => changedByMe.includes(key))
    if (overlap.length > 0) {
      return {
        status: 'conflict',
        conflicts: overlap.map((key) => ({ key, wanted: patch[key], current: currentMap[key] })),
        mergedFields: [],
        record: current
      }
    }
    // 各改各的字段 → 合并
    writePatch(currentMap, patch)
    current.version = currentVersion + 1
    apply(current)
    return { status: 'merged', conflicts: [], mergedFields: changedByOther, record: current }
  }

  writePatch(currentMap, patch)
  current.version = currentVersion + 1
  apply(current)
  return { status: 'ok', conflicts: [], mergedFields: [], record: current }
}

function writePatch<K extends string>(
  target: Record<string, unknown>,
  patch: Partial<Record<K, unknown>>
): void {
  ;(Object.keys(patch) as K[]).forEach((key) => {
    if (META_KEYS.has(key)) return
    target[key] = patch[key]
  })
}

/** 字段名 → 中文标签（冲突提示用） */
export function conflictFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    lengthM: '长度',
    orientation: '朝向',
    no: '样带编号',
    surveyDate: '调查日期',
    observer: '调查人',
    genus: '属名',
    form: '形态',
    coverCm: '覆盖长度',
    bleachLevel: '白化等级',
    remark: '备注'
  }
  return labels[key] ?? key
}
