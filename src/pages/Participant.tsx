import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useLiveSession } from '../lib/useLiveSession'
import type { Answer, Participant, Slide } from '../lib/types'

export default function ParticipantPage() {
  const [booting, setBooting] = useState(true)
  const [participant, setParticipant] = useState<Participant | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        // 1) 익명 세션 확보. 이 토큰이 있어야 RLS 가 "이 사람"을 식별할 수 있습니다.
        const { data: existing } = await supabase.auth.getSession()
        if (!existing.session) {
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
        <h1 className="login__title">설문 참여</h1>
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

function LiveView({ participant }: { participant: Participant }) {
  const { session } = useLiveSession(participant.session_id)
  const [slide, setSlide] = useState<Slide | null>(null)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  )
  const [saveError, setSaveError] = useState<string | null>(null)

  const index = session?.current_slide_index ?? null
  const live = session?.status === 'live'

  // 슬라이드가 바뀔 때마다 문항과 "내가 이미 낸 응답"을 함께 불러옵니다.
  useEffect(() => {
    if (!live || index == null) {
      setSlide(null)
      return
    }
    let cancelled = false

    void (async () => {
      const { data: slideRow } = await supabase
        .from('slides')
        .select('*')
        .eq('session_id', participant.session_id)
        .eq('order_index', index)
        .maybeSingle()

      if (cancelled) return
      setSlide((slideRow as Slide) ?? null)
      setAnswer(null)
      setSaveState('idle')
      setSaveError(null)

      if (slideRow) {
        const { data: responseRow } = await supabase
          .from('responses')
          .select('answer')
          .eq('slide_id', (slideRow as Slide).id)
          .eq('participant_id', participant.id)
          .maybeSingle()

        if (!cancelled && responseRow) setAnswer(responseRow.answer as Answer)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [live, index, participant.session_id, participant.id])

  const save = useCallback(
    async (next: Answer) => {
      if (!slide) return
      setSaveState('saving')
      setSaveError(null)

      const { error } = await supabase.rpc('submit_response', {
        p_slide_id: slide.id,
        p_answer: next,
      })

      if (error) {
        setSaveState('error')
        setSaveError(error.message)
      } else {
        setSaveState('saved')
      }
    },
    [slide],
  )

  // 화면에는 즉시 반영하고 저장은 뒤따르게 합니다 (탭 반응이 끊기지 않도록).
  const update = useCallback(
    (next: Answer) => {
      setAnswer(next)
      void save(next)
    },
    [save],
  )

  if (!session) return <Centered>설문을 불러오는 중…</Centered>

  if (session.status === 'draft')
    return (
      <Centered>
        <h1 className="waiting__title">{session.title}</h1>
        <p className="waiting__body">
          {participant.display_name}님, 입장하셨습니다.
          <br />곧 시작합니다. 이 화면을 그대로 두고 기다려 주세요.
        </p>
      </Centered>
    )

  if (session.status === 'ended')
    return (
      <Centered>
        <h1 className="waiting__title">설문이 종료되었습니다</h1>
        <p className="waiting__body">참여해 주셔서 감사합니다.</p>
      </Centered>
    )

  if (!slide) return <Centered>다음 항목을 기다리는 중…</Centered>

  return (
    <div className="screen">
      <header className="topbar">
        <span className="topbar__name">{participant.display_name}</span>
        <SaveBadge state={saveState} type={slide.type} />
      </header>

      <main className="slide">
        <h1 className="slide__title">{slide.title}</h1>
        {slide.body && <p className="slide__body">{slide.body}</p>}

        <AnswerInput slide={slide} answer={answer} onChange={update} />

        {saveError && <p className="error">{saveError}</p>}

        {slide.type !== 'info' && (
          <p className="slide__note">
            진행 중에는 답변을 몇 번이든 바꿀 수 있습니다.
          </p>
        )}
      </main>
    </div>
  )
}

function SaveBadge({
  state,
  type,
}: {
  state: 'idle' | 'saving' | 'saved' | 'error'
  type: Slide['type']
}) {
  if (type === 'info') return null
  if (state === 'saving') return <span className="badge">저장 중…</span>
  if (state === 'saved') return <span className="badge badge--ok">저장됨</span>
  if (state === 'error') return <span className="badge badge--err">저장 실패</span>
  return <span className="badge badge--muted">미응답</span>
}

/* ------------------------------------------------------------- 응답 입력 */

function AnswerInput({
  slide,
  answer,
  onChange,
}: {
  slide: Slide
  answer: Answer | null
  onChange: (next: Answer) => void
}) {
  switch (slide.type) {
    case 'info':
      return null

    case 'ox':
      return (
        <ChoiceList
          options={['O', 'X']}
          selected={answer?.choice ? [answer.choice] : []}
          variant="ox"
          onPick={(value) => onChange({ choice: value })}
        />
      )

    case 'choice':
      if (slide.multi) {
        const selected = answer?.choices ?? []
        return (
          <ChoiceList
            options={slide.options}
            selected={selected}
            variant="list"
            onPick={(value) =>
              onChange({
                choices: selected.includes(value)
                  ? selected.filter((v) => v !== value)
                  : [...selected, value],
              })
            }
          />
        )
      }
      return (
        <ChoiceList
          options={slide.options}
          selected={answer?.choice ? [answer.choice] : []}
          variant="list"
          onPick={(value) => onChange({ choice: value })}
        />
      )

    case 'text':
      return <TextAnswer value={answer?.text ?? ''} onCommit={(t) => onChange({ text: t })} />
  }
}

function ChoiceList({
  options,
  selected,
  variant,
  onPick,
}: {
  options: string[]
  selected: string[]
  variant: 'list' | 'ox'
  onPick: (value: string) => void
}) {
  return (
    <div className={variant === 'ox' ? 'choices choices--ox' : 'choices'}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={
            'choice' + (selected.includes(option) ? ' choice--selected' : '')
          }
          aria-pressed={selected.includes(option)}
          onClick={() => onPick(option)}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

/**
 * 주관식은 글자마다 저장하면 요청이 과하게 나가므로,
 * 입력이 잠깐 멈추면 저장하고 포커스가 빠질 때 한 번 더 확정합니다.
 */
function TextAnswer({
  value,
  onCommit,
}: {
  value: string
  onCommit: (text: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const timer = useRef<number | undefined>(undefined)
  const committed = useRef(value)

  // 슬라이드가 바뀌거나 서버 값이 새로 로드되면 초안을 맞춰 줍니다.
  useEffect(() => {
    setDraft(value)
    committed.current = value
  }, [value])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const schedule = (text: string) => {
    setDraft(text)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (text !== committed.current) {
        committed.current = text
        onCommit(text)
      }
    }, 700)
  }

  const flush = () => {
    window.clearTimeout(timer.current)
    if (draft !== committed.current) {
      committed.current = draft
      onCommit(draft)
    }
  }

  return (
    <textarea
      className="text-answer"
      value={draft}
      maxLength={1000}
      rows={6}
      placeholder="자유롭게 입력해 주세요"
      onChange={(e) => schedule(e.target.value)}
      onBlur={flush}
    />
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
