-- Run this in the Supabase SQL editor.
alter table holding_leaderboard
  add column if not exists holding_player text;
