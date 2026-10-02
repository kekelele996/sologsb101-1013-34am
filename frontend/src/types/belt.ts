/** 样带朝向 */
export type Orientation = '北' | '东' | '南' | '西'

export const ORIENTATIONS: Orientation[] = ['北', '东', '南', '西']

/** 样带：站位上布设的普查样带 */
export interface Belt {
  id: string
  /** 所属站位 */
  siteId: string
  /** 样带编号，如 T-01 */
  no: string
  /** 样带长度（m） */
  lengthM: number
  /** 朝向 */
  orientation: Orientation
  /** 调查日期 */
  surveyDate: string
  /** 调查人 */
  observer: string
  /**
   * 乐观并发版本号：每次成功保存 +1。
   * 布设页与珊瑚计数页可能同时打开同一条样带，提交时各自带上看到的版本；
   * 若库中版本已领先，说明被他人先改过，应提示冲突而不是整条覆盖。
   * 历史数据可能没有该字段，读取时统一用 normalizeVersion 兜底为 1。
   */
  version: number
  createdAt: number
  updatedAt: number
}

/**
 * 归一化版本号：历史数据没有 version 字段时兜底为 1，
 * 保证升级后旧数据照常打开、照常提交（首次提交即补出版本号）。
 */
export function normalizeVersion(version: number | null | undefined): number {
  return Number.isFinite(version) && (version as number) > 0 ? Math.floor(version as number) : 1
}

/** 样带布设草稿（存于 beltStore） */
export interface BeltDraft {
  no: string
  lengthM: number
  orientation: Orientation
  surveyDate: string
  observer: string
}

export function createEmptyBeltDraft(no = ''): BeltDraft {
  return {
    no,
    lengthM: 50,
    orientation: '北',
    surveyDate: new Date().toISOString().slice(0, 10),
    observer: ''
  }
}

/** 常用样带长度预设（m） */
export const BELT_LENGTH_PRESETS: number[] = [10, 20, 25, 50, 100]
