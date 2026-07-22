-- ============================================================
-- now-here-survey — schema
-- Supabase SQL Editor 에 이 파일 전체를 붙여넣고 실행하세요.
-- 재실행해도 안전하도록 작성되어 있습니다.
--
-- 구조
--   surveys      설문 하나. 문항을 가집니다.
--   sessions     그 설문의 진행 회차. 회차마다 참가자·진행상태·응답이 따로입니다.
--   slides       문항. 설문에 속합니다 (회차가 아니라).
--   participants 참가자. 회차에 배정됩니다.
--   responses    응답. 회차 + 문항 + 참가자.
-- ============================================================

-- ------------------------------------------------------------
-- 1. 테이블
-- ------------------------------------------------------------

create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

-- 설문. 문항을 보유하고, 실제 진행은 아래 sessions 로 여러 번 할 수 있습니다.
create table if not exists public.surveys (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  owner_id   uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id                       uuid primary key default gen_random_uuid(),
  survey_id                uuid references public.surveys(id) on delete cascade,
  name                     text,
  status                   text not null default 'draft'
                             check (status in ('draft', 'live', 'ended')),
  current_slide_index      int  not null default 0,
  started_at               timestamptz,
  current_slide_started_at timestamptz,
  ended_at                 timestamptz,
  created_at               timestamptz not null default now()
);

create table if not exists public.slides (
  id          uuid primary key default gen_random_uuid(),
  survey_id   uuid references public.surveys(id) on delete cascade,
  order_index int  not null,
  type        text not null check (type in ('choice', 'ox', 'info', 'text')),
  title       text not null default '',
  body        text,
  options     jsonb not null default '[]'::jsonb,
  multi       boolean not null default false,
  required    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.participants (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.sessions(id) on delete cascade,
  login_id     text not null,
  passcode     text not null,
  display_name text not null,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (session_id, login_id)
);

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

-- ------------------------------------------------------------
-- 2. 이행 (예전 구조에서 올라오는 경우에만 동작)
-- ------------------------------------------------------------
-- 예전에는 "설문 = 1회 진행" 이라 문항이 회차에 직접 묶여 있었습니다.
-- 기존 설문 하나를 [설문 + 1회차] 로 나눠 옮깁니다. 이미 옮겨졌으면
-- 아무 일도 일어나지 않습니다.

-- 정책이 옛 열을 참조하고 있으면 열을 지울 수 없습니다.
-- 아래 6번에서 새 정의로 다시 만들므로 여기서 먼저 걷어냅니다.
drop policy if exists slides_participant_read   on public.slides;
drop policy if exists slides_admin_all          on public.slides;
drop policy if exists sessions_participant_read on public.sessions;
drop policy if exists sessions_admin_all        on public.sessions;

alter table public.sessions  add column if not exists survey_id uuid references public.surveys(id) on delete cascade;
alter table public.sessions  add column if not exists name text;
alter table public.slides    add column if not exists survey_id uuid references public.surveys(id) on delete cascade;
alter table public.responses add column if not exists comment text;
alter table public.responses alter column answer drop not null;
alter table public.slides    alter column title set default '';

do $$
declare
  r         record;
  v_survey  uuid;
  v_has_old boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sessions' and column_name = 'title'
  ) into v_has_old;

  if not v_has_old then
    return;  -- 이미 이행된 스키마
  end if;

  for r in execute 'select id, title, owner_id from public.sessions where survey_id is null'
  loop
    insert into public.surveys (title, owner_id)
    values (r.title, r.owner_id)
    returning id into v_survey;

    update public.sessions
       set survey_id = v_survey,
           name = coalesce(name, '1회차')
     where id = r.id;

    -- 문항을 회차가 아니라 설문에 붙입니다.
    execute format(
      'update public.slides set survey_id = %L where session_id = %L and survey_id is null',
      v_survey, r.id
    );
  end loop;
end $$;

-- 이행이 끝났으면 옛 열을 정리하고 제약을 채웁니다.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'slides' and column_name = 'session_id'
  ) and not exists (select 1 from public.slides where survey_id is null) then
    alter table public.slides drop column session_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sessions' and column_name = 'title'
  ) and not exists (select 1 from public.sessions where survey_id is null) then
    alter table public.sessions drop column title;
  end if;

  if not exists (select 1 from public.sessions where survey_id is null) then
    alter table public.sessions alter column survey_id set not null;
  end if;

  if not exists (select 1 from public.slides where survey_id is null) then
    alter table public.slides alter column survey_id set not null;
  end if;
end $$;

update public.sessions set name = '1회차' where name is null or trim(name) = '';

create index if not exists slides_survey_order_idx    on public.slides (survey_id, order_index);
create index if not exists sessions_survey_idx        on public.sessions (survey_id);
create index if not exists participants_auth_user_idx on public.participants (auth_user_id);
create index if not exists responses_session_idx      on public.responses (session_id);

-- ------------------------------------------------------------
-- 3. 헬퍼
-- ------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create or replace function public.current_participant_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select id from public.participants where auth_user_id = auth.uid();
$$;

-- ------------------------------------------------------------
-- 4. RPC — 참가자용
-- ------------------------------------------------------------

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
language plpgsql security definer set search_path = public
as $$
declare
  v_participant public.participants%rowtype;
  v_matches     int;
begin
  if auth.uid() is null then
    raise exception '로그인 세션이 없습니다. 새로고침 후 다시 시도해 주세요.';
  end if;

  /*
   * 같은 아이디/비밀번호가 여러 회차에 등록돼 있을 수 있습니다.
   * 그때 아무 회차나 골라 넣으면 오전 참가자가 오후 회차에 들어가 버리고,
   * 응답이 엉뚱한 곳에 쌓입니다.
   *
   * 그래서 "지금 진행 중인 회차"를 먼저 찾습니다. 한 번에 하나만 진행하는
   * 것이 정상이므로 이걸로 대부분 갈립니다. 그래도 갈리지 않으면 조용히
   * 아무 데나 넣지 않고 실패시킵니다 — 잘못된 방에 들어가는 것보다
   * 들어가지 못하는 편이 낫습니다.
   */
  select count(*) into v_matches
  from public.participants p
  join public.sessions s on s.id = p.session_id
  where lower(p.login_id) = lower(trim(p_login_id))
    and p.passcode = trim(p_passcode)
    and s.status = 'live';

  if v_matches > 1 then
    raise exception '이 아이디가 여러 회차에 등록되어 있습니다. 진행자에게 문의해 주세요.';
  end if;

  if v_matches = 1 then
    select p.* into v_participant
    from public.participants p
    join public.sessions s on s.id = p.session_id
    where lower(p.login_id) = lower(trim(p_login_id))
      and p.passcode = trim(p_passcode)
      and s.status = 'live';
  else
    select count(*) into v_matches
    from public.participants p
    where lower(p.login_id) = lower(trim(p_login_id))
      and p.passcode = trim(p_passcode);

    if v_matches > 1 then
      raise exception '이 아이디가 여러 회차에 등록되어 있습니다. 진행자에게 문의해 주세요.';
    end if;

    select * into v_participant
    from public.participants p
    where lower(p.login_id) = lower(trim(p_login_id))
      and p.passcode = trim(p_passcode);
  end if;

  if v_participant.id is null then
    raise exception '아이디 또는 비밀번호가 올바르지 않습니다.';
  end if;

  update public.participants
     set auth_user_id = auth.uid(),
         last_seen_at = now()
   where id = v_participant.id;

  return query
  select v_participant.id,
         v_participant.session_id,
         v_participant.display_name,
         sv.title
  from public.sessions s
  join public.surveys sv on sv.id = s.survey_id
  where s.id = v_participant.session_id;
end;
$$;

create or replace function public.submit_response(
  p_slide_id uuid,
  p_answer   jsonb
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_participant_id uuid;
  v_session_id     uuid;
  v_slide          public.slides%rowtype;
  v_session        public.sessions%rowtype;
begin
  select id, session_id into v_participant_id, v_session_id
  from public.participants where auth_user_id = auth.uid();

  if v_participant_id is null then
    raise exception '참가자 인증이 필요합니다.';
  end if;

  select * into v_session from public.sessions where id = v_session_id;
  select * into v_slide   from public.slides   where id = p_slide_id;

  -- 문항이 이 회차가 속한 설문의 것인지 확인합니다.
  if v_slide.id is null or v_slide.survey_id <> v_session.survey_id then
    raise exception '잘못된 문항입니다.';
  end if;

  if v_session.status <> 'live' then
    raise exception '진행 중인 설문이 아닙니다.';
  end if;

  if v_slide.order_index <> v_session.current_slide_index then
    raise exception '이미 지나간 문항입니다.';
  end if;

  -- comment 는 건드리지 않습니다.
  insert into public.responses (session_id, slide_id, participant_id, answer)
  values (v_session_id, p_slide_id, v_participant_id, p_answer)
  on conflict (slide_id, participant_id)
  do update set answer = excluded.answer, updated_at = now();
end;
$$;

create or replace function public.submit_comment(
  p_slide_id uuid,
  p_comment  text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_participant_id uuid;
  v_session_id     uuid;
  v_slide          public.slides%rowtype;
  v_session        public.sessions%rowtype;
begin
  select id, session_id into v_participant_id, v_session_id
  from public.participants where auth_user_id = auth.uid();

  if v_participant_id is null then
    raise exception '참가자 인증이 필요합니다.';
  end if;

  select * into v_session from public.sessions where id = v_session_id;
  select * into v_slide   from public.slides   where id = p_slide_id;

  if v_slide.id is null or v_slide.survey_id <> v_session.survey_id then
    raise exception '잘못된 문항입니다.';
  end if;

  if v_session.status <> 'live' then
    raise exception '진행 중인 설문이 아닙니다.';
  end if;

  if v_slide.order_index <> v_session.current_slide_index then
    raise exception '이미 지나간 문항입니다.';
  end if;

  insert into public.responses (session_id, slide_id, participant_id, comment)
  values (v_session_id, p_slide_id, v_participant_id, nullif(trim(p_comment), ''))
  on conflict (slide_id, participant_id)
  do update set comment = nullif(trim(excluded.comment), ''), updated_at = now();
end;
$$;

-- ------------------------------------------------------------
-- 5. RPC — 관리자용
-- ------------------------------------------------------------

create or replace function public.start_session(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception '권한이 없습니다.'; end if;

  update public.sessions
     set status = 'live', current_slide_index = 0,
         started_at = now(), current_slide_started_at = now(), ended_at = null
   where id = p_session_id;
end;
$$;

create or replace function public.move_slide(p_session_id uuid, p_delta int)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_current int;
  v_max     int;
  v_next    int;
begin
  if not public.is_admin() then raise exception '권한이 없습니다.'; end if;

  select current_slide_index into v_current from public.sessions where id = p_session_id;

  select coalesce(max(sl.order_index), -1) into v_max
  from public.slides sl
  join public.sessions s on s.survey_id = sl.survey_id
  where s.id = p_session_id;

  v_next := greatest(0, least(v_current + p_delta, v_max));

  update public.sessions
     set current_slide_index = v_next, current_slide_started_at = now()
   where id = p_session_id;

  return v_next;
end;
$$;

create or replace function public.end_session(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception '권한이 없습니다.'; end if;
  update public.sessions set status = 'ended', ended_at = now() where id = p_session_id;
end;
$$;

-- 회차 초기화. 참가자 접속은 유지합니다 — 리허설 직후 본 진행으로 넘어갈 때
-- 참가자 전원에게 재로그인을 안내하는 상황을 피하기 위해서입니다.
create or replace function public.reset_session(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception '권한이 없습니다.'; end if;

  delete from public.responses where session_id = p_session_id;

  update public.sessions
     set status = 'draft', current_slide_index = 0,
         started_at = null, current_slide_started_at = null, ended_at = null
   where id = p_session_id;
end;
$$;

-- 설문 복사. 문항만 복제하고 회차·참가자는 가져오지 않습니다.
create or replace function public.duplicate_survey(
  p_survey_id uuid,
  p_title     text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_new_id uuid;
  v_title  text;
begin
  if not public.is_admin() then raise exception '권한이 없습니다.'; end if;

  select coalesce(nullif(trim(p_title), ''), sv.title || ' (사본)')
    into v_title
  from public.surveys sv where sv.id = p_survey_id;

  if v_title is null then raise exception '원본 설문을 찾을 수 없습니다.'; end if;

  insert into public.surveys (title, owner_id)
  values (v_title, auth.uid())
  returning id into v_new_id;

  insert into public.slides (survey_id, order_index, type, title, body, options, multi, required)
  select v_new_id, order_index, type, title, body, options, multi, required
  from public.slides where survey_id = p_survey_id;

  return v_new_id;
end;
$$;

create or replace function public.admin_list_participants(p_session_id uuid)
returns table (
  id uuid, login_id text, passcode text, display_name text,
  connected boolean, last_seen_at timestamptz
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception '권한이 없습니다.'; end if;

  return query
  select p.id, p.login_id, p.passcode, p.display_name,
         (p.auth_user_id is not null), p.last_seen_at
  from public.participants p
  where p.session_id = p_session_id
  order by p.display_name;
end;
$$;

-- 설문 전체 결과를 내보낼 때 씁니다 (회차별 내보내기는 세션 id 로 직접 조회).
create or replace function public.admin_survey_participants(p_survey_id uuid)
returns table (
  id uuid, session_id uuid, session_name text,
  login_id text, passcode text, display_name text
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception '권한이 없습니다.'; end if;

  return query
  select p.id, p.session_id, s.name, p.login_id, p.passcode, p.display_name
  from public.participants p
  join public.sessions s on s.id = p.session_id
  where s.survey_id = p_survey_id
  order by s.created_at, p.display_name;
end;
$$;

-- ------------------------------------------------------------
-- 6. RLS
-- ------------------------------------------------------------

alter table public.admins       enable row level security;
alter table public.surveys      enable row level security;
alter table public.sessions     enable row level security;
alter table public.slides       enable row level security;
alter table public.participants enable row level security;
alter table public.responses    enable row level security;

drop policy if exists admins_self_read on public.admins;
create policy admins_self_read on public.admins
  for select to authenticated using (user_id = auth.uid());

drop policy if exists surveys_admin_all on public.surveys;
create policy surveys_admin_all on public.surveys
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 참가자는 자기 회차가 속한 설문의 제목만 읽으면 됩니다.
drop policy if exists surveys_participant_read on public.surveys;
create policy surveys_participant_read on public.surveys
  for select to authenticated
  using (
    id in (
      select s.survey_id from public.sessions s
      join public.participants p on p.session_id = s.id
      where p.auth_user_id = auth.uid()
    )
  );

drop policy if exists sessions_admin_all on public.sessions;
create policy sessions_admin_all on public.sessions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 자기가 배정된 회차만. 다른 회차는 보이지 않습니다.
drop policy if exists sessions_participant_read on public.sessions;
create policy sessions_participant_read on public.sessions
  for select to authenticated
  using (
    id = (select session_id from public.participants where auth_user_id = auth.uid())
  );

drop policy if exists slides_admin_all on public.slides;
create policy slides_admin_all on public.slides
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 자기 회차가 속한 설문의 문항 중, 지금까지 진행된 순번까지만.
drop policy if exists slides_participant_read on public.slides;
create policy slides_participant_read on public.slides
  for select to authenticated
  using (
    exists (
      select 1
      from public.participants p
      join public.sessions s on s.id = p.session_id
      where p.auth_user_id = auth.uid()
        and s.survey_id = slides.survey_id
        and s.status = 'live'
        and slides.order_index <= s.current_slide_index
    )
  );

drop policy if exists participants_admin_all on public.participants;
create policy participants_admin_all on public.participants
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists participants_self_read on public.participants;
create policy participants_self_read on public.participants
  for select to authenticated using (auth_user_id = auth.uid());

drop policy if exists responses_admin_all on public.responses;
create policy responses_admin_all on public.responses
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists responses_self_read on public.responses;
create policy responses_self_read on public.responses
  for select to authenticated
  using (participant_id = public.current_participant_id());

-- ------------------------------------------------------------
-- 7. 권한
-- ------------------------------------------------------------
-- 기본 권한 설정에 기대지 않고 필요한 것만 직접 부여합니다.
-- 참가자는 익명 로그인 후 authenticated 역할을 받으므로 anon 에는 아무것도
-- 주지 않습니다. 행 단위 통제는 위의 RLS 가 합니다.

grant usage on schema public to authenticated;

grant select, insert, update, delete on public.surveys   to authenticated;
grant select, insert, update, delete on public.sessions  to authenticated;
grant select, insert, update, delete on public.slides    to authenticated;
grant select, insert, update, delete on public.responses to authenticated;
grant select on public.admins to authenticated;

-- participants 는 passcode 를 뺀 열에만 select 를 부여합니다.
-- 열 단위 REVOKE 는 테이블 단위 권한을 걷어내지 못하므로, 처음부터 열을
-- 열거해 부여합니다.
grant select (id, session_id, login_id, display_name, auth_user_id,
              last_seen_at, created_at)
  on public.participants to authenticated;
grant insert, update, delete on public.participants to authenticated;

grant execute on function public.is_admin()                     to authenticated;
grant execute on function public.current_participant_id()       to authenticated;
grant execute on function public.claim_participant(text, text)  to authenticated;
grant execute on function public.submit_response(uuid, jsonb)   to authenticated;
grant execute on function public.submit_comment(uuid, text)     to authenticated;
grant execute on function public.start_session(uuid)            to authenticated;
grant execute on function public.move_slide(uuid, int)          to authenticated;
grant execute on function public.end_session(uuid)              to authenticated;
grant execute on function public.reset_session(uuid)            to authenticated;
grant execute on function public.duplicate_survey(uuid, text)   to authenticated;
grant execute on function public.admin_list_participants(uuid)  to authenticated;
grant execute on function public.admin_survey_participants(uuid) to authenticated;

-- ------------------------------------------------------------
-- 8. Realtime
-- ------------------------------------------------------------

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

-- 예전 함수 정리 (설문=1회 진행 구조에서 쓰던 것)
drop function if exists public.duplicate_session(uuid, text);
