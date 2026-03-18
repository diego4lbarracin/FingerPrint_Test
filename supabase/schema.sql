create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  lastname text not null,
  email text not null,
  fingerprint_template text,
  enrolled_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists users_email_lower_idx
  on public.users ((lower(email)));

create table if not exists public.auth_logs (
  id bigint generated always as identity primary key,
  matched_user_id uuid references public.users(id) on delete set null,
  match_score double precision not null,
  success boolean not null,
  attempted_at timestamptz not null default now()
);

create index if not exists auth_logs_attempted_at_idx
  on public.auth_logs (attempted_at desc);

create index if not exists auth_logs_success_idx
  on public.auth_logs (success);
