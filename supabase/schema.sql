create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  last_name text not null,
  email text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists app_users_email_lower_idx on app_users ((lower(email)));

create table if not exists fingerprint_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references app_users(id) on delete cascade,
  sample_format integer not null,
  template_data text not null,
  template_sha256 text not null,
  device_id text,
  quality_code integer,
  created_at timestamptz not null default now()
);

create index if not exists fingerprint_templates_hash_idx on fingerprint_templates (template_sha256);

create table if not exists auth_attempts (
  id bigint generated always as identity primary key,
  matched_user_id uuid references app_users(id) on delete set null,
  probe_template_sha256 text not null,
  match_score double precision,
  success boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists auth_attempts_created_at_idx on auth_attempts (created_at desc);
create index if not exists auth_attempts_success_idx on auth_attempts (success);
