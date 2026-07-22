/**
 * 여러 설문을 하루에 나눠 진행하는 상황 점검.
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run multi
 *
 * 같은 아이디 체계를 여러 설문에 재사용했을 때, 참가자가 엉뚱한 설문에
 * 들어가지 않는지 확인합니다. 오전·오후로 나눠 진행하면서 명단을 복사해
 * 쓰면 실제로 생기는 상황입니다.
 *
 * 잘못된 방에 들어가면 응답이 엉뚱한 곳에 쌓이는데, 진행 중에는 알아채기
 * 어렵고 끝난 뒤에는 되돌릴 수 없습니다.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const U = env.VITE_SUPABASE_URL
const K = env.VITE_SUPABASE_KEY
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

async function call(path, { method = 'GET', token, body, prefer } = {}) {
  const headers = {
    apikey: K,
    Authorization: `Bearer ${token ?? K}`,
    'Content-Type': 'application/json',
  }
  if (prefer) headers.Prefer = prefer
  const r = await fetch(U + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { ok: r.ok, status: r.status, data }
}

const rest = (p, o) => call('/rest/v1' + p, o)
const rpc = (fn, args, token) =>
  call('/rest/v1/rpc/' + fn, { method: 'POST', token, body: args })

const login = await call('/auth/v1/token?grant_type=password', {
  method: 'POST',
  body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
})
if (!login.ok) {
  console.error('관리자 로그인 실패')
  process.exit(1)
}
const ADMIN = login.data.access_token

console.log('\n[준비] 같은 아이디 체계를 쓰는 설문 3개')
await rest('/sessions?title=like.%5B회차테스트%5D*', { method: 'DELETE', token: ADMIN })

const sessions = []
for (const name of ['오전', '오후1', '오후2']) {
  const s = await rest('/sessions', {
    method: 'POST', token: ADMIN, prefer: 'return=representation',
    body: { title: `[회차테스트] ${name}` },
  })
  const id = s.data[0].id
  await rest('/slides', {
    method: 'POST', token: ADMIN, prefer: 'return=minimal',
    body: [{
      session_id: id, order_index: 0, type: 'choice',
      title: `${name} 문항`, options: [{ label: 'A' }, { label: 'B' }], multi: false,
    }],
  })
  // 세 설문 모두 같은 아이디/비밀번호를 씁니다 (명단을 복사해 쓰는 상황).
  await rest('/participants', {
    method: 'POST', token: ADMIN, prefer: 'return=minimal',
    body: [{
      session_id: id, login_id: 'user01', passcode: '1234',
      display_name: `${name} 참가자`,
    }],
  })
  sessions.push({ name, id })
}
check('설문 3개 생성 (모두 user01/1234)', sessions.length === 3)

const anon = async () => {
  const r = await call('/auth/v1/signup', { method: 'POST', body: {} })
  return r.data.access_token
}

/* ----------------------------------------------- 1. 전부 준비 중일 때 */
console.log('\n[1] 아직 아무 설문도 시작 전')
const t1 = await anon()
const r1 = await rpc('claim_participant', { p_login_id: 'user01', p_passcode: '1234' }, t1)
check('여러 설문에 걸치면 입장을 거부',
  !r1.ok && String(r1.data?.message ?? '').includes('여러 설문'),
  r1.ok ? '들어가졌음 (위험)' : r1.data?.message)

/* ------------------------------------------- 2. 한 설문만 진행 중일 때 */
console.log('\n[2] 오전 설문만 진행 중')
await rpc('start_session', { p_session_id: sessions[0].id }, ADMIN)

const t2 = await anon()
const r2 = await rpc('claim_participant', { p_login_id: 'user01', p_passcode: '1234' }, t2)
check('진행 중인 설문으로 들어감', r2.ok, r2.ok ? '' : JSON.stringify(r2.data))
check('오전 설문이 맞음',
  r2.data?.[0]?.session_id === sessions[0].id,
  r2.data?.[0]?.session_title)

/* ------------------------------------- 3. 회차가 바뀌면 그쪽으로 들어감 */
console.log('\n[3] 오전 종료 → 오후1 시작')
await rpc('end_session', { p_session_id: sessions[0].id }, ADMIN)
await rpc('start_session', { p_session_id: sessions[1].id }, ADMIN)

const t3 = await anon()
const r3 = await rpc('claim_participant', { p_login_id: 'user01', p_passcode: '1234' }, t3)
check('이번에는 오후1 설문으로 들어감',
  r3.ok && r3.data?.[0]?.session_id === sessions[1].id,
  r3.data?.[0]?.session_title)

/* ----------------------------------------- 4. 두 설문이 동시에 진행 중 */
console.log('\n[4] 실수로 두 설문이 동시에 진행 중')
await rpc('start_session', { p_session_id: sessions[2].id }, ADMIN)

const t4 = await anon()
const r4 = await rpc('claim_participant', { p_login_id: 'user01', p_passcode: '1234' }, t4)
check('어느 쪽인지 모르면 조용히 넣지 않고 실패',
  !r4.ok && String(r4.data?.message ?? '').includes('여러 설문'),
  r4.ok ? '들어가졌음 (위험)' : r4.data?.message)

/* --------------------------------- 5. 아이디를 회차별로 나눈 경우 (권장) */
console.log('\n[5] 회차별로 아이디를 나눈 경우 (권장 방식)')
await rest('/participants', {
  method: 'POST', token: ADMIN, prefer: 'return=minimal',
  body: [
    { session_id: sessions[0].id, login_id: 'am01', passcode: '1234', display_name: '오전 A' },
    { session_id: sessions[2].id, login_id: 'pm01', passcode: '1234', display_name: '오후 A' },
  ],
})

const t5 = await anon()
const r5 = await rpc('claim_participant', { p_login_id: 'pm01', p_passcode: '1234' }, t5)
check('아이디가 갈리면 동시 진행 중이어도 정확히 들어감',
  r5.ok && r5.data?.[0]?.session_id === sessions[2].id,
  r5.data?.[0]?.session_title)

const t6 = await anon()
const r6 = await rpc('claim_participant', { p_login_id: 'am01', p_passcode: '1234' }, t6)
check('다른 회차 아이디도 각자 제 설문으로',
  r6.ok && r6.data?.[0]?.session_id === sessions[0].id,
  r6.data?.[0]?.session_title)

console.log('\n[정리]')
for (const s of sessions) {
  await rest(`/sessions?id=eq.${s.id}`, { method: 'DELETE', token: ADMIN })
}
console.log('  테스트 설문 삭제 완료')

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail > 0 ? 1 : 0)
