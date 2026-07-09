-- Run this in the Supabase SQL editor.

-- Handle (nickname) captured at registration, shown on the public leaderboard
-- instead of phone numbers.
alter table holding_entries
  add column if not exists handle text;

-- Leaderboard: Games Master manually posts/updates standings per game code.
create table if not exists holding_leaderboard (
  id bigint generated always as identity primary key,
  game_code text not null,
  handle text not null,
  points integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (game_code, handle)
);

create index if not exists idx_holding_leaderboard_game_code on holding_leaderboard(game_code);
