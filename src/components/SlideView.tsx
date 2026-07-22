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
}: {
  slide: Pick<Slide, 'type' | 'title' | 'body' | 'options' | 'multi'>
  answer: Answer | null
  onChange: (next: Answer) => void
  comment: string
  onCommentChange: (next: string) => void
}) {
  return (
    <>
      <h1 className="slide__title">{slide.title || '(제목 없음)'}</h1>
      {slide.body && <p className="slide__body">{slide.body}</p>}

      <AnswerInput slide={slide} answer={answer} onChange={onChange} />

      {/* 안내 페이지를 포함해 모든 항목에서 의견을 남길 수 있습니다. */}
      <CommentBox value={comment} onCommit={onCommentChange} />
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

function CommentBox({
  value,
  onCommit,
}: {
  value: string
  onCommit: (next: string) => void
}) {
  return (
    <div className="comment">
      <label className="comment__label" htmlFor="slide-comment">
        추가 의견 <span className="comment__optional">(선택)</span>
      </label>
      <DebouncedTextarea
        id="slide-comment"
        className="comment__input"
        value={value}
        placeholder="이 항목에 대해 덧붙이고 싶은 말이 있으면 적어 주세요"
        rows={3}
        onCommit={onCommit}
      />
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
