import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useLiveSession } from '../lib/useLiveSession'
import { formatDuration, useElapsedSeconds } from '../lib/useElapsed'
import { useWakeLock } from '../lib/useWakeLock'
import { SLIDE_TYPE_LABEL, type Page, type Slide } from '../lib/types'

export default function LiveControl({
  sessionId,
  surveyId,
  onChanged,
}: {
  sessionId: string
  /** 페이지·문항은 세션이 아니라 설문에 붙어 있습니다. */
  surveyId: string
  /** 진행 상태가 바뀌면 사이드바의 표시도 갱신합니다. */
  onChanged?: () => void
}) {
  const { session } = useLiveSession(sessionId)
  const [pages, setPages] = useState<Page[]>([])
  const [slides, setSlides] = useState<Slide[]>([])
  const [participantCount, setParticipantCount] = useState(0)
  /** 문항별 응답 인원 (answer 가 실제로 채워진 행만). */
  const [answered, setAnswered] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingBack, setConfirmingBack] = useState(false)

  // 진행 중에는 화면이 꺼지면 곤란합니다.
  useWakeLock(session?.status === 'live')

  useEffect(() => {
    void (async () => {
      const [{ data: pageRows }, { data: slideRows }, { count }] = await Promise.all([
        supabase
          .from('pages')
          .select('*')
          .eq('survey_id', surveyId)
          .order('order_index'),
        supabase
          .from('slides')
          .select('*')
          .eq('survey_id', surveyId)
          .order('order_index'),
        supabase
          .from('participants')
          .select('id', { count: 'exact', head: true })
          .eq('session_id', sessionId),
      ])
      setPages((pageRows as Page[]) ?? [])
      setSlides((slideRows as Slide[]) ?? [])
      setParticipantCount(count ?? 0)
    })()
  }, [sessionId, surveyId])

  const pageSlides = useCallback(
    (page: Page | undefined) =>
      page
        ? slides
            .filter((s) => s.page_id === page.id)
            .sort((a, b) => a.order_index - b.order_index)
        : [],
    [slides],
  )

  const current = pages.find((p) => p.order_index === session?.current_page_index)
  const next = pages.find(
    (p) => p.order_index === (session?.current_page_index ?? -1) + 1,
  )
  const currentSlides = pageSlides(current)
  const currentQuestions = currentSlides.filter((s) => s.type !== 'info')

  // 지금 페이지의 문항마다 몇 명이 답했는지. 응답 "내용"은 보지 않고 수만 셉니다.
  // (배열은 렌더마다 새로 만들어지므로, 의존성은 id 를 이어 붙인 문자열로 둡니다.)
  const questionIds = currentQuestions.map((s) => s.id).join(',')
  const refreshAnswered = useCallback(async () => {
    const ids = questionIds ? questionIds.split(',') : []
    if (ids.length === 0) {
      setAnswered({})
      return
    }
    // 의견만 남기고 답은 고르지 않은 사람도 행이 생기므로, 실제로 응답한
    // 사람만 셉니다. (이 숫자를 보고 넘길 타이밍을 잡기 때문에 중요합니다.)
    // 문항은 설문의 여러 회차가 공유하므로 이 회차의 응답만 셉니다.
    const { data } = await supabase
      .from('responses')
      .select('slide_id')
      .eq('session_id', sessionId)
      .in('slide_id', ids)
      .not('answer', 'is', null)
    const counts: Record<string, number> = {}
    for (const row of (data as { slide_id: string }[]) ?? []) {
      counts[row.slide_id] = (counts[row.slide_id] ?? 0) + 1
    }
    setAnswered(counts)
  }, [questionIds, sessionId])

  useEffect(() => {
    void refreshAnswered()
    if (!current) return

    // 페이지 안 문항이 여럿이라 세션 단위로 구독합니다.
    const channel = supabase
      .channel(`responses:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'responses',
          filter: `session_id=eq.${sessionId}`,
        },
        () => void refreshAnswered(),
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void refreshAnswered()
      })

    // 카운터가 멈춰 있으면 관리자가 넘길 타이밍을 잘못 잡게 되므로,
    // Realtime 이벤트가 유실돼도 숫자는 따라오게 해 둡니다.
    const poll = setInterval(() => void refreshAnswered(), 5000)

    return () => {
      clearInterval(poll)
      void supabase.removeChannel(channel)
    }
  }, [current?.id, sessionId, refreshAnswered])

  const call = async (fn: string, args: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    const { error: rpcError } = await supabase.rpc(fn, args)
    if (rpcError) setError(rpcError.message)
    else onChanged?.()
    setBusy(false)
    setConfirmingBack(false)
  }

  const totalElapsed = useElapsedSeconds(session?.started_at)
  const pageElapsed = useElapsedSeconds(session?.current_page_started_at)

  if (!session) return <p className="muted">불러오는 중…</p>

  if (pages.length === 0 || slides.length === 0)
    return (
      <div className="card">
        <p className="muted">
          문항이 없습니다. <strong>문항</strong> 탭에서 먼저 항목을 추가해 주세요.
        </p>
      </div>
    )

  const presentUrl = `${location.origin}${location.pathname}#/present/${sessionId}`

  /* --------------------------------------------------------- 준비 중 */
  if (session.status === 'draft')
    return (
      <div className="control">
        <div className="card">
          <p>
            페이지 {pages.length}개 · 문항 {slides.length}개 · 등록된 참가자{' '}
            {participantCount}명
          </p>
          <p className="muted">
            시작하면 참가자 폰이 첫 페이지로 동시에 넘어갑니다.
          </p>
          {participantCount === 0 && (
            <p className="warn">
              등록된 참가자가 없습니다. <strong>참가자</strong> 탭에서 명단을
              먼저 올려 주세요.
            </p>
          )}
        </div>

        <PresentLink url={presentUrl} />

        {error && <p className="error">{error}</p>}
        <button
          className="btn btn--primary btn--block btn--lg"
          disabled={busy}
          onClick={() => call('start_session', { p_session_id: sessionId })}
        >
          설문 시작
        </button>
      </div>
    )

  /* ----------------------------------------------------------- 종료 */
  if (session.status === 'ended')
    return (
      <div className="control">
        <div className="card">
          <h2>설문이 종료되었습니다</h2>
          <p className="muted">총 진행 시간 {formatDuration(totalElapsed)}</p>
          <p className="muted">
            <strong>결과</strong> 탭에서 엑셀로 내려받을 수 있습니다.
          </p>
        </div>

        {error && <p className="error">{error}</p>}
        <ResetButton
          sessionId={sessionId}
          onDone={() => {
            setError(null)
            onChanged?.()
          }}
        />
      </div>
    )

  /* --------------------------------------------------------- 진행 중 */
  const isLast = session.current_page_index >= pages.length - 1
  const nextSlides = pageSlides(next)

  /** 페이지를 요약해 보여 줍니다 — 제목이 있으면 제목, 없으면 첫 문항. */
  const pageLabel = (page: Page | undefined, inPage: Slide[]) =>
    page?.title || inPage[0]?.title || '(빈 페이지)'

  return (
    <div className="control">
      <div className="timers">
        <div className="timer">
          <span className="timer__label">총 경과</span>
          <span className="timer__value">{formatDuration(totalElapsed)}</span>
        </div>
        <div className="timer">
          <span className="timer__label">이 페이지</span>
          <span className="timer__value">{formatDuration(pageElapsed)}</span>
        </div>
      </div>

      <div className="card current">
        <span className="current__meta">
          {session.current_page_index + 1} / {pages.length} 페이지
          {currentSlides.length > 1 && ` · 문항 ${currentSlides.length}개`}
          {currentSlides.length === 1 &&
            ` · ${SLIDE_TYPE_LABEL[currentSlides[0].type]}`}
        </span>
        <h2 className="current__title">{pageLabel(current, currentSlides)}</h2>
        {currentSlides.length === 1 && currentSlides[0].body && (
          <p className="current__body">{currentSlides[0].body}</p>
        )}

        {/* 문항이 여럿이면 문항별 응답 수를 나란히 보여 줍니다.
            이 숫자를 보고 넘길 타이밍을 잡습니다. */}
        {currentSlides.length > 1 && (
          <ul className="current__slides">
            {currentSlides.map((slide) => (
              <li key={slide.id} className="current__slide">
                <span
                  className={`slide-card__type slide-card__type--${slide.type}`}
                >
                  {SLIDE_TYPE_LABEL[slide.type]}
                </span>
                <span className="current__slide-title">
                  {slide.title || '(제목 없음)'}
                </span>
                {slide.type !== 'info' && (
                  <span className="current__slide-count">
                    {answered[slide.id] ?? 0} / {participantCount}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card upnext">
        <span className="upnext__label">다음</span>
        <span className="upnext__title">
          {next ? pageLabel(next, nextSlides) : '— 마지막 페이지입니다 —'}
        </span>
      </div>

      {/* 문항이 하나면 예전처럼 큰 카운터 하나만 보여 줍니다. */}
      {currentQuestions.length === 1 && (
        <div className="counter">
          <span className="counter__value">
            {answered[currentQuestions[0].id] ?? 0}{' '}
            <span className="counter__total">/ {participantCount}</span>
          </span>
          <span className="counter__label">응답</span>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <div className="control__actions">
        {confirmingBack ? (
          <div className="confirm">
            <span>이전 페이지로 돌아갈까요?</span>
            <button
              className="btn btn--sm"
              onClick={() => call('move_page', { p_session_id: sessionId, p_delta: -1 })}
            >
              돌아가기
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => setConfirmingBack(false)}>
              취소
            </button>
          </div>
        ) : (
          <button
            className="btn btn--ghost btn--sm"
            disabled={busy || session.current_page_index === 0}
            onClick={() => setConfirmingBack(true)}
          >
            ← 이전
          </button>
        )}

        {isLast ? (
          <button
            className="btn btn--danger btn--block btn--lg"
            disabled={busy}
            onClick={() => call('end_session', { p_session_id: sessionId })}
          >
            설문 종료
          </button>
        ) : (
          <button
            className="btn btn--primary btn--block btn--lg"
            disabled={busy}
            onClick={() => call('move_page', { p_session_id: sessionId, p_delta: 1 })}
          >
            다음 →
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 응답을 지우고 준비 중 상태로 되돌립니다.
 *
 * 되돌릴 수 없는 동작이라 두 단계로 나눴습니다. 리허설 직후에 누르는 것이
 * 정상 흐름이지만, 본 진행이 끝난 화면에서도 같은 자리에 있기 때문에
 * 실수로 눌러 응답을 날리는 일을 막아야 합니다.
 */
function ResetButton({
  sessionId,
  onDone,
}: {
  sessionId: string
  onDone: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = async () => {
    setBusy(true)
    setError(null)
    const { error: rpcError } = await supabase.rpc('reset_session', {
      p_session_id: sessionId,
    })
    if (rpcError) setError(rpcError.message)
    else {
      setConfirming(false)
      onDone()
    }
    setBusy(false)
  }

  if (!confirming)
    return (
      <div className="card">
        <h2>다시 시작하기</h2>
        <p className="muted">
          받은 응답을 모두 지우고 준비 중 상태로 되돌립니다. 리허설을 마치고 본
          진행을 시작할 때 사용합니다.
        </p>
        <p className="warn">
          결과가 필요하면 <strong>먼저 결과 탭에서 엑셀로 내려받으세요.</strong>{' '}
          지운 응답은 되돌릴 수 없습니다.
        </p>
        <button className="btn" onClick={() => setConfirming(true)}>
          다시 시작하기
        </button>
      </div>
    )

  return (
    <div className="card card--danger">
      <h2>정말 지울까요?</h2>
      <p className="muted">
        이 설문의 응답과 의견이 모두 사라집니다. 문항과 참가자 명단은 그대로
        남고, 참가자는 다시 로그인하지 않아도 됩니다.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn btn--danger" disabled={busy} onClick={reset}>
          {busy ? '지우는 중…' : '응답을 지우고 다시 시작'}
        </button>
        <button
          className="btn btn--ghost"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          취소
        </button>
      </div>
    </div>
  )
}

function PresentLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="card">
      <p className="muted">
        빔프로젝터에 연결한 노트북에서 이 주소를 열어 두세요. 조작 없이 진행을
        따라갑니다. (같은 브라우저에서 관리자 로그인이 되어 있어야 합니다.)
      </p>
      <code className="code">{url}</code>
      <button
        className="btn btn--sm"
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          })
        }}
      >
        {copied ? '복사됨' : '주소 복사'}
      </button>
    </div>
  )
}
