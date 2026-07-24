import { useState } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import { buildWorkbook, downloadWorkbook, safeFilename } from '../lib/excel'
import type { AdminParticipant, Page, ResponseRow, Slide } from '../lib/types'

export type ExportScope =
  | { kind: 'survey' }
  | { kind: 'session'; sessionId: string; sessionName: string }

export default function ResultsExport({
  surveyId,
  surveyTitle,
  scope,
}: {
  surveyId: string
  surveyTitle: string
  scope: ExportScope
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const isSurvey = scope.kind === 'survey'

  const exportNow = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      // 페이지·문항은 설문에 붙어 있으므로 두 경우 모두 같습니다.
      const [pagesRes, slidesRes] = await Promise.all([
        supabase.from('pages').select('*').eq('survey_id', surveyId).order('order_index'),
        supabase.from('slides').select('*').eq('survey_id', surveyId).order('order_index'),
      ])
      if (pagesRes.error) throw new Error(pagesRes.error.message)
      if (slidesRes.error) throw new Error(slidesRes.error.message)

      let participants: AdminParticipant[]
      let responses: ResponseRow[]

      if (isSurvey) {
        // 설문 전체 — 모든 세션의 참가자와 응답을 한 파일에 담습니다.
        // 응답은 1000행을 넘을 수 있으므로 전량을 페이지로 넘겨 가져옵니다.
        const [pRes, rRows] = await Promise.all([
          supabase.rpc('admin_survey_participants', { p_survey_id: surveyId }),
          fetchAllRows<ResponseRow>(() =>
            supabase
              .from('responses')
              .select('*, sessions!inner(survey_id)')
              .eq('sessions.survey_id', surveyId),
          ),
        ])
        if (pRes.error) throw new Error(pRes.error.message)
        participants = (pRes.data as AdminParticipant[]) ?? []
        responses = rRows
      } else {
        const [pRes, rRows] = await Promise.all([
          supabase.rpc('admin_list_participants', { p_session_id: scope.sessionId }),
          fetchAllRows<ResponseRow>(() =>
            supabase.from('responses').select('*').eq('session_id', scope.sessionId),
          ),
        ])
        if (pRes.error) throw new Error(pRes.error.message)
        participants = ((pRes.data as AdminParticipant[]) ?? []).map((p) => ({
          ...p,
          session_name: scope.sessionName,
        }))
        responses = rRows
      }

      if (participants.length === 0)
        throw new Error('참가자가 없어 내려받을 결과가 없습니다.')

      const workbook = buildWorkbook({
        pages: (pagesRes.data as Page[]) ?? [],
        slides: (slidesRes.data as Slide[]) ?? [],
        participants,
        responses,
        // 세션이 여럿 섞이는 전체 내보내기에서만 세션 열을 넣습니다.
        includeSession: isSurvey,
      })

      const stamp = new Date().toISOString().slice(0, 10)
      const name = isSurvey
        ? `${safeFilename(surveyTitle)}_전체_${stamp}.xlsx`
        : `${safeFilename(surveyTitle)}_${safeFilename(scope.sessionName)}_${stamp}.xlsx`

      downloadWorkbook(workbook, name)
      setNotice('내려받기를 시작했습니다.')
    } catch (err) {
      setError(err instanceof Error ? err.message : '내보내기에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2>{isSurvey ? '전체 결과 내보내기' : '이 세션 결과 내보내기'}</h2>

      <p className="muted">
        {isSurvey
          ? '모든 세션의 응답을 한 파일에 담습니다. 각 행에 세션 이름이 들어갑니다.'
          : '이 세션의 응답만 담습니다.'}
      </p>

      <ul className="muted bullets">
        <li>
          <strong>응답(가로)</strong> — 행이 참가자, 열이 문항. 훑어보기 좋은 형태
        </li>
        <li>
          <strong>응답(세로)</strong> — 한 응답이 한 행. 피벗·집계용
        </li>
        <li>
          <strong>의견</strong> — 참가자가 남긴 자유 의견만 모아서
        </li>
        <li>
          <strong>문항</strong> — 문항 정의 백업
        </li>
      </ul>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <button className="btn btn--primary" disabled={busy} onClick={exportNow}>
        {busy ? '만드는 중…' : '엑셀로 내려받기'}
      </button>
    </div>
  )
}
