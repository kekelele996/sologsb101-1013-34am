/** 珊瑚形态 */
export type CoralForm = '枝状' | '块状' | '叶状' | '软珊瑚'

export const CORAL_FORMS: CoralForm[] = ['枝状', '块状', '叶状', '软珊瑚']

/** 白化等级 */
export type BleachLevel = '无' | '轻' | '中' | '重' | '死亡'

export const BLEACH_LEVELS: BleachLevel[] = ['无', '轻', '中', '重', '死亡']

/** 珊瑚记录：样带内某属名、某形态的覆盖长度与白化等级 */
export interface CoralRecord {
  id: string
  /** 所属样带 */
  beltId: string
  /** 属名，如 鹿角珊瑚属 */
  genus: string
  /** 形态 */
  form: CoralForm
  /** 覆盖长度（cm） */
  coverCm: number
  /** 白化等级 */
  bleachLevel: BleachLevel
  /** 备注（病敌害、断枝等） */
  remark: string
  /**
   * 乐观锁版本号：每次内容改动 +1。
   * 同一条珊瑚记录被两个人先后保存时，提交方带上自己看到的版本，
   * 版本落后说明别人先改过，本次只指出冲突行，不整条覆盖。
   */
  version: number
  /** 是否需要重新核对（样带长度缩短到覆盖长度以内时置 true） */
  needsReview: boolean
  /** 待核对原因，如「样带长度改为 40 m，覆盖长度超出新长度」 */
  reviewReason: string
  createdAt: number
  updatedAt: number
}

/** 历史数据（v2 及更早）没有版本号，升级后统一按初始版本打开 */
export const INITIAL_RECORD_VERSION = 1

/** 待核对原因前缀（样带长度变化引起，覆盖长度重新落入新长度内时按此前缀清除） */
export const LENGTH_REVIEW_PREFIX = '样带长度改为'

/** 珊瑚记录草稿（存于 surveyStore） */
export interface CoralDraft {
  genus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
  remark: string
}

export function createEmptyCoralDraft(): CoralDraft {
  return {
    genus: '',
    form: '枝状',
    coverCm: 100,
    bleachLevel: '无',
    remark: ''
  }
}

/** 常见属名（表单联想用） */
export const COMMON_GENERA: string[] = [
  '鹿角珊瑚属',
  '杯形珊瑚属',
  '滨珊瑚属',
  '蜂巢珊瑚属',
  '蔷薇珊瑚属',
  '陀螺珊瑚属',
  '石芝珊瑚属',
  '软珊瑚属',
  '柳珊瑚属',
  '星珊瑚属'
]

/** 批量粘贴解析出的一行珊瑚记录 */
export interface CoralPasteRow {
  genus: string
  form: CoralForm
  coverCm: number
  bleachLevel: BleachLevel
}

/**
 * 解析批量粘贴文本：每行「属名,形态,覆盖长度[,白化等级]」。
 * 逗号 / 制表符 / 分号可作分隔（属名常含空格，不用空格定界）。
 */
export function parseCoralPaste(text: string): { rows: CoralPasteRow[]; errors: string[] } {
  const rows: CoralPasteRow[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；]+/).map((cell) => cell.trim())
    if (cells.length < 3) {
      errors.push(`第 ${index + 1} 行「${line}」至少需要「属名,形态,覆盖长度(cm)」三列`)
      return
    }
    const form = cells[1] as CoralForm
    if (!CORAL_FORMS.includes(form)) {
      errors.push(`第 ${index + 1} 行形态「${cells[1]}」不在 ${CORAL_FORMS.join(' / ')} 之内`)
      return
    }
    const coverCm = Number(cells[2])
    if (!Number.isFinite(coverCm) || coverCm < 0) {
      errors.push(`第 ${index + 1} 行覆盖长度应为非负数字（cm）`)
      return
    }
    const bleachLevel = (cells.length >= 4 ? cells[3] : '无') as BleachLevel
    if (!BLEACH_LEVELS.includes(bleachLevel)) {
      errors.push(`第 ${index + 1} 行白化等级「${cells[3]}」不在 ${BLEACH_LEVELS.join(' / ')} 之内`)
      return
    }
    rows.push({
      genus: cells[0],
      form,
      coverCm: Number(coverCm.toFixed(1)),
      bleachLevel
    })
  })
  return { rows, errors }
}
