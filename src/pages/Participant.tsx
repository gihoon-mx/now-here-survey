import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useLiveSession } from '../lib/useLiveSession'
import { SlideView } from '../components/SlideView'
import type { Answer, Page, Participant, Slide } from '../lib/types'

export default function ParticipantPage() {
  const [booting, setBooting] = useState(true)
  const [participant, setParticipant] = useState<Participant | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        // 1) 익명 세션 확보. 이 토큰이 있어야 RLS 가 "이 사람"을 식별할 수 있습니다.
        //
        // 관리자로 로그인한 브라우저에서 이 화면을 열면 그 세션이 남아 있는데,
        // 관리자는 참가자 명단 전체가 보이기 때문에 아래 조회가 깨지고
        // 자칫 관리자 계정이 참가자로 묶일 수도 있습니다. 참가자 화면에서는
        // 익명 세션만 재사용하고, 그 밖의 세션은 정리하고 새로 발급받습니다.
        const { data: existing } = await supabase.auth.getSession()
        if (!existing.session?.user.is_anonymous) {
          if (existing.session) await supabase.auth.signOut()
          const { error } = await supabase.auth.signInAnonymously()
          if (error) throw error
        }

        // 2) 이미 이 기기에서 로그인한 적이 있으면 바로 복귀시킵니다.
        //    (폰을 잠갔다 켜거나 새로고침한 경우 — 현장에서 가장 흔한 상황)
        const { data } = await supabase
          .from('participants')
          .select('id, session_id, login_id, display_name, last_seen_at')
          .maybeSingle()

        if (data) setParticipant(data as Participant)
      } catch (err) {
        setBootError(
          err instanceof Error
            ? `접속 준비에 실패했습니다: ${err.message}`
            : '접속 준비에 실패했습니다.',
        )
      } finally {
        setBooting(false)
      }
    })()
  }, [])

  if (booting) return <Centered>접속 중…</Centered>
  if (bootError)
    return (
      <Centered>
        <p className="error">{bootError}</p>
        <button className="btn" onClick={() => location.reload()}>
          다시 시도
        </button>
      </Centered>
    )

  if (!participant) return <LoginForm onLoggedIn={setParticipant} />
  return <LiveView participant={participant} />
}

/* ---------------------------------------------------------------- 로그인 */

function LoginForm({ onLoggedIn }: { onLoggedIn: (p: Participant) => void }) {
  const [loginId, setLoginId] = useState('')
  const [passcode, setPasscode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)

    const { data, error: rpcError } = await supabase.rpc('claim_participant', {
      p_login_id: loginId,
      p_passcode: passcode,
    })

    if (rpcError || !data?.[0]) {
      setError(rpcError?.message ?? '로그인에 실패했습니다.')
      setBusy(false)
      return
    }

    const row = data[0]
    onLoggedIn({
      id: row.participant_id,
      session_id: row.session_id,
      login_id: loginId,
      display_name: row.display_name,
      last_seen_at: null,
    })
  }

  return (
    <div className="screen screen--center">
      <form className="card login" onSubmit={submit}>
        <h1 className="login__title">📝 설문 참여</h1>
        <p className="login__hint">진행자가 안내한 아이디와 비밀번호를 입력해 주세요.</p>

        <label className="field">
          <span>아이디</span>
          <input
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            required
          />
        </label>

        <label className="field">
          <span>비밀번호</span>
          <input
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            required
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn btn--primary btn--block" disabled={busy}>
          {busy ? '확인 중…' : '입장'}
        </button>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------- 진행 화면 */

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

function LiveView({ participant }: { participant: Participant }) {
  const { session } = useLiveSession(participant.session_id)
  const [surveyTitle, setSurveyTitle] = useState('')
  const [page, setPage] = useState<Page | null>(null)
  const [slides, setSlides] = useState<Slide[]>([])
  // 페이지 안 문항마다 응답·의견·저장 상태를 따로 둡니다.
  const [answers, setAnswers] = useState<Record<string, Answer | null>>({})
  const [comments, setComments] = useState<Record<string, string>>({})
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({})
  const [saveError, setSaveError] = useState<string | null>(null)

  const index = session?.current_page_index ?? null
  const live = session?.status === 'live'
  // 진행자가 "페이지 시작"을 누르기 전에는 현재 페이지가 열리지 않습니다.
  const revealed = session?.page_revealed ?? false

  // 대기 화면에 보여 줄 설문 제목. RLS 로 자기 회차의 설문만 읽힙니다.
  useEffect(() => {
    if (!session?.survey_id) return
    void (async () => {
      const { data } = await supabase
        .from('surveys')
        .select('title')
        .eq('id', session.survey_id)
        .maybeSingle()
      if (data) setSurveyTitle(data.title as string)
    })()
  }, [session?.survey_id])

  // 페이지가 열릴 때마다 그 페이지의 문항과 "내가 이미 낸 응답"을 불러옵니다.
  useEffect(() => {
    if (!live || index == null || !revealed) {
      setPage(null)
      setSlides([])
      return
    }
    let cancelled = false

    void (async () => {
      // 페이지는 설문에 붙어 있습니다. RLS 가 "내 회차의 설문 중 진행된
      // 순번까지"만 보여 주므로, 순번만으로 안전하게 찾을 수 있습니다.
      const { data: pageRow } = await supabase
        .from('pages')
        .select('*')
        .eq('order_index', index)
        .maybeSingle()

      if (cancelled) return
      setPage((pageRow as Page) ?? null)
      setAnswers({})
      setComments({})
      setSaveStates({})
      setSaveError(null)

      if (!pageRow) {
        setSlides([])
        return
      }

      const { data: slideRows } = await supabase
        .from('slides')
        .select('*')
        .eq('page_id', (pageRow as Page).id)
        .order('order_index')

      if (cancelled) return
      const loaded = (slideRows as Slide[]) ?? []
      setSlides(loaded)

      if (loaded.length > 0) {
        const { data: responseRows } = await supabase
          .from('responses')
          .select('slide_id, answer, comment')
          .in('slide_id', loaded.map((s) => s.id))
          .eq('participant_id', participant.id)

        if (!cancelled && responseRows) {
          const nextAnswers: Record<string, Answer | null> = {}
          const nextComments: Record<string, string> = {}
          for (const row of responseRows) {
            nextAnswers[row.slide_id as string] = (row.answer as Answer) ?? null
            nextComments[row.slide_id as string] = (row.comment as string) ?? ''
          }
          setAnswers(nextAnswers)
          setComments(nextComments)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [live, index, revealed, participant.session_id, participant.id])

  const setSaveState = (slideId: string, state: SaveState) =>
    setSaveStates((prev) => ({ ...prev, [slideId]: state }))

  // 화면에는 즉시 반영하고 저장은 뒤따르게 합니다 (탭 반응이 끊기지 않도록).
  const update = useCallback(
    (slideId: string, next: Answer) => {
      setAnswers((prev) => ({ ...prev, [slideId]: next }))
      setSaveState(slideId, 'saving')
      setSaveError(null)
      void supabase
        .rpc('submit_response', { p_slide_id: slideId, p_answer: next })
        .then(({ error }) => {
          if (error) {
            setSaveState(slideId, 'error')
            setSaveError(error.message)
          } else {
            setSaveState(slideId, 'saved')
          }
        })
    },
    [],
  )

  const updateComment = useCallback(
    (slideId: string, next: string) => {
      setComments((prev) => ({ ...prev, [slideId]: next }))
      setSaveState(slideId, 'saving')
      setSaveError(null)
      void supabase
        .rpc('submit_comment', { p_slide_id: slideId, p_comment: next })
        .then(({ error }) => {
          if (error) {
            setSaveState(slideId, 'error')
            setSaveError(error.message)
          } else {
            setSaveState(slideId, 'saved')
          }
        })
    },
    [],
  )

  if (!session) return <Centered>설문을 불러오는 중…</Centered>

  if (session.status === 'draft')
    return (
      <Centered>
        <h1 className="waiting__title">{surveyTitle}</h1>
        <p className="waiting__body">
          👋 {participant.display_name}님, 입장하셨습니다.
          <br />곧 시작합니다. 이 화면을 그대로 두고 기다려 주세요 ⏳
        </p>
      </Centered>
    )

  if (session.status === 'ended')
    return <EndedView participant={participant} />

  if (!page || slides.length === 0)
    return (
      <Centered>
        <h1 className="waiting__title">⏳ 잠시만 기다려 주세요</h1>
        <p className="waiting__body">진행자가 곧 다음 페이지를 시작합니다.</p>
      </Centered>
    )

  // 고를 것이 있는 문항 기준으로 페이지 전체의 진행을 요약합니다.
  const questions = slides.filter((s) => s.type !== 'info')
  const answered = questions.filter((s) => answers[s.id] != null).length

  return (
    <div className="screen">
      <header className="topbar">
        <span className="topbar__name">{participant.display_name}</span>
        <PageBadge
          states={Object.values(saveStates)}
          answered={answered}
          total={questions.length}
        />
      </header>

      <main className="pageview">
        {page.title && <h1 className="pageview__title">{page.title}</h1>}

        {slides.map((slide, i) => (
          <section key={slide.id} className="pageview__item">
            {slides.length > 1 && (
              <span className="pageview__num">
                {i + 1} / {slides.length}
              </span>
            )}
            <div className="slide">
              <SlideView
                slide={slide}
                answer={answers[slide.id] ?? null}
                onChange={(next) => update(slide.id, next)}
                comment={comments[slide.id] ?? ''}
                onCommentChange={(next) => updateComment(slide.id, next)}
              />
            </div>
          </section>
        ))}

        {saveError && <p className="error">{saveError}</p>}

        {questions.length > 0 && (
          <p className="slide__note">
            {questions.length > 1
              ? '✍️ 화면을 내리며 모든 문항에 답해 주세요. 진행 중에는 답변을 몇 번이든 바꿀 수 있습니다.'
              : '진행 중에는 답변을 몇 번이든 바꿀 수 있습니다.'}
          </p>
        )}
      </main>
    </div>
  )
}

/* ------------------------------------------- 종료 후 미응답 보충 응답 */

/**
 * 설문이 끝난 뒤, 진행 중에 놓친 문항을 마저 답할 수 있게 합니다.
 *
 * 진행된 문항 중 답이 없는 것만 모아 보여 줍니다. 이미 답한 문항은 서버가
 * 수정을 거부하므로 아예 보여 주지 않습니다. 화면에 나온 문항은 실제 진행
 * 때와 똑같이 동작합니다 — 의견란도 그대로 있습니다 (진행 중에 남겨 둔
 * 의견이 있으면 이어서 보이고, 문항별 의견란 끔 설정도 따릅니다).
 */
function EndedView({ participant }: { participant: Participant }) {
  const [phase, setPhase] = useState<'loading' | 'summary' | 'makeup'>('loading')
  const [missed, setMissed] = useState<Slide[]>([])
  const [answers, setAnswers] = useState<Record<string, Answer | null>>({})
  const [comments, setComments] = useState<Record<string, string>>({})
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({})
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      // RLS 가 진행된 페이지까지만 보여 줍니다. 그중 답이 없는 문항을 찾습니다.
      const [pageRes, slideRes, respRes] = await Promise.all([
        supabase.from('pages').select('*').order('order_index'),
        supabase.from('slides').select('*'),
        supabase
          .from('responses')
          .select('slide_id, answer, comment')
          .eq('participant_id', participant.id),
      ])

      const pages = (pageRes.data as Page[]) ?? []
      const slides = (slideRes.data as Slide[]) ?? []
      const rows =
        (respRes.data as { slide_id: string; answer: Answer | null; comment: string | null }[]) ??
        []
      const answered = new Set(
        rows.filter((r) => r.answer != null).map((r) => r.slide_id),
      )

      const pageOrder = new Map(pages.map((p) => [p.id, p.order_index]))
      const unanswered = slides
        .filter((s) => s.type !== 'info' && !answered.has(s.id))
        .sort(
          (a, b) =>
            (pageOrder.get(a.page_id) ?? 0) - (pageOrder.get(b.page_id) ?? 0) ||
            a.order_index - b.order_index,
        )

      // 놓친 문항에 진행 중 남겨 둔 의견이 있으면 이어서 보여 줍니다.
      const existingComments: Record<string, string> = {}
      for (const row of rows) {
        if (row.comment) existingComments[row.slide_id] = row.comment
      }
      setComments(existingComments)
      setMissed(unanswered)
      setPhase('summary')
    })()
  }, [participant.id])

  const save = useCallback((slideId: string, next: Answer) => {
    setAnswers((prev) => ({ ...prev, [slideId]: next }))
    setSaveStates((prev) => ({ ...prev, [slideId]: 'saving' }))
    setSaveError(null)
    void supabase
      .rpc('submit_response', { p_slide_id: slideId, p_answer: next })
      .then(({ error }) => {
        setSaveStates((prev) => ({ ...prev, [slideId]: error ? 'error' : 'saved' }))
        if (error) setSaveError(error.message)
      })
  }, [])

  const saveComment = useCallback((slideId: string, next: string) => {
    setComments((prev) => ({ ...prev, [slideId]: next }))
    setSaveStates((prev) => ({ ...prev, [slideId]: 'saving' }))
    setSaveError(null)
    void supabase
      .rpc('submit_comment', { p_slide_id: slideId, p_comment: next })
      .then(({ error }) => {
        setSaveStates((prev) => ({ ...prev, [slideId]: error ? 'error' : 'saved' }))
        if (error) setSaveError(error.message)
      })
  }, [])

  if (phase === 'loading') return <Centered>확인 중…</Centered>

  const remaining = missed.filter((s) => answers[s.id] == null).length

  if (phase === 'summary')
    return (
      <Centered>
        <h1 className="waiting__title">🎉 설문이 종료되었습니다</h1>
        <p className="waiting__body">참여해 주셔서 감사합니다 🙏</p>
        {missed.length > 0 && (
          <>
            <p className="waiting__body">
              아직 답하지 않은 문항이 <strong>{missed.length}개</strong> 있습니다.
            </p>
            <button className="btn btn--primary btn--lg" onClick={() => setPhase('makeup')}>
              ✍️ 미응답 문항 답변하기
            </button>
          </>
        )}
      </Centered>
    )

  return (
    <div className="screen">
      <header className="topbar">
        <span className="topbar__name">{participant.display_name}</span>
        {remaining === 0 ? (
          <span className="badge badge--ok">모두 응답</span>
        ) : (
          <span className="badge badge--muted">{remaining}개 남음</span>
        )}
      </header>

      <main className="pageview">
        <h1 className="pageview__title">미응답 문항</h1>
        <p className="muted">
          진행 중에 놓친 문항입니다. 답을 고르면 바로 저장됩니다.
        </p>

        {missed.map((slide, i) => (
          <section key={slide.id} className="pageview__item">
            <span className="pageview__num">
              {i + 1} / {missed.length}
              {saveStates[slide.id] === 'saved' && (
                <span className="badge badge--ok"> 저장됨</span>
              )}
              {saveStates[slide.id] === 'error' && (
                <span className="badge badge--err"> 저장 실패</span>
              )}
            </span>
            <div className="slide">
              <SlideView
                slide={slide}
                answer={answers[slide.id] ?? null}
                onChange={(next) => save(slide.id, next)}
                comment={comments[slide.id] ?? ''}
                onCommentChange={(next) => saveComment(slide.id, next)}
              />
            </div>
          </section>
        ))}

        {saveError && <p className="error">{saveError}</p>}

        {remaining === 0 && (
          <div className="card">
            <p className="notice">🎉 모든 문항에 답했습니다. 참여해 주셔서 감사합니다!</p>
          </div>
        )}
      </main>
    </div>
  )
}

/**
 * 페이지 전체의 저장 상태 요약. 문항이 여러 개일 때는 "몇 개에 답했는지"가
 * 참가자에게 가장 필요한 정보입니다.
 */
function PageBadge({
  states,
  answered,
  total,
}: {
  states: SaveState[]
  answered: number
  total: number
}) {
  if (states.includes('error')) return <span className="badge badge--err">저장 실패</span>
  if (states.includes('saving')) return <span className="badge">저장 중…</span>
  // 안내만 있는 페이지에는 응답 수를 셀 것이 없습니다.
  // (의견은 안내 페이지에도 남길 수 있습니다.)
  if (total === 0) return null
  if (answered >= total) return <span className="badge badge--ok">✅ 모두 응답</span>
  if (total === 1) return <span className="badge badge--muted">미응답</span>
  return (
    <span className="badge badge--muted">
      {answered} / {total} 응답
    </span>
  )
}

/* ---------------------------------------------------------------- 공통 */

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="screen screen--center">
      <div className="centered">{children}</div>
    </div>
  )
}
