# KIT.md — paste this into your agent

Copy everything below the line into Claude Code, Codex, Cursor, or any agent
with a shell. It stands up the Harvester on your Cloudflare account, wired into
your Second Brain library, with your own lenses. Budget: about 20 minutes, then
a few cents to a few dollars per harvest depending on video length.

---

You are setting up **Harvester** (paste a link, get the lessons) from
https://github.com/lennymadethat/harvester. It writes into a Second Brain
library (https://github.com/lennymadethat/second-brain), which must exist
first. Work through every step, verify each one, and stop only when you need a
value from me. Never paste a secret into a committed file; secrets go in with
`wrangler secret put` (or `.dev.vars` locally, which is git-ignored).

**1. Confirm the library exists**

Ask me for the Second Brain project URL (`https://<ref>.supabase.co`) and where
the service-role key is. If I do not have one yet, stop and point me at its
KIT.md first.

**2. Clone, install, configure**

```
git clone https://github.com/lennymadethat/harvester.git
cd harvester
npm install
```

Edit `wrangler.toml`: `SUPABASE_URL` = the library URL. Leave the model
strings unless I ask for a change.

**3. My lenses**

Open `src/lenses.js`. Ask me, in one question, what worlds I learn for (work,
a hobby, a business, a body of study) and what rulebook page in my library, if
any, defines each one's vocabulary. Then:
- rename or replace `Work` and `Personal` to match, one lens per world, with a
  one-line `description` Auto can recognise and a `frame` that says how to read
  a source for that world;
- point `methodology` at real page paths in my library (or an empty array if I
  have no rulebook yet; the lens still works with less context);
- keep `Auto`, `Raw`, and `Visuals` as they are.

**4. The ledger table**

Run `migrations/0001_harvest_ledger.sql` in the library's Postgres (Supabase
SQL Editor, or `psql -f`). Confirm `harvest_events` exists.

**5. Secrets**

```
npx wrangler login
npx wrangler secret put GEMINI_API_KEY          # aistudio.google.com
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put HARVESTER_TOKEN         # generate: openssl rand -hex 32
```

**6. Deploy and verify**

```
npx wrangler deploy
curl https://<worker>.workers.dev/health
```

`health` must show `library: true` and both `llm.gemini` and `llm.anthropic`
true. If any is false, fix it before going on.

**7. First harvest**

Ask me for one short YouTube link (under ten minutes) about one of my worlds.
Run it through the Raw lens first (cheapest):

```
curl -X POST https://<worker>.workers.dev/harvest \
  -H "x-harvester-token: <token>" -H "content-type: application/json" \
  -d '{"urls":["<link>"],"lens":"Raw"}'
```

Confirm a page exists at `raw/harvested/…` in the library and `harvest_events`
has one row with `status = harvested`. Then run the same link with
`"lens":"Auto"` and show me which lens it picked, why, and which project pages
received action items. If Auto chose wrong, that is a `description` to sharpen
in `src/lenses.js`, not a bug.

**8. Report**

Tell me: the worker URL, my lenses and their rulebook pages, the models in
use, and what the two test harvests produced. Remind me the token is a password
and I rotate it with `wrangler secret put HARVESTER_TOKEN`. Remind me every
harvest spends model credit, and Raw is the cheapest run.
