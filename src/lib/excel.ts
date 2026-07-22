import * as XLSX from 'xlsx'
import {
  answerToText,
  orderSlides,
  slideOptions,
  SLIDE_TYPE_LABEL,
  type AdminParticipant,
  type Page,
  type ResponseRow,
  type Slide,
  type SlideOption,
  type SlideType,
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

/* -------------------------------------------------- 문항 import/export */

/**
 * 선택지는 한 칸에 `|` 로 구분해 담고, 설명이 있으면 `라벨 :: 설명` 으로 씁니다.
 *
 *   매우 그렇다 :: 기대보다 좋았다 | 보통 | 아니다
 *
 * 라벨과 설명을 두 열로 나누면 스프레드시트에서는 읽기 편하지만, 개수가
 * 어긋나는 순간 어느 설명이 어느 선택지 것인지 알 수 없게 됩니다. 짝을 붙여
 * 두면 그런 어긋남 자체가 생기지 않습니다.
 */
const OPTION_SEPARATOR = '|'
const DESCRIPTION_SEPARATOR = '::'

export function optionsToCell(options: SlideOption[]): string {
  return options
    .map((o) => (o.description ? `${o.label} ${DESCRIPTION_SEPARATOR} ${o.description}` : o.label))
    .join(` ${OPTION_SEPARATOR} `)
}

export function cellToOptions(cell: string): SlideOption[] {
  return cell
    .split(OPTION_SEPARATOR)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const at = chunk.indexOf(DESCRIPTION_SEPARATOR)
      if (at < 0) return { label: chunk }
      const label = chunk.slice(0, at).trim()
      const description = chunk.slice(at + DESCRIPTION_SEPARATOR.length).trim()
      return description ? { label, description } : { label }
    })
    .filter((o) => o.label)
}

/** 한국어 유형 이름과 영문 코드를 모두 받아 줍니다. */
const TYPE_FROM_TEXT: Record<string, SlideType> = {
  choice: 'choice',
  다지선다: 'choice',
  객관식: 'choice',
  ox: 'ox',
  OX: 'ox',
  '2지선다': 'ox',
  양자택일: 'ox',
  info: 'info',
  안내: 'info',
  '안내 페이지': 'info',
  안내페이지: 'info',
  text: 'text',
  주관식: 'text',
  '주관식 입력': 'text',
  자유입력: 'text',
}

export interface SlideImportRow {
  type: SlideType
  title: string
  body: string
  options: SlideOption[]
  multi: boolean
}

/** 가져온 파일의 페이지 하나. 문항 여러 개를 담습니다. */
export interface PageImport {
  title: string
  slides: SlideImportRow[]
}

const SLIDE_HEADER_ALIASES: Record<string, string> = {
  페이지: 'page',
  page: 'page',
  페이지제목: 'pageTitle',
  '페이지 제목': 'pageTitle',
  pagetitle: 'pageTitle',
  유형: 'type',
  type: 'type',
  종류: 'type',
  제목: 'title',
  title: 'title',
  질문: 'title',
  문항: 'title',
  설명: 'body',
  body: 'body',
  본문: 'body',
  선택지: 'options',
  options: 'options',
  보기: 'options',
  복수선택: 'multi',
  multi: 'multi',
}

export async function parseSlideFile(file: File): Promise<PageImport[]> {
  const buffer = await file.arrayBuffer()

  const workbook = file.name.toLowerCase().endsWith('.csv')
    ? XLSX.read(decodeCsv(buffer), { type: 'string' })
    : XLSX.read(buffer, { type: 'array' })

  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('파일에서 시트를 찾을 수 없습니다.')

  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
  if (raw.length === 0) throw new Error('데이터 행이 없습니다.')

  const mapping = new Map<string, string>()
  for (const header of Object.keys(raw[0])) {
    const field = SLIDE_HEADER_ALIASES[header.trim().replace(/\s+/g, '')]
      ?? SLIDE_HEADER_ALIASES[header.trim()]
    if (field) mapping.set(header, field)
  }

  const fields = [...mapping.values()]
  if (!fields.includes('type') || !fields.includes('title')) {
    throw new Error(
      '필요한 열을 찾지 못했습니다: 유형, 제목\n' +
        '첫 줄 헤더를 "페이지, 유형, 제목, 설명, 선택지, 복수선택" 으로 맞춰 주세요.',
    )
  }
  const hasPageColumn = fields.includes('page')

  /*
   * 페이지 열의 값이 같은 행끼리 한 페이지가 됩니다. 셀을 병합해 저장하면
   * 두 번째 행부터는 빈 값으로 읽히므로, 빈 칸은 "위 행과 같은 페이지"로
   * 봅니다. 페이지 열이 아예 없는 파일(예전 형식)은 문항마다 페이지를 하나씩
   * 만들어 예전과 같은 진행이 되게 합니다.
   */
  const pages: PageImport[] = []
  const pageByKey = new Map<string, PageImport>()
  let lastKey: string | null = null

  raw.forEach((record, i) => {
    const cell: Record<string, string> = {}
    for (const [header, field] of mapping) {
      cell[field] = String(record[header] ?? '').trim()
    }
    // 파일 끝의 빈 행은 조용히 건너뜁니다.
    if (!cell.type && !cell.title) return

    const type = TYPE_FROM_TEXT[cell.type] ?? TYPE_FROM_TEXT[cell.type?.toLowerCase()]
    if (!type) {
      throw new Error(
        `${i + 2}행: 알 수 없는 유형입니다 — "${cell.type}"\n` +
          '다지선다 / OX / 안내 페이지 / 주관식 중 하나여야 합니다.',
      )
    }
    if (!cell.title) throw new Error(`${i + 2}행: 제목이 비어 있습니다.`)

    const options = cellToOptions(cell.options ?? '')
    if (type === 'choice' && options.length === 0) {
      throw new Error(`${i + 2}행: 다지선다인데 선택지가 없습니다.`)
    }

    const slide: SlideImportRow = {
      type,
      title: cell.title,
      body: cell.body ?? '',
      options: type === 'ox' && options.length === 0
        ? [{ label: 'O' }, { label: 'X' }]
        : options,
      multi: /^(o|y|yes|true|1|예|О)$/i.test(cell.multi ?? ''),
    }

    const key = hasPageColumn
      ? (cell.page || lastKey || `행${i}`)
      : `행${i}`  // 페이지 열이 없으면 문항마다 새 페이지
    lastKey = key

    let page = pageByKey.get(key)
    if (!page) {
      page = { title: '', slides: [] }
      pageByKey.set(key, page)
      pages.push(page)
    }
    if (!page.title && cell.pageTitle) page.title = cell.pageTitle
    page.slides.push(slide)
  })

  if (pages.length === 0) throw new Error('유효한 문항 행이 없습니다.')
  return pages
}

/** 내보낸 파일을 그대로 다시 가져올 수 있는 형식으로 만듭니다. */
export function buildSlideWorkbook(pages: Page[], slides: Slide[]): XLSX.WorkBook {
  const sorted = [...pages].sort((a, b) => a.order_index - b.order_index)
  const rows = sorted.flatMap((page, pageNo) =>
    slides
      .filter((s) => s.page_id === page.id)
      .sort((a, b) => a.order_index - b.order_index)
      .map((slide) => ({
        페이지: pageNo + 1,
        페이지제목: page.title ?? '',
        유형: SLIDE_TYPE_LABEL[slide.type],
        제목: slide.title,
        설명: slide.body ?? '',
        선택지: optionsToCell(slideOptions(slide.options)),
        복수선택: slide.multi ? 'O' : '',
      })),
  )

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), '문항')
  return workbook
}

export function buildSlideTemplate(): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        페이지: 1,
        페이지제목: '안내',
        유형: '안내 페이지',
        제목: '설문 안내',
        설명: '지금부터 설문을 시작하겠습니다.',
        선택지: '',
        복수선택: '',
      },
      {
        페이지: 2,
        페이지제목: '만족도',
        유형: '다지선다',
        제목: '이번 세션은 어떠셨나요?',
        설명: '',
        선택지: '매우 좋았다 :: 기대보다 좋았다 | 보통이다 | 아쉬웠다',
        복수선택: '',
      },
      {
        // 페이지 값이 같으면 위 문항과 같은 페이지에 함께 나옵니다.
        페이지: 2,
        페이지제목: '',
        유형: 'OX',
        제목: '다음에도 참여하시겠습니까?',
        설명: '',
        선택지: 'O :: 참여하겠다 | X :: 참여하지 않겠다',
        복수선택: '',
      },
      {
        페이지: 3,
        페이지제목: '',
        유형: '주관식',
        제목: '자유롭게 의견을 남겨 주세요',
        설명: '',
        선택지: '',
        복수선택: '',
      },
    ]),
    '문항',
  )
  return workbook
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
  pages: Page[]
  slides: Slide[]
  participants: AdminParticipant[]
  responses: ResponseRow[]
  /** 여러 세션을 한 파일에 담을 때 세션 이름 열을 넣습니다. */
  includeSession?: boolean
}): XLSX.WorkBook {
  const { pages, slides, participants, responses, includeSession = false } = params

  /** 세션 열은 여러 세션이 섞일 때만 의미가 있습니다. */
  const who = (p: AdminParticipant): Record<string, string> =>
    includeSession
      ? { 세션: p.session_name ?? '', 이름: p.display_name, 아이디: p.login_id }
      : { 이름: p.display_name, 아이디: p.login_id }

  const byKey = new Map<string, ResponseRow>()
  for (const r of responses) byKey.set(`${r.slide_id}::${r.participant_id}`, r)

  // 의견은 안내 페이지에도 남을 수 있으므로, 의견 열은 모든 항목을 대상으로
  // 합니다. 반대로 응답 열은 고를 것이 있는 항목만 대상입니다.
  const allSlides = orderSlides(pages, slides)

  // 안내 페이지는 응답이 없으므로 결과 시트에서 제외합니다.
  const questionSlides = allSlides.filter((s) => s.type !== 'info')

  /** 문항이 몇 번째 페이지에 있는지 (1부터). */
  const pageNoById = new Map(
    [...pages]
      .sort((a, b) => a.order_index - b.order_index)
      .map((p, i) => [p.id, i + 1]),
  )
  const pageNo = (slide: Slide): number => pageNoById.get(slide.page_id) ?? 0

  /* 가로 */
  const wide = participants.map((p) => {
    const row: Record<string, string> = { ...who(p) }
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
        ...who(p),
        페이지: pageNo(slide),
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
        페이지: pageNo(slide),
        문항번호: i + 1,
        문항: slide.title,
        ...who(p),
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
      페이지: pageNo(slide),
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

  return workbook
}

export function downloadWorkbook(workbook: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(workbook, filename)
}

/** 파일명에 쓸 수 없는 문자를 제거합니다. */
export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'survey'
}
