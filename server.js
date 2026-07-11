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

    const combos = { 0: null };
    for (const line of rawLines) {
      const dotIdx = line.indexOf('.');
      const n = parseInt(line.slice(0, dotIdx), 10);
      const players = line.slice(dotIdx + 1).split('|').map((p) => p.trim());
      combos[n] = players;
    }

    const players = [...new Set(Object.values(combos).filter(Boolean).flat())].sort();

    gamesCombos[gameCode] = { combos, max: rawLines.length, players };
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

    const players = gameData.combos[nextIndex];
    if (!players) {
      return res.status(500).json({ error: 'Combination lookup failed.' });
    }

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

// ---------- Public: leaderboard for a game (auto-computed from Quarter Winners) ----------
app.get('/api/leaderboard/:code', async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const { data, error } = await supabase
    .from('holding_quarter_leaders')
    .select('handle')
    .eq('game_code', gameCode)
    .not('handle', 'is', null);

  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  for (const row of data) {
    counts[row.handle] = (counts[row.handle] || 0) + 1;
  }

  const leaderboard = Object.entries(counts)
    .map(([handle, points]) => ({ handle, points }))
    .sort((a, b) => b.points - a.points || a.handle.localeCompare(b.handle));

  res.json(leaderboard);
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
    .select('game_code, current_index, status')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
  const noLeader = req.body.no_leader === true || req.body.no_leader === 'true';
  const handle = noLeader ? null : String(req.body.handle || '').trim();
  const holdingPlayer = noLeader ? null : (String(req.body.holding_player || '').trim() || null);

  if (!gameCode || ![1, 2, 3, 4].includes(quarter)) {
    return res.status(400).json({ error: 'game_code and quarter (1-4) are required.' });
  }
  if (!noLeader && !handle) {
    return res.status(400).json({ error: 'Enter a handle, or tick "No leader this quarter".' });
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
