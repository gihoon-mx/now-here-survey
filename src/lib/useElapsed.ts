import { useEffect, useState } from 'react'

/**
 * 서버가 찍어준 시각(ISO 문자열)으로부터 흐른 시간을 초 단위로 돌려줍니다.
 *
 * 기준점이 항상 서버 시각이라 모든 기기가 같은 숫자를 봅니다.
 * (각자 로컬 시계로 세면 폰마다 값이 어긋납니다.)
 */
export function useElapsedSeconds(since: string | null | undefined): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!since) return 0
  return Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000))
}

/** 초를 m:ss 로 표시합니다. 한 시간이 넘어가면 h:mm:ss. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`
}
