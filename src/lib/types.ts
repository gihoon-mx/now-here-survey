export type SlideType = 'choice' | 'ox' | 'info' | 'text'

export const SLIDE_TYPE_LABEL: Record<SlideType, string> = {
  choice: '다지선다',
  ox: 'OX (2지선다)',
  info: '안내 페이지',
  text: '주관식 입력',
}

export type SessionStatus = 'draft' | 'live' | 'ended'

/** 설문 하나. 문항을 보유하고, 아래 Session 으로 여러 번 진행할 수 있습니다. */
export interface Survey {
  id: string
  title: string
  created_at: string
}

/** 설문의 진행 회차. 회차마다 참가자·진행상태·응답이 따로입니다. */
export interface Session {
  id: string
  survey_id: string
  name: string
  status: SessionStatus
  current_page_index: number
  started_at: string | null
  current_page_started_at: string | null
  ended_at: string | null
  created_at: string
}

/**
 * 페이지. 진행자가 한 번에 넘기는 단위이고, 문항을 여러 개 담을 수 있습니다.
 * 참가자는 한 페이지 안의 문항을 스크롤하며 모두 답한 뒤 다음 페이지를 기다립니다.
 */
export interface Page {
  id: string
  survey_id: string
  order_index: number
  title: string | null
}

/** 선택지 하나. 설명은 선택지 아래 작은 글씨로 표시됩니다. */
export interface SlideOption {
  label: string
  description?: string
}

/**
 * DB 에는 예전 형식(문자열 배열)이 남아 있을 수 있어 둘 다 받습니다.
 * 읽을 때는 항상 slideOptions() 를 거쳐 형식을 맞춥니다.
 */
export type RawOption = string | SlideOption

export interface Slide {
  id: string
  survey_id: string
  page_id: string
  /** 페이지 안에서의 순서입니다 (설문 전체 순서가 아니라). */
  order_index: number
  type: SlideType
  title: string
  body: string | null
  options: RawOption[]
  multi: boolean
  required: boolean
}

/** 페이지 순서 → 페이지 안 순서로 문항을 설문 전체 순서로 폅니다. */
export function orderSlides(pages: Page[], slides: Slide[]): Slide[] {
  const pageOrder = new Map(pages.map((p) => [p.id, p.order_index]))
  return [...slides].sort(
    (a, b) =>
      (pageOrder.get(a.page_id) ?? 0) - (pageOrder.get(b.page_id) ?? 0) ||
      a.order_index - b.order_index,
  )
}

/** 어떤 형식으로 저장돼 있든 { label, description } 배열로 돌려줍니다. */
export function slideOptions(options: RawOption[] | null | undefined): SlideOption[] {
  if (!Array.isArray(options)) return []
  return options.map((option) =>
    typeof option === 'string'
      ? { label: option }
      : { label: option?.label ?? '', description: option?.description || undefined },
  )
}

export interface Participant {
  id: string
  session_id: string
  login_id: string
  display_name: string
  last_seen_at: string | null
}

/** admin_list_participants RPC 의 반환 형태 (passcode 포함 — 관리자 전용) */
export interface AdminParticipant {
  id: string
  login_id: string
  passcode: string
  display_name: string
  connected: boolean
  last_seen_at: string | null
  /** 설문 전체 결과를 내보낼 때만 채워집니다. */
  session_id?: string
  session_name?: string
}

export interface ResponseRow {
  id: string
  session_id: string
  slide_id: string
  participant_id: string
  /** 안내 페이지처럼 고를 것이 없는 항목에서는 비어 있습니다. */
  answer: Answer | null
  /** 항목별 자유 의견. 모든 항목에서 남길 수 있습니다. */
  comment: string | null
  answered_at: string
  updated_at: string
}

/**
 * 응답 값의 모양은 슬라이드 타입에 따라 다릅니다.
 *  - choice (단일) : { choice: "선택지 텍스트" }
 *  - choice (복수) : { choices: ["A", "B"] }
 *  - ox            : { choice: "O" | "X" }
 *  - text          : { text: "자유 입력" }
 */
export interface Answer {
  choice?: string
  choices?: string[]
  text?: string
}

/** 응답을 엑셀 셀 하나에 들어갈 문자열로 평탄화합니다. */
export function answerToText(answer: Answer | null | undefined): string {
  if (!answer) return ''
  if (answer.text != null) return answer.text
  if (answer.choices != null) return answer.choices.join(', ')
  if (answer.choice != null) return answer.choice
  return ''
}
