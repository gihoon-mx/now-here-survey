/**
 * Realtime 동기화 테스트.
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run realtime
 *
 * 관리자가 슬라이드를 넘겼을 때 참가자 쪽이 실제로 통보를 받는지 확인합니다.
 * 이 경로는 HTTP 요청만으로는 검증할 수 없어 스모크 테스트와 분리했습니다.
 *
 * 참가자 클라이언트는 앱과 똑같이 익명 로그인 + claim 을 거친 뒤 구독하므로,
 * Realtime 이 RLS 를 제대로 통과하는지까지 함께 확인됩니다.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

// 관리자 계정은 .env.local 에 넣어 두면 매번 환경변수로 넘기지 않아도 됩니다.
try {
  for (const line of readFileSync(join(root, '.env.local'), 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i > 0) env[t.slice(0, i).trim()] ??= t.slice(i + 1).trim()
  }
} catch { /* .env.local 이 없으면 환경변수만 씁니다 */ }

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? env.ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD
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

// Node 에는 localStorage 가 없으므로 세션을 메모리에만 둡니다.
const mkClient = () =>
  createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

const admin = mkClient()
const participant = mkClient()

console.log('\n[1] 준비')
const { error: loginErr } = await admin.auth.signInWithPassword({
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
})
check('관리자 로그인', !loginErr, loginErr?.message ?? '')
if (loginErr) process.exit(1)

await admin.from('surveys').delete().like('title', '[realtime테스트]%')

const { data: survey } = await admin
  .from('surveys')
  .insert({ title: '[realtime테스트] 삭제해도 됩니다' })
  .select()
  .single()

const { data: session } = await admin
  .from('sessions')
  .insert({ survey_id: survey.id, name: '1회차' })
  .select()
  .single()

// 진행 단위는 페이지이므로 페이지 2개를 만들고 문항을 하나씩 붙입니다.
// PostgREST 는 배열 insert 시 모든 객체의 키 구성이 같아야 합니다.
// (키가 어긋나면 통째로 거부되는데, 에러를 안 보면 페이지가 하나도 없는
//  세션으로 조용히 테스트가 진행되어 버립니다.)
const { data: pageRows, error: pagesErr } = await admin
  .from('pages')
  .insert([
    { survey_id: survey.id, order_index: 0 },
    { survey_id: survey.id, order_index: 1 },
  ])
  .select()
check('페이지 2개 생성', !pagesErr, pagesErr?.message ?? '')
const pagesSorted = (pageRows ?? []).sort((a, b) => a.order_index - b.order_index)

const { error: slidesErr } = await admin.from('slides').insert([
  { survey_id: survey.id, page_id: pagesSorted[0]?.id, order_index: 0, type: 'info', title: '첫 항목',    options: [] },
  { survey_id: survey.id, page_id: pagesSorted[1]?.id, order_index: 0, type: 'ox',   title: '두번째 항목', options: ['O', 'X'] },
])
check('슬라이드 2개 생성', !slidesErr, slidesErr?.message ?? '')

const { count: slideCount } = await admin
  .from('slides')
  .select('id', { count: 'exact', head: true })
  .eq('survey_id', survey.id)
check('슬라이드가 실제로 저장됨', slideCount === 2, `${slideCount}개`)

const { error: partErr } = await admin.from('participants').insert({
  session_id: session.id,
  login_id: 'rt01',
  passcode: 'rtpw',
  display_name: '리얼타임테스터',
})
check('참가자 등록', !partErr, partErr?.message ?? '')

const { error: anonErr } = await participant.auth.signInAnonymously()
check('참가자 익명 로그인', !anonErr, anonErr?.message ?? '')

const { error: claimErr } = await participant.rpc('claim_participant', {
  p_login_id: 'rt01',
  p_passcode: 'rtpw',
})
check('참가자 입장', !claimErr, claimErr?.message ?? '')

/* ------------------------------------------------------------- 구독 */
console.log('\n[2] 구독')

const events = []
let subscribed = false

const channel = participant
  .channel(`session:${session.id}`)
  .on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'sessions',
      filter: `id=eq.${session.id}`,
    },
    (payload) => events.push({ at: Date.now(), row: payload.new }),
  )
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') subscribed = true
  })

const waitFor = async (predicate, timeoutMs) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return Date.now() - start
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

const subMs = await waitFor(() => subscribed, 15000)
check('Realtime 채널 연결', subMs !== null, subMs !== null ? `${subMs}ms` : '타임아웃')

// SUBSCRIBED 보고와 서버 쪽 복제 구독이 실제로 붙는 시점 사이에는 짧은 틈이
// 있어, 그 사이의 변경은 통보되지 않습니다. 앱은 이 구간을 useLiveSession 의
// "구독 직후 재조회 + 주기적 재조회"로 메웁니다. 여기서는 Realtime 전달 자체를
// 보려는 것이므로 틈이 지나가길 기다린 뒤 측정합니다.
await new Promise((r) => setTimeout(r, 3000))

/* --------------------------------------------------------- 진행 통보 */
console.log('\n[3] 진행 통보')

/**
 * "상태가 조건을 만족하는가" 대신 "이 동작 뒤에 새 이벤트가 왔고 그 내용이
 * 맞는가"를 봅니다. 상태만 보면 이전부터 이미 만족하던 조건에 걸려 통보가
 * 오지 않았는데도 통과해 버립니다.
 */
const expectEvent = async (label, action, predicate, timeoutMs = 10000) => {
  const before = events.length
  const started = Date.now()
  await action()
  const waited = await waitFor(
    () => events.length > before && predicate(events.at(-1).row),
    timeoutMs,
  )
  check(label, waited !== null,
    waited !== null ? `${Date.now() - started}ms` : '타임아웃')
}

await expectEvent(
  '세션 시작이 참가자에게 전달됨',
  () => admin.rpc('start_session', { p_session_id: session.id }),
  (row) => row.status === 'live' && row.current_page_index === 0,
)

await expectEvent(
  '다음 페이지 이동이 전달됨',
  () => admin.rpc('move_page', { p_session_id: session.id, p_delta: 1 }),
  (row) => row.current_page_index === 1,
)

await expectEvent(
  '이전으로 돌아가기도 전달됨',
  () => admin.rpc('move_page', { p_session_id: session.id, p_delta: -1 }),
  (row) => row.current_page_index === 0,
)

await expectEvent(
  '종료가 전달됨',
  () => admin.rpc('end_session', { p_session_id: session.id }),
  (row) => row.status === 'ended',
)

// 페이지마다 서버가 시각을 다시 찍는지 (경과 시간 표시의 근거)
const stamps = new Set(events.map((e) => e.row.current_page_started_at))
check('페이지마다 서버 시각이 갱신됨', stamps.size >= 3, `서로 다른 시각 ${stamps.size}개`)

/* ------------------------------------------------------------- 정리 */
console.log('\n[4] 정리')
await participant.removeChannel(channel)
const { error: delErr } = await admin.from('surveys').delete().eq('id', survey.id)
check('테스트 세션 삭제', !delErr, delErr?.message ?? '')

console.log(`\n받은 이벤트 ${events.length}건`)
const t0 = events[0]?.at ?? Date.now()
for (const e of events) {
  console.log(
    `  +${String(e.at - t0).padStart(6)}ms  status=${e.row.status} page=${e.row.current_page_index}`,
  )
}
console.log(`===== ${pass} passed, ${fail} failed =====`)
process.exit(fail > 0 ? 1 : 0)
