import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useLiveSession } from '../lib/useLiveSession'
import { formatDuration, useElapsedSeconds } from '../lib/useElapsed'
import { useWakeLock } from '../lib/useWakeLock'
import { SLIDE_TYPE_LABEL, type Slide } from '../lib/types'

export default function LiveControl({ sessionId }: { sessionId: string }) {
  const { session } = useLiveSession(sessionId)
  const [slides, setSlides] = useState<Slide[]>([])
  const [participantCount, setParticipantCount] = useState(0)
  const [answered, setAnswered] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingBack, setConfirmingBack] = useState(false)

  // 진행 중에는 화면이 꺼지면 곤란합니다.
  useWakeLock(session?.status === 'live')

  useEffect(() => {
    void (async () => {
      const [{ data: slideRows }, { count }] = await Promise.all([
        supabase
          .from('slides')
          .select('*')
          .eq('session_id', sessionId)
          .order('order_index'),
        supabase
          .from('participants')
          .select('id', { count: 'exact', head: true })
          .eq('session_id', sessionId),
      ])
      setSlides((slideRows as Slide[]) ?? [])
      setParticipantCount(count ?? 0)
    })()
  }, [sessionId])

  const current = slides.find(
    (s) => s.order_index === session?.current_slide_index,
  )
  const next = slides.find(
    (s) => s.order_index === (session?.current_slide_index ?? -1) + 1,
  )

  // 지금 문항에 몇 명이 답했는지. 응답 "내용"은 보지 않고 수만 셉니다.
  const refreshAnswered = useCallback(async () => {
    if (!current) {
      setAnswered(0)
      return
    }
    const { count } = await supabase
      .from('responses')
      .select('id', { count: 'exact', head: true })
      .eq('slide_id', current.id)
    setAnswered(count ?? 0)
  }, [current])

  useEffect(() => {
    void refreshAnswered()
    if (!current) return

    const channel = supabase
      .channel(`responses:${current.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'responses',
          filter: `slide_id=eq.${current.id}`,
        },
        () => void refreshAnswered(),
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [current, refreshAnswered])

  const call = async (fn: string, args: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    const { error: rpcError } = await supabase.rpc(fn, args)
    if (rpcError) setError(rpcError.message)
    setBusy(false)
    setConfirmingBack(false)
  }

  const totalElapsed = useElapsedSeconds(session?.started_at)
  const slideElapsed = useElapsedSeconds(session?.current_slide_started_at)

  if (!session) return <p className="muted">불러오는 중…</p>

  if (slides.length === 0)
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
            문항 {slides.length}개 · 등록된 참가자 {participantCount}명
          </p>
          <p className="muted">
            시작하면 참가자 폰이 첫 항목으로 동시에 넘어갑니다.
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
      </div>
    )

  /* --------------------------------------------------------- 진행 중 */
  const isLast = session.current_slide_index >= slides.length - 1

  return (
    <div className="control">
      <div className="timers">
        <div className="timer">
          <span className="timer__label">총 경과</span>
          <span className="timer__value">{formatDuration(totalElapsed)}</span>
        </div>
        <div className="timer">
          <span className="timer__label">이 항목</span>
          <span className="timer__value">{formatDuration(slideElapsed)}</span>
        </div>
      </div>

      <div className="card current">
        <span className="current__meta">
          {session.current_slide_index + 1} / {slides.length}
          {current && ` · ${SLIDE_TYPE_LABEL[current.type]}`}
        </span>
        <h2 className="current__title">{current?.title ?? '—'}</h2>
        {current?.body && <p className="current__body">{current.body}</p>}
      </div>

      <div className="card upnext">
        <span className="upnext__label">다음</span>
        <span className="upnext__title">
          {next ? next.title : '— 마지막 항목입니다 —'}
        </span>
      </div>

      {/* 응답 수만 보여 줍니다. 내용은 종료 후 결과 탭에서 확인합니다. */}
      {current && current.type !== 'info' && (
        <div className="counter">
          <span className="counter__value">
            {answered} <span className="counter__total">/ {participantCount}</span>
          </span>
          <span className="counter__label">응답</span>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <div className="control__actions">
        {confirmingBack ? (
          <div className="confirm">
            <span>이전 항목으로 돌아갈까요?</span>
            <button
              className="btn btn--sm"
              onClick={() => call('move_slide', { p_session_id: sessionId, p_delta: -1 })}
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
            disabled={busy || session.current_slide_index === 0}
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
            onClick={() => call('move_slide', { p_session_id: sessionId, p_delta: 1 })}
          >
            다음 →
          </button>
        )}
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
