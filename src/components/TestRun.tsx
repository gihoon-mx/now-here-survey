import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { SlideView } from './SlideView'
import { SLIDE_TYPE_LABEL, type Answer, type Slide } from '../lib/types'

/**
 * 설문 테스트.
 *
 * 참가자 화면 그대로 처음부터 끝까지 넘겨 보는 기능입니다. DB 에는 아무것도
 * 쓰지 않으므로 실제 세션 상태나 응답에 영향이 없고, 참가자 폰도 움직이지
 * 않습니다. 문구가 어색하지 않은지, 선택지가 빠지지 않았는지, 항목 순서가
 * 맞는지를 혼자 확인하는 용도입니다.
 *
 * 실제로 사람을 모아 리허설한 뒤에는 "다시 시작하기"로 응답을 지우면 됩니다.
 */
export default function TestRun({ surveyId }: { surveyId: string }) {
  const [slides, setSlides] = useState<Slide[]>([])
  const [loading, setLoading] = useState(true)
  const [index, setIndex] = useState(0)
  // 눌러 본 선택과 적어 본 의견은 이 화면 안에만 남습니다.
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [comments, setComments] = useState<Record<string, string>>({})

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('slides')
        .select('*')
        .eq('survey_id', surveyId)
        .order('order_index')
      setSlides((data as Slide[]) ?? [])
      setLoading(false)
    })()
  }, [surveyId])

  if (loading) return <p className="muted">불러오는 중…</p>

  if (slides.length === 0)
    return (
      <div className="card">
        <p className="muted">
          문항이 없습니다. <strong>문항</strong> 탭에서 먼저 추가해 주세요.
        </p>
      </div>
    )

  const slide = slides[index]
  const atEnd = index >= slides.length - 1

  return (
    <div className="testrun">
      <div className="card testrun__banner">
        <strong>테스트 진행</strong>
        <p className="muted">
          참가자에게 보이는 화면 그대로입니다. 여기서 무엇을 누르든 저장되지
          않고, 참가자 폰도 움직이지 않습니다.
        </p>
      </div>

      <div className="testrun__meta">
        <span>
          {index + 1} / {slides.length}
        </span>
        <span className={`slide-card__type slide-card__type--${slide.type}`}>
          {SLIDE_TYPE_LABEL[slide.type]}
        </span>
      </div>

      <div className="preview__frame testrun__frame">
        <div className="slide">
          <SlideView
            slide={slide}
            answer={answers[slide.id] ?? null}
            onChange={(next) => setAnswers((prev) => ({ ...prev, [slide.id]: next }))}
            comment={comments[slide.id] ?? ''}
            onCommentChange={(next) =>
              setComments((prev) => ({ ...prev, [slide.id]: next }))
            }
          />
        </div>
      </div>

      <div className="testrun__nav">
        <button
          className="btn"
          disabled={index === 0}
          onClick={() => setIndex((i) => i - 1)}
        >
          ← 이전
        </button>
        <button
          className="btn btn--primary"
          disabled={atEnd}
          onClick={() => setIndex((i) => i + 1)}
        >
          다음 →
        </button>
      </div>

      {atEnd && (
        <p className="muted testrun__done">
          마지막 항목입니다. 처음부터 다시 보려면{' '}
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => {
              setIndex(0)
              setAnswers({})
              setComments({})
            }}
          >
            처음으로
          </button>
        </p>
      )}
    </div>
  )
}
