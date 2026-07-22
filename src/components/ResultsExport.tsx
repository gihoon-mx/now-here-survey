import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildWorkbook, downloadWorkbook, safeFilename } from '../lib/excel'
import type { AdminParticipant, ResponseRow, Slide } from '../lib/types'

export default function ResultsExport({
  sessionId,
  sessionTitle,
}: {
  sessionId: string
  sessionTitle: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const exportNow = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      const [slidesRes, participantsRes, responsesRes] = await Promise.all([
        supabase.from('slides').select('*').eq('session_id', sessionId).order('order_index'),
        supabase.rpc('admin_list_participants', { p_session_id: sessionId }),
        supabase.from('responses').select('*').eq('session_id', sessionId),
      ])

      const failure =
        slidesRes.error ?? participantsRes.error ?? responsesRes.error
      if (failure) throw new Error(failure.message)

      const participants = (participantsRes.data as AdminParticipant[]) ?? []
      if (participants.length === 0)
        throw new Error('참가자가 없어 내려받을 결과가 없습니다.')

      const workbook = buildWorkbook({
        sessionTitle,
        slides: (slidesRes.data as Slide[]) ?? [],
        participants,
        responses: (responsesRes.data as ResponseRow[]) ?? [],
      })

      const stamp = new Date().toISOString().slice(0, 10)
      downloadWorkbook(workbook, `${safeFilename(sessionTitle)}_${stamp}.xlsx`)
      setNotice('내려받기를 시작했습니다.')
    } catch (err) {
      setError(err instanceof Error ? err.message : '내보내기에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2>결과 내보내기</h2>
      <p className="muted">
        시트 세 장이 담긴 엑셀 파일을 만듭니다.
      </p>
      <ul className="muted bullets">
        <li>
          <strong>응답(가로)</strong> — 행이 참가자, 열이 문항. 훑어보기 좋은 형태
        </li>
        <li>
          <strong>응답(세로)</strong> — 한 응답이 한 행. 피벗·집계용
        </li>
        <li>
          <strong>문항</strong> — 문항 정의 백업
        </li>
      </ul>
      <p className="muted">
        진행 중에도 내려받을 수 있지만, 보통은 종료 후에 받습니다.
      </p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <button className="btn btn--primary" disabled={busy} onClick={exportNow}>
        {busy ? '만드는 중…' : '엑셀로 내려받기'}
      </button>
    </div>
  )
}
