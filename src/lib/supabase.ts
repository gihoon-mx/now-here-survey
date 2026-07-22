import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_KEY

if (!url || !key) {
  throw new Error(
    'VITE_SUPABASE_URL / VITE_SUPABASE_KEY 가 설정되지 않았습니다. .env 파일을 확인하세요.',
  )
}

// 저장소 키는 고정합니다.
//
// 한때 주소(#/admin 인지)를 보고 관리자용/참가자용 저장소를 나눴는데,
// 그 판단이 "페이지가 처음 로드된 순간"에만 일어나는 것이 문제였습니다.
// 이미 열린 참가자 화면 뒤에 #/admin 을 붙이면 해시만 바뀌고 페이지는
// 다시 로드되지 않아, 관리자 로그인이 참가자용 저장소에 들어갑니다.
// 그러면 로그인은 된 것처럼 보이다가 새로고침하는 순간 풀려서, 무한
// 로그인 루프처럼 보입니다.
//
// 대신 한 브라우저에서 관리자와 참가자로 동시에 로그인할 수는 없습니다.
// 리허설할 때는 참가자 쪽을 시크릿 창으로 열면 됩니다.
export const supabase = createClient(url, key, {
  auth: {
    storageKey: 'nhs-auth',
    persistSession: true,
    autoRefreshToken: true,
  },
})
