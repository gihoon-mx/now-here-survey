import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 는 https://gihoon-mx.github.io/now-here-survey/ 하위로 서빙되므로
// base 경로를 리포지토리 이름에 맞춰야 자산 경로가 깨지지 않습니다.
export default defineConfig({
  base: '/now-here-survey/',
  plugins: [react()],
  server: {
    // 개발 도구가 PORT 로 포트를 지정할 수 있게 합니다 (기본은 5173).
    port: Number(process.env.PORT) || 5173,
  },
})
