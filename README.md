# now-here-survey

현장 인터뷰 서베이용 웹앱. 참석자는 프리젠테이션 화면을 보면서 폰으로 응답하고,
진행자가 폰으로 항목을 하나씩 넘깁니다.

- **프론트엔드** — React + TypeScript + Vite, GitHub Pages 로 정적 배포
- **백엔드** — Supabase (Postgres + Realtime + Auth). 서버 코드는 없습니다
- **동시 접속** — 30명 기준으로 설계 (여유 있음)

## 화면 세 개

| 경로 | 기기 | 역할 |
|---|---|---|
| `#/` | 참가자 폰 | 아이디/비번 로그인 → 문항과 응답지 |
| `#/admin` | 관리자 폰 | 문항 편집, 참가자 명단, 진행 제어, 결과 내보내기 |
| `#/present/<세션ID>` | 노트북 → 빔프로젝터 | 조작 없이 진행만 따라가는 표시 전용 화면 |

`#/present` 는 관리자 계정으로 로그인된 브라우저에서 열어야 합니다.
관리자 폰과 노트북에 각각 로그인하면 되고, 같은 계정으로 동시에 접속할 수 있습니다.

---

## 셋업

### 1. Supabase

> **이 프로젝트(`bpydykgjxawdjkozwvqm`)에는 아래 1~4번이 이미 적용되어 있습니다.**
> `npm run smoke` 로 언제든 상태를 확인할 수 있습니다. 아래 절차는 프로젝트를
> 새로 만들거나 초기화할 때를 위한 기록입니다.

1. `supabase/schema.sql` 전체를 **SQL Editor** 에 붙여넣고 실행합니다.
   재실행해도 안전하게 작성되어 있습니다.

2. **Authentication → Sign In / Providers → Anonymous sign-ins 를 켭니다.**
   참가자는 익명 세션을 먼저 발급받은 뒤 아이디/비번으로 본인을 확인합니다.
   이게 꺼져 있으면 참가자 화면이 "접속 준비에 실패했습니다" 에서 멈춥니다.

3. **Authentication → Rate Limits 에서 익명 로그인 한도를 올립니다.**
   ⚠️ 현장에서 가장 조용히 터지는 지점입니다. 행사장 와이파이는 30명이 **같은
   공인 IP** 를 쓰는데 기본 한도는 IP당 시간당 30회라, 몇 명이 새로고침만 해도
   나머지가 접속하지 못합니다. 100 이상으로 올려 두세요.

4. 관리자 계정을 만듭니다. **Authentication → Users → Add user** 로 이메일/비번
   계정을 만든 뒤, 그 유저 ID 를 `admins` 에 넣습니다:

   ```sql
   insert into public.admins (user_id, email)
   select id, email from auth.users where email = '관리자이메일@example.com';
   ```

### 2. GitHub

리포지토리는 **gihoon-mx** 계정에 `now-here-survey` 이름으로 만듭니다.

다른 계정(shoomerion)과 섞이지 않도록 이 리포지토리에서는 전역 git 설정을
쓰지 않습니다. 아래는 SSH 별칭을 쓰는 방법입니다 — 자격 증명 관리자가 저장해 둔
계정이 끼어들 여지가 없어 가장 안전합니다.

```bash
ssh-keygen -t ed25519 -C "gihoon-mx" -f ~/.ssh/id_ed25519_gihoon
```

생성된 `~/.ssh/id_ed25519_gihoon.pub` 를 gihoon-mx 계정의 SSH keys 에 등록하고,
`~/.ssh/config` 에 아래를 추가합니다:

```
Host github-gihoon
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_gihoon
  IdentitiesOnly yes
```

그다음 리포지토리에서:

```bash
git remote add origin git@github-gihoon:gihoon-mx/now-here-survey.git
```

푸시 전에 신원을 확인하세요:

```bash
git config user.email
```

### 3. GitHub Pages

리포지토리 **Settings → Pages → Source** 를 `GitHub Actions` 로 바꿉니다.
`main` 에 푸시하면 `.github/workflows/deploy.yml` 이 빌드해서 배포합니다.

배포 주소: `https://gihoon-mx.github.io/now-here-survey/`

> 리포지토리 이름을 바꾸면 `vite.config.ts` 의 `base` 도 같이 바꿔야 합니다.
> 안 그러면 자산 경로가 어긋나 흰 화면이 뜹니다.

---

## 진행 순서

1. `#/admin` 로그인 → **새 설문 만들기**
2. **문항** 탭에서 항목 추가 (다지선다 / OX / 안내 페이지 / 주관식)
3. **참가자** 탭에서 명단 업로드 — 헤더는 `아이디, 비밀번호, 이름`
   (`양식 내려받기` 버튼으로 예시 파일을 받을 수 있습니다)
4. 노트북에서 `#/present/<세션ID>` 를 열어 빔프로젝터에 띄웁니다
5. 관리자 폰에서 **진행** 탭 → **설문 시작**
6. 항목마다 응답 수(`23 / 30`)를 보고 **다음 →**
7. 마지막에 **설문 종료** → **결과** 탭에서 엑셀 내려받기

---

## 설계 노트

**진행 중 응답 변경.** `responses` 는 `(slide_id, participant_id)` 유일 제약이 있어
같은 문항에 다시 답하면 덮어씁니다. 다만 `submit_response` 함수가 "이 슬라이드가
지금 진행 중인 순번인지"를 서버에서 직접 확인하므로, 지나간 문항은 클라이언트가
무엇을 보내든 바뀌지 않습니다.

**앞 문항 미리보기 차단.** `slides` 의 RLS 정책이 참가자에게
`order_index <= current_slide_index` 인 행만 보여 줍니다. 개발자 도구를 열어도
아직 나오지 않은 문항은 읽히지 않습니다.

**비밀번호 열.** `participants.passcode` 는 컬럼 단위로 `select` 권한을
회수해 두었습니다. 검증은 `claim_participant` 함수 안에서만 일어나고,
관리자 화면은 별도 함수(`admin_list_participants`)로 조회합니다.
값 자체는 평문입니다 — 행사 당일 참가자에게 다시 알려줘야 하기 때문이고,
행사 후에는 세션을 지워 정리하는 것을 전제로 합니다.

**시간 표시.** 경과 시간은 전부 서버가 찍은 `started_at` /
`current_slide_started_at` 에서 계산합니다. 각 폰의 로컬 시계로 세면 기기마다
값이 어긋납니다.

**끊김 복구.** 참가자가 새로고침하거나 폰을 잠갔다 켜면 저장된 익명 세션으로
자동 복귀하고, 탭이 다시 보이거나 네트워크가 돌아오면 현재 상태를 다시 읽어
진행 중인 항목으로 합류합니다. 늦게 들어온 사람도 마찬가지입니다.

**Realtime 을 믿되, 의존하지는 않습니다.** 구독이 `SUBSCRIBED` 를 보고한
시점과 서버 쪽 복제 구독이 실제로 붙는 시점 사이에는 짧은 틈이 있어, 그 사이
변경은 통보되지 않습니다. 늦게 합류하거나 재접속한 참가자가 정확히 이 구간에
걸립니다. 그래서 구독 직후 한 번 더 읽고, 진행 중에는 10초마다 상태를
확인합니다. 참가자 화면이 멈춘 채로 남는 것이 이 앱에서 가장 나쁜 실패라,
Realtime 이벤트가 유실돼도 늦어도 10초 안에 따라잡도록 했습니다.
(30명이 10초 간격이면 초당 3건이라 부하는 문제되지 않습니다.)

**번들 분리.** 엑셀 라이브러리는 관리자만 쓰므로 별도 청크로 분리했습니다.
참가자 폰이 받는 용량은 약 130 kB (gzip) 입니다.

---

## 개발

```bash
npm install
npm run dev
```

### 스모크 테스트

스키마나 RLS 정책을 건드린 뒤에는 이걸 돌려 주세요. 실제 앱과 똑같이 공개 anon
키로만 접근해서, 참가자가 넘볼 수 없어야 할 것들이 정말 막혀 있는지까지
확인합니다.

```bash
ADMIN_EMAIL=관리자이메일 ADMIN_PASSWORD=비밀번호 npm run smoke
```

RLS 는 조용히 열리고 조용히 막히는 게 문제라, 눈으로 보고 넘어가면 놓치기
쉽습니다. 26개 항목이 모두 PASS 여야 정상입니다.

Realtime 동기화(관리자가 넘기면 참가자 화면이 따라오는 부분)는 HTTP 로
확인할 수 없어 따로 있습니다:

```bash
ADMIN_EMAIL=관리자이메일 ADMIN_PASSWORD=비밀번호 npm run realtime
```

13개 항목이 PASS 여야 하고, 전달 지연이 1초를 크게 넘으면 프로젝트 지역
설정이나 네트워크를 확인해 보세요.

### 환경 변수

`.env` 에는 Supabase URL 과 publishable(anon) 키가 들어 있습니다. 이 두 값은
브라우저에 노출되는 것을 전제로 한 공개 값이고, 실제 접근 통제는 전부 RLS
정책이 담당합니다. **`service_role` 키는 이 프로젝트에 넣지 마세요** — 필요하지
않고, 정적 사이트에 넣으면 DB 전체가 열립니다.

---

## 현장 체크리스트

- [x] Supabase 익명 로그인 **켜짐**
- [x] Supabase 익명 로그인 **rate limit 상향** (200 으로 설정됨)
- [x] 관리자 계정이 `admins` 테이블에 등록됨
- [ ] `npm run smoke` 26개 항목 전부 PASS
- [ ] `npm run realtime` 13개 항목 전부 PASS
- [ ] 참가자 명단 업로드 완료, 인원수 확인
- [ ] 노트북에 관리자 로그인 + `#/present/<세션ID>` 열어 둠
- [ ] 관리자 폰에 관리자 로그인 + **진행** 탭 열어 둠
- [ ] 폰 두 대로 실제 로그인 리허설 (다른 네트워크에서 한 번)
- [ ] 관리자 폰 배터리 / 절전 모드 해제
