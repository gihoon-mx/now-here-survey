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
      .subscribe((status) => {
        // SUBSCRIBED 가 보고된 시점과 서버 쪽 복제 구독이 실제로 붙는 시점
        // 사이에 짧은 틈이 있어, 그 사이에 일어난 변경은 통보되지 않습니다.
        // 붙은 직후 한 번 읽어 그 틈을 메웁니다. (늦게 합류하거나 재접속한
        // 참가자가 바로 이 구간에 걸립니다.)
        if (status === 'SUBSCRIBED') void refetch()
      })

    const onWake = () => {
      if (document.visibilityState === 'visible') void refetch()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', onWake)

    // 안전망. 현장 와이파이에서는 Realtime 이벤트가 조용히 유실될 수 있는데,
    // 참가자 화면이 멈춘 채로 남는 것이 이 앱에서 제일 나쁜 실패입니다.
    // 30명이 10초 간격으로 읽어도 초당 3건이라 부하는 문제되지 않습니다.
    const poll = setInterval(() => void refetch(), 10000)

    return () => {
      clearInterval(poll)
      void supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('online', onWake)
    }
  }, [sessionId, refetch])

  return { session, loading, refetch }
}
