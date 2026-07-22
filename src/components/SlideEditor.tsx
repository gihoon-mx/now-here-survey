import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { SlideView } from './SlideView'
import {
  SLIDE_TYPE_LABEL,
  slideOptions,
  type Answer,
  type Slide,
  type SlideOption,
  type SlideType,
} from '../lib/types'

const DEFAULT_OPTIONS: Record<SlideType, SlideOption[]> = {
  choice: [
    { label: '매우 그렇다' },
    { label: '그렇다' },
    { label: '보통이다' },
    { label: '그렇지 않다' },
    { label: '전혀 그렇지 않다' },
  ],
  ox: [{ label: 'O' }, { label: 'X' }],
  info: [],
  text: [],
}

export default function SlideEditor({ sessionId }: { sessionId: string }) {
  const [slides, setSlides] = useState<Slide[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    const { data } = await supabase
      .from('slides')
      .select('*')
      .eq('session_id', sessionId)
      .order('order_index')
    setSlides((data as Slide[]) ?? [])
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [sessionId])

  const add = async (type: SlideType) => {
    setError(null)
    const { data, error: insertError } = await supabase
      .from('slides')
      .insert({
        session_id: sessionId,
        order_index: slides.length,
        type,
        title: type === 'info' ? '새 안내 페이지' : '새 문항',
        options: DEFAULT_OPTIONS[type],
      })
      .select()
      .single()

    if (insertError) {
      setError(insertError.message)
      return
    }
    setSlides((prev) => [...prev, data as Slide])
    setOpenId((data as Slide).id)
  }

  const patch = async (id: string, changes: Partial<Slide>) => {
    setSlides((prev) => prev.map((s) => (s.id === id ? { ...s, ...changes } : s)))
    const { error: updateError } = await supabase
      .from('slides')
      .update(changes)
      .eq('id', id)
    if (updateError) setError(updateError.message)
  }

  const remove = async (id: string) => {
    if (!confirm('이 항목을 삭제할까요? 이미 받은 응답도 함께 지워집니다.')) return
    await supabase.from('slides').delete().eq('id', id)
    // 남은 항목의 순번을 0..n-1 로 다시 채웁니다.
    const remaining = slides.filter((s) => s.id !== id)
    await Promise.all(
      remaining.map((s, i) =>
        s.order_index === i
          ? Promise.resolve()
          : supabase.from('slides').update({ order_index: i }).eq('id', s.id),
      ),
    )
    setSlides(remaining.map((s, i) => ({ ...s, order_index: i })))
  }

  const move = async (id: string, delta: number) => {
    const from = slides.findIndex((s) => s.id === id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= slides.length) return

    const reordered = [...slides]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)

    setSlides(reordered.map((s, i) => ({ ...s, order_index: i })))
    await Promise.all(
      reordered.map((s, i) =>
        supabase.from('slides').update({ order_index: i }).eq('id', s.id),
      ),
    )
  }

  if (loading) return <p className="muted">불러오는 중…</p>

  return (
    <div className="editor">
      <div className="editor__add">
        {(Object.keys(SLIDE_TYPE_LABEL) as SlideType[]).map((type) => (
          <button key={type} className="btn btn--sm" onClick={() => add(type)}>
            + {SLIDE_TYPE_LABEL[type]}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {slides.length === 0 && (
        <p className="muted">위 버튼으로 항목을 추가해 주세요.</p>
      )}

      <ol className="editor__list">
        {slides.map((slide, i) => (
          <li key={slide.id} className="card slide-card">
            <div className="slide-card__head">
              <span className="slide-card__index">{i + 1}</span>
              <button
                className="slide-card__summary"
                onClick={() => setOpenId(openId === slide.id ? null : slide.id)}
              >
                <span className={`slide-card__type slide-card__type--${slide.type}`}>
                  {SLIDE_TYPE_LABEL[slide.type]}
                </span>
                <span className="slide-card__title">{slide.title}</span>
              </button>
              <div className="slide-card__tools">
                <button className="icon-btn" title="위로" onClick={() => move(slide.id, -1)}>
                  ↑
                </button>
                <button className="icon-btn" title="아래로" onClick={() => move(slide.id, 1)}>
                  ↓
                </button>
                <button
                  className="icon-btn icon-btn--danger"
                  title="삭제"
                  onClick={() => remove(slide.id)}
                >
                  ✕
                </button>
              </div>
            </div>

            {openId === slide.id && (
              <SlideForm slide={slide} onPatch={(c) => patch(slide.id, c)} />
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

/* --------------------------------------------------------- 항목 편집 폼 */

function SlideForm({
  slide,
  onPatch,
}: {
  slide: Slide
  onPatch: (changes: Partial<Slide>) => void
}) {
  // 미리보기에서 눌러 본 선택과 적어 본 의견은 저장되지 않습니다.
  // 화면이 어떻게 반응하는지 확인하는 용도라, 이 컴포넌트 안에만 둡니다.
  const [previewAnswer, setPreviewAnswer] = useState<Answer | null>(null)
  const [previewComment, setPreviewComment] = useState('')

  // 저장 형식은 항상 { label, description } 으로 통일합니다.
  // (예전 문자열 형식으로 저장된 항목도 편집하는 순간 이 형식으로 바뀝니다.)
  const options = slideOptions(slide.options)

  const setOption = (index: number, changes: Partial<SlideOption>) => {
    const next = options.map((o, i) => (i === index ? { ...o, ...changes } : o))
    onPatch({ options: next })
  }

  const addOption = () => onPatch({ options: [...options, { label: '' }] })

  const removeOption = (index: number) =>
    onPatch({ options: options.filter((_, i) => i !== index) })

  const moveOption = (index: number, delta: number) => {
    const to = index + delta
    if (to < 0 || to >= options.length) return
    const next = [...options]
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    onPatch({ options: next })
  }

  const hasOptions = slide.type === 'choice' || slide.type === 'ox'

  return (
    <div className="slide-card__body">
      <label className="field">
        <span>{slide.type === 'info' ? '안내 제목' : '질문'}</span>
        <input
          value={slide.title}
          onChange={(e) => onPatch({ title: e.target.value })}
        />
      </label>

      <label className="field">
        <span>설명 (선택)</span>
        <textarea
          rows={2}
          value={slide.body ?? ''}
          onChange={(e) => onPatch({ body: e.target.value })}
        />
      </label>

      {hasOptions && (
        <div className="field">
          <span>선택지</span>
          <ul className="option-list">
            {options.map((option, i) => (
              <li key={i} className="option-item">
                <div className="option-row">
                  <input
                    value={option.label}
                    placeholder={`선택지 ${i + 1}`}
                    onChange={(e) => setOption(i, { label: e.target.value })}
                  />
                  <button
                    className="icon-btn"
                    title="위로"
                    onClick={() => moveOption(i, -1)}
                    disabled={i === 0}
                  >
                    ↑
                  </button>
                  <button
                    className="icon-btn"
                    title="아래로"
                    onClick={() => moveOption(i, 1)}
                    disabled={i === options.length - 1}
                  >
                    ↓
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    title="삭제"
                    onClick={() => removeOption(i)}
                  >
                    ✕
                  </button>
                </div>
                <input
                  className="option-desc"
                  value={option.description ?? ''}
                  placeholder="설명 (선택) — 선택지 아래 작은 글씨로 표시됩니다"
                  onChange={(e) => setOption(i, { description: e.target.value })}
                />
              </li>
            ))}
          </ul>
          {/* OX 는 두 개를 넘기지 않습니다. 화면이 두 개 기준으로 그려집니다. */}
          {!(slide.type === 'ox' && options.length >= 2) && (
            <button className="btn btn--sm" onClick={addOption}>
              + 선택지 추가
            </button>
          )}
        </div>
      )}

      {slide.type === 'choice' && (
        <label className="check">
          <input
            type="checkbox"
            checked={slide.multi}
            onChange={(e) => onPatch({ multi: e.target.checked })}
          />
          <span>복수 선택 허용</span>
        </label>
      )}

      {slide.type === 'info' && (
        <p className="muted">안내 페이지에는 응답 입력란이 표시되지 않습니다.</p>
      )}

      {slide.type === 'text' && (
        <p className="muted">참가자에게 자유 입력란(최대 1000자)이 표시됩니다.</p>
      )}

      {/* 참가자 화면과 같은 컴포넌트로 그리므로 실제 모습과 어긋나지 않습니다. */}
      <div className="preview">
        <div className="preview__label">참가자 화면 미리보기</div>
        <div className="preview__frame">
          <div className="slide">
            <SlideView
              slide={slide}
              answer={previewAnswer}
              onChange={setPreviewAnswer}
              comment={previewComment}
              onCommentChange={setPreviewComment}
            />
          </div>
        </div>
        <p className="preview__note">
          여기서 누른 선택은 저장되지 않습니다.
        </p>
      </div>
    </div>
  )
}
