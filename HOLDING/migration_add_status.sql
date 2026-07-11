-- Run this in the Supabase SQL editor. Safe to run even if you already
-- created the original tables — it only adds what's new.

alter table holding_games
  add column if not exists status text not null default 'open';

alter table holding_games
  drop constraint if exists holding_games_status_check;

alter table holding_games
  add constraint holding_games_status_check check (status in ('open', 'closed'));

-- Replace the function so it refuses to hand out combos once a game is closed.
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
