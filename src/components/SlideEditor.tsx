import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { SLIDE_TYPE_LABEL, type Slide, type SlideType } from '../lib/types'

const DEFAULT_OPTIONS: Record<SlideType, string[]> = {
  choice: ['매우 그렇다', '그렇다', '보통이다', '그렇지 않다', '전혀 그렇지 않다'],
  ox: ['O', 'X'],
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
    setSlides((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...changes } : s)),
    )
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
                <span className="slide-card__type">
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
                <button className="icon-btn icon-btn--danger" title="삭제" onClick={() => remove(slide.id)}>
                  ✕
                </button>
              </div>
            </div>

            {openId === slide.id && (
              <div className="slide-card__body">
                <label className="field">
                  <span>{slide.type === 'info' ? '안내 제목' : '질문'}</span>
                  <input
                    value={slide.title}
                    onChange={(e) => patch(slide.id, { title: e.target.value })}
                  />
                </label>

                <label className="field">
                  <span>설명 (선택)</span>
                  <textarea
                    rows={2}
                    value={slide.body ?? ''}
                    onChange={(e) => patch(slide.id, { body: e.target.value })}
                  />
                </label>

                {slide.type === 'choice' && (
                  <>
                    <label className="field">
                      <span>선택지 — 한 줄에 하나</span>
                      <textarea
                        rows={5}
                        value={slide.options.join('\n')}
                        onChange={(e) =>
                          patch(slide.id, {
                            options: e.target.value
                              .split('\n')
                              .map((v) => v.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={slide.multi}
                        onChange={(e) => patch(slide.id, { multi: e.target.checked })}
                      />
                      <span>복수 선택 허용</span>
                    </label>
                  </>
                )}

                {slide.type === 'ox' && (
                  <label className="field">
                    <span>두 선택지 — 한 줄에 하나</span>
                    <textarea
                      rows={2}
                      value={slide.options.join('\n')}
                      onChange={(e) =>
                        patch(slide.id, {
                          options: e.target.value
                            .split('\n')
                            .map((v) => v.trim())
                            .filter(Boolean)
                            .slice(0, 2),
                        })
                      }
                    />
                  </label>
                )}

                {slide.type === 'info' && (
                  <p className="muted">
                    안내 페이지에는 응답 입력란이 표시되지 않습니다.
                  </p>
                )}

                {slide.type === 'text' && (
                  <p className="muted">
                    참가자에게 자유 입력란(최대 1000자)이 표시됩니다.
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
