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

/* ------------------------------------------------ 문항 import / export */
console.log('\n[문항 파일 왕복]')

const XLSX = await server.ssrLoadModule('xlsx')
const excel = await server.ssrLoadModule('/src/lib/excel.ts')

// 선택지 한 칸 안에서 라벨과 설명이 온전히 되살아나는지.
const roundTripCell = excel.cellToOptions(
  excel.optionsToCell([
    { label: '매우 그렇다', description: '기대보다 좋았다' },
    { label: '보통' },
    { label: '아니다', description: '다시 오지 않겠다' },
  ]),
)
check('선택지 3개가 그대로 복원됨', roundTripCell.length === 3)
check('설명이 붙은 선택지 복원',
  roundTripCell[0].label === '매우 그렇다' &&
  roundTripCell[0].description === '기대보다 좋았다')
check('설명 없는 선택지는 설명이 비어 있음',
  roundTripCell[1].label === '보통' && roundTripCell[1].description === undefined)

// 라벨에 구분자가 없는 평범한 입력도 문제없어야 합니다.
check('구분자 없는 단순 입력', excel.cellToOptions('A | B | C').length === 3)
check('빈 칸은 선택지 없음', excel.cellToOptions('').length === 0)

/** 워크북을 실제 파일처럼 만들어 parseSlideFile 에 넘깁니다. */
const asFile = (workbook, name) => {
  const buf = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
  return new File([buf], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

const template = await excel.parseSlideFile(asFile(excel.buildSlideTemplate(), 't.xlsx'))
check('양식 파일이 그대로 읽힘', template.length === 4, `${template.length}행`)
check('양식 — 유형이 코드로 변환됨',
  template.map((r) => r.type).join(',') === 'info,choice,ox,text',
  template.map((r) => r.type).join(','))
check('양식 — OX 선택지 설명 보존',
  template[2].options[0].description === '참여하겠다')

// 내보낸 문항을 다시 가져오는 경로 (실제로 가장 많이 쓰게 될 흐름).
const exported = excel.buildSlideWorkbook([
  { order_index: 0, type: 'info', title: '안내', body: '설명입니다', options: [], multi: false },
  {
    order_index: 1,
    type: 'choice',
    title: '복수 문항',
    body: null,
    options: [{ label: 'A', description: '가' }, { label: 'B' }],
    multi: true,
  },
])
const reimported = await excel.parseSlideFile(asFile(exported, 'e.xlsx'))
check('내보낸 문항을 다시 가져옴', reimported.length === 2)
check('제목·설명 보존',
  reimported[0].title === '안내' && reimported[0].body === '설명입니다')
check('선택지 설명 보존', reimported[1].options[0].description === '가')
check('복수 선택 여부 보존', reimported[1].multi === true && reimported[0].multi === false)

// 잘못된 파일은 조용히 넘어가지 않고 어디가 문제인지 알려줘야 합니다.
const badType = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(
  badType,
  XLSX.utils.json_to_sheet([{ 유형: '단답형', 제목: '제목' }]),
  '문항',
)
let badTypeError = ''
try {
  await excel.parseSlideFile(asFile(badType, 'b.xlsx'))
} catch (err) {
  badTypeError = err.message
}
check('알 수 없는 유형은 행 번호와 함께 거부',
  badTypeError.includes('2행') && badTypeError.includes('단답형'),
  badTypeError.split('\n')[0])

const noOptions = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(
  noOptions,
  XLSX.utils.json_to_sheet([{ 유형: '다지선다', 제목: '선택지 없는 문항', 선택지: '' }]),
  '문항',
)
let noOptionsError = ''
try {
  await excel.parseSlideFile(asFile(noOptions, 'n.xlsx'))
} catch (err) {
  noOptionsError = err.message
}
check('선택지 없는 다지선다는 거부', noOptionsError.includes('선택지가 없습니다'),
  noOptionsError.split('\n')[0])

/* ---------------------------------------------------------- 라우팅 */
/*
 * 라우트에 적은 파라미터 이름과 페이지가 useParams 로 꺼내는 이름이 어긋나면,
 * 값이 undefined 로 들어와 화면이 조용히 엉뚱하게 나옵니다. 빌드도 통과하고
 * 에러도 없어서 눈으로는 알아채기 어렵습니다. (실제로 :sessionId 로 두고
 * surveyId 를 읽어, 설문을 눌러도 목록만 다시 나온 적이 있습니다.)
 */
console.log('\n[라우팅]')

const { readFileSync: readSrc } = await import('node:fs')
const { join: joinPath, dirname: dirName } = await import('node:path')
const { fileURLToPath: toPath } = await import('node:url')
const root = joinPath(dirName(toPath(import.meta.url)), '..')

const appSrc = readSrc(joinPath(root, 'src/App.tsx'), 'utf8')

const PAGE_FILE = {
  ParticipantPage: 'src/pages/Participant.tsx',
  AdminPage: 'src/pages/Admin.tsx',
  PresentPage: 'src/pages/Present.tsx',
}

const routes = [...appSrc.matchAll(/<Route\s+path="([^"]+)"\s+element=\{<(\w+)/g)]
check('라우트를 읽어냄', routes.length >= 4, `${routes.length}개`)

for (const [, path, component] of routes) {
  const params = [...path.matchAll(/:(\w+)/g)].map((m) => m[1])
  if (params.length === 0) continue

  const file = PAGE_FILE[component]
  if (!file) {
    check(`${path} → ${component} 파일을 앎`, false, '매핑에 없음')
    continue
  }

  const pageSrc = readSrc(joinPath(root, file), "utf8")
  for (const param of params) {
    // useParams 구조분해 안에 그 이름이 있는지 봅니다.
    const used = new RegExp(`const\\s*\\{[^}]*\\b${param}\\b[^}]*\\}\\s*=\\s*useParams`).test(
      pageSrc,
    )
    check(`${path} 의 :${param} 를 ${component} 가 읽음`, used,
      used ? '' : `${file} 의 useParams 에 ${param} 없음`)
  }
}

await server.close()
console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail > 0 ? 1 : 0)
