import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { Session } from './types'

/**
 * 세션 한 건을 실시간으로 따라갑니다.
 *
 * 관리자가 next 를 누르면 sessions 행이 갱신되고, Realtime 이 그 변경을
 * 모든 화면(참가자 폰 / 프리젠테이션 화면 / 관리자 폰)에 밀어줍니다.
 *
 * 현장 와이파이가 잠깐 끊기면 Realtime 이벤트를 놓칠 수 있으므로,
 * 탭이 다시 보이거나 네트워크가 복구되면 한 번 더 직접 읽어옵니다.
 */
export function useLiveSession(sessionId: string | null) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    if (!sessionId) return
    const { data } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .maybeSingle()
    if (data) setSession(data as Session)
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) {
      setSession(null)
      setLoading(false)
      return
    }

    setLoading(true)
    void refetch()

    const channel = supabase
      .channel(`session:${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'sessions',
          filter: `id=eq.${sessionId}`,
        },
        (payload) => setSession(payload.new as Session),
      )
      .subscribe()

    const onWake = () => {
      if (document.visibilityState === 'visible') void refetch()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', onWake)

    return () => {
      void supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('online', onWake)
    }
  }, [sessionId, refetch])

  return { session, loading, refetch }
}
