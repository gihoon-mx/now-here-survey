import { Suspense, lazy } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import ParticipantPage from './pages/Participant'

/**
 * 관리자 화면은 엑셀 라이브러리까지 끌고 오기 때문에 번들이 꽤 큽니다.
 * 참가자는 그 코드를 전혀 쓰지 않으므로 따로 떼어 두어, 현장 와이파이에서
 * 폰이 받아야 하는 용량을 최소로 유지합니다.
 */
const AdminPage = lazy(() => import('./pages/Admin'))
const PresentPage = lazy(() => import('./pages/Present'))

/**
 * GitHub Pages 는 서버 라우팅 규칙을 설정할 수 없어서 /admin 같은 경로로
 * 직접 들어오면 404 가 납니다. HashRouter 를 쓰면 경로가 전부 # 뒤로 가므로
 * 새로고침이나 링크 공유에서 문제가 없습니다.
 */
export default function App() {
  return (
    <HashRouter>
      <Suspense fallback={<div className="screen screen--center">불러오는 중…</div>}>
        <Routes>
          <Route path="/" element={<ParticipantPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/:sessionId" element={<AdminPage />} />
          <Route path="/present/:sessionId" element={<PresentPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </HashRouter>
  )
}
