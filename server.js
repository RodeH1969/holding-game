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

// ---------- Load combinations once at startup ----------
const COMBOS_PATH = path.join(__dirname, 'combinations.txt');
const rawLines = fs.readFileSync(COMBOS_PATH, 'utf8').split('\n').filter(Boolean);

// combos[1] => array of 4 player strings, matches the "N." numbering in the file
const combos = { 0: null };
for (const line of rawLines) {
  const dotIdx = line.indexOf('.');
  const n = parseInt(line.slice(0, dotIdx), 10);
  const players = line
    .slice(dotIdx + 1)
    .split('|')
    .map((p) => p.trim());
  combos[n] = players;
}
const MAX_COMBO_INDEX = rawLines.length;
console.log(`Loaded ${MAX_COMBO_INDEX} combinations`);

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

    if (nextIndex > MAX_COMBO_INDEX) {
      return res.status(409).json({ error: 'All combinations for this game have been given out.' });
    }

    const players = combos[nextIndex];
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

// ---------- Public: leaderboard for a game ----------
app.get('/api/leaderboard/:code', async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const { data, error } = await supabase
    .from('holding_leaderboard')
    .select('handle, points, holding_player, updated_at')
    .eq('game_code', gameCode)
    .order('points', { ascending: false })
    .order('updated_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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

// Admin: view leaderboard for a game (same data as public endpoint, kept
// separate so the admin page doesn't depend on the public route's shape)
app.get('/admin/leaderboard/:code', checkAdminPassword, async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const { data, error } = await supabase
    .from('holding_leaderboard')
    .select('handle, points, holding_player, updated_at')
    .eq('game_code', gameCode)
    .order('points', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Admin: add or update a handle's points for a game
app.post('/admin/leaderboard', checkAdminPassword, async (req, res) => {
  const gameCode = String(req.body.game_code || '').trim().toUpperCase();
  const handle = String(req.body.handle || '').trim();
  const pointsToAdd = parseInt(req.body.points, 10);
  const holdingPlayer = String(req.body.holding_player || '').trim();

  if (!gameCode || !handle || Number.isNaN(pointsToAdd)) {
    return res.status(400).json({ error: 'game_code, handle, and points are required.' });
  }

  // Look up whatever's already there so we ADD to it, not overwrite it.
  const { data: existing, error: fetchErr } = await supabase
    .from('holding_leaderboard')
    .select('points')
    .eq('game_code', gameCode)
    .eq('handle', handle)
    .maybeSingle();

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  const newTotal = (existing ? existing.points : 0) + pointsToAdd;

  const { error } = await supabase
    .from('holding_leaderboard')
    .upsert(
      {
        game_code: gameCode,
        handle,
        points: newTotal,
        holding_player: holdingPlayer || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'game_code,handle' }
    );

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, new_total: newTotal });
});

// Admin: remove a leaderboard entry
app.delete('/admin/leaderboard/:code/:handle', checkAdminPassword, async (req, res) => {
  const gameCode = String(req.params.code || '').trim().toUpperCase();
  const handle = String(req.params.handle || '').trim();

  const { error } = await supabase
    .from('holding_leaderboard')
    .delete()
    .eq('game_code', gameCode)
    .eq('handle', handle);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
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
