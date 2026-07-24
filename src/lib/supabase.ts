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

/**
 * PostgREST 는 한 번에 최대 1000행만 돌려줍니다. 응답이 이 수를 넘으면
 * (세션이 여러 개거나 문항이 많으면 금방 넘습니다) 뒤쪽이 조용히 잘려,
 * 전체 결과에서 일부 세션 응답이 통째로 빠지는 것처럼 보입니다.
 *
 * 이 헬퍼는 range 로 페이지를 넘기며 전량을 모아 옵니다. build 는 매
 * 페이지마다 같은 필터가 걸린 새 쿼리를 만들어 돌려주는 함수입니다.
 */
export async function fetchAllRows<T>(
  build: () => {
    range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
  },
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < pageSize) break
  }
  return all
}
