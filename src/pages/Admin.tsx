import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Session, Survey } from '../lib/types'
import SlideEditor from '../components/SlideEditor'
import ParticipantManager from '../components/ParticipantManager'
import LiveControl from '../components/LiveControl'
import ResultsExport from '../components/ResultsExport'
import ResultsView from '../components/ResultsView'
import TestRun from '../components/TestRun'

export default function AdminPage() {
  const [checking, setChecking] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)

  const verify = useCallback(async () => {
    const { data: sessionData } = await supabase.auth.getSession()
    if (!sessionData.session) {
      setIsAdmin(false)
      setChecking(false)
      return
    }
    const { data } = await supabase.rpc('is_admin')
    setIsAdmin(data === true)
    setChecking(false)
  }, [])

  useEffect(() => {
    void verify()
  }, [verify])

  if (checking) return <div className="screen screen--center">확인 중…</div>
  if (!isAdmin) return <AdminLogin onSignedIn={verify} />
  return <AdminShell />
}

/* ---------------------------------------------------------------- 로그인 */

function AdminLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (signInError) {
      setError(signInError.message)
      setBusy(false)
      return
    }

    const { data } = await supabase.rpc('is_admin')
    if (data !== true) {
      setError('이 계정은 관리자로 등록되어 있지 않습니다. (admins 테이블 확인)')
      await supabase.auth.signOut()
      setBusy(false)
      return
    }
    onSignedIn()
  }

  return (
    <div className="screen screen--center">
      <form className="card login" onSubmit={submit}>
        <h1 className="login__title">관리자 로그인</h1>

        <label className="field">
          <span>이메일</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoCapitalize="none"
            required
          />
        </label>

        <label className="field">
          <span>비밀번호</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn btn--primary btn--block" disabled={busy}>
          {busy ? '로그인 중…' : '로그인'}
        </button>
      </form>
    </div>
  )
}

function AdminShell() {
  const { surveyId } = useParams<{ surveyId?: string }>()
  return surveyId ? <SurveyDetail surveyId={surveyId} /> : <SurveyList />
}

/* -------------------------------------------------------------- 설문 목록 */

function SurveyList() {
  const [surveys, setSurveys] = useState<Survey[]>([])
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [copying, setCopying] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const load = async () => {
    const { data } = await supabase
      .from('surveys')
      .select('*')
      .order('created_at', { ascending: false })
    setSurveys((data as Survey[]) ?? [])
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    const { data: auth } = await supabase.auth.getUser()
    const { data, error: insertError } = await supabase
      .from('surveys')
      .insert({ title: title.trim(), owner_id: auth.user?.id })
      .select()
      .single()
    if (insertError) setError(insertError.message)
    else if (data) navigate(`/admin/${(data as Survey).id}`)
  }

  /** 문항만 복제합니다. 회차와 참가자는 새 설문에서 다시 만듭니다. */
  const duplicate = async (source: Survey) => {
    const name = prompt('새 설문 제목', `${source.title} (사본)`)
    if (name === null) return

    setCopying(source.id)
    setError(null)
    const { data, error: rpcError } = await supabase.rpc('duplicate_survey', {
      p_survey_id: source.id,
      p_title: name,
    })
    setCopying(null)

    if (rpcError) setError(rpcError.message)
    else if (data) navigate(`/admin/${data as string}`)
  }

  /**
   * 설문 삭제. 문항·세션·참가자·응답이 모두 연쇄 삭제되고 되돌릴 수 없으므로
   * 두 번 확인합니다. 진행 중인 세션이 있으면 막습니다 — 현장에서 참가자들이
   * 응답하는 중에 발밑이 사라지는 사고를 방지합니다.
   */
  const remove = async (survey: Survey) => {
    setError(null)
    setRemoving(survey.id)
    try {
      const { count } = await supabase
        .from('sessions')
        .select('id', { count: 'exact', head: true })
        .eq('survey_id', survey.id)
        .eq('status', 'live')
      if ((count ?? 0) > 0) {
        setError('진행 중인 세션이 있는 설문은 삭제할 수 없습니다. 먼저 세션을 종료해 주세요.')
        return
      }

      if (
        !confirm(
          `"${survey.title}" 설문을 삭제할까요?\n` +
            '문항, 모든 세션, 참가자 명단, 받은 응답이 함께 지워집니다.',
        )
      )
        return
      if (!confirm('되돌릴 수 없습니다. 결과가 필요하면 먼저 엑셀로 내려받으세요.\n정말 삭제할까요?'))
        return

      const { error: deleteError } = await supabase
        .from('surveys')
        .delete()
        .eq('id', survey.id)
      if (deleteError) setError(deleteError.message)
      else await load()
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="screen admin">
      <header className="admin__header">
        <h1>설문 목록</h1>
        <button
          className="btn btn--ghost"
          onClick={() => supabase.auth.signOut().then(() => location.reload())}
        >
          로그아웃
        </button>
      </header>

      <form className="card row-form" onSubmit={create}>
        <input
          placeholder="새 설문 제목"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button className="btn btn--primary">만들기</button>
      </form>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">불러오는 중…</p>
      ) : surveys.length === 0 ? (
        <p className="muted">아직 만든 설문이 없습니다.</p>
      ) : (
        <ul className="list">
          {surveys.map((s) => (
            <li key={s.id} className="list__row">
              <Link className="list__item" to={`/admin/${s.id}`}>
                <span className="list__title">{s.title}</span>
              </Link>
              <button
                className="btn btn--sm"
                title="문항을 그대로 둔 새 설문 만들기"
                disabled={copying === s.id}
                onClick={() => duplicate(s)}
              >
                {copying === s.id ? '복사 중…' : '복사'}
              </button>
              <button
                className="btn btn--sm btn--ghost-danger"
                title="설문 삭제 (세션·참가자·응답 포함)"
                disabled={removing === s.id}
                onClick={() => remove(s)}
              >
                {removing === s.id ? '삭제 중…' : '삭제'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- 설문 상세 */

type SurveyTab = 'slides' | 'test' | 'results'
type SessionTab = 'control' | 'participants' | 'results'

type View =
  | { kind: 'survey'; tab: SurveyTab }
  | { kind: 'session'; sessionId: string; tab: SessionTab }

function SurveyDetail({ surveyId }: { surveyId: string }) {
  const [survey, setSurvey] = useState<Survey | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>({ kind: 'survey', tab: 'slides' })
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSessions = useCallback(async () => {
    const { data } = await supabase
      .from('sessions')
      .select('*')
      .eq('survey_id', surveyId)
      .order('created_at')
    setSessions((data as Session[]) ?? [])
  }, [surveyId])

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('surveys')
        .select('*')
        .eq('id', surveyId)
        .maybeSingle()
      setSurvey((data as Survey) ?? null)
      await loadSessions()
      setLoading(false)
    })()
  }, [surveyId, loadSessions])

  const addSession = async () => {
    const name = prompt('세션 이름', `${sessions.length + 1}회차`)
    if (name === null) return
    const { data, error: insertError } = await supabase
      .from('sessions')
      .insert({ survey_id: surveyId, name: name.trim() || `${sessions.length + 1}회차` })
      .select()
      .single()
    if (insertError) {
      setError(insertError.message)
      return
    }
    await loadSessions()
    setView({ kind: 'session', sessionId: (data as Session).id, tab: 'participants' })
  }

  const removeSession = async (s: Session) => {
    if (
      !confirm(
        `"${s.name}" 세션을 삭제할까요?\n이 세션의 참가자와 응답도 함께 지워집니다.`,
      )
    )
      return
    await supabase.from('sessions').delete().eq('id', s.id)
    await loadSessions()
    setView({ kind: 'survey', tab: 'slides' })
  }

  if (loading) return <div className="screen screen--center">불러오는 중…</div>
  if (!survey)
    return (
      <div className="screen screen--center">
        <p>설문을 찾을 수 없습니다.</p>
        <Link className="btn" to="/admin">
          목록으로
        </Link>
      </div>
    )

  const activeSession =
    view.kind === 'session' ? sessions.find((s) => s.id === view.sessionId) : undefined

  /** 메뉴에서 무언가를 고르면 모바일에서는 메뉴를 닫습니다. */
  const go = (next: View) => {
    setView(next)
    setMenuOpen(false)
  }

  return (
    <div className="layout">
      <header className="layout__top">
        <button
          className="btn btn--ghost btn--sm layout__menu-btn"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ☰ 메뉴
        </button>
        <h1 className="layout__title">{survey.title}</h1>
      </header>

      <div className="layout__body">
        <nav className={'sidebar' + (menuOpen ? ' sidebar--open' : '')}>
          <Link className="sidebar__back" to="/admin">
            ← 설문 목록
          </Link>

          <div className="sidebar__group">
            <span className="sidebar__label">설문</span>
            {(
              [
                ['slides', '문항'],
                ['test', '테스트'],
                ['results', '전체 결과'],
              ] as [SurveyTab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                className={
                  'sidebar__item' +
                  (view.kind === 'survey' && view.tab === key ? ' sidebar__item--active' : '')
                }
                onClick={() => go({ kind: 'survey', tab: key })}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="sidebar__group">
            <span className="sidebar__label">
              세션
              <button className="sidebar__add" onClick={addSession} title="세션 추가">
                +
              </button>
            </span>

            {sessions.length === 0 && (
              <p className="sidebar__empty">
                세션이 없습니다. <br />
                <code>+</code> 로 추가하세요.
              </p>
            )}

            {sessions.map((s) => (
              <button
                key={s.id}
                className={
                  'sidebar__item sidebar__item--session' +
                  (view.kind === 'session' && view.sessionId === s.id
                    ? ' sidebar__item--active'
                    : '')
                }
                onClick={() => go({ kind: 'session', sessionId: s.id, tab: 'control' })}
              >
                <span className="sidebar__session-name">{s.name}</span>
                <StatusDot status={s.status} />
              </button>
            ))}
          </div>
        </nav>

        {/* 모바일에서 메뉴가 열렸을 때 바깥을 눌러 닫습니다. */}
        {menuOpen && (
          <button
            className="sidebar__scrim"
            aria-label="메뉴 닫기"
            onClick={() => setMenuOpen(false)}
          />
        )}

        <main className="content">
          {error && <p className="error">{error}</p>}

          {view.kind === 'survey' && view.tab === 'slides' && (
            <SlideEditor surveyId={surveyId} />
          )}
          {view.kind === 'survey' && view.tab === 'test' && (
            <TestRun surveyId={surveyId} />
          )}
          {view.kind === 'survey' && view.tab === 'results' && (
            <>
              <ResultsExport
                surveyId={surveyId}
                surveyTitle={survey.title}
                scope={{ kind: 'survey' }}
              />
              <ResultsView surveyId={surveyId} scope={{ kind: 'survey' }} />
            </>
          )}

          {view.kind === 'session' && activeSession && (
            <>
              <div className="content__head">
                <h2 className="content__title">{activeSession.name}</h2>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => removeSession(activeSession)}
                >
                  세션 삭제
                </button>
              </div>

              <nav className="tabs">
                {(
                  [
                    ['control', '진행'],
                    ['participants', '참가자'],
                    ['results', '결과'],
                  ] as [SessionTab, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className={'tab' + (view.tab === key ? ' tab--active' : '')}
                    onClick={() => setView({ ...view, tab: key })}
                  >
                    {label}
                  </button>
                ))}
              </nav>

              {view.tab === 'control' && (
                <LiveControl
                  sessionId={activeSession.id}
                  surveyId={surveyId}
                  onChanged={loadSessions}
                />
              )}
              {view.tab === 'participants' && (
                <ParticipantManager sessionId={activeSession.id} />
              )}
              {view.tab === 'results' && (
                <>
                  <ResultsExport
                    surveyId={surveyId}
                    surveyTitle={survey.title}
                    scope={{ kind: 'session', sessionId: activeSession.id, sessionName: activeSession.name }}
                  />
                  <ResultsView
                    surveyId={surveyId}
                    scope={{ kind: 'session', sessionId: activeSession.id, sessionName: activeSession.name }}
                  />
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: Session['status'] }) {
  const label = { draft: '준비 중', live: '진행 중', ended: '종료' }[status]
  return <span className={`dot dot--${status}`} title={label} />
}
