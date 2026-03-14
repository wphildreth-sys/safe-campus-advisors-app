create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  organization_name text,
  role text default 'assessor',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assessments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  status text not null default 'Draft' check (status in ('Draft', 'Finalized')),
  school_name text,
  district text,
  address text,
  principal text,
  assessor text,
  assessment_date date,
  summary text,
  priority_actions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assessment_items (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  area text not null check (area in ('inside', 'outside')),
  section_id text not null,
  section_title text not null,
  label text not null,
  response text not null default 'Not Observed' check (response in ('Compliant', 'Needs Improvement', 'Critical Concern', 'Not Observed', 'N/A')),
  risk text not null default 'Medium' check (risk in ('Low', 'Medium', 'High')),
  notes text,
  gps_latitude double precision,
  gps_longitude double precision,
  gps_accuracy double precision,
  gps_captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assessment_files (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  assessment_item_id uuid not null references public.assessment_items(id) on delete cascade,
  file_name text not null,
  storage_path text not null unique,
  public_url text,
  mime_type text,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists set_assessments_updated_at on public.assessments;
create trigger set_assessments_updated_at before update on public.assessments for each row execute function public.set_updated_at();
drop trigger if exists set_assessment_items_updated_at on public.assessment_items;
create trigger set_assessment_items_updated_at before update on public.assessment_items for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.assessments enable row level security;
alter table public.assessment_items enable row level security;
alter table public.assessment_files enable row level security;

create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);
create policy "Users can view own assessments" on public.assessments for select using (auth.uid() = owner_id);
create policy "Users can insert own assessments" on public.assessments for insert with check (auth.uid() = owner_id);
create policy "Users can update own assessments" on public.assessments for update using (auth.uid() = owner_id);
create policy "Users can delete own assessments" on public.assessments for delete using (auth.uid() = owner_id);
create policy "Users can view own assessment items" on public.assessment_items for select using (exists (select 1 from public.assessments a where a.id = assessment_items.assessment_id and a.owner_id = auth.uid()));
create policy "Users can insert own assessment items" on public.assessment_items for insert with check (exists (select 1 from public.assessments a where a.id = assessment_items.assessment_id and a.owner_id = auth.uid()));
create policy "Users can update own assessment items" on public.assessment_items for update using (exists (select 1 from public.assessments a where a.id = assessment_items.assessment_id and a.owner_id = auth.uid()));
create policy "Users can delete own assessment items" on public.assessment_items for delete using (exists (select 1 from public.assessments a where a.id = assessment_items.assessment_id and a.owner_id = auth.uid()));
create policy "Users can view own assessment files" on public.assessment_files for select using (exists (select 1 from public.assessments a where a.id = assessment_files.assessment_id and a.owner_id = auth.uid()));
create policy "Users can insert own assessment files" on public.assessment_files for insert with check (exists (select 1 from public.assessments a where a.id = assessment_files.assessment_id and a.owner_id = auth.uid()));
create policy "Users can delete own assessment files" on public.assessment_files for delete using (exists (select 1 from public.assessments a where a.id = assessment_files.assessment_id and a.owner_id = auth.uid()));
