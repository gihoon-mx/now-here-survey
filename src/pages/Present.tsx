import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useLiveSession } from '../lib/useLiveSession'
import { formatDuration, useElapsedSeconds } from '../lib/useElapsed'
import { useWakeLock } from '../lib/useWakeLock'
import { slideOptions, type Slide } from '../lib/types'

/**
 * 빔프로젝터용 화면. 조작 UI가 없고 진행만 따라갑니다.
 * 관리자가 폰으로 조작하는 동안 노트북에서 열어 둡니다.
 */
export default function PresentPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const { session } = useLiveSession(sessionId ?? null)
  const [slides, setSlides] = useState<Slide[]>([])
  const [authorized, setAuthorized] = useState<boolean | null>(null)

  useWakeLock(true)

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.rpc('is_admin')
      setAuthorized(data === true)
    })()
  }, [])

  useEffect(() => {
    if (!sessionId || !authorized) return
    void (async () => {
      const { data } = await supabase
        .from('slides')
        .select('*')
        .eq('session_id', sessionId)
        .order('order_index')
      setSlides((data as Slide[]) ?? [])
    })()
  }, [sessionId, authorized])

  const totalElapsed = useElapsedSeconds(session?.started_at)

  if (authorized === null) return <div className="present present--center">확인 중…</div>

  if (!authorized)
    return (
      <div className="present present--center">
        <p>
          이 화면은 관리자 로그인이 필요합니다.
          <br />
          같은 브라우저에서 <code>#/admin</code> 으로 먼저 로그인해 주세요.
        </p>
      </div>
    )

  if (!session) return <div className="present present--center">불러오는 중…</div>

  if (session.status === 'draft')
    return (
      <div className="present present--center">
        <h1 className="present__title">{session.title}</h1>
        <p className="present__sub">곧 시작합니다</p>
      </div>
    )

  if (session.status === 'ended')
    return (
      <div className="present present--center">
        <h1 className="present__title">설문이 종료되었습니다</h1>
        <p className="present__sub">참여해 주셔서 감사합니다</p>
      </div>
    )

  const current = slides.find((s) => s.order_index === session.current_slide_index)
  const options = slideOptions(current?.options)

  return (
    <div className="present">
      <header className="present__bar">
        <span>
          {session.current_slide_index + 1} / {slides.length}
        </span>
        <span>{formatDuration(totalElapsed)}</span>
      </header>

      <main className="present__main">
        <h1 className="present__title">{current?.title ?? ''}</h1>
        {current?.body && <p className="present__body">{current.body}</p>}

        {current && current.type !== 'info' && options.length > 0 && (
          <ul
            className={
              current.type === 'ox'
                ? 'present__options present__options--ox'
                : 'present__options'
            }
          >
            {options.map((option, i) => (
              <li key={`${option.label}-${i}`}>
                <span className="present__option-label">{option.label}</span>
                {option.description && (
                  <span className="present__option-desc">{option.description}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {current?.type === 'text' && (
          <p className="present__sub">폰에 자유롭게 입력해 주세요</p>
        )}
      </main>
    </div>
  )
}
