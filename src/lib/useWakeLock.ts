import { useEffect } from 'react'

/**
 * 진행 중에 화면이 저절로 꺼지지 않게 합니다.
 * 관리자 폰에서 특히 중요합니다 — next 를 누르려 할 때마다
 * 잠금을 풀어야 하면 진행이 끊깁니다.
 *
 * 지원하지 않는 브라우저(주로 iOS 구버전)에서는 조용히 무시됩니다.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return

    let sentinel: WakeLockSentinel | null = null
    let cancelled = false

    const request = async () => {
      try {
        sentinel = await navigator.wakeLock.request('screen')
      } catch {
        // 배터리 절약 모드 등으로 거부될 수 있습니다. 기능 저하일 뿐이라 무시합니다.
      }
    }

    void request()

    // 탭을 벗어났다 돌아오면 잠금이 해제되어 있으므로 다시 요청합니다.
    const onVisible = () => {
      if (!cancelled && document.visibilityState === 'visible') void request()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void sentinel?.release().catch(() => {})
    }
  }, [active])
}
