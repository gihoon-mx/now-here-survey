/**
 * supabase/schema.sql 을 Supabase Management API 로 실행합니다.
 *
 *   npm run apply-schema
 *
 * SQL Editor 에 붙여넣는 것과 같은 일을 명령 한 번으로 합니다.
 * 스키마는 재실행해도 안전하게 작성되어 있으므로, 스키마를 고친 뒤에는
 * 이걸 돌리고 이어서 `npm run smoke` 로 확인하면 됩니다.
 *
 * 토큰은 .env.local 의 SUPABASE_ACCESS_TOKEN 에서 읽습니다 (커밋 금지 파일).
 * https://supabase.com/dashboard/account/tokens 에서 발급합니다.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** .env 와 .env.local 을 순서대로 읽어 합칩니다 (.env.local 이 우선). */
function readEnvFiles() {
  const merged = {}
  for (const name of ['.env', '.env.local']) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const i = trimmed.indexOf('=')
      if (i < 0) continue
      merged[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim()
    }
  }
  return merged
}

const env = readEnvFiles()
const token = process.env.SUPABASE_ACCESS_TOKEN ?? env.SUPABASE_ACCESS_TOKEN

if (!token) {
  console.error(
    'SUPABASE_ACCESS_TOKEN 이 없습니다.\n' +
      '.env.local 에 SUPABASE_ACCESS_TOKEN=sbp_... 를 넣어 주세요.\n' +
      '(발급: https://supabase.com/dashboard/account/tokens)',
  )
  process.exit(1)
}

// 프로젝트 ref 는 .env 의 URL 에서 꺼냅니다 — 두 곳에 따로 적어 두면 어긋납니다.
const ref = env.VITE_SUPABASE_URL?.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1]
if (!ref) {
  console.error('.env 의 VITE_SUPABASE_URL 에서 프로젝트 ref 를 찾지 못했습니다.')
  process.exit(1)
}

const sql = readFileSync(join(root, 'supabase', 'schema.sql'), 'utf8')

console.log(`프로젝트 ${ref} 에 supabase/schema.sql (${sql.length}자) 을 적용합니다…`)

const res = await fetch(
  `https://api.supabase.com/v1/projects/${ref}/database/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  },
)

const text = await res.text()

if (!res.ok) {
  console.error(`실패 (HTTP ${res.status}):\n${text}`)
  process.exit(1)
}

console.log('적용 완료.')
console.log('이어서 확인: ADMIN_EMAIL/ADMIN_PASSWORD 설정 후 npm run smoke')
