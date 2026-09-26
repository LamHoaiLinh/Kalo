-- Kalo v1.7: synced preferences, unread counts, media storage, file relay and realtime.
-- Idempotent migration. Applied to project family-farm-online on 2026-09-26.

create table if not exists public.kalo_contact_aliases (
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_user_id uuid not null references auth.users(id) on delete cascade,
  alias text not null check (char_length(alias) between 1 and 60),
  updated_at timestamptz not null default now(),
  primary key (user_id, contact_user_id),
  check (user_id <> contact_user_id)
);

create table if not exists public.kalo_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  color text not null default '#43c77a' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists kalo_categories_user_sort_idx
  on public.kalo_categories(user_id, sort_order, created_at);

create table if not exists public.kalo_conversation_prefs (
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.kalo_conversations(id) on delete cascade,
  category_id uuid references public.kalo_categories(id) on delete set null,
  pinned boolean not null default false,
  muted boolean not null default false,
  archived boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, conversation_id)
);
create index if not exists kalo_conversation_prefs_user_idx
  on public.kalo_conversation_prefs(user_id, updated_at desc);

create table if not exists public.kalo_message_pins (
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.kalo_conversations(id) on delete cascade,
  message_id uuid not null references public.kalo_messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);
create index if not exists kalo_message_pins_conversation_idx
  on public.kalo_message_pins(user_id, conversation_id, created_at desc);

create table if not exists public.kalo_file_relays (
  id uuid primary key,
  conversation_id uuid not null references public.kalo_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists kalo_file_relays_sender_exp_idx
  on public.kalo_file_relays(sender_id, expires_at);

alter table public.kalo_contact_aliases enable row level security;
alter table public.kalo_categories enable row level security;
alter table public.kalo_conversation_prefs enable row level security;
alter table public.kalo_message_pins enable row level security;
alter table public.kalo_file_relays enable row level security;

drop policy if exists "kalo aliases self select" on public.kalo_contact_aliases;
create policy "kalo aliases self select" on public.kalo_contact_aliases for select using (user_id = (select auth.uid()));
drop policy if exists "kalo aliases self insert" on public.kalo_contact_aliases;
create policy "kalo aliases self insert" on public.kalo_contact_aliases for insert with check (user_id = (select auth.uid()));
drop policy if exists "kalo aliases self update" on public.kalo_contact_aliases;
create policy "kalo aliases self update" on public.kalo_contact_aliases for update
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "kalo aliases self delete" on public.kalo_contact_aliases;
create policy "kalo aliases self delete" on public.kalo_contact_aliases for delete using (user_id = (select auth.uid()));

drop policy if exists "kalo categories self select" on public.kalo_categories;
create policy "kalo categories self select" on public.kalo_categories for select using (user_id = (select auth.uid()));
drop policy if exists "kalo categories self insert" on public.kalo_categories;
create policy "kalo categories self insert" on public.kalo_categories for insert with check (user_id = (select auth.uid()));
drop policy if exists "kalo categories self update" on public.kalo_categories;
create policy "kalo categories self update" on public.kalo_categories for update
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "kalo categories self delete" on public.kalo_categories;
create policy "kalo categories self delete" on public.kalo_categories for delete using (user_id = (select auth.uid()));

drop policy if exists "kalo conversation prefs self select" on public.kalo_conversation_prefs;
create policy "kalo conversation prefs self select" on public.kalo_conversation_prefs for select using (user_id = (select auth.uid()));
drop policy if exists "kalo conversation prefs self insert" on public.kalo_conversation_prefs;
create policy "kalo conversation prefs self insert" on public.kalo_conversation_prefs for insert with check (
  user_id = (select auth.uid())
  and (private.kalo_is_member(conversation_id, (select auth.uid()))
       or private.kalo_is_owner(conversation_id, (select auth.uid())))
);
drop policy if exists "kalo conversation prefs self update" on public.kalo_conversation_prefs;
create policy "kalo conversation prefs self update" on public.kalo_conversation_prefs for update
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (private.kalo_is_member(conversation_id, (select auth.uid()))
         or private.kalo_is_owner(conversation_id, (select auth.uid())))
  );
drop policy if exists "kalo conversation prefs self delete" on public.kalo_conversation_prefs;
create policy "kalo conversation prefs self delete" on public.kalo_conversation_prefs for delete using (user_id = (select auth.uid()));

drop policy if exists "kalo message pins self select" on public.kalo_message_pins;
create policy "kalo message pins self select" on public.kalo_message_pins for select using (user_id = (select auth.uid()));
drop policy if exists "kalo message pins self insert" on public.kalo_message_pins;
create policy "kalo message pins self insert" on public.kalo_message_pins for insert with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.kalo_messages m
    where m.id = message_id
      and m.conversation_id = conversation_id
      and (private.kalo_is_member(m.conversation_id, (select auth.uid()))
           or private.kalo_is_owner(m.conversation_id, (select auth.uid())))
  )
);
drop policy if exists "kalo message pins self delete" on public.kalo_message_pins;
create policy "kalo message pins self delete" on public.kalo_message_pins for delete using (user_id = (select auth.uid()));

drop policy if exists "kalo relays members select" on public.kalo_file_relays;
create policy "kalo relays members select" on public.kalo_file_relays for select using (
  private.kalo_is_member(conversation_id, (select auth.uid()))
  or private.kalo_is_owner(conversation_id, (select auth.uid()))
);
drop policy if exists "kalo relays sender insert" on public.kalo_file_relays;
create policy "kalo relays sender insert" on public.kalo_file_relays for insert with check (
  sender_id = (select auth.uid())
  and (private.kalo_is_member(conversation_id, (select auth.uid()))
       or private.kalo_is_owner(conversation_id, (select auth.uid())))
);
drop policy if exists "kalo relays sender delete" on public.kalo_file_relays;
create policy "kalo relays sender delete" on public.kalo_file_relays for delete using (sender_id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kalo-avatars','kalo-avatars',true,2097152,array['image/jpeg','image/png','image/webp']::text[])
on conflict (id) do update
set public=excluded.public, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kalo-small-files','kalo-small-files',false,10485760,null)
on conflict (id) do update set public=excluded.public, file_size_limit=excluded.file_size_limit;

create or replace function private.kalo_storage_conversation_access(object_name text, p_user uuid)
returns boolean
language plpgsql stable security definer
set search_path = public, private
as $$
declare v_conversation uuid;
begin
  v_conversation := split_part(object_name, '/', 1)::uuid;
  return private.kalo_is_member(v_conversation, p_user)
      or private.kalo_is_owner(v_conversation, p_user);
exception when others then return false;
end;
$$;

drop policy if exists "kalo avatars authenticated read" on storage.objects;
create policy "kalo avatars authenticated read" on storage.objects for select using (bucket_id='kalo-avatars');
drop policy if exists "kalo avatars own insert" on storage.objects;
create policy "kalo avatars own insert" on storage.objects for insert with check (
  bucket_id='kalo-avatars' and split_part(name,'/',1)=(select auth.uid())::text
);
drop policy if exists "kalo avatars own update" on storage.objects;
create policy "kalo avatars own update" on storage.objects for update using (
  bucket_id='kalo-avatars' and split_part(name,'/',1)=(select auth.uid())::text
) with check (
  bucket_id='kalo-avatars' and split_part(name,'/',1)=(select auth.uid())::text
);
drop policy if exists "kalo avatars own delete" on storage.objects;
create policy "kalo avatars own delete" on storage.objects for delete using (
  bucket_id='kalo-avatars' and split_part(name,'/',1)=(select auth.uid())::text
);

drop policy if exists "kalo small files members select" on storage.objects;
create policy "kalo small files members select" on storage.objects for select using (
  bucket_id='kalo-small-files' and private.kalo_storage_conversation_access(name,(select auth.uid()))
);
drop policy if exists "kalo small files members insert" on storage.objects;
create policy "kalo small files members insert" on storage.objects for insert with check (
  bucket_id='kalo-small-files' and private.kalo_storage_conversation_access(name,(select auth.uid()))
);
drop policy if exists "kalo small files members update" on storage.objects;
create policy "kalo small files members update" on storage.objects for update using (
  bucket_id='kalo-small-files' and private.kalo_storage_conversation_access(name,(select auth.uid()))
) with check (
  bucket_id='kalo-small-files' and private.kalo_storage_conversation_access(name,(select auth.uid()))
);
drop policy if exists "kalo small files members delete" on storage.objects;
create policy "kalo small files members delete" on storage.objects for delete using (
  bucket_id='kalo-small-files' and private.kalo_storage_conversation_access(name,(select auth.uid()))
);

create or replace function public.kalo_unread_counts()
returns table(conversation_id uuid, unread_count bigint)
language sql stable security invoker set search_path=public
as $$
  select c.id, count(m.id)::bigint
  from public.kalo_conversations c
  join public.kalo_conversation_members cm on cm.conversation_id=c.id and cm.user_id=auth.uid()
  left join public.kalo_reads r on r.conversation_id=c.id and r.user_id=auth.uid()
  left join public.kalo_messages m on m.conversation_id=c.id
    and m.sender_id<>auth.uid()
    and m.deleted_at is null
    and m.created_at>coalesce(r.read_at,'-infinity'::timestamptz)
  group by c.id;
$$;
grant execute on function public.kalo_unread_counts() to authenticated;

create or replace function public.kalo_latest_messages()
returns table(
  id uuid, conversation_id uuid, sender_id uuid, kind text, encrypted_payloads jsonb,
  created_at timestamptz, edited_at timestamptz, deleted_at timestamptz
)
language sql stable security invoker set search_path=public
as $$
  select distinct on (m.conversation_id)
    m.id,m.conversation_id,m.sender_id,m.kind,m.encrypted_payloads,m.created_at,m.edited_at,m.deleted_at
  from public.kalo_messages m
  order by m.conversation_id,m.created_at desc;
$$;
grant execute on function public.kalo_latest_messages() to authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'kalo_profiles','kalo_reads','kalo_contact_aliases','kalo_categories',
    'kalo_conversation_prefs','kalo_message_pins','kalo_conversations',
    'kalo_conversation_members','kalo_file_relays'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I',t);
    end if;
  end loop;
end $$;
