-- HOLDING app schema
-- Run this in the Supabase SQL editor for your project.

create table if not exists holding_games (
  game_code text primary key,
  current_index integer not null default 0,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now()
);

create table if not exists holding_entries (
  id bigint generated always as identity primary key,
  game_code text not null references holding_games(game_code),
  phone text not null,
  combo_index integer not null,
  combo_text text not null,
  created_at timestamptz not null default now(),
  unique (game_code, phone)
);

create index if not exists idx_holding_entries_game_code on holding_entries(game_code);

-- Atomically claims the next combination index for a game, creating the
-- game row on first use. Safe under concurrent requests because the
-- UPDATE...RETURNING is a single atomic statement per row in Postgres.
create or replace function holding_next_index(p_game_code text)
returns integer
language plpgsql
as $$
declare
  v_index integer;
  v_status text;
begin
  insert into holding_games (game_code, current_index, status)
  values (p_game_code, 0, 'open')
  on conflict (game_code) do nothing;

  select status into v_status from holding_games where game_code = p_game_code;
  if v_status = 'closed' then
    raise exception 'GAME_CLOSED';
  end if;

  update holding_games
  set current_index = current_index + 1
  where game_code = p_game_code
  returning current_index into v_index;

  return v_index;
end;
$$;
