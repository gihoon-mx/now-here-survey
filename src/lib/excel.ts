import * as XLSX from 'xlsx'
import {
  answerToText,
  slideOptions,
  SLIDE_TYPE_LABEL,
  type AdminParticipant,
  type ResponseRow,
  type Slide,
} from './types'

/* ------------------------------------------------------------- import */

export interface ParticipantImportRow {
  login_id: string
  passcode: string
  display_name: string
}

/** 한글/영문 헤더를 모두 받아 줍니다. */
const HEADER_ALIASES: Record<keyof ParticipantImportRow, string[]> = {
  login_id: ['login_id', 'id', '아이디', '로그인아이디', '로그인 아이디'],
  passcode: ['passcode', 'password', 'pw', '비밀번호', '비번', '패스코드'],
  display_name: ['display_name', 'name', '이름', '성명', '참가자', '참가자명'],
}

function normalizeHeader(raw: string): keyof ParticipantImportRow | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, '')
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((alias) => alias.toLowerCase().replace(/\s+/g, '') === key)) {
      return field as keyof ParticipantImportRow
    }
  }
  return null
}

/**
 * 엑셀에서 "CSV로 저장"하면 한국어 Windows 에서는 대개 UTF-8 이 아니라 CP949 로
 * 저장됩니다. 그대로 UTF-8 로 읽으면 이름이 전부 깨지므로, UTF-8 로 엄격하게
 * 디코딩해 보고 실패하면 EUC-KR(CP949 호환)로 다시 읽습니다.
 */
function decodeCsv(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('euc-kr').decode(buffer)
  }
}

export async function parseParticipantFile(
  file: File,
): Promise<ParticipantImportRow[]> {
  const buffer = await file.arrayBuffer()

  const workbook = file.name.toLowerCase().endsWith('.csv')
    ? XLSX.read(decodeCsv(buffer), { type: 'string' })
    : XLSX.read(buffer, { type: 'array' })

  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('파일에서 시트를 찾을 수 없습니다.')

  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
  })
  if (raw.length === 0) throw new Error('데이터 행이 없습니다.')

  // 첫 행의 헤더를 우리 필드명으로 매핑합니다.
  const mapping = new Map<string, keyof ParticipantImportRow>()
  for (const header of Object.keys(raw[0])) {
    const field = normalizeHeader(header)
    if (field) mapping.set(header, field)
  }

  const missing = (
    ['login_id', 'passcode', 'display_name'] as const
  ).filter((field) => ![...mapping.values()].includes(field))

  if (missing.length > 0) {
    throw new Error(
      `필요한 열을 찾지 못했습니다: ${missing.join(', ')}\n` +
        '첫 줄 헤더를 "아이디, 비밀번호, 이름" 또는 ' +
        '"login_id, passcode, display_name" 으로 맞춰 주세요.',
    )
  }

  const rows: ParticipantImportRow[] = []
  for (const record of raw) {
    const row: ParticipantImportRow = {
      login_id: '',
      passcode: '',
      display_name: '',
    }
    for (const [header, field] of mapping) {
      row[field] = String(record[header] ?? '').trim()
    }
    // 엑셀 파일 끝의 빈 행은 조용히 건너뜁니다.
    if (row.login_id && row.passcode && row.display_name) rows.push(row)
  }

  if (rows.length === 0)
    throw new Error('유효한 참가자 행이 없습니다. 세 열이 모두 채워져 있어야 합니다.')

  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.login_id.toLowerCase()
    if (seen.has(key)) throw new Error(`아이디가 중복되었습니다: ${row.login_id}`)
    seen.add(key)
  }

  return rows
}

/* ------------------------------------------------------------- export */

const TYPE_LABEL = SLIDE_TYPE_LABEL

function formatTimestamp(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/**
 * 시트를 두 벌로 만듭니다.
 *  - "응답(가로)" : 사람이 훑어보기 좋은 형태. 행=참가자, 열=문항.
 *  - "응답(세로)" : 집계/피벗용. 한 응답이 한 행.
 *  - "문항"       : 문항 정의 백업.
 */
export function buildWorkbook(params: {
  sessionTitle: string
  slides: Slide[]
  participants: AdminParticipant[]
  responses: ResponseRow[]
}): XLSX.WorkBook {
  const { sessionTitle, slides, participants, responses } = params

  // 안내 페이지는 응답이 없으므로 결과 시트에서 제외합니다.
  const questionSlides = slides
    .filter((s) => s.type !== 'info')
    .sort((a, b) => a.order_index - b.order_index)

  const byKey = new Map<string, ResponseRow>()
  for (const r of responses) byKey.set(`${r.slide_id}::${r.participant_id}`, r)

  // 의견은 안내 페이지에도 남을 수 있으므로, 의견 열은 모든 항목을 대상으로
  // 합니다. 반대로 응답 열은 고를 것이 있는 항목만 대상입니다.
  const allSlides = [...slides].sort((a, b) => a.order_index - b.order_index)

  /* 가로 */
  const wide = participants.map((p) => {
    const row: Record<string, string> = {
      이름: p.display_name,
      아이디: p.login_id,
    }
    questionSlides.forEach((slide, i) => {
      // 문항 제목이 겹쳐도 열이 합쳐지지 않도록 번호를 붙입니다.
      row[`${i + 1}. ${slide.title}`] = answerToText(
        byKey.get(`${slide.id}::${p.id}`)?.answer,
      )
    })
    allSlides.forEach((slide, i) => {
      const comment = byKey.get(`${slide.id}::${p.id}`)?.comment
      // 아무도 의견을 남기지 않은 항목까지 열을 만들면 표가 지저분해집니다.
      if (responses.some((r) => r.slide_id === slide.id && r.comment)) {
        row[`[의견] ${i + 1}. ${slide.title}`] = comment ?? ''
      }
    })
    return row
  })

  /* 세로 */
  const long: Record<string, string | number>[] = []
  for (const p of participants) {
    allSlides.forEach((slide, i) => {
      const response = byKey.get(`${slide.id}::${p.id}`)
      const isQuestion = slide.type !== 'info'
      // 응답도 의견도 없으면 행을 만들지 않습니다 (안내 페이지가 특히 그렇습니다).
      if (!isQuestion && !response?.comment) return

      long.push({
        이름: p.display_name,
        아이디: p.login_id,
        문항번호: i + 1,
        문항: slide.title,
        유형: TYPE_LABEL[slide.type],
        응답: answerToText(response?.answer),
        의견: response?.comment ?? '',
        응답여부: response?.answer ? 'O' : '',
        최초응답시각: formatTimestamp(response?.answered_at ?? null),
        최종수정시각: formatTimestamp(response?.updated_at ?? null),
      })
    })
  }

  /* 의견만 모아 보기 — 인터뷰 서베이에서는 여기가 제일 값진 시트입니다. */
  const comments: Record<string, string | number>[] = []
  for (const p of participants) {
    allSlides.forEach((slide, i) => {
      const comment = byKey.get(`${slide.id}::${p.id}`)?.comment
      if (!comment) return
      comments.push({
        문항번호: i + 1,
        문항: slide.title,
        이름: p.display_name,
        아이디: p.login_id,
        응답: answerToText(byKey.get(`${slide.id}::${p.id}`)?.answer),
        의견: comment,
      })
    })
  }

  /* 문항 정의 */
  const slideSheet = allSlides.map((slide, i) => {
    const options = slideOptions(slide.options)
    return {
      순서: i + 1,
      유형: TYPE_LABEL[slide.type],
      제목: slide.title,
      설명: slide.body ?? '',
      선택지: options.map((o) => o.label).join(' | '),
      선택지설명: options
        .filter((o) => o.description)
        .map((o) => `${o.label}: ${o.description}`)
        .join(' | '),
      복수선택: slide.multi ? 'O' : '',
    }
  })

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(wide),
    '응답(가로)',
  )
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(long),
    '응답(세로)',
  )
  if (comments.length > 0) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(comments),
      '의견',
    )
  }
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(slideSheet),
    '문항',
  )

  // 시트 이름에는 쓸 수 없는 문자가 있어 제목은 파일명에만 사용합니다.
  void sessionTitle
  return workbook
}

export function downloadWorkbook(workbook: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(workbook, filename)
}

/** 파일명에 쓸 수 없는 문자를 제거합니다. */
export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'survey'
}
