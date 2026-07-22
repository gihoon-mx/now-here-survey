import { useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { parseParticipantFile } from '../lib/excel'
import type { AdminParticipant } from '../lib/types'

/** 현장에서 불러주기 쉬운 네 자리 숫자. */
const randomPasscode = () => String(Math.floor(1000 + Math.random() * 9000))

interface Draft {
  display_name: string
  login_id: string
  passcode: string
}

const emptyDraft = (): Draft => ({
  display_name: '',
  login_id: '',
  passcode: randomPasscode(),
})

export default function ParticipantManager({ sessionId }: { sessionId: string }) {
  const [rows, setRows] = useState<AdminParticipant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft)

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

  /** 아이디 중복은 DB 제약으로도 막히지만, 먼저 알려주는 편이 친절합니다. */
  const validate = (d: Draft, exceptId?: string): string | null => {
    if (!d.display_name.trim()) return '이름을 입력해 주세요.'
    if (!d.login_id.trim()) return '아이디를 입력해 주세요.'
    if (!d.passcode.trim()) return '비밀번호를 입력해 주세요.'
    const dup = rows.some(
      (r) =>
        r.id !== exceptId &&
        r.login_id.toLowerCase() === d.login_id.trim().toLowerCase(),
    )
    if (dup) return `이미 있는 아이디입니다: ${d.login_id.trim()}`
    return null
  }

  const addOne = async (e: React.FormEvent) => {
    e.preventDefault()
    const problem = validate(draft)
    if (problem) {
      setError(problem)
      return
    }

    setBusy(true)
    setError(null)
    setNotice(null)

    const { error: insertError } = await supabase.from('participants').insert({
      session_id: sessionId,
      display_name: draft.display_name.trim(),
      login_id: draft.login_id.trim(),
      passcode: draft.passcode.trim(),
    })

    if (insertError) setError(insertError.message)
    else {
      setNotice(`${draft.display_name.trim()} 님을 추가했습니다.`)
      setDraft(emptyDraft())
      await load()
    }
    setBusy(false)
  }

  const startEdit = (r: AdminParticipant) => {
    setEditingId(r.id)
    setEditDraft({
      display_name: r.display_name,
      login_id: r.login_id,
      passcode: r.passcode,
    })
    setError(null)
  }

  const saveEdit = async () => {
    if (!editingId) return
    const problem = validate(editDraft, editingId)
    if (problem) {
      setError(problem)
      return
    }

    setBusy(true)
    setError(null)

    // .select() 를 붙이지 않습니다 — 반환 행에 passcode 가 포함되면
    // 읽기 권한이 없어 통째로 거부됩니다.
    const { error: updateError } = await supabase
      .from('participants')
      .update({
        display_name: editDraft.display_name.trim(),
        login_id: editDraft.login_id.trim(),
        passcode: editDraft.passcode.trim(),
      })
      .eq('id', editingId)

    if (updateError) setError(updateError.message)
    else {
      setEditingId(null)
      setNotice('수정했습니다.')
      await load()
    }
    setBusy(false)
  }

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

  const exportList = () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        rows.map((r) => ({
          이름: r.display_name,
          아이디: r.login_id,
          비밀번호: r.passcode,
        })),
      ),
      '참가자',
    )
    XLSX.writeFile(workbook, '참가자_명단.xlsx')
  }

  const connected = rows.filter((r) => r.connected).length

  return (
    <div className="participants">
      {/* 직접 추가 */}
      <form className="card" onSubmit={addOne}>
        <h2>참가자 추가</h2>
        <div className="field-row">
          <label className="field">
            <span>이름</span>
            <input
              value={draft.display_name}
              onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
              placeholder="홍길동"
            />
          </label>
          <label className="field">
            <span>아이디</span>
            <input
              value={draft.login_id}
              onChange={(e) => setDraft({ ...draft, login_id: e.target.value })}
              placeholder="user01"
              autoCapitalize="none"
              autoCorrect="off"
            />
          </label>
          <label className="field">
            <span>비밀번호</span>
            <div className="input-with-btn">
              <input
                value={draft.passcode}
                onChange={(e) => setDraft({ ...draft, passcode: e.target.value })}
                autoCapitalize="none"
                autoCorrect="off"
              />
              <button
                type="button"
                className="btn btn--sm"
                title="새 비밀번호 생성"
                onClick={() => setDraft({ ...draft, passcode: randomPasscode() })}
              >
                ↻
              </button>
            </div>
          </label>
        </div>
        <button className="btn btn--primary" disabled={busy}>
          추가
        </button>
      </form>

      {/* 파일로 일괄 등록 */}
      <div className="card">
        <h2>파일로 일괄 등록</h2>
        <p className="muted">
          엑셀(.xlsx) 또는 CSV. 첫 줄 헤더는{' '}
          <strong>아이디, 비밀번호, 이름</strong> 입니다. 같은 아이디가 이미
          있으면 덮어씁니다.
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
          {rows.length > 0 && (
            <button className="btn btn--sm" onClick={exportList}>
              현재 명단 내려받기
            </button>
          )}
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
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {loading ? (
        <p className="muted">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <p className="muted">등록된 참가자가 없습니다.</p>
      ) : (
        <>
          <p className="muted">
            총 {rows.length}명 · 접속함 {connected}명
          </p>
          <div className="table-wrap">
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
                {rows.map((r) =>
                  editingId === r.id ? (
                    <tr key={r.id} className="row--editing">
                      <td>
                        <input
                          value={editDraft.display_name}
                          onChange={(e) =>
                            setEditDraft({ ...editDraft, display_name: e.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          value={editDraft.login_id}
                          onChange={(e) =>
                            setEditDraft({ ...editDraft, login_id: e.target.value })
                          }
                          autoCapitalize="none"
                        />
                      </td>
                      <td>
                        <input
                          value={editDraft.passcode}
                          onChange={(e) =>
                            setEditDraft({ ...editDraft, passcode: e.target.value })
                          }
                          autoCapitalize="none"
                        />
                      </td>
                      <td />
                      <td>
                        <div className="row-actions">
                          <button
                            className="btn btn--sm btn--primary"
                            disabled={busy}
                            onClick={saveEdit}
                          >
                            저장
                          </button>
                          <button
                            className="btn btn--sm btn--ghost"
                            onClick={() => {
                              setEditingId(null)
                              setError(null)
                            }}
                          >
                            취소
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={r.id}>
                      <td>{r.display_name}</td>
                      <td className="mono">{r.login_id}</td>
                      <td className="mono">{r.passcode}</td>
                      <td>{r.connected ? '●' : ''}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            className="icon-btn"
                            title="수정"
                            onClick={() => startEdit(r)}
                          >
                            ✎
                          </button>
                          <button
                            className="icon-btn icon-btn--danger"
                            title="삭제"
                            onClick={() => removeOne(r.id, r.display_name)}
                          >
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
