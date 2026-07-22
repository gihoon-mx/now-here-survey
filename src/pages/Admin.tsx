import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Session } from '../lib/types'
import SlideEditor from '../components/SlideEditor'
import ParticipantManager from '../components/ParticipantManager'
import LiveControl from '../components/LiveControl'
import ResultsExport from '../components/ResultsExport'
import TestRun from '../components/TestRun'

export default function AdminPage() {
  const [checking, setChecking] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)

  const verify = async () => {
    const { data: sessionData } = await supabase.auth.getSession()
    if (!sessionData.session) {
      setIsAdmin(false)
      setChecking(false)
      return
    }
    const { data } = await supabase.rpc('is_admin')
    setIsAdmin(data === true)
    setChecking(false)
  }

  useEffect(() => {
    void verify()
  }, [])

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

/* ------------------------------------------------------- 세션 목록 / 상세 */

function AdminShell() {
  const { sessionId } = useParams<{ sessionId?: string }>()
  return sessionId ? <SessionDetail sessionId={sessionId} /> : <SessionList />
}

function SessionList() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [copying, setCopying] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const load = async () => {
    const { data } = await supabase
      .from('sessions')
      .select('*')
      .order('created_at', { ascending: false })
    setSessions((data as Session[]) ?? [])
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    const { data: auth } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('sessions')
      .insert({ title: title.trim(), owner_id: auth.user?.id })
      .select()
      .single()
    if (!error && data) navigate(`/admin/${(data as Session).id}`)
  }

  /**
   * 문항만 복제합니다. 참가자는 개인별 비밀번호가 딸려 있어 조용히 따라오면
   * 어느 설문의 명단인지 헷갈리므로 가져오지 않습니다. 같은 인원으로 다시
   * 돌릴 때는 참가자 탭의 "현재 명단 내려받기" 로 옮기면 됩니다.
   */
  const duplicate = async (source: Session) => {
    const name = prompt('새 설문 제목', `${source.title} (사본)`)
    if (name === null) return

    setCopying(source.id)
    setError(null)
    const { data, error: rpcError } = await supabase.rpc('duplicate_session', {
      p_session_id: source.id,
      p_title: name,
    })
    setCopying(null)

    if (rpcError) setError(rpcError.message)
    else if (data) navigate(`/admin/${data as string}`)
  }

  return (
    <div className="screen admin">
      <header className="admin__header">
        <h1>설문 목록</h1>
        <button className="btn btn--ghost" onClick={() => supabase.auth.signOut().then(() => location.reload())}>
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
      ) : sessions.length === 0 ? (
        <p className="muted">아직 만든 설문이 없습니다.</p>
      ) : (
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.id} className="list__row">
              <Link className="list__item" to={`/admin/${s.id}`}>
                <span className="list__title">{s.title}</span>
                <StatusBadge status={s.status} />
              </Link>
              <button
                className="btn btn--sm"
                title="문항을 그대로 둔 새 설문 만들기"
                disabled={copying === s.id}
                onClick={() => duplicate(s)}
              >
                {copying === s.id ? '복사 중…' : '복사'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: Session['status'] }) {
  const label = { draft: '준비 중', live: '진행 중', ended: '종료' }[status]
  return <span className={`badge badge--${status}`}>{label}</span>
}

type Tab = 'control' | 'slides' | 'test' | 'participants' | 'results'

function SessionDetail({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<Session | null>(null)
  const [tab, setTab] = useState<Tab>('control')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('sessions')
        .select('*')
        .eq('id', sessionId)
        .maybeSingle()
      const row = (data as Session) ?? null
      setSession(row)
      // 아직 준비 중이면 대개 문항부터 손보게 되므로 그 탭을 먼저 엽니다.
      if (row?.status === 'draft') setTab('slides')
      setLoading(false)
    })()
  }, [sessionId])

  if (loading) return <div className="screen screen--center">불러오는 중…</div>
  if (!session)
    return (
      <div className="screen screen--center">
        <p>설문을 찾을 수 없습니다.</p>
        <Link className="btn" to="/admin">
          목록으로
        </Link>
      </div>
    )

  return (
    <div className="screen admin">
      <header className="admin__header">
        <Link className="btn btn--ghost btn--sm" to="/admin">
          ← 목록
        </Link>
        <h1 className="admin__title">{session.title}</h1>
      </header>

      <nav className="tabs">
        {(
          [
            ['control', '진행'],
            ['slides', '문항'],
            ['test', '테스트'],
            ['participants', '참가자'],
            ['results', '결과'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={'tab' + (tab === key ? ' tab--active' : '')}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'control' && <LiveControl sessionId={sessionId} />}
      {tab === 'slides' && <SlideEditor sessionId={sessionId} />}
      {tab === 'test' && <TestRun sessionId={sessionId} />}
      {tab === 'participants' && <ParticipantManager sessionId={sessionId} />}
      {tab === 'results' && (
        <ResultsExport sessionId={sessionId} sessionTitle={session.title} />
      )}
    </div>
  )
}
