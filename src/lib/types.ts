export type SlideType = 'choice' | 'ox' | 'info' | 'text'

export const SLIDE_TYPE_LABEL: Record<SlideType, string> = {
  choice: '다지선다',
  ox: 'OX (2지선다)',
  info: '안내 페이지',
  text: '주관식 입력',
}

export type SessionStatus = 'draft' | 'live' | 'ended'

export interface Session {
  id: string
  title: string
  status: SessionStatus
  current_slide_index: number
  started_at: string | null
  current_slide_started_at: string | null
  ended_at: string | null
  created_at: string
}

export interface Slide {
  id: string
  session_id: string
  order_index: number
  type: SlideType
  title: string
  body: string | null
  options: string[]
  multi: boolean
  required: boolean
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
}

export interface ResponseRow {
  id: string
  session_id: string
  slide_id: string
  participant_id: string
  answer: Answer
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
