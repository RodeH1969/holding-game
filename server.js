require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Supabase ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Load one combinations pool per game from combos/ ----------
// Each file in combos/ is named GAMECODE.txt and holds that game's own
// numbered combinations, e.g. combos/PIESVROOSR18.txt. This lets multiple
// games run at once, each drawing from its own player pool.
const COMBOS_DIR = path.join(__dirname, 'combos');
const gamesCombos = {}; // gameCode -> { combos: {1: [...], ...}, max: N, players: [...] }

if (!fs.existsSync(COMBOS_DIR)) {
  console.error(`WARNING: combos/ folder not found at ${COMBOS_DIR}.`);
  console.error('The server will start, but every /api/enter request will fail with "Unknown game code" until this is fixed.');
  console.error('Check that the combos/ folder (with your GAMECODE.txt files inside) was committed and pushed to GitHub.');
} else {
  for (const filename of fs.readdirSync(COMBOS_DIR)) {
    if (!filename.endsWith('.txt')) continue;
    const gameCode = filename.replace(/\.txt$/, '').toUpperCase();
    const rawLines = fs.readFileSync(path.join(COMBOS_DIR, filename), 'utf8').split('\n').filter(Boolean);

    // Instead of storing each combo as 4 full player-name strings (which
    // duplicates the same ~46 names hundreds of thousands of times and
    // eats huge amounts of memory across several large games at once),
    // store a shared list of unique player names and have each combo just
    // reference 4 small index numbers into that list.
    const playerToIndex = new Map();
    const playerList = [];
    const combos = { 0: null };

    rawLines.forEach((line, idx) => {
      // Handle Windows line endings (\r\n) leaving a trailing \r.
      const clean = line.replace(/\r$/, '');
      // Strip a leading "N. " if present, but always index by line
      // position — don't trust the embedded number, since some combo
      // files have it and some don't.
      const stripped = clean.replace(/^\d+\.\s*/, '');
      // Some files use "|" to separate players, others use ",". Detect
      // whichever this file actually uses.
      const delimiter = stripped.includes('|') ? '|' : ',';
      const players = stripped.split(delimiter).map((p) => p.trim()).filter(Boolean);
      if (players.length !== 4) return;

      combos[idx + 1] = players.map((p) => {
        let i = playerToIndex.get(p);
        if (i === undefined) {
          i = playerList.length;
          playerList.push(p);
          playerToIndex.set(p, i);
        }
        return i;
      });
    });

    const sortedPlayers = [...playerList].sort();

    gamesCombos[gameCode] = { combos, max: rawLines.length, players: sortedPlayers, playerList };
    console.log(`Loaded ${rawLines.length} combinations for ${gameCode}`);
  }
}

// ---------- Phone normalisation ----------
// Accepts 04XXXXXXXX or 614XXXXXXXX (with or without +/spaces/dashes)
// Returns normalised form "614XXXXXXXX" or null if invalid.
function normalisePhone(input) {
  if (!input) return null;
  let raw = String(input).replace(/[\s\-()]/g, '');
  if (raw.startsWith('+')) raw = raw.slice(1);

  if (/^614\d{8}$/.test(raw)) return raw;
  if (/^04\d{8}$/.test(raw)) return '61' + raw.slice(1);
  return null;
}

// ---------- Entry endpoint ----------
app.post('/api/enter', async (req, res) => {
  try {
    const gameCode = String(req.body.game_code || '').trim().toUpperCase();
    const phone = normalisePhone(req.body.phone);
    const handle = String(req.body.handle || '').trim();

    if (!gameCode) {
      return res.status(400).json({ error: 'Enter a game code.' });
    }
    if (!phone) {
      return res.status(400).json({ error: 'Enter a valid mobile number (04... or 614...).' });
    }
    if (!handle) {
      return res.status(400).json({ error: 'Enter a handle (name shown on the leaderboard).' });
    }

    const gameData = gamesCombos[gameCode];
    if (!gameData) {
      return res.status(404).json({ error: 'Unknown game code.' });
    }

    // Already entered this game with this phone? Return the same combo again.
    const { data: existing, error: existingErr } = await supabase
      .from('holding_entries')
      .select('combo_index, combo_text')
      .eq('game_code', gameCode)
      .eq('phone', phone)
      .maybeSingle();

    if (existingErr) throw existingErr;

    if (existing) {
      return res.json({ players: existing.combo_text.split('|') });
    }

    // Atomically claim the next index for this game
    const { data: nextIndex, error: rpcErr } = await supabase.rpc('holding_next_index', {
      p_game_code: gameCode,
    });
    if (rpcErr) {
      if (String(rpcErr.message || '').includes('GAME_CLOSED')) {
        return res.status(403).json({ error: 'Entries are closed for this game — it has already started.' });
      }
      throw rpcErr;
    }

    if (nextIndex > gameData.max) {
      return res.status(409).json({ error: 'All combinations for this game have been given out.' });
    }

    const comboIndices = gameData.combos[nextIndex];
    if (!comboIndices) {
      return res.status(500).json({ error: 'Combination lookup failed.' });
    }
    const players = comboIndices.map((i) => gameData.playerList[i]);

    const { error: insertErr } = await supabase.from('holding_entries').insert({
      game_code: gameCode,
      phone,
      handle,
      combo_index: nextIndex,
      combo_text: players.join('|'),
    });
    if (insertErr) throw insertErr;

    return res.json({ players });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

// ---------- Public: check a game's status (for the entry-page badge) ----------
app.get('/api/game-status/:code', async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const { data, error } = await supabase
    .from('holding_games')
    .select('status')
    .eq('game_code', gameCode)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  // A game that hasn't had its first entry yet doesn't have a row —
  // treat that as open, since it will open on first use.
  res.json({ game_code: gameCode, status: data ? data.status : 'open' });
});

// ---------- Public: list every game code that's ever been used (for the leaderboard dropdown) ----------
app.get('/api/games', async (req, res) => {
  const { data, error } = await supabase
    .from('holding_games')
    .select('game_code, status, display_name, round, event_datetime, created_at')
    .order('event_datetime', { ascending: true, nullsFirst: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- Public: leaderboard for a game (auto-computed from Quarter Winners) ----------
app.get('/api/leaderboard/:code', async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const { data, error } = await supabase
    .from('holding_quarter_leaders')
    .select('handle, quarter')
    .eq('game_code', gameCode)
    .not('handle', 'is', null);

  if (error) return res.status(500).json({ error: error.message });

  // Points are weighted by which quarter was won: Q1 = 1pt, Q2 = 2pts,
  // Q3 = 3pts, Q4 = 4pts — not a flat 1 point per quarter win.
  const totals = {};
  for (const row of data) {
    totals[row.handle] = (totals[row.handle] || 0) + row.quarter;
  }

  const leaderboard = Object.entries(totals)
    .map(([handle, points]) => ({ handle, points }))
    .sort((a, b) => b.points - a.points || a.handle.localeCompare(b.handle));

  res.json(leaderboard);
});

// ---------- Public: registered handles for a game (no phone numbers) ----------
app.get('/api/registered/:code', async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const { data, error } = await supabase
    .from('holding_entries')
    .select('handle')
    .eq('game_code', gameCode);

  if (error) return res.status(500).json({ error: error.message });
  const handles = [...new Set(data.map((r) => r.handle).filter(Boolean))].sort();
  res.json(handles);
});

// ---------- Public: prize claim status for a game ----------
app.get('/api/prize-claims/:code', async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const { data, error } = await supabase
    .from('holding_prize_claims')
    .select('handle, claimed')
    .eq('game_code', gameCode);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- Public: Prize 2 winner - all 4 of a handle's players were each
// the holding player in some quarter of this game ----------
app.get('/api/prize2-winner/:code', async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();

  const { data: quarters, error: qErr } = await supabase
    .from('holding_quarter_leaders')
    .select('holding_player')
    .eq('game_code', gameCode)
    .not('holding_player', 'is', null);

  if (qErr) return res.status(500).json({ error: qErr.message });

  const holdingSet = new Set(quarters.map((q) => q.holding_player));
  // Need exactly 4 distinct players recorded as holding across the quarters
  // for it to even be possible that one entrant's whole combo was covered.
  if (holdingSet.size !== 4) {
    return res.json({ winner: null });
  }

  const { data: entries, error: eErr } = await supabase
    .from('holding_entries')
    .select('handle, combo_text')
    .eq('game_code', gameCode);

  if (eErr) return res.status(500).json({ error: eErr.message });

  for (const entry of entries) {
    const comboPlayers = entry.combo_text.split('|').map((p) => p.trim());
    if (comboPlayers.length === 4 && comboPlayers.every((p) => holdingSet.has(p))) {
      return res.json({ winner: entry.handle });
    }
  }

  res.json({ winner: null });
});

// ---------- Public: quarter-by-quarter leaders ----------
app.get('/api/quarter-leaders/:code', async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const { data, error } = await supabase
    .from('holding_quarter_leaders')
    .select('quarter, handle, holding_player, updated_at')
    .eq('game_code', gameCode)
    .order('quarter', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- Admin auth ----------
function checkAdminPassword(req, res, next) {
  const pw = req.query.pw || req.headers['x-admin-password'];
  if (!process.env.ADMIN_PASSWORD || pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).send('Unauthorised');
  }
  next();
}

// List of game codes + entry counts + status (for the admin page)
app.get('/admin/games', checkAdminPassword, async (req, res) => {
  const { data, error } = await supabase
    .from('holding_games')
    .select('game_code, current_index, status, display_name, round, event_datetime')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Admin: create a new game or update an existing game's display info
// (name/round/date). Does NOT touch status or current_index if the game
// already exists — only the display metadata.
app.post('/admin/games', checkAdminPassword, async (req, res) => {
  const gameCode = String(req.body.game_code || '').trim().toUpperCase();
  const displayName = String(req.body.display_name || '').trim() || null;
  const round = String(req.body.round || '').trim() || null;
  const eventDatetime = req.body.event_datetime ? new Date(req.body.event_datetime).toISOString() : null;

  if (!gameCode) {
    return res.status(400).json({ error: 'game_code is required.' });
  }

  const { data: existing, error: fetchErr } = await supabase
    .from('holding_games')
    .select('game_code')
    .eq('game_code', gameCode)
    .maybeSingle();

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  if (existing) {
    // Editing an already-known game (e.g. fixing its display name/round) —
    // doesn't need the combos file to still exist, since it's not being
    // used to hand out new entries by this action.
    const { error } = await supabase
      .from('holding_games')
      .update({ display_name: displayName, round, event_datetime: eventDatetime })
      .eq('game_code', gameCode);
    if (error) return res.status(500).json({ error: error.message });
  } else {
    // Creating a brand new game — this one does need a real combos file,
    // otherwise there'd be nothing to hand out when people register.
    if (!gamesCombos[gameCode]) {
      return res.status(400).json({ error: `No combos file found for ${gameCode}. Add combos/${gameCode}.txt and restart the server first.` });
    }
    const { error } = await supabase
      .from('holding_games')
      .insert({
        game_code: gameCode,
        current_index: 0,
        status: 'open',
        display_name: displayName,
        round,
        event_datetime: eventDatetime,
      });
    if (error) return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true });
});

// Open or close entries for a game code
app.post('/admin/games/:code/status', checkAdminPassword, async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const status = req.body.status === 'closed' ? 'closed' : 'open';

  const { error } = await supabase
    .from('holding_games')
    .update({ status })
    .eq('game_code', gameCode);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ game_code: gameCode, status });
});

// Admin: full list of players for a specific game (for the "Player Holding Ball" dropdown)
app.get('/admin/players/:code', checkAdminPassword, (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const gameData = gamesCombos[gameCode];
  if (!gameData) return res.status(404).json({ error: 'Unknown game code.' });
  res.json(gameData.players);
});

// Admin: distinct handles registered for a game (for the "Handle" dropdown)
app.get('/admin/handles/:code', checkAdminPassword, async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const { data, error } = await supabase
    .from('holding_entries')
    .select('handle')
    .eq('game_code', gameCode);

  if (error) return res.status(500).json({ error: error.message });
  const handles = [...new Set(data.map((r) => r.handle).filter(Boolean))].sort();
  res.json(handles);
});

// Admin: set/update the leader for a given quarter
app.post('/admin/quarter-leaders', checkAdminPassword, async (req, res) => {
  const gameCode = String(req.body.game_code || '').trim().toUpperCase();
  const quarter = parseInt(req.body.quarter, 10);
  // Both handle and holding_player are independently optional now:
  // - holding_player blank/absent = nobody was holding the ball
  // - handle blank/absent = nobody's combo won, even if a player was holding it
  const handle = String(req.body.handle || '').trim() || null;
  const holdingPlayer = String(req.body.holding_player || '').trim() || null;

  if (!gameCode || ![1, 2, 3, 4].includes(quarter)) {
    return res.status(400).json({ error: 'game_code and quarter (1-4) are required.' });
  }

  const { error } = await supabase
    .from('holding_quarter_leaders')
    .upsert(
      {
        game_code: gameCode,
        quarter,
        handle,
        holding_player: holdingPlayer,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'game_code,quarter' }
    );

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Admin: clear a quarter's leader
app.delete('/admin/quarter-leaders/:code/:quarter', checkAdminPassword, async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const quarter = parseInt(req.params.quarter, 10);

  const { error } = await supabase
    .from('holding_quarter_leaders')
    .delete()
    .eq('game_code', gameCode)
    .eq('quarter', quarter);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Admin: mark whether a handle claimed their prize
app.post('/admin/prize-claims', checkAdminPassword, async (req, res) => {
  const gameCode = String(req.body.game_code || '').trim().toUpperCase();
  const handle = String(req.body.handle || '').trim();
  const claimed = req.body.claimed === true || req.body.claimed === 'true';

  if (!gameCode || !handle) {
    return res.status(400).json({ error: 'game_code and handle are required.' });
  }

  const { error } = await supabase
    .from('holding_prize_claims')
    .upsert(
      { game_code: gameCode, handle, claimed, updated_at: new Date().toISOString() },
      { onConflict: 'game_code,handle' }
    );

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Download an .xlsx snapshot of entries. game_code=ALL for everything.
app.get('/admin/export.xlsx', checkAdminPassword, async (req, res) => {
  try {
    const gameCode = String(req.query.game_code || 'ALL').trim().toUpperCase();

    let query = supabase
      .from('holding_entries')
      .select('game_code, phone, handle, combo_text, created_at')
      .order('created_at', { ascending: true });

    if (gameCode !== 'ALL') {
      query = query.eq('game_code', gameCode);
    }

    const { data, error } = await query;
    if (error) throw error;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Entries');
    sheet.columns = [
      { header: 'Game Code', key: 'game_code', width: 14 },
      { header: 'Handle', key: 'handle', width: 16 },
      { header: 'Phone', key: 'phone', width: 16 },
      { header: 'Player 1', key: 'p1', width: 20 },
      { header: 'Player 2', key: 'p2', width: 20 },
      { header: 'Player 3', key: 'p3', width: 20 },
      { header: 'Player 4', key: 'p4', width: 20 },
      { header: 'Entered At', key: 'created_at', width: 22 },
    ];
    sheet.getRow(1).font = { bold: true };

    for (const row of data) {
      const [p1, p2, p3, p4] = row.combo_text.split('|');
      sheet.addRow({
        game_code: row.game_code,
        handle: row.handle || '',
        phone: row.phone,
        p1,
        p2,
        p3,
        p4,
        created_at: new Date(row.created_at).toLocaleString('en-AU'),
      });
    }

    const filename = `holding-entries-${gameCode}-${Date.now()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Export failed.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HOLDING app listening on port ${PORT}`));
