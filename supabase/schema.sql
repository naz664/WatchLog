-- WatchLog Cloud Sync schema
-- Run this entire file in Supabase Dashboard -> SQL Editor.
-- The browser uses only the Project URL + Publishable Key.
-- NEVER put a Supabase secret/service_role key in WatchLog.

create table if not exists public.watchlog_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists watchlog_items_user_updated_idx
  on public.watchlog_items (user_id, updated_at);

alter table public.watchlog_items enable row level security;

grant select, insert, update, delete
  on table public.watchlog_items
  to authenticated;

drop policy if exists "WatchLog users can read their own rows" on public.watchlog_items;
create policy "WatchLog users can read their own rows"
  on public.watchlog_items
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "WatchLog users can insert their own rows" on public.watchlog_items;
create policy "WatchLog users can insert their own rows"
  on public.watchlog_items
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "WatchLog users can update their own rows" on public.watchlog_items;
create policy "WatchLog users can update their own rows"
  on public.watchlog_items
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "WatchLog users can delete their own rows" on public.watchlog_items;
create policy "WatchLog users can delete their own rows"
  on public.watchlog_items
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Optional helper trigger: keeps updated_at current when rows are changed
create or replace function public.watchlog_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists watchlog_items_updated_at on public.watchlog_items;
create trigger watchlog_items_updated_at
before update on public.watchlog_items
for each row execute function public.watchlog_set_updated_at();
