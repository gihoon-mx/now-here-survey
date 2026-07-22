/**
 * 문항 렌더링 점검.
 *
 *   npm run render-check
 *
 * SlideView 는 참가자 화면과 관리자 편집 화면의 미리보기가 함께 쓰는
 * 컴포넌트라, 여기가 깨지면 두 화면이 동시에 깨집니다. 네 가지 문항 유형을
 * 각각 서버 렌더링해서 예상한 내용이 실제로 나오는지 확인합니다.
 *
 * 브라우저 없이 도는 점검이라 CI 나 배포 전에 가볍게 돌릴 수 있습니다.
 */
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (ok) pass++
  else fail++
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

const { SlideView } = await server.ssrLoadModule('/src/components/SlideView.tsx')

const render = (slide, answer = null, comment = '') =>
  renderToStaticMarkup(
    createElement(SlideView, {
      slide,
      answer,
      comment,
      onChange: () => {},
      onCommentChange: () => {},
    }),
  )

console.log('\n[문항 유형별 렌더링]')

const choice = render({
  type: 'choice',
  title: '만족도는 어떠셨나요?',
  body: '하나만 골라 주세요.',
  options: [
    { label: '매우 그렇다', description: '기대한 것보다 좋았다' },
    { label: '보통' },
    { label: '아니다' },
  ],
  multi: false,
})
check('다지선다 — 제목 표시', choice.includes('만족도는 어떠셨나요?'))
check('다지선다 — 설명 표시', choice.includes('하나만 골라 주세요.'))
check('다지선다 — 선택지 3개', (choice.match(/class="choice"/g) ?? []).length === 3)
check('선택지 설명이 작은 글씨로 표시됨',
  choice.includes('choice__desc') && choice.includes('기대한 것보다 좋았다'))
check('설명 없는 선택지에는 빈 요소가 생기지 않음',
  (choice.match(/choice__desc/g) ?? []).length === 1)

// 예전에 저장된 문자열 배열도 그대로 읽혀야 합니다.
const legacy = render({
  type: 'choice',
  title: '예전 형식',
  body: null,
  options: ['A', 'B'],
  multi: false,
})
check('문자열 배열로 저장된 예전 선택지도 표시됨',
  legacy.includes('>A<') && legacy.includes('>B<'))

const selected = render(
  {
    type: 'choice',
    title: '만족도',
    body: null,
    options: [{ label: 'A' }, { label: 'B' }],
    multi: false,
  },
  { choice: 'B' },
)
check('선택한 항목에 표시가 붙음', selected.includes('choice--selected'))
check('고르지 않은 항목에는 안 붙음',
  (selected.match(/choice--selected/g) ?? []).length === 1)

const multi = render(
  {
    type: 'choice',
    title: '복수 선택',
    body: null,
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    multi: true,
  },
  { choices: ['A', 'C'] },
)
check('복수 선택 — 두 개가 선택됨',
  (multi.match(/choice--selected/g) ?? []).length === 2)

const ox = render({
  type: 'ox',
  title: '재참여 의향',
  body: null,
  options: [{ label: 'O', description: '다시 참여하겠다' }, { label: 'X' }],
  multi: false,
})
check('OX — 가로 배치 클래스', ox.includes('choices--ox'))
check('OX — 선택지 2개', (ox.match(/class="choice"/g) ?? []).length === 2)
check('OX — 설명도 표시됨', ox.includes('다시 참여하겠다'))

const info = render({ type: 'info', title: '잠시 안내드립니다', body: '곧 시작합니다.', options: [], multi: false })
check('안내 페이지 — 제목 표시', info.includes('잠시 안내드립니다'))
check('안내 페이지 — 선택지 없음', !info.includes('class="choice"'))

const text = render({ type: 'text', title: '자유 의견', body: null, options: [], multi: false }, { text: '좋았습니다' })
check('주관식 — 입력란 표시', text.includes('text-answer'))
check('주관식 — 기존 응답이 채워짐', text.includes('좋았습니다'))

console.log('\n[항목별 자유 의견]')
// 모든 유형에 의견란이 붙어야 합니다 — 안내 페이지 포함.
for (const [label, markup] of [
  ['다지선다', choice],
  ['OX', ox],
  ['안내 페이지', info],
  ['주관식', text],
]) {
  check(`${label} — 의견란 표시`, markup.includes('comment__input'))
}

const withComment = render(
  { type: 'info', title: '안내', body: null, options: [], multi: false },
  null,
  '이미 적어 둔 의견',
)
check('기존 의견이 채워짐', withComment.includes('이미 적어 둔 의견'))

console.log('\n[편집 중간 상태]')
// 편집기에서는 선택지가 아직 비어 있는 순간이 자연스럽게 생깁니다.
// 그때 미리보기가 죽으면 편집이 불가능해집니다.
const empty = render({ type: 'choice', title: '', body: null, options: [], multi: false })
check('제목이 비어도 죽지 않음', empty.includes('(제목 없음)'))
check('선택지가 없어도 안내만 표시', empty.includes('선택지가 아직 없습니다'))

await server.close()
console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail > 0 ? 1 : 0)
