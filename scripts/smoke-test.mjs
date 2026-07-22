/**
 * 백엔드 스모크 테스트.
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run smoke
 *
 * 실제 앱과 똑같은 경로(공개 anon 키 + RLS)로 전체 흐름을 돌립니다.
 * service_role 은 쓰지 않습니다 — 참가자가 실제로 뚫을 수 있는지까지
 * 확인해야 의미가 있기 때문입니다.
 *
 * 스키마를 고친 뒤에는 이걸 한 번 돌려 주세요. 특히 RLS 정책이나 GRANT 를
 * 건드렸다면, 조용히 열리거나 조용히 막히는 실수를 여기서 잡을 수 있습니다.
 *
 * 테스트가 만든 세션은 끝에서 지웁니다. (중간에 끊겨도 다음 실행이 치웁니다.)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// .env 에서 공개 설정을 읽습니다.
const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=')
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
    }),
)

const URL_BASE = env.VITE_SUPABASE_URL
const ANON = env.VITE_SUPABASE_KEY
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL 과 ADMIN_PASSWORD 환경변수가 필요합니다.')
  process.exit(1)
}

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (ok) pass++
  else fail++
}

async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token ?? ANON}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

const rest = (p, o) => call(`/rest/v1${p}`, o)
const rpc = (fn, args, token) =>
  call(`/rest/v1/rpc/${fn}`, { method: 'POST', token, body: args })

/* ---------------------------------------------------- 1. 관리자 로그인 */
console.log('\n[1] 관리자 로그인')
const login = await call('/auth/v1/token?grant_type=password', {
  method: 'POST',
  body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
})
check('이메일/비번 로그인', login.ok, login.ok ? '' : JSON.stringify(login.data))
if (!login.ok) process.exit(1)
const ADMIN = login.data.access_token

const isAdmin = await rpc('is_admin', {}, ADMIN)
check('is_admin() = true', isAdmin.data === true, JSON.stringify(isAdmin.data))

/* ------------------------------------------------------ 2. 설문 구성 */
console.log('\n[2] 설문 구성')
await rest('/sessions?title=like.%5B자동테스트%5D*', { method: 'DELETE', token: ADMIN })

const mkSession = await rest('/sessions', {
  method: 'POST', token: ADMIN,
  headers: { Prefer: 'return=representation' },
  body: { title: '[자동테스트] 삭제해도 됩니다' },
})
check('세션 생성', mkSession.ok, mkSession.ok ? '' : JSON.stringify(mkSession.data))
const SESSION = mkSession.data?.[0]?.id
if (!SESSION) process.exit(1)

// PostgREST 는 배열 insert 시 모든 객체의 키 구성이 같아야 합니다.
const mkSlides = await rest('/slides', {
  method: 'POST', token: ADMIN,
  headers: { Prefer: 'return=representation' },
  body: [
    { session_id: SESSION, order_index: 0, type: 'info',   title: '안내',        options: [] },
    { session_id: SESSION, order_index: 1, type: 'choice', title: '만족도는?',   options: ['매우 그렇다', '보통', '아니다'] },
    { session_id: SESSION, order_index: 2, type: 'ox',     title: '재참여 의향', options: ['O', 'X'] },
    { session_id: SESSION, order_index: 3, type: 'text',   title: '자유 의견',   options: [] },
  ],
})
check('슬라이드 4개 생성', mkSlides.ok, mkSlides.ok ? '' : JSON.stringify(mkSlides.data))
const slides = (mkSlides.data ?? []).sort((a, b) => a.order_index - b.order_index)

// 앱과 동일하게 return=minimal 로 넣습니다. representation 을 요구하면 응답에
// passcode 가 포함되어야 하는데 그 열은 읽기가 막혀 있어 통째로 거부됩니다.
const mkParts = await rest('/participants', {
  method: 'POST', token: ADMIN,
  headers: { Prefer: 'return=minimal' },
  body: [
    { session_id: SESSION, login_id: 'tester01', passcode: 'pw1111', display_name: '테스터일' },
    { session_id: SESSION, login_id: 'tester02', passcode: 'pw2222', display_name: '테스터이' },
  ],
})
check('참가자 2명 등록 (passcode 쓰기 가능)', mkParts.ok,
  mkParts.ok ? '' : JSON.stringify(mkParts.data))

const adminList = await rpc('admin_list_participants', { p_session_id: SESSION }, ADMIN)
check('관리자는 RPC 로 비번 조회 가능',
  adminList.ok && adminList.data?.[0]?.passcode?.startsWith('pw'),
  JSON.stringify(adminList.data?.map?.((r) => r.login_id)))

/* ---------------------------------------------------- 3. 참가자 로그인 */
console.log('\n[3] 참가자 로그인 (익명 → claim)')
const anonUp = await call('/auth/v1/signup', { method: 'POST', body: {} })
check('익명 로그인', anonUp.ok, anonUp.ok ? '' : JSON.stringify(anonUp.data))
const P1 = anonUp.data.access_token

const wrong = await rpc('claim_participant',
  { p_login_id: 'tester01', p_passcode: '틀린비번' }, P1)
check('틀린 비번은 거부됨', !wrong.ok, `status ${wrong.status}`)

const claim = await rpc('claim_participant',
  { p_login_id: 'tester01', p_passcode: 'pw1111' }, P1)
check('올바른 비번으로 입장', claim.ok && claim.data?.[0]?.display_name === '테스터일',
  claim.ok ? '' : JSON.stringify(claim.data))

/* ------------------------------------------------- 4. 참가자 권한 경계 */
console.log('\n[4] 참가자 권한 경계')
const peekPass = await rest('/participants?select=login_id,passcode', { token: P1 })
check('참가자는 passcode 열을 읽을 수 없음', !peekPass.ok, `status ${peekPass.status}`)

const ownRow = await rest('/participants?select=login_id,display_name', { token: P1 })
check('참가자는 자기 행만 보임',
  ownRow.ok && ownRow.data.length === 1 && ownRow.data[0].login_id === 'tester01',
  JSON.stringify(ownRow.data))

const peekSlides = await rest('/slides?select=title', { token: P1 })
check('시작 전에는 문항이 하나도 안 보임',
  peekSlides.ok && peekSlides.data.length === 0,
  JSON.stringify(peekSlides.data))

/* ------------------------------------------------------- 5. 진행 제어 */
console.log('\n[5] 진행 제어')
const start = await rpc('start_session', { p_session_id: SESSION }, ADMIN)
check('관리자가 세션 시작', start.ok, start.ok ? '' : JSON.stringify(start.data))

const notAdmin = await rpc('start_session', { p_session_id: SESSION }, P1)
check('참가자는 세션을 제어할 수 없음', !notAdmin.ok, `status ${notAdmin.status}`)

const seen0 = await rest('/slides?select=order_index&order=order_index', { token: P1 })
check('0번 슬라이드만 보임',
  seen0.ok && seen0.data.length === 1,
  JSON.stringify(seen0.data.map((s) => s.order_index)))

await rpc('move_slide', { p_session_id: SESSION, p_delta: 1 }, ADMIN)
const seen1 = await rest('/slides?select=order_index&order=order_index', { token: P1 })
check('다음으로 넘기면 0,1 까지만 보임', seen1.data.length === 2,
  JSON.stringify(seen1.data.map((s) => s.order_index)))

/* --------------------------------------------------------- 6. 응답 */
console.log('\n[6] 응답')
const ans1 = await rpc('submit_response',
  { p_slide_id: slides[1].id, p_answer: { choice: '보통' } }, P1)
check('현재 문항에 응답', ans1.ok, ans1.ok ? '' : JSON.stringify(ans1.data))

const ans2 = await rpc('submit_response',
  { p_slide_id: slides[1].id, p_answer: { choice: '매우 그렇다' } }, P1)
check('진행 중 응답 변경 가능', ans2.ok, ans2.ok ? '' : JSON.stringify(ans2.data))

const mine = await rest(`/responses?select=answer&slide_id=eq.${slides[1].id}`, { token: P1 })
check('변경된 값이 저장됨', mine.data?.[0]?.answer?.choice === '매우 그렇다',
  JSON.stringify(mine.data))

const future = await rpc('submit_response',
  { p_slide_id: slides[3].id, p_answer: { text: '미리 답하기' } }, P1)
check('아직 안 나온 문항에는 응답 불가', !future.ok, `status ${future.status}`)

/* --------------------------------------------------- 6-2. 항목별 의견 */
const cmt = await rpc('submit_comment',
  { p_slide_id: slides[1].id, p_comment: '설명이 조금 헷갈렸습니다' }, P1)
check('의견 저장', cmt.ok, cmt.ok ? '' : JSON.stringify(cmt.data))

const withCmt = await rest(
  `/responses?select=answer,comment&slide_id=eq.${slides[1].id}`, { token: P1 })
check('의견이 응답을 지우지 않음',
  withCmt.data?.[0]?.comment === '설명이 조금 헷갈렸습니다' &&
  withCmt.data?.[0]?.answer?.choice === '매우 그렇다',
  JSON.stringify(withCmt.data))

const reAns = await rpc('submit_response',
  { p_slide_id: slides[1].id, p_answer: { choice: '보통' } }, P1)
const afterReAns = await rest(
  `/responses?select=answer,comment&slide_id=eq.${slides[1].id}`, { token: P1 })
check('응답을 바꿔도 의견이 남음',
  reAns.ok && afterReAns.data?.[0]?.comment === '설명이 조금 헷갈렸습니다' &&
  afterReAns.data?.[0]?.answer?.choice === '보통',
  JSON.stringify(afterReAns.data))

const blank = await rpc('submit_comment',
  { p_slide_id: slides[1].id, p_comment: '   ' }, P1)
const afterBlank = await rest(
  `/responses?select=comment&slide_id=eq.${slides[1].id}`, { token: P1 })
check('공백만 남기면 의견은 비워짐',
  blank.ok && afterBlank.data?.[0]?.comment === null,
  JSON.stringify(afterBlank.data))

await rpc('move_slide', { p_session_id: SESSION, p_delta: 1 }, ADMIN)
const past = await rpc('submit_response',
  { p_slide_id: slides[1].id, p_answer: { choice: '아니다' } }, P1)
check('지나간 문항은 수정 불가', !past.ok, `status ${past.status}`)

const pastCmt = await rpc('submit_comment',
  { p_slide_id: slides[1].id, p_comment: '뒤늦게 덧붙이기' }, P1)
check('지나간 문항에는 의견도 불가', !pastCmt.ok, `status ${pastCmt.status}`)

/* ------------------------------------------- 7. 다른 참가자 응답 격리 */
console.log('\n[7] 응답 격리')
const anon2 = await call('/auth/v1/signup', { method: 'POST', body: {} })
const P2 = anon2.data.access_token
await rpc('claim_participant', { p_login_id: 'tester02', p_passcode: 'pw2222' }, P2)
await rpc('submit_response', { p_slide_id: slides[2].id, p_answer: { choice: 'O' } }, P2)

// 안내 페이지(0번)는 지나갔으므로, 의견만 남기는 경우는 현재 항목에서 확인합니다.
const onlyCmt = await rpc('submit_comment',
  { p_slide_id: slides[2].id, p_comment: '답은 골랐고 의견도 남깁니다' }, P2)
check('답과 의견이 한 행에 함께 저장됨', onlyCmt.ok,
  onlyCmt.ok ? '' : JSON.stringify(onlyCmt.data))

const p1sees = await rest('/responses?select=participant_id', { token: P1 })
check('참가자는 남의 응답을 볼 수 없음', p1sees.ok && p1sees.data.length === 1,
  `본 행 수: ${p1sees.data?.length}`)

const adminSees = await rest(`/responses?select=answer&session_id=eq.${SESSION}`, { token: ADMIN })
check('관리자는 전체 응답을 볼 수 있음', adminSees.ok && adminSees.data.length === 2,
  `${adminSees.data?.length}건`)

/* --------------------------------------------------------- 8. 종료 */
console.log('\n[8] 종료 및 정리')
const end = await rpc('end_session', { p_session_id: SESSION }, ADMIN)
check('세션 종료', end.ok, end.ok ? '' : JSON.stringify(end.data))

const afterEnd = await rpc('submit_response',
  { p_slide_id: slides[2].id, p_answer: { choice: 'X' } }, P2)
check('종료 후에는 응답 불가', !afterEnd.ok, `status ${afterEnd.status}`)

const del = await rest(`/sessions?id=eq.${SESSION}`, { method: 'DELETE', token: ADMIN })
check('테스트 세션 삭제 (참가자·응답 연쇄 삭제)', del.ok, `status ${del.status}`)

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail > 0 ? 1 : 0)
