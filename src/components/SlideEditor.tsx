import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { SlideView } from './SlideView'
import {
  buildSlideTemplate,
  buildSlideWorkbook,
  downloadWorkbook,
  parseSlideFile,
} from '../lib/excel'
import {
  SLIDE_TYPE_LABEL,
  slideOptions,
  type Answer,
  type Page,
  type Slide,
  type SlideOption,
  type SlideType,
} from '../lib/types'

/*
 * 새 항목은 빈칸으로 시작합니다. 예시 문구를 채워 두면 지우는 일이 먼저
 * 생기고, 지우지 않은 채 진행에 들어가는 사고도 납니다.
 * 다지선다는 선택지 칸만 네 개 만들어 둡니다 (가장 흔한 개수).
 */
const DEFAULT_OPTIONS: Record<SlideType, SlideOption[]> = {
  choice: [{ label: '' }, { label: '' }, { label: '' }, { label: '' }],
  ox: [{ label: 'O' }, { label: 'X' }],
  info: [],
  text: [],
}

export default function SlideEditor({ surveyId }: { surveyId: string }) {
  const [pages, setPages] = useState<Page[]>([])
  const [slides, setSlides] = useState<Slide[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  /** 상단 고정 툴바의 문항 추가 버튼이 어느 페이지에 넣을지. */
  const [activePageId, setActivePageId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  // 같은 파일 선택창을 "뒤에 추가"와 "전체 교체"가 함께 쓰기 때문에,
  // 어느 버튼으로 열었는지 기억해 둡니다.
  const importMode = useRef<'replace' | 'append'>('append')

  const load = async () => {
    const [pageRes, slideRes] = await Promise.all([
      supabase.from('pages').select('*').eq('survey_id', surveyId).order('order_index'),
      supabase.from('slides').select('*').eq('survey_id', surveyId).order('order_index'),
    ])
    const loadedPages = (pageRes.data as Page[]) ?? []
    setPages(loadedPages)
    setSlides((slideRes.data as Slide[]) ?? [])
    // 활성 페이지가 사라졌으면 마지막 페이지로 옮깁니다.
    setActivePageId((prev) =>
      prev && loadedPages.some((p) => p.id === prev)
        ? prev
        : loadedPages.at(-1)?.id ?? null,
    )
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [surveyId])

  const pageSlides = (pageId: string) =>
    slides
      .filter((s) => s.page_id === pageId)
      .sort((a, b) => a.order_index - b.order_index)

  /* ------------------------------------------------------------ 페이지 */

  const addPage = async (): Promise<Page | null> => {
    setError(null)
    const { data, error: insertError } = await supabase
      .from('pages')
      .insert({ survey_id: surveyId, order_index: pages.length })
      .select()
      .single()
    if (insertError) {
      setError(insertError.message)
      return null
    }
    const page = data as Page
    setPages((prev) => [...prev, page])
    setActivePageId(page.id)
    return page
  }

  const patchPage = async (id: string, changes: Partial<Page>) => {
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, ...changes } : p)))
    const { error: updateError } = await supabase.from('pages').update(changes).eq('id', id)
    if (updateError) setError(updateError.message)
  }

  const removePage = async (page: Page) => {
    const count = pageSlides(page.id).length
    if (
      !confirm(
        `이 페이지를 삭제할까요?` +
          (count > 0 ? `\n안의 문항 ${count}개와 받은 응답도 함께 지워집니다.` : ''),
      )
    )
      return
    await supabase.from('pages').delete().eq('id', page.id)
    const remaining = pages.filter((p) => p.id !== page.id)
    await renumberPages(remaining)
    setSlides((prev) => prev.filter((s) => s.page_id !== page.id))
  }

  const movePage = async (id: string, delta: number) => {
    const from = pages.findIndex((p) => p.id === id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= pages.length) return
    const reordered = [...pages]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)
    await renumberPages(reordered)
  }

  /** 페이지 순번을 0..n-1 로 다시 채우고 화면에도 반영합니다. */
  const renumberPages = async (ordered: Page[]) => {
    setPages(ordered.map((p, i) => ({ ...p, order_index: i })))
    await Promise.all(
      ordered.map((p, i) =>
        p.order_index === i
          ? Promise.resolve()
          : supabase.from('pages').update({ order_index: i }).eq('id', p.id),
      ),
    )
  }

  /* ------------------------------------------------------------- 문항 */

  const addSlide = async (type: SlideType) => {
    setError(null)
    // 페이지가 없으면 먼저 하나 만들어 그 안에 넣습니다.
    let pageId = activePageId ?? pages.at(-1)?.id ?? null
    if (!pageId) {
      const page = await addPage()
      if (!page) return
      pageId = page.id
    }

    const { data, error: insertError } = await supabase
      .from('slides')
      .insert({
        survey_id: surveyId,
        page_id: pageId,
        order_index: pageSlides(pageId).length,
        type,
        title: '',
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

  const remove = async (slide: Slide) => {
    if (!confirm('이 항목을 삭제할까요? 이미 받은 응답도 함께 지워집니다.')) return
    await supabase.from('slides').delete().eq('id', slide.id)
    const remaining = pageSlides(slide.page_id).filter((s) => s.id !== slide.id)
    setSlides((prev) => prev.filter((s) => s.id !== slide.id))
    await renumberSlides(slide.page_id, remaining)
  }

  /**
   * 페이지 안에서는 위아래로 자리를 바꾸고, 페이지 경계에 닿으면
   * 인접 페이지로 넘어갑니다 — 문항을 다른 페이지로 옮길 때 씁니다.
   */
  const moveSlide = async (slide: Slide, delta: number) => {
    const inPage = pageSlides(slide.page_id)
    const idx = inPage.findIndex((s) => s.id === slide.id)
    const to = idx + delta

    if (to >= 0 && to < inPage.length) {
      const reordered = [...inPage]
      const [moved] = reordered.splice(idx, 1)
      reordered.splice(to, 0, moved)
      await renumberSlides(slide.page_id, reordered)
      return
    }

    // 페이지 경계를 넘습니다.
    const pageIdx = pages.findIndex((p) => p.id === slide.page_id)
    const target = pages[pageIdx + delta]
    if (!target) return

    const targetSlides = pageSlides(target.id)
    const rest = inPage.filter((s) => s.id !== slide.id)
    const movedSlide = { ...slide, page_id: target.id }
    const nextTarget =
      delta > 0 ? [movedSlide, ...targetSlides] : [...targetSlides, movedSlide]

    setSlides((prev) =>
      prev.map((s) => (s.id === slide.id ? { ...s, page_id: target.id } : s)),
    )
    await supabase.from('slides').update({ page_id: target.id }).eq('id', slide.id)
    await renumberSlides(slide.page_id, rest)
    await renumberSlides(target.id, nextTarget)
  }

  /** 한 페이지 안의 문항 순번을 0..n-1 로 다시 채웁니다. */
  const renumberSlides = async (pageId: string, ordered: Slide[]) => {
    setSlides((prev) =>
      prev.map((s) => {
        const i = ordered.findIndex((o) => o.id === s.id)
        return i >= 0 ? { ...s, page_id: pageId, order_index: i } : s
      }),
    )
    await Promise.all(
      ordered.map((s, i) =>
        supabase.from('slides').update({ order_index: i }).eq('id', s.id),
      ),
    )
  }

  /* ------------------------------------------------- 파일로 가져오기/내보내기 */

  const importSlides = async (file: File, mode: 'replace' | 'append') => {
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      const parsed = await parseSlideFile(file)
      const slideCount = parsed.reduce((n, p) => n + p.slides.length, 0)

      if (mode === 'replace') {
        if (
          !confirm(
            `기존 문항 ${slides.length}개를 지우고 ${slideCount}개로 교체합니다.\n` +
              '이미 받은 응답도 함께 지워집니다. 계속할까요?',
          )
        )
          return
        await supabase.from('pages').delete().eq('survey_id', surveyId)
      }

      const base = mode === 'replace' ? 0 : pages.length

      // 페이지를 먼저 만들고, 문항을 각 페이지에 붙입니다.
      const { data: newPages, error: pageError } = await supabase
        .from('pages')
        .insert(
          parsed.map((page, i) => ({
            survey_id: surveyId,
            order_index: base + i,
            title: page.title || null,
          })),
        )
        .select()
      if (pageError) throw new Error(pageError.message)

      const created = (newPages as Page[]).sort((a, b) => a.order_index - b.order_index)
      const { error: insertError } = await supabase.from('slides').insert(
        parsed.flatMap((page, i) =>
          page.slides.map((row, j) => ({
            survey_id: surveyId,
            page_id: created[i].id,
            order_index: j,
            type: row.type,
            title: row.title,
            body: row.body || null,
            options: row.options,
            multi: row.multi,
          })),
        ),
      )
      if (insertError) throw new Error(insertError.message)

      setNotice(`페이지 ${parsed.length}개, 문항 ${slideCount}개를 가져왔습니다.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '가져오기에 실패했습니다.')
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  if (loading) return <p className="muted">불러오는 중…</p>

  const activeIndex = pages.findIndex((p) => p.id === activePageId)

  return (
    <div className="editor">
      {/*
       * 문항 추가 버튼은 스크롤과 상관없이 항상 위에 붙어 있습니다.
       * 문항이 수십 개로 늘면 목록 아래에서 추가하러 맨 위나 맨 아래로
       * 오가는 일이 잦은데, 그 왕복을 없앱니다.
       */}
      <div className="editor__toolbar">
        <button className="btn btn--sm btn--primary" onClick={() => void addPage()}>
          + 페이지
        </button>
        <span className="editor__toolbar-sep" />
        {(Object.keys(SLIDE_TYPE_LABEL) as SlideType[]).map((type) => (
          <button key={type} className="btn btn--sm" onClick={() => void addSlide(type)}>
            + {SLIDE_TYPE_LABEL[type]}
          </button>
        ))}
        {pages.length > 0 && (
          <span className="editor__toolbar-hint">
            문항은 {activeIndex >= 0 ? `${activeIndex + 1}페이지` : '마지막 페이지'}에
            추가됩니다
          </span>
        )}
      </div>

      <div className="card">
        <h2>파일로 문항 관리</h2>
        <p className="muted">
          엑셀(.xlsx) 또는 CSV. <code>페이지</code> 열의 값이 같은 문항이 한 페이지에
          함께 나옵니다. 선택지는 <code>|</code> 로 구분하고, 설명을 붙일 때는{' '}
          <code>라벨 :: 설명</code> 으로 씁니다.
          <br />
          내보낸 파일은 그대로 다시 가져올 수 있습니다.
        </p>
        <div className="row">
          <button
            className="btn btn--sm"
            onClick={() => downloadWorkbook(buildSlideTemplate(), '문항_양식.xlsx')}
          >
            양식 내려받기
          </button>
          {slides.length > 0 && (
            <button
              className="btn btn--sm"
              onClick={() =>
                downloadWorkbook(buildSlideWorkbook(pages, slides), '문항.xlsx')
              }
            >
              문항 내보내기
            </button>
          )}
          <button
            className="btn btn--sm btn--primary"
            disabled={busy}
            onClick={() => {
              importMode.current = 'append'
              fileInput.current?.click()
            }}
          >
            {busy ? '가져오는 중…' : '뒤에 추가'}
          </button>
          {slides.length > 0 && (
            <button
              className="btn btn--sm"
              disabled={busy}
              onClick={() => {
                importMode.current = 'replace'
                fileInput.current?.click()
              }}
            >
              전체 교체
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls,.csv"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void importSlides(file, importMode.current)
            }}
          />
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {pages.length === 0 && (
        <p className="muted">
          위 버튼으로 페이지나 문항을 추가해 주세요. 문항을 바로 추가하면 첫
          페이지가 함께 만들어집니다.
        </p>
      )}

      <ol className="editor__pages">
        {pages.map((page, pageNo) => {
          const inPage = pageSlides(page.id)
          return (
            <li
              key={page.id}
              className={
                'card page-card' + (page.id === activePageId ? ' page-card--active' : '')
              }
              onClick={() => setActivePageId(page.id)}
            >
              <div className="page-card__head">
                <span className="page-card__index">{pageNo + 1}페이지</span>
                <input
                  className="page-card__title"
                  value={page.title ?? ''}
                  placeholder="페이지 제목 (선택)"
                  onChange={(e) => void patchPage(page.id, { title: e.target.value })}
                />
                <div className="slide-card__tools">
                  <button
                    className="icon-btn"
                    title="페이지 위로"
                    onClick={() => void movePage(page.id, -1)}
                    disabled={pageNo === 0}
                  >
                    ↑
                  </button>
                  <button
                    className="icon-btn"
                    title="페이지 아래로"
                    onClick={() => void movePage(page.id, 1)}
                    disabled={pageNo === pages.length - 1}
                  >
                    ↓
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    title="페이지 삭제"
                    onClick={() => void removePage(page)}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {inPage.length === 0 ? (
                <p className="muted page-card__empty">
                  문항이 없는 페이지입니다. 이 페이지를 누른 뒤 위의 문항 추가
                  버튼을 쓰세요.
                </p>
              ) : (
                <ol className="editor__list">
                  {inPage.map((slide, i) => (
                    <li key={slide.id} className="slide-card slide-card--nested">
                      <div className="slide-card__head">
                        <span className="slide-card__index">{i + 1}</span>
                        <button
                          className="slide-card__summary"
                          onClick={() => setOpenId(openId === slide.id ? null : slide.id)}
                        >
                          <span
                            className={`slide-card__type slide-card__type--${slide.type}`}
                          >
                            {SLIDE_TYPE_LABEL[slide.type]}
                          </span>
                          <span
                            className={
                              'slide-card__title' +
                              (slide.title ? '' : ' slide-card__title--empty')
                            }
                          >
                            {slide.title || '(제목 없음)'}
                          </span>
                        </button>
                        <div className="slide-card__tools">
                          <button
                            className="icon-btn"
                            title="위로 (페이지 맨 위에서는 앞 페이지로)"
                            onClick={() => void moveSlide(slide, -1)}
                            disabled={pageNo === 0 && i === 0}
                          >
                            ↑
                          </button>
                          <button
                            className="icon-btn"
                            title="아래로 (페이지 맨 아래에서는 다음 페이지로)"
                            onClick={() => void moveSlide(slide, 1)}
                            disabled={
                              pageNo === pages.length - 1 && i === inPage.length - 1
                            }
                          >
                            ↓
                          </button>
                          <button
                            className="icon-btn icon-btn--danger"
                            title="삭제"
                            onClick={() => void remove(slide)}
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
              )}
            </li>
          )
        })}
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
