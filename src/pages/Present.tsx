import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useLiveSession } from '../lib/useLiveSession'
import { formatDuration, useElapsedSeconds } from '../lib/useElapsed'
import { useWakeLock } from '../lib/useWakeLock'
import { slideOptions, type Page, type Slide } from '../lib/types'

/**
 * 빔프로젝터용 화면. 조작 UI가 없고 진행만 따라갑니다.
 * 관리자가 폰으로 조작하는 동안 노트북에서 열어 둡니다.
 */
export default function PresentPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const { session } = useLiveSession(sessionId ?? null)
  const [pages, setPages] = useState<Page[]>([])
  const [slides, setSlides] = useState<Slide[]>([])
  const [surveyTitle, setSurveyTitle] = useState("")
  const [authorized, setAuthorized] = useState<boolean | null>(null)

  useWakeLock(true)

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.rpc('is_admin')
      setAuthorized(data === true)
    })()
  }, [])

  // 페이지·문항은 설문에 붙어 있으므로 세션 → 설문을 거쳐 불러옵니다.
  useEffect(() => {
    if (!authorized || !session?.survey_id) return
    void (async () => {
      const [pageRes, slideRes, surveyRes] = await Promise.all([
        supabase
          .from('pages')
          .select('*')
          .eq('survey_id', session.survey_id)
          .order('order_index'),
        supabase
          .from('slides')
          .select('*')
          .eq('survey_id', session.survey_id)
          .order('order_index'),
        supabase.from('surveys').select('title').eq('id', session.survey_id).maybeSingle(),
      ])
      setPages((pageRes.data as Page[]) ?? [])
      setSlides((slideRes.data as Slide[]) ?? [])
      if (surveyRes.data) setSurveyTitle(surveyRes.data.title as string)
    })()
  }, [authorized, session?.survey_id])

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
        <h1 className="present__title">{surveyTitle}</h1>
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

  const currentPage = pages.find((p) => p.order_index === session.current_page_index)
  const pageSlides = currentPage
    ? slides
        .filter((s) => s.page_id === currentPage.id)
        .sort((a, b) => a.order_index - b.order_index)
    : []
  const multiple = pageSlides.length > 1

  return (
    <div className="present">
      <header className="present__bar">
        <span>
          {session.current_page_index + 1} / {pages.length}
        </span>
        <span>{formatDuration(totalElapsed)}</span>
      </header>

      {/* 문항이 여럿이면 화면을 위에서부터 채우고, 넘치면 스크롤합니다. */}
      <main className={'present__main' + (multiple ? ' present__main--list' : '')}>
        {currentPage?.title && multiple && (
          <p className="present__page-title">{currentPage.title}</p>
        )}

        {pageSlides.map((slide) => {
          const options = slideOptions(slide.options)
          return (
            <section key={slide.id} className="present__slide">
              <h1 className="present__title">{slide.title}</h1>
              {slide.body && <p className="present__body">{slide.body}</p>}

              {slide.type !== 'info' && options.length > 0 && (
                <ul
                  className={
                    slide.type === 'ox'
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

              {slide.type === 'text' && (
                <p className="present__sub">폰에 자유롭게 입력해 주세요</p>
              )}
            </section>
          )
        })}

        {multiple && (
          <p className="present__sub present__scroll-hint">
            폰 화면을 내리며 모든 문항에 답해 주세요
          </p>
        )}
      </main>
    </div>
  )
}
