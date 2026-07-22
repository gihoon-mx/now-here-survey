-- ============================================================
-- now-here-survey — schema
-- Supabase SQL Editor 에 이 파일 전체를 붙여넣고 실행하세요.
-- 재실행해도 안전하도록 작성되어 있습니다.
-- ============================================================

-- ------------------------------------------------------------
-- 1. 테이블
-- ------------------------------------------------------------

-- 관리자 목록. Supabase Auth 의 이메일/비번 계정과 1:1로 연결됩니다.
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

-- 설문 세션 하나 = 현장 진행 한 번.
create table if not exists public.sessions (
  id                       uuid primary key default gen_random_uuid(),
  title                    text not null,
  status                   text not null default 'draft'
                             check (status in ('draft', 'live', 'ended')),
  current_slide_index      int  not null default 0,
  started_at               timestamptz,
  current_slide_started_at timestamptz,
  ended_at                 timestamptz,
  owner_id                 uuid references auth.users(id) on delete set null,
  created_at               timestamptz not null default now()
);

-- 슬라이드 = 설문 항목 하나 (문항 또는 안내 페이지).
create table if not exists public.slides (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions(id) on delete cascade,
  order_index int  not null,
  type        text not null check (type in ('choice', 'ox', 'info', 'text')),
  title       text not null,
  body        text,
  -- choice/ox 의 선택지: ["매우 그렇다", "그렇다", ...]
  options     jsonb not null default '[]'::jsonb,
  multi       boolean not null default false,  -- 다지선다 복수선택 허용
  required    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists slides_session_order_idx
  on public.slides (session_id, order_index);

-- 참가자. CSV 로 일괄 등록합니다.
create table if not exists public.participants (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.sessions(id) on delete cascade,
  login_id     text not null,
  passcode     text not null,
  display_name text not null,
  -- 로그인 시 익명 auth 유저와 묶입니다.
  auth_user_id uuid unique references auth.users(id) on delete set null,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (session_id, login_id)
);

create index if not exists participants_auth_user_idx
  on public.participants (auth_user_id);

-- 응답. (슬라이드, 참가자) 당 한 행 — 진행 중 변경은 덮어쓰기.
--
-- answer 와 comment 는 각각 따로 채워질 수 있습니다. 안내 페이지처럼 고를
-- 것이 없는 항목에도 의견은 남길 수 있어야 하고, 반대로 의견 없이 답만 하는
-- 경우가 대부분이기 때문입니다. 그래서 둘 다 null 을 허용합니다.
create table if not exists public.responses (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.sessions(id) on delete cascade,
  slide_id       uuid not null references public.slides(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  answer         jsonb,
  comment        text,
  answered_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (slide_id, participant_id)
);

-- 기존 프로젝트에 이미 테이블이 있는 경우를 위한 이행 처리.
alter table public.responses add column if not exists comment text;
alter table public.responses alter column answer drop not null;

create index if not exists responses_session_idx
  on public.responses (session_id);

-- ------------------------------------------------------------
-- 2. 헬퍼 함수
-- ------------------------------------------------------------

-- 현재 로그인 유저가 관리자인지. security definer 로 RLS 재귀를 피합니다.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- 현재 로그인 유저에 묶인 참가자 id.
create or replace function public.current_participant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.participants where auth_user_id = auth.uid();
$$;

-- ------------------------------------------------------------
-- 3. RPC — 참가자용
-- ------------------------------------------------------------

-- 아이디/비번을 검증하고 현재 익명 세션에 참가자를 연결합니다.
-- 이 함수만이 passcode 를 읽을 수 있습니다 (아래 컬럼 권한 회수 참고).
create or replace function public.claim_participant(
  p_login_id text,
  p_passcode text
)
returns table (
  participant_id uuid,
  session_id     uuid,
  display_name   text,
  session_title  text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant public.participants%rowtype;
begin
  if auth.uid() is null then
    raise exception '로그인 세션이 없습니다. 새로고침 후 다시 시도해 주세요.';
  end if;

  select * into v_participant
  from public.participants p
  where lower(p.login_id) = lower(trim(p_login_id))
    and p.passcode = trim(p_passcode)
  limit 1;

  if v_participant.id is null then
    raise exception '아이디 또는 비밀번호가 올바르지 않습니다.';
  end if;

  -- 기기를 바꿔 다시 접속하는 경우를 허용합니다 (이전 연결은 해제).
  update public.participants
     set auth_user_id = auth.uid(),
         last_seen_at = now()
   where id = v_participant.id;

  return query
  select v_participant.id,
         v_participant.session_id,
         v_participant.display_name,
         s.title
  from public.sessions s
  where s.id = v_participant.session_id;
end;
$$;

-- 응답 제출/수정.
-- 서버가 "지금 라이브인 슬라이드인지"를 직접 확인하므로,
-- 지나간 문항이나 앞으로 나올 문항에는 클라이언트가 무엇을 보내든 쓸 수 없습니다.
create or replace function public.submit_response(
  p_slide_id uuid,
  p_answer   jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant_id uuid;
  v_session_id     uuid;
  v_slide          public.slides%rowtype;
  v_session        public.sessions%rowtype;
begin
  select id, session_id into v_participant_id, v_session_id
  from public.participants
  where auth_user_id = auth.uid();

  if v_participant_id is null then
    raise exception '참가자 인증이 필요합니다.';
  end if;

  select * into v_slide from public.slides where id = p_slide_id;
  if v_slide.id is null or v_slide.session_id <> v_session_id then
    raise exception '잘못된 문항입니다.';
  end if;

  select * into v_session from public.sessions where id = v_session_id;

  if v_session.status <> 'live' then
    raise exception '진행 중인 설문이 아닙니다.';
  end if;

  if v_slide.order_index <> v_session.current_slide_index then
    raise exception '이미 지나간 문항입니다.';
  end if;

  -- comment 는 건드리지 않습니다. 의견을 먼저 쓰고 답을 나중에 고르는
  -- 순서로도 각각 남아야 합니다.
  insert into public.responses (session_id, slide_id, participant_id, answer)
  values (v_session_id, p_slide_id, v_participant_id, p_answer)
  on conflict (slide_id, participant_id)
  do update set answer = excluded.answer,
                updated_at = now();
end;
$$;

-- 항목별 자유 의견. 안내 페이지를 포함해 모든 항목에 남길 수 있습니다.
-- 진행 중인 항목인지 확인하는 규칙은 응답과 동일합니다.
create or replace function public.submit_comment(
  p_slide_id uuid,
  p_comment  text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant_id uuid;
  v_session_id     uuid;
  v_slide          public.slides%rowtype;
  v_session        public.sessions%rowtype;
begin
  select id, session_id into v_participant_id, v_session_id
  from public.participants
  where auth_user_id = auth.uid();

  if v_participant_id is null then
    raise exception '참가자 인증이 필요합니다.';
  end if;

  select * into v_slide from public.slides where id = p_slide_id;
  if v_slide.id is null or v_slide.session_id <> v_session_id then
    raise exception '잘못된 문항입니다.';
  end if;

  select * into v_session from public.sessions where id = v_session_id;

  if v_session.status <> 'live' then
    raise exception '진행 중인 설문이 아닙니다.';
  end if;

  if v_slide.order_index <> v_session.current_slide_index then
    raise exception '이미 지나간 문항입니다.';
  end if;

  -- answer 는 건드리지 않습니다.
  insert into public.responses (session_id, slide_id, participant_id, comment)
  values (v_session_id, p_slide_id, v_participant_id, nullif(trim(p_comment), ''))
  on conflict (slide_id, participant_id)
  do update set comment = nullif(trim(excluded.comment), ''),
                updated_at = now();
end;
$$;

-- ------------------------------------------------------------
-- 4. RPC — 관리자용 (진행 제어)
-- ------------------------------------------------------------

-- 세션 시작. 타임스탬프는 전부 서버 시각(now())으로 찍힙니다.
create or replace function public.start_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '권한이 없습니다.';
  end if;

  update public.sessions
     set status = 'live',
         current_slide_index = 0,
         started_at = now(),
         current_slide_started_at = now(),
         ended_at = null
   where id = p_session_id;
end;
$$;

-- 다음/이전 슬라이드로 이동. p_delta = 1 또는 -1.
create or replace function public.move_slide(p_session_id uuid, p_delta int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current int;
  v_max     int;
  v_next    int;
begin
  if not public.is_admin() then
    raise exception '권한이 없습니다.';
  end if;

  select current_slide_index into v_current
  from public.sessions where id = p_session_id;

  select coalesce(max(order_index), -1) into v_max
  from public.slides where session_id = p_session_id;

  v_next := greatest(0, least(v_current + p_delta, v_max));

  update public.sessions
     set current_slide_index = v_next,
         current_slide_started_at = now()
   where id = p_session_id;

  return v_next;
end;
$$;

-- 설문 복사. 문항만 복제하고 참가자는 가져오지 않습니다.
--
-- 참가자는 특정 개인에게 발급한 비밀번호가 딸려 있어, 복사본에 조용히 딸려
-- 오면 누가 어느 설문에 속하는지 헷갈립니다. 같은 인원으로 다시 돌릴 때는
-- 참가자 탭에서 "현재 명단 내려받기" 후 복사본에 올리면 됩니다.
create or replace function public.duplicate_session(
  p_session_id uuid,
  p_title      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_id uuid;
  v_title  text;
begin
  if not public.is_admin() then
    raise exception '권한이 없습니다.';
  end if;

  select coalesce(nullif(trim(p_title), ''), s.title || ' (사본)')
    into v_title
  from public.sessions s
  where s.id = p_session_id;

  if v_title is null then
    raise exception '원본 설문을 찾을 수 없습니다.';
  end if;

  insert into public.sessions (title, owner_id)
  values (v_title, auth.uid())
  returning id into v_new_id;

  insert into public.slides
    (session_id, order_index, type, title, body, options, multi, required)
  select v_new_id, order_index, type, title, body, options, multi, required
  from public.slides
  where session_id = p_session_id;

  return v_new_id;
end;
$$;

-- 설문 다시 시작하기. 응답을 모두 지우고 준비 중 상태로 되돌립니다.
--
-- 참가자의 접속(auth_user_id)은 그대로 둡니다. 리허설 직후 본 진행으로
-- 넘어갈 때 30명에게 다시 로그인하라고 안내하는 상황을 피하기 위해서입니다.
-- 참가자 폰은 대기 화면으로 알아서 돌아갑니다.
create or replace function public.reset_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '권한이 없습니다.';
  end if;

  delete from public.responses where session_id = p_session_id;

  update public.sessions
     set status = 'draft',
         current_slide_index = 0,
         started_at = null,
         current_slide_started_at = null,
         ended_at = null
   where id = p_session_id;
end;
$$;

create or replace function public.end_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '권한이 없습니다.';
  end if;

  update public.sessions
     set status = 'ended', ended_at = now()
   where id = p_session_id;
end;
$$;

-- ------------------------------------------------------------
-- 5. RLS
-- ------------------------------------------------------------

alter table public.admins       enable row level security;
alter table public.sessions     enable row level security;
alter table public.slides       enable row level security;
alter table public.participants enable row level security;
alter table public.responses    enable row level security;

-- admins: 본인 행만 확인 가능 (관리자 여부 판별용)
drop policy if exists admins_self_read on public.admins;
create policy admins_self_read on public.admins
  for select to authenticated
  using (user_id = auth.uid());

-- sessions: 관리자는 전체, 참가자는 자기 세션만
drop policy if exists sessions_admin_all on public.sessions;
create policy sessions_admin_all on public.sessions
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists sessions_participant_read on public.sessions;
create policy sessions_participant_read on public.sessions
  for select to authenticated
  using (
    id = (select session_id from public.participants
          where auth_user_id = auth.uid())
  );

-- slides: 관리자는 전체.
-- 참가자는 "현재 진행 중인 순번까지"만 읽을 수 있습니다 → 앞선 문항 미리보기 불가.
drop policy if exists slides_admin_all on public.slides;
create policy slides_admin_all on public.slides
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists slides_participant_read on public.slides;
create policy slides_participant_read on public.slides
  for select to authenticated
  using (
    exists (
      select 1
      from public.participants p
      join public.sessions s on s.id = p.session_id
      where p.auth_user_id = auth.uid()
        and p.session_id = slides.session_id
        and s.status = 'live'
        and slides.order_index <= s.current_slide_index
    )
  );

-- participants: 관리자는 전체, 참가자는 본인 행만
drop policy if exists participants_admin_all on public.participants;
create policy participants_admin_all on public.participants
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists participants_self_read on public.participants;
create policy participants_self_read on public.participants
  for select to authenticated
  using (auth_user_id = auth.uid());

-- responses: 관리자는 전체, 참가자는 본인 응답만 (쓰기는 RPC 로만)
drop policy if exists responses_admin_all on public.responses;
create policy responses_admin_all on public.responses
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists responses_self_read on public.responses;
create policy responses_self_read on public.responses
  for select to authenticated
  using (participant_id = public.current_participant_id());

-- ------------------------------------------------------------
-- 6. 관리자 전용 조회 RPC
-- ------------------------------------------------------------

-- 참가자 명단 + 비번 (관리자만). 현장에서 비번을 다시 알려줄 때 사용.
create or replace function public.admin_list_participants(p_session_id uuid)
returns table (
  id           uuid,
  login_id     text,
  passcode     text,
  display_name text,
  connected    boolean,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '권한이 없습니다.';
  end if;

  return query
  select p.id, p.login_id, p.passcode, p.display_name,
         (p.auth_user_id is not null) as connected,
         p.last_seen_at
  from public.participants p
  where p.session_id = p_session_id
  order by p.display_name;
end;
$$;

-- ------------------------------------------------------------
-- 7. 권한 (GRANT)
-- ------------------------------------------------------------
-- Supabase 의 기본 권한 설정에 기대지 않고 필요한 것만 직접 부여합니다.
-- (프로젝트에 따라 default privileges 가 걸려 있지 않아, 이게 없으면
--  authenticated 역할이 테이블에 전혀 접근하지 못합니다.)
--
-- 참가자는 익명 로그인 후 authenticated 역할을 받습니다. 따라서 anon 에는
-- 아무 권한도 주지 않습니다. 실제 행 단위 통제는 위의 RLS 정책이 합니다.

grant usage on schema public to authenticated;

grant select, insert, update, delete on public.sessions  to authenticated;
grant select, insert, update, delete on public.slides    to authenticated;
grant select, insert, update, delete on public.responses to authenticated;
grant select on public.admins to authenticated;

-- participants 는 passcode 를 뺀 열에만 select 를 부여합니다.
--
-- REVOKE 로 열 권한을 빼앗는 방식은 쓰지 않습니다 — Postgres 에서
-- 열 단위 REVOKE 는 이미 부여된 "테이블 단위" 권한을 걷어내지 못하기 때문에,
-- 막았다고 착각하기 쉽습니다. 처음부터 열을 열거해 부여하는 편이 확실합니다.
grant select (id, session_id, login_id, display_name, auth_user_id,
              last_seen_at, created_at)
  on public.participants to authenticated;

-- 명단 업로드·수정·삭제에는 passcode 열도 써야 하므로 쓰기는 테이블 단위로
-- 부여합니다. 읽기만 막혀 있으면 목적은 달성됩니다.
grant insert, update, delete on public.participants to authenticated;

-- RLS 정책 안에서 호출되는 함수라 실행 권한이 반드시 필요합니다.
grant execute on function public.is_admin()                to authenticated;
grant execute on function public.current_participant_id()  to authenticated;

grant execute on function public.claim_participant(text, text) to authenticated;
grant execute on function public.submit_response(uuid, jsonb)  to authenticated;
grant execute on function public.submit_comment(uuid, text)    to authenticated;
grant execute on function public.start_session(uuid)           to authenticated;
grant execute on function public.move_slide(uuid, int)         to authenticated;
grant execute on function public.end_session(uuid)             to authenticated;
grant execute on function public.duplicate_session(uuid, text) to authenticated;
grant execute on function public.reset_session(uuid)           to authenticated;
grant execute on function public.admin_list_participants(uuid) to authenticated;

-- ------------------------------------------------------------
-- 8. Realtime
-- ------------------------------------------------------------
-- sessions: 관리자가 next 를 누르면 모든 화면이 즉시 따라오도록.
-- responses: 관리자 화면의 "n / 30 응답" 카운터용.
-- (Realtime 도 RLS 를 그대로 따릅니다.)

alter table public.sessions  replica identity full;
alter table public.responses replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'sessions'
  ) then
    alter publication supabase_realtime add table public.sessions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'responses'
  ) then
    alter publication supabase_realtime add table public.responses;
  end if;
end $$;
