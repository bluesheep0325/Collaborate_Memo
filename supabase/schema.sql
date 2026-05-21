create table if not exists public.memo_rooms (
  room_id text primary key,
  active_page_id text not null,
  pages jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists memo_rooms_updated_at_idx
  on public.memo_rooms (updated_at);

alter table public.memo_rooms enable row level security;
