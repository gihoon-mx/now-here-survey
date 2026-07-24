import { useCallback, useEffect, useState } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import type { ExportScope } from './ResultsExport'
import {
  answerToText,
  slideOptions,
  SLIDE_TYPE_LABEL,
  type AdminParticipant,
  type Answer,
  type Page,
  type ResponseRow,
  type Slide,
} from '../lib/types'

/**
 * 문항별 응답 현황을 웹에서 바로 봅니다. 엑셀을 내려받기 전에 결과를
 * 훑어보거나, 진행 직후 현장에서 바로 공유할 때 씁니다.
 *
 * 선택형은 선택지별 인원과 막대, 주관식·의견은 원문 목록으로 보여 줍니다.
 * 집계는 화면에서만 하고 DB 에는 아무것도 쓰지 않습니다.
 */
export default function ResultsView({
  surveyId,
  scope,
}: {
  surveyId: string
  scope: ExportScope
}) {
  const [pages, setPages] = useState<Page[]>([])
  const [slides, setSlides] = useState<Slide[]>([])
  const [participants, setParticipants] = useState<AdminParticipant[]>([])
  const [responses, setResponses] = useState<ResponseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)

  // scope 객체는 렌더마다 새로 만들어지므로 의존성은 원시값으로 풀어 둡니다.
  const sessionId = scope.kind === 'session' ? scope.sessionId : null

  const load = useCallback(async () => {
    setError(null)
    try {
      const [pagesRes, slidesRes] = await Promise.all([
        supabase.from('pages').select('*').eq('survey_id', surveyId).order('order_index'),
        supabase.from('slides').select('*').eq('survey_id', surveyId).order('order_index'),
      ])
      if (pagesRes.error) throw new Error(pagesRes.error.message)
      if (slidesRes.error) throw new Error(slidesRes.error.message)

      let pRows: AdminParticipant[]
      let rRows: ResponseRow[]
      if (sessionId === null) {
        // 응답이 1000행을 넘으면 전량을 페이지로 넘겨 가져옵니다.
        const [pRes, rows] = await Promise.all([
          supabase.rpc('admin_survey_participants', { p_survey_id: surveyId }),
          fetchAllRows<ResponseRow>(() =>
            supabase
              .from('responses')
              .select('*, sessions!inner(survey_id)')
              .eq('sessions.survey_id', surveyId),
          ),
        ])
        if (pRes.error) throw new Error(pRes.error.message)
        pRows = (pRes.data as AdminParticipant[]) ?? []
        rRows = rows
      } else {
        const [pRes, rows] = await Promise.all([
          supabase.rpc('admin_list_participants', { p_session_id: sessionId }),
          fetchAllRows<ResponseRow>(() =>
            supabase.from('responses').select('*').eq('session_id', sessionId),
          ),
        ])
        if (pRes.error) throw new Error(pRes.error.message)
        pRows = (pRes.data as AdminParticipant[]) ?? []
        rRows = rows
      }

      setPages((pagesRes.data as Page[]) ?? [])
      setSlides((slidesRes.data as Slide[]) ?? [])
      setParticipants(pRows)
      setResponses(rRows)
      setLoadedAt(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : '결과를 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [surveyId, sessionId])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  if (loading) return <p className="muted">결과를 불러오는 중…</p>

  if (error)
    return (
      <div className="card">
        <p className="error">{error}</p>
        <button className="btn btn--sm" onClick={() => void load()}>
          다시 시도
        </button>
      </div>
    )

  const nameById = new Map(participants.map((p) => [p.id, p.display_name]))
  const total = participants.length

  /** 문항별 응답 행. 이름을 붙여 돌려줍니다. */
  const rowsFor = (slideId: string) =>
    responses
      .filter((r) => r.slide_id === slideId)
      .map((r) => ({ ...r, name: nameById.get(r.participant_id) ?? '(알 수 없음)' }))

  const sortedPages = [...pages].sort((a, b) => a.order_index - b.order_index)
  let questionNo = 0

  return (
    <div className="results">
      <div className="results__head">
        <p className="muted">
          참가자 {total}명
          {loadedAt &&
            ` · ${loadedAt.toLocaleTimeString('ko-KR', { hour12: false })} 기준`}
        </p>
        <button className="btn btn--sm" onClick={() => void load()}>
          새로고침
        </button>
      </div>

      {slides.length === 0 && <p className="muted">문항이 없습니다.</p>}
      {slides.length > 0 && responses.length === 0 && (
        <p className="muted">아직 받은 응답이 없습니다.</p>
      )}

      {sortedPages.map((page, pageNo) => {
        const inPage = slides
          .filter((s) => s.page_id === page.id)
          .sort((a, b) => a.order_index - b.order_index)
        if (inPage.length === 0) return null

        return (
          <section key={page.id} className="results__page">
            <h3 className="results__page-title">
              {pageNo + 1}페이지{page.title ? ` — ${page.title}` : ''}
            </h3>

            {inPage.map((slide) => {
              if (slide.type !== 'info') questionNo += 1
              return (
                <QuestionResult
                  key={slide.id}
                  slide={slide}
                  number={slide.type !== 'info' ? questionNo : null}
                  rows={rowsFor(slide.id)}
                  total={total}
                />
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

type NamedRow = ResponseRow & { name: string }

function QuestionResult({
  slide,
  number,
  rows,
  total,
}: {
  slide: Slide
  number: number | null
  rows: NamedRow[]
  total: number
}) {
  const comments = rows.filter((r) => r.comment)
  const answeredRows = rows.filter((r) => r.answer != null)

  return (
    <div className="card rq">
      <div className="rq__head">
        {number != null && <span className="rq__num">Q{number}</span>}
        <span className={`slide-card__type slide-card__type--${slide.type}`}>
          {SLIDE_TYPE_LABEL[slide.type]}
        </span>
        {slide.type !== 'info' && (
          <span className="rq__count">
            응답 {answeredRows.length} / {total}
          </span>
        )}
      </div>
      <h4 className="rq__title">{slide.title || '(제목 없음)'}</h4>

      {(slide.type === 'choice' || slide.type === 'ox') && (
        <ChoiceBreakdown slide={slide} answers={answeredRows.map((r) => r.answer!)} total={total} />
      )}

      {slide.type === 'text' && (
        <ul className="rq__texts">
          {answeredRows.length === 0 && <li className="muted">아직 응답이 없습니다.</li>}
          {answeredRows.map((r) => (
            <li key={r.id} className="rq__text">
              <span className="rq__who">{r.name}</span>
              <span>{answerToText(r.answer)}</span>
            </li>
          ))}
        </ul>
      )}

      {comments.length > 0 && (
        <div className="rq__comments">
          <span className="rq__comments-label">의견 {comments.length}건</span>
          <ul className="rq__texts">
            {comments.map((r) => (
              <li key={r.id} className="rq__text rq__text--comment">
                <span className="rq__who">{r.name}</span>
                <span>{r.comment}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * 선택지별 인원 집계. 복수 선택은 고른 것마다 셉니다.
 * 선택지를 나중에 고쳐서 지금 목록에 없는 응답이 있으면 버리지 않고
 * "(현재 없는 선택지)" 로 함께 보여 줍니다 — 조용히 사라지면 합계가 안 맞습니다.
 */
function ChoiceBreakdown({
  slide,
  answers,
  total,
}: {
  slide: Slide
  answers: Answer[]
  total: number
}) {
  const options = slideOptions(slide.options)
  const counts = new Map<string, number>(options.map((o) => [o.label, 0]))
  const orphans = new Map<string, number>()

  for (const answer of answers) {
    const picked = answer.choices ?? (answer.choice != null ? [answer.choice] : [])
    for (const label of picked) {
      if (counts.has(label)) counts.set(label, (counts.get(label) ?? 0) + 1)
      else orphans.set(label, (orphans.get(label) ?? 0) + 1)
    }
  }

  const bars: { label: string; count: number; orphan?: boolean }[] = [
    ...options.map((o) => ({ label: o.label, count: counts.get(o.label) ?? 0 })),
    ...[...orphans].map(([label, count]) => ({ label, count, orphan: true })),
  ]
  const max = Math.max(1, ...bars.map((b) => b.count))

  return (
    <ul className="rq__bars">
      {bars.map((bar) => (
        <li key={bar.label} className="rq__bar-row">
          <span className={'rq__bar-label' + (bar.orphan ? ' rq__bar-label--orphan' : '')}>
            {bar.label}
            {bar.orphan && ' (현재 없는 선택지)'}
          </span>
          <span className="rq__bar-track">
            <span
              className="rq__bar-fill"
              style={{ width: `${(bar.count / max) * 100}%` }}
            />
          </span>
          <span className="rq__bar-count">
            {bar.count}
            {total > 0 && (
              <span className="rq__bar-pct">
                {' '}
                ({Math.round((bar.count / total) * 100)}%)
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
