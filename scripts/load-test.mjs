/**
 * 동시 접속 부하 테스트.
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run loadtest
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run loadtest -- --participants 40 --slides 6
 *
 * 가상 참가자 N 명을 동시에 접속시켜 실제 진행과 같은 순서로 돌립니다.
 * 임시 세션과 임시 참가자를 직접 만들고 끝나면 지우므로, 실제 설문에는
 * 영향이 없습니다. 항목을 다 만들기 전에도 돌릴 수 있습니다.
 *
 * ─ 알 수 있는 것 ─
 *   Supabase 가 동시 접속을 감당하는지, 관리자가 넘겼을 때 전원에게 도달하는
 *   데 걸리는 시간, 동시에 응답이 몰릴 때의 지연과 실패율.
 *
 * ─ 알 수 없는 것 ─
 *   행사장 와이파이. 이 스크립트는 컴퓨터 한 대에서 돌기 때문에, 서로 다른
 *   폰 30 대가 혼잡한 AP 를 나눠 쓰는 상황은 재현되지 않습니다. 현장의 실제
 *   위험은 대부분 그쪽이므로, 이 테스트가 통과했다고 안심하면 안 됩니다.
 *
 * ⚠️ 익명 로그인은 IP 당 시간당 한도가 있습니다(현재 200). 참가자 수만큼
 *    로그인을 소모하므로, 30명으로 돌리면 시간당 6번 정도가 한계입니다.
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

const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL 과 ADMIN_PASSWORD 환경변수가 필요합니다.')
  process.exit(1)
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const PARTICIPANTS = arg('participants', 30)
const SLIDES = arg('slides', 5)

const mkClient = () =>
  createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 정렬된 배열에서 백분위 값을 꺼냅니다. */
const pct = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]

function report(label, values, unit = 'ms') {
  const ok = values.filter((v) => typeof v === 'number').sort((a, b) => a - b)
  const missing = values.length - ok.length
  if (ok.length === 0) {
    console.log(`  ${label.padEnd(22)} 측정값 없음 (${missing}건 실패)`)
    return
  }
  console.log(
    `  ${label.padEnd(22)} p50 ${String(pct(ok, 50)).padStart(5)}${unit}` +
      `  p95 ${String(pct(ok, 95)).padStart(5)}${unit}` +
      `  최대 ${String(ok.at(-1)).padStart(5)}${unit}` +
      (missing > 0 ? `   ⚠️ 누락 ${missing}건` : ''),
  )
}

console.log(`\n가상 참가자 ${PARTICIPANTS}명 · 문항 ${SLIDES}개로 진행합니다.`)
console.log('임시 세션을 만들어 돌리고 끝나면 지웁니다.\n')

/* ------------------------------------------------------------- 준비 */
const admin = mkClient()
const { error: loginErr } = await admin.auth.signInWithPassword({
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
})
if (loginErr) {
  console.error('관리자 로그인 실패:', loginErr.message)
  process.exit(1)
}

await admin.from('sessions').delete().like('title', '[부하테스트]%')

const { data: session, error: sErr } = await admin
  .from('sessions')
  .insert({ title: `[부하테스트] ${new Date().toISOString().slice(0, 16)}` })
  .select()
  .single()
if (sErr) {
  console.error('세션 생성 실패:', sErr.message)
  process.exit(1)
}

await admin.from('slides').insert(
  Array.from({ length: SLIDES }, (_, i) => ({
    session_id: session.id,
    order_index: i,
    type: 'choice',
    title: `부하테스트 문항 ${i + 1}`,
    body: null,
    options: [{ label: '보기 A' }, { label: '보기 B' }, { label: '보기 C' }],
    multi: false,
  })),
)

const { data: slides } = await admin
  .from('slides')
  .select('id, order_index')
  .eq('session_id', session.id)
  .order('order_index')

await admin.from('participants').insert(
  Array.from({ length: PARTICIPANTS }, (_, i) => ({
    session_id: session.id,
    login_id: `load${String(i).padStart(3, '0')}`,
    passcode: 'loadpw',
    display_name: `가상참가자${i + 1}`,
  })),
)

const cleanup = async () => {
  await admin.from('sessions').delete().eq('id', session.id)
}
process.on('SIGINT', async () => {
  await cleanup()
  process.exit(130)
})

/* ------------------------------------------------- 1. 동시 접속 */
console.log('[1] 동시 접속 (익명 로그인 → 입장 → 구독)')

const t0 = Date.now()
const clients = await Promise.all(
  Array.from({ length: PARTICIPANTS }, async (_, i) => {
    const c = mkClient()
    const state = { i, client: c, events: [], errors: [], loginMs: null, claimMs: null, subMs: null }

    const a = Date.now()
    const { error: anonErr } = await c.auth.signInAnonymously()
    if (anonErr) {
      state.errors.push(`로그인: ${anonErr.message}`)
      return state
    }
    state.loginMs = Date.now() - a

    const b = Date.now()
    const { error: claimErr } = await c.rpc('claim_participant', {
      p_login_id: `load${String(i).padStart(3, '0')}`,
      p_passcode: 'loadpw',
    })
    if (claimErr) {
      state.errors.push(`입장: ${claimErr.message}`)
      return state
    }
    state.claimMs = Date.now() - b

    const d = Date.now()
    await new Promise((resolve) => {
      const ch = c
        .channel(`session:${session.id}:${i}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${session.id}` },
          (payload) => state.events.push({ at: Date.now(), row: payload.new }),
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            state.subMs = Date.now() - d
            resolve()
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            state.errors.push(`구독: ${status}`)
            resolve()
          }
        })
      state.channel = ch
    })
    return state
  }),
)

const connected = clients.filter((c) => c.subMs !== null)
console.log(`  전원 접속까지: ${((Date.now() - t0) / 1000).toFixed(1)}초`)
console.log(`  성공 ${connected.length} / ${PARTICIPANTS}`)
report('익명 로그인', clients.map((c) => c.loginMs))
report('입장(claim)', clients.map((c) => c.claimMs))
report('Realtime 구독', clients.map((c) => c.subMs))

const failed = clients.filter((c) => c.errors.length > 0)
if (failed.length > 0) {
  console.log(`\n  ⚠️ 실패 ${failed.length}건:`)
  const grouped = {}
  for (const c of failed) for (const e of c.errors) grouped[e] = (grouped[e] ?? 0) + 1
  for (const [msg, n] of Object.entries(grouped)) console.log(`     ${n}회  ${msg}`)
}

// 구독 직후의 틈이 지나가길 기다립니다 (앱은 재조회로 메웁니다).
await wait(3000)

/* --------------------------------------------- 2. 진행 통보 도달 */
console.log('\n[2] 진행 통보 도달 (관리자가 넘김 → 전원 수신)')

const broadcastLatencies = []
for (const c of connected) c.events.length = 0

const sentAt = Date.now()
await admin.rpc('start_session', { p_session_id: session.id })
await wait(4000)

const missedStart = []
for (const c of connected) {
  const hit = c.events.find((e) => e.row.status === 'live')
  broadcastLatencies.push(hit ? hit.at - sentAt : undefined)
  if (!hit) missedStart.push(c)
}
report('세션 시작 도달', broadcastLatencies)

/*
 * Realtime 이벤트를 놓친 참가자가 정말 멈춰 버리는지 확인합니다.
 *
 * 앱은 이벤트에만 기대지 않고 주기적으로 상태를 다시 읽습니다. 여기서도
 * 같은 방식으로 직접 조회해, 놓친 사람이 결국 따라잡는지를 봅니다.
 * "몇 명이 이벤트를 놓쳤나"보다 "결국 아무도 멈추지 않는가"가 현장에서
 * 중요한 질문입니다.
 */
let recovered = 0
for (const c of missedStart) {
  const { data } = await c.client
    .from('sessions')
    .select('status')
    .eq('id', session.id)
    .maybeSingle()
  if (data?.status === 'live') recovered++
}
if (missedStart.length > 0) {
  console.log(
    `  이벤트를 놓친 ${missedStart.length}명 중 ${recovered}명이 재조회로 따라잡음` +
      (recovered === missedStart.length ? '  ✓' : '  ⚠️ 따라잡지 못한 인원 있음'),
  )
}

/* ------------------------------------------ 3. 동시 응답 + 이동 */
console.log('\n[3] 문항별 동시 응답 + 다음 항목 이동')

const submitLatencies = []
const moveLatencies = []
const submitErrors = []

for (let s = 0; s < slides.length; s++) {
  // 전원이 같은 순간에 응답을 던집니다 (현장에서 제일 몰리는 순간).
  const results = await Promise.all(
    connected.map(async (c) => {
      const a = Date.now()
      const { error } = await c.client.rpc('submit_response', {
        p_slide_id: slides[s].id,
        p_answer: { choice: '보기 A' },
      })
      if (error) {
        submitErrors.push(error.message)
        return undefined
      }
      return Date.now() - a
    }),
  )
  submitLatencies.push(...results)

  if (s < slides.length - 1) {
    for (const c of connected) c.events.length = 0
    const moveAt = Date.now()
    await admin.rpc('move_slide', { p_session_id: session.id, p_delta: 1 })
    await wait(3000)
    for (const c of connected) {
      const hit = c.events.find((e) => e.row.current_slide_index === s + 1)
      moveLatencies.push(hit ? hit.at - moveAt : undefined)
    }
  }
}

report('응답 저장', submitLatencies)
report('다음 항목 도달', moveLatencies)

if (submitErrors.length > 0) {
  console.log(`\n  ⚠️ 응답 실패 ${submitErrors.length}건:`)
  const grouped = {}
  for (const e of submitErrors) grouped[e] = (grouped[e] ?? 0) + 1
  for (const [msg, n] of Object.entries(grouped)) console.log(`     ${n}회  ${msg}`)
}

/* ----------------------------------------------------- 4. 확인 */
console.log('\n[4] 저장 결과 확인')

const { count: saved } = await admin
  .from('responses')
  .select('id', { count: 'exact', head: true })
  .eq('session_id', session.id)
  .not('answer', 'is', null)

const expected = connected.length * slides.length
console.log(`  저장된 응답 ${saved} / 예상 ${expected}` +
  (saved === expected ? '  ✓' : '  ⚠️ 누락'))

/* ----------------------------------------------------- 정리 */
console.log('\n[5] 정리')
for (const c of clients) {
  if (c.channel) await c.client.removeChannel(c.channel)
  await c.client.auth.signOut().catch(() => {})
}
await cleanup()
console.log('  임시 세션 삭제 완료')

/*
 * 판정 기준.
 *
 * Realtime 이벤트 유실 자체는 실패로 보지 않습니다 — 앱이 재조회로 메우도록
 * 설계되어 있기 때문입니다. 다만 "놓쳤는데 재조회로도 못 따라잡는" 경우는
 * 참가자 화면이 멈춘다는 뜻이라 실패입니다.
 */
const stranded = missedStart.length - recovered
const allGood =
  connected.length === PARTICIPANTS &&
  submitErrors.length === 0 &&
  saved === expected &&
  stranded === 0

console.log(`\n===== ${allGood ? '이상 없음' : '확인 필요 — 위 경고를 보세요'} =====\n`)

if (missedStart.length > 0) {
  const rate = Math.round((missedStart.length / connected.length) * 100)
  console.log(
    `Realtime 유실 ${missedStart.length}/${connected.length}명 (${rate}%) — 전원 재조회로 복구.\n` +
      '구독 직후 짧은 구간에서 나타나며, 사람이 많을수록 잦아집니다.\n' +
      '앱은 구독 직후와 그 뒤 몇 초간 다시 읽어 이 구간을 메웁니다.\n',
  )
}
console.log('참고: 이 결과는 Supabase 쪽 용량만 말해 줍니다.')
console.log('행사장 와이파이는 재현되지 않으므로, 현장 리허설을 대신하지 못합니다.\n')
process.exit(allGood ? 0 : 1)
