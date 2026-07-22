import { useEffect, useRef, useState } from 'react'
import { slideOptions, type Answer, type Slide, type SlideOption } from '../lib/types'

/**
 * 참가자에게 보이는 문항 화면.
 *
 * 참가자 화면과 관리자 편집 화면의 미리보기가 이 컴포넌트를 함께 씁니다.
 * 미리보기를 따로 만들면 시간이 지나면서 실제 화면과 어긋나는데, 그러면
 * 미리보기를 믿을 수 없게 되어 존재 의미가 없어집니다.
 */
export function SlideView({
  slide,
  answer,
  onChange,
  comment,
  onCommentChange,
  showComment = true,
}: {
  slide: Pick<Slide, 'type' | 'title' | 'body' | 'options' | 'multi'> &
    Partial<Pick<Slide, 'comment_enabled'>>
  answer: Answer | null
  onChange: (next: Answer) => void
  comment: string
  onCommentChange: (next: string) => void
  /** 종료 후 보충 응답처럼 의견란을 아예 빼야 하는 화면에서 끕니다. */
  showComment?: boolean
}) {
  // 의견란은 문항 옵션(기본 켜짐)과 화면 사정 둘 다 허락할 때만 나옵니다.
  const commentVisible = showComment && (slide.comment_enabled ?? true)

  return (
    <>
      <h1 className="slide__title">{slide.title || '(제목 없음)'}</h1>
      {slide.body && <p className="slide__body">{slide.body}</p>}

      <AnswerInput slide={slide} answer={answer} onChange={onChange} />

      {/* 안내 페이지를 포함해 모든 항목에서 의견을 남길 수 있습니다. */}
      {commentVisible && <CommentBox value={comment} onCommit={onCommentChange} />}
    </>
  )
}

function AnswerInput({
  slide,
  answer,
  onChange,
}: {
  slide: Pick<Slide, 'type' | 'options' | 'multi'>
  answer: Answer | null
  onChange: (next: Answer) => void
}) {
  const options = slideOptions(slide.options)

  switch (slide.type) {
    case 'info':
      return null

    case 'ox':
      return (
        <ChoiceList
          options={options.length > 0 ? options : [{ label: 'O' }, { label: 'X' }]}
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
            options={options}
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
          options={options}
          selected={answer?.choice ? [answer.choice] : []}
          variant="list"
          onPick={(value) => onChange({ choice: value })}
        />
      )

    case 'text':
      return (
        <DebouncedTextarea
          className="text-answer"
          value={answer?.text ?? ''}
          placeholder="자유롭게 입력해 주세요"
          rows={6}
          onCommit={(t) => onChange({ text: t })}
        />
      )
  }
}

function ChoiceList({
  options,
  selected,
  variant,
  onPick,
}: {
  options: SlideOption[]
  selected: string[]
  variant: 'list' | 'ox'
  onPick: (value: string) => void
}) {
  if (options.length === 0)
    return <p className="muted">선택지가 아직 없습니다.</p>

  return (
    <div className={variant === 'ox' ? 'choices choices--ox' : 'choices'}>
      {options.map((option, i) => (
        <button
          key={`${option.label}-${i}`}
          type="button"
          className={
            'choice' + (selected.includes(option.label) ? ' choice--selected' : '')
          }
          aria-pressed={selected.includes(option.label)}
          onClick={() => onPick(option.label)}
        >
          <span className="choice__label">{option.label}</span>
          {option.description && (
            <span className="choice__desc">{option.description}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/**
 * 항목별 자유 의견.
 *
 * 예전에는 입력이 멈추면 조용히 저장했는데, 참가자 입장에서 "내 의견이
 * 들어갔는지"를 확신할 수 없었습니다. 지금은 [입력] 버튼을 눌러야 저장되고,
 * 저장된 내용이 그대로 화면에 남아 반영을 눈으로 확인할 수 있습니다.
 * 평소에는 한 줄짜리 버튼으로 접혀 있어 문항을 가리지 않습니다.
 */
function CommentBox({
  value,
  onCommit,
}: {
  value: string
  onCommit: (next: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [justSaved, setJustSaved] = useState(false)
  const savedTimer = useRef<number | undefined>(undefined)

  // 서버에서 기존 의견이 로드되면 초안도 맞춰 줍니다.
  useEffect(() => {
    setDraft(value)
  }, [value])

  useEffect(() => () => window.clearTimeout(savedTimer.current), [])

  const submit = () => {
    onCommit(draft.trim())
    setEditing(false)
    setJustSaved(true)
    window.clearTimeout(savedTimer.current)
    savedTimer.current = window.setTimeout(() => setJustSaved(false), 2500)
  }

  if (!editing) {
    // 의견이 없으면 한 줄 버튼만. 있으면 저장된 내용을 보여 줍니다.
    if (!value) {
      return (
        <div className="comment comment--compact">
          <button
            type="button"
            className="comment__add"
            onClick={() => {
              setDraft('')
              setEditing(true)
            }}
          >
            ＋ 의견 남기기 <span className="comment__optional">(선택)</span>
          </button>
          {justSaved && <span className="comment__saved-badge">입력됨 ✓</span>}
        </div>
      )
    }
    return (
      <div className="comment comment--compact">
        <div className="comment__view">
          <span className="comment__label">
            내 의견
            {justSaved && <span className="comment__saved-badge"> 입력됨 ✓</span>}
          </span>
          <p className="comment__text">{value}</p>
          <button
            type="button"
            className="btn btn--sm btn--ghost comment__edit"
            onClick={() => {
              setDraft(value)
              setEditing(true)
            }}
          >
            수정
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="comment comment--compact">
      <label className="comment__label" htmlFor="slide-comment">
        의견 <span className="comment__optional">(선택)</span>
      </label>
      <textarea
        id="slide-comment"
        className="comment__input"
        value={draft}
        maxLength={1000}
        rows={2}
        autoFocus
        placeholder="덧붙이고 싶은 말을 적고 [입력]을 눌러 주세요"
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="comment__actions">
        <button type="button" className="btn btn--sm btn--primary" onClick={submit}>
          입력
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => {
            setDraft(value)
            setEditing(false)
          }}
        >
          취소
        </button>
      </div>
    </div>
  )
}

/**
 * 글자마다 저장하면 요청이 과하게 나가므로, 입력이 잠깐 멈추면 저장하고
 * 포커스가 빠질 때 한 번 더 확정합니다.
 */
function DebouncedTextarea({
  value,
  onCommit,
  className,
  placeholder,
  rows,
  id,
}: {
  value: string
  onCommit: (text: string) => void
  className?: string
  placeholder?: string
  rows?: number
  id?: string
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
      id={id}
      className={className}
      value={draft}
      maxLength={1000}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => schedule(e.target.value)}
      onBlur={flush}
    />
  )
}
