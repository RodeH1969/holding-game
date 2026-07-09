# HOLDING

Person enters a game code + mobile number, gets the next unused 4-player
combination for that game. Entries are logged in Supabase. You download an
.xlsx snapshot any time from the admin page.

## How it works
- `data/combinations.txt` (your 163,185 combos, numbered 1...N) is loaded
  into memory once when the server starts.
- Each **game code** gets its own counter in Supabase (`holding_games`),
  starting at 0. Every new phone number for that game code atomically claims
  the next combo (1, 2, 3...). Multiple games can run at once, each starting
  fresh from combo #1.
- Same phone number entering the same game code again just gets shown their
  original combo again (no double-dipping, no crash).
- Phone numbers accepted as `04XXXXXXXX` or `614XXXXXXXX` (spaces/dashes/+
  are stripped), normalised to `614XXXXXXXX` for storage/uniqueness.

## Setup

1. **Supabase**: create a project, then run `supabase_schema.sql` in the SQL
   editor. Grab your Project URL and `service_role` key (Settings → API).

2. **Environment variables** — copy `.env.example` to `.env` and fill in:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_PASSWORD` — whatever you want to use to open `/admin.html`

3. **Install & run locally**
   ```
   npm install
   npm start
   ```
   Visit `http://localhost:3000` for the entry form,
   `http://localhost:3000/admin.html` for the admin page.

4. **Deploy to Render** — see the "Deploying to GitHub + Render" section
   below for the exact commands.

## Deploying to GitHub + Render

1. **Push to GitHub** (from inside `C:\Users\User\HOLDING`):
   ```
   git init
   git add .
   git commit -m "HOLDING app"
   git remote add origin https://github.com/RodeH1969/holding.git
   git branch -M main
   git push -u origin main
   ```
   (Create the empty repo on GitHub first if it doesn't exist yet — no
   README/gitignore, just an empty repo, so the push above doesn't conflict.)
   `.gitignore` already excludes `node_modules/` and `.env`, so your
   Supabase key and admin password won't end up on GitHub.

2. **Create the Render service**
   - render.com → New → Web Service → connect the `holding` GitHub repo
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free is fine to start

3. **Set environment variables in Render**
   Under the service's **Environment** tab, add the same three from your
   local `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_PASSWORD`

   Do **not** upload `.env` itself — Render env vars are the equivalent,
   set directly in their dashboard.

4. Deploy. Once it's live, Render gives you a URL like
   `https://holding.onrender.com` — that's your entry page, and
   `https://holding.onrender.com/admin.html` is your admin page.


## Admin page
Go to `/admin.html`, enter your `ADMIN_PASSWORD`. You'll see every game
code, how many combos it's given out, and its status (Open/Closed).

- **Stop Entries** — closes the game immediately. Anyone trying to enter
  that code after this gets "Entries are closed for this game — it has
  already started." The entry page itself picks this up automatically
  (checks every 15 seconds) and swaps the game's badge to "Entries Closed",
  no refresh needed.
- **Reopen** — reverses it, in case you closed the wrong one or want to
  extend entries.
- **Download** next to a game for just that game's entries, or **Download
  ALL entries** for everything — both give you an `.xlsx` file (Game Code,
  Phone, Player 1–4, Entered At) ready to open in Excel.

## If you already have a live Supabase project
Run `migration_add_status.sql` in the SQL editor — it adds the open/closed
status to your existing `holding_games` table without touching your data.
(A fresh install via `supabase_schema.sql` already includes it.)

## Notes / things to decide
- Game codes aren't pre-registered anywhere — the first person to enter a
  code creates it. If you'd rather only allow pre-approved game codes
  (e.g. set up on the admin page beforehand), that's a small change to
  `/api/enter`.
- Combos run out at 163,185 per game code — plenty of headroom, but if a
  game code somehow exceeds it, entrants get a friendly "all combinations
  given out" message instead of a crash.
