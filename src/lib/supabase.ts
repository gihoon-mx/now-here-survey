import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_KEY

if (!url || !key) {
  throw new Error(
    'VITE_SUPABASE_URL / VITE_SUPABASE_KEY 가 설정되지 않았습니다. .env 파일을 확인하세요.',
  )
}

// 관리자 화면과 참가자 화면이 같은 브라우저에서 열릴 수 있습니다 (리허설/테스트).
// 저장소 키를 분리해 두면 한쪽 로그인이 다른 쪽을 밀어내지 않습니다.
const isAdminSurface =
  location.hash.startsWith('#/admin') || location.hash.startsWith('#/present')

export const supabase = createClient(url, key, {
  auth: {
    storageKey: isAdminSurface ? 'nhs-admin-auth' : 'nhs-participant-auth',
    persistSession: true,
    autoRefreshToken: true,
  },
})
