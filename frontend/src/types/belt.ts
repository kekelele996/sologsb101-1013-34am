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
   * 乐观锁版本号：每次内容改动 +1。
   * 样带布设页与珊瑚计数页分别编辑样带时，提交方带上自己看到的版本，
   * 版本落后说明别人先改过，本次只指出冲突字段，不整条覆盖。
   */
  version: number
  createdAt: number
  updatedAt: number
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
