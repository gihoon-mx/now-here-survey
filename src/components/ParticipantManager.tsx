import { useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { parseParticipantFile } from '../lib/excel'
import type { AdminParticipant } from '../lib/types'

export default function ParticipantManager({ sessionId }: { sessionId: string }) {
  const [rows, setRows] = useState<AdminParticipant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = async () => {
    const { data, error: rpcError } = await supabase.rpc(
      'admin_list_participants',
      { p_session_id: sessionId },
    )
    if (rpcError) setError(rpcError.message)
    setRows((data as AdminParticipant[]) ?? [])
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [sessionId])

  const importFile = async (file: File) => {
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      const parsed = await parseParticipantFile(file)

      // 같은 아이디는 덮어쓰고 새 아이디는 추가합니다.
      // (현장에서 명단을 고쳐 다시 올리는 일이 흔합니다.)
      //
      // ⚠️ 여기에 .select() 를 붙이지 마세요. 붙이면 PostgREST 가 삽입한 행을
      // 되돌려주려 하는데, 그 안에 passcode 열이 들어갑니다. 그 열은 읽기
      // 권한이 없어 통째로 403 이 납니다. 반환값 없이 넣어야 합니다.
      const { error: upsertError } = await supabase
        .from('participants')
        .upsert(
          parsed.map((r) => ({ ...r, session_id: sessionId })),
          { onConflict: 'session_id,login_id' },
        )

      if (upsertError) throw new Error(upsertError.message)
      setNotice(`${parsed.length}명을 등록했습니다.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '가져오기에 실패했습니다.')
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const removeOne = async (id: string, name: string) => {
    if (!confirm(`${name} 님을 명단에서 삭제할까요? 응답도 함께 지워집니다.`)) return
    await supabase.from('participants').delete().eq('id', id)
    await load()
  }

  const downloadTemplate = () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        { 아이디: 'user01', 비밀번호: '1234', 이름: '홍길동' },
        { 아이디: 'user02', 비밀번호: '5678', 이름: '김철수' },
      ]),
      '참가자',
    )
    XLSX.writeFile(workbook, '참가자_양식.xlsx')
  }

  const connected = rows.filter((r) => r.connected).length

  return (
    <div className="participants">
      <div className="card">
        <p className="muted">
          엑셀(.xlsx) 또는 CSV 파일을 올려 주세요. 첫 줄 헤더는{' '}
          <strong>아이디, 비밀번호, 이름</strong> 입니다.
        </p>
        <div className="row">
          <button className="btn btn--sm" onClick={downloadTemplate}>
            양식 내려받기
          </button>
          <button
            className="btn btn--sm btn--primary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? '가져오는 중…' : '명단 가져오기'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls,.csv"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void importFile(file)
            }}
          />
        </div>
        {error && <p className="error">{error}</p>}
        {notice && <p className="notice">{notice}</p>}
      </div>

      {loading ? (
        <p className="muted">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <p className="muted">등록된 참가자가 없습니다.</p>
      ) : (
        <>
          <p className="muted">
            총 {rows.length}명 · 접속함 {connected}명
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>이름</th>
                <th>아이디</th>
                <th>비밀번호</th>
                <th>접속</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.display_name}</td>
                  <td className="mono">{r.login_id}</td>
                  <td className="mono">{r.passcode}</td>
                  <td>{r.connected ? '●' : ''}</td>
                  <td>
                    <button
                      className="icon-btn icon-btn--danger"
                      onClick={() => removeOne(r.id, r.display_name)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
