import { createClient, type Client } from "@libsql/client";
import { FACETS_VERSION, facetsOf } from "./facets";
import { notifyDbTrouble } from "./notify";

// Turso in production (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN); a local SQLite file in development.
// Without either (e.g. a Vercel deploy with no database yet) everything still works, just uncached.
export const CACHE_MS = 12 * 60 * 60 * 1000;

export type RepoCard = {
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  difficulty: string;
  views: number;
  worked: number;
  stuck: number;
  analyzedAt: number;
  risingAt: number | null; // when the trending job last found it rising
};

export type Votes = { worked: number; stuck: number; byOs: Record<string, { worked: number; stuck: number }> };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS repos (
    key TEXT PRIMARY KEY,           -- lower-case owner/repo, plus @ref for branches
    full_name TEXT NOT NULL,
    description TEXT,
    stars INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    difficulty TEXT NOT NULL,
    data TEXT NOT NULL,             -- the full /api/analyze response
    analyzed_at INTEGER NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    last_viewed INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS votes (
    key TEXT NOT NULL,
    os TEXT NOT NULL,
    worked INTEGER NOT NULL,        -- 1 = got it running, 0 = got stuck
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS votes_key ON votes (key);
  CREATE TABLE IF NOT EXISTS fb_posts (
    id TEXT PRIMARY KEY,            -- the Facebook post id
    repo TEXT NOT NULL,             -- owner/repo found in the caption
    kind TEXT NOT NULL,             -- poster | reel
    caption TEXT,
    permalink TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    image BLOB,                     -- a copy: Facebook's image links expire
    image_type TEXT,
    synced_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS guides (
    key TEXT NOT NULL,
    os TEXT NOT NULL,
    text TEXT NOT NULL,             -- the AI-written guide, so each repo/OS is generated once
    created_at INTEGER NOT NULL,
    PRIMARY KEY (key, os)
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    hash TEXT PRIMARY KEY,          -- SHA-256 of the key; the key itself is shown once and never stored
    prefix TEXT NOT NULL,           -- its first characters, so the owner can tell which key it is
    github_id INTEGER NOT NULL UNIQUE, -- one key per GitHub account
    login TEXT NOT NULL,            -- GitHub username, for the owner and the admin list
    created_at INTEGER NOT NULL,
    last_used INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,    -- API and MCP requests made with it
    blocked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS hits (
    bucket TEXT PRIMARY KEY,        -- what is counted, e.g. "analyze:<hashed visitor>" (never a raw IP)
    count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL       -- when the window ends and counting starts over
  );
  CREATE TABLE IF NOT EXISTS chat_spend (
    key TEXT PRIMARY KEY,           -- account + the question's idempotency key, so a resend isn't charged twice
    pool TEXT NOT NULL,             -- whose budget it comes from, e.g. "user" (signed in)
    account TEXT NOT NULL,          -- GitHub user id for signed-in chat
    day TEXT NOT NULL,              -- UTC date, YYYY-MM-DD
    reserved INTEGER NOT NULL,      -- worst-case cost held before the model is called, in millionths of a dollar
    cost INTEGER,                   -- actual cost once settled, in millionths of a dollar
    status TEXT NOT NULL,           -- reserved | settled
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,    -- a reservation never settled stops counting as "in progress" here, but keeps its full cost
    settled_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS chat_spend_account ON chat_spend (account, day);
  CREATE INDEX IF NOT EXISTS chat_spend_pool ON chat_spend (pool, day);
  CREATE TABLE IF NOT EXISTS users (
    github_id INTEGER PRIMARY KEY,  -- who signed in with GitHub (for chat, an API key or private repos)
    login TEXT NOT NULL,            -- GitHub username, updated at each sign-in
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,     -- the last sign-in or chat answer
    sign_ins INTEGER NOT NULL DEFAULT 0 -- 0 for API key owners from before sign-ins were recorded
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    github_id INTEGER PRIMARY KEY,  -- who has (or had) GitManual Pro; one subscription per GitHub account
    customer TEXT NOT NULL,         -- Stripe customer id
    subscription TEXT NOT NULL UNIQUE, -- Stripe subscription id
    status TEXT NOT NULL,           -- Stripe's: active, trialing, past_due, canceled, ...
    plan TEXT,                      -- month | year
    period_end INTEGER NOT NULL,    -- ms; paid up until then
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS purchases (
    session TEXT PRIMARY KEY,       -- Stripe Checkout session id: the same payment is never recorded twice
    github_id INTEGER NOT NULL,     -- who paid
    repo TEXT NOT NULL,             -- lower-case owner/name it unlocks: its Deep Inspection and PDF manuals
    full_name TEXT NOT NULL,        -- owner/Name as shown
    amount INTEGER NOT NULL,        -- cents, before tax
    currency TEXT NOT NULL,
    paid_at INTEGER NOT NULL        -- ms
  );
  CREATE INDEX IF NOT EXISTS purchases_owner ON purchases (github_id, repo);
  CREATE TABLE IF NOT EXISTS problems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,    -- ms
    repo TEXT NOT NULL,             -- owner/Name the manual was for, as shown; '' for the site (the footer's "Report a problem")
    os TEXT NOT NULL,               -- '' for the site
    kind TEXT NOT NULL,             -- lib/problems.ts PROBLEM_KINDS, SITE_KINDS
    step INTEGER,                   -- 1-based step number, when they picked one
    step_title TEXT,
    message TEXT NOT NULL,
    error TEXT,                     -- what the terminal printed, pasted
    email TEXT,                     -- only when they want a reply
    github_login TEXT,              -- when signed in
    version INTEGER NOT NULL,       -- the manual's analysis version (lib/pipeline.ts VERSION)
    status TEXT NOT NULL DEFAULT 'open' -- open | fixed | closed
  );
  CREATE INDEX IF NOT EXISTS problems_status ON problems (status, created_at);
  CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at INTEGER NOT NULL,       -- ms
    ref_kind TEXT NOT NULL,         -- problem | purchase | subscription | custom: what the email was about (/admin/email)
    ref_id TEXT NOT NULL,           -- problems.id, purchases.session, subscriptions.subscription; '' for custom
    to_hint TEXT NOT NULL,          -- the address, masked (j***@gmail.com): enough to tell sends apart, not to reuse
    from_address TEXT,              -- which of our addresses it came from (hello@ or the personal one)
    subject TEXT NOT NULL,
    admin TEXT NOT NULL,            -- GitHub login of the admin who sent it
    resend_id TEXT                  -- Resend's email id, to look it up in their dashboard
  );
  CREATE INDEX IF NOT EXISTS email_log_ref ON email_log (ref_kind, ref_id, sent_at);
  CREATE TABLE IF NOT EXISTS health_marks (
    name TEXT PRIMARY KEY,          -- stripe-webhook, cron-trending, cron-facebook, cron-digest, ... (/admin/health)
    at INTEGER NOT NULL,            -- ms, the last time it ran
    ok INTEGER NOT NULL,            -- 1 when that run worked
    note TEXT                       -- a short result or error, for the health page
  );
  CREATE TABLE IF NOT EXISTS repo_gone (
    key TEXT PRIMARY KEY,           -- lower-case owner/repo (covers its branch views too)
    full_name TEXT NOT NULL,
    reason TEXT NOT NULL,           -- github: GitHub said it's gone on a re-read | hidden: an admin took the manual down
    at INTEGER NOT NULL,            -- ms
    note TEXT,                      -- why (hidden), or GitHub's answer (github)
    by TEXT                         -- GitHub login of the admin who hid it
  );
  CREATE TABLE IF NOT EXISTS interest (
    feature TEXT NOT NULL,          -- a feature not built yet, e.g. "pdf", whose button only says "coming soon"
    day TEXT NOT NULL,              -- UTC date, YYYY-MM-DD
    repo TEXT NOT NULL,             -- lower-case owner/repo the button was on
    clicks INTEGER NOT NULL,        -- different visitors that day (one per visitor, repo and day; lib/limit.ts firstTime)
    PRIMARY KEY (feature, day, repo)
  );
  CREATE TABLE IF NOT EXISTS chat_conversations (
    id TEXT PRIMARY KEY,            -- random, given to the browser; the history itself never leaves the server
    account TEXT NOT NULL,          -- GitHub user id; only this account can continue it
    repo TEXT NOT NULL,             -- owner/repo
    sha TEXT NOT NULL,              -- the commit every file in the chat is read from
    paths TEXT NOT NULL,            -- JSON: file paths at that commit, as a hint for what can be read
    messages TEXT NOT NULL,         -- JSON: the Claude messages so far, kept exactly as sent and received
    answers INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL     -- deleted after this; nothing about a chat is kept longer
  );
  CREATE TABLE IF NOT EXISTS inspections (
    key TEXT PRIMARY KEY,           -- lower-case owner/repo
    version INTEGER NOT NULL,       -- lib/inspection VERSION: an older report is rebuilt
    data TEXT NOT NULL,             -- JSON: the whole report (facts, findings, headline, grades, summary)
    scanned_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saves (
    github_id INTEGER NOT NULL,     -- who saved it (signed in with GitHub)
    key TEXT NOT NULL,              -- lower-case owner/repo; public repos only
    os TEXT NOT NULL,               -- the computer they were looking at: mac | windows | linux
    status TEXT NOT NULL,           -- try | installed | dropped
    release_tag TEXT,               -- the latest release when saved, for "new release since you saved"
    saved_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (github_id, key)
  );
  CREATE INDEX IF NOT EXISTS saves_key ON saves (key);
  CREATE INDEX IF NOT EXISTS saves_day ON saves (saved_at);
  CREATE TABLE IF NOT EXISTS inspection_snapshots (
    key TEXT NOT NULL,              -- lower-case owner/repo
    scanned_at INTEGER NOT NULL,
    data TEXT NOT NULL,             -- JSON: a few headline numbers, for trends over time
    PRIMARY KEY (key, scanned_at)
  );
`;

// One connection per server process. Kept on globalThis because dev hot reloads re-run this module,
// and a fresh connection per reload leaves stale handles on the SQLite file (they end in SQLITE_IOERR).
const store = globalThis as typeof globalThis & { gitmanualDb?: Promise<Client | null> | null };

const DB_TIMEOUT_MS = 15_000;
// Bump when SCHEMA, the added columns or the indexes below change, so the next start runs the setup once.
const SCHEMA_VERSION = 10; // 2: purchases, 3: problems, 4: problems.page, 5: problems.mode and name (the contact form), 6: cleanup indexes, no repos_stars, 7: fb_posts_list, 8: email_log, 9: health_marks, 10: repo_gone

function db(): Promise<Client | null> {
  store.gitmanualDb ??= (async () => {
    const url = process.env.TURSO_DATABASE_URL ?? (process.env.VERCEL ? null : `file:${process.env.GITMANUAL_DB ?? "data/gitmanual.db"}`);
    if (!url) {
      console.warn("gitmanual: TURSO_DATABASE_URL is not set, so history and caching are off.");
      return null;
    }
    if (url.startsWith("file:")) {
      const { mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(url.slice(5)), { recursive: true });
    }
    // A stuck request to Turso fails after DB_TIMEOUT_MS instead of holding the page until Vercel's 5-minute limit.
    // The client runs at most 20 requests at once, so a few stuck ones would otherwise queue every page behind them
    // (2026-11-17: /, /shelf and manuals all timed out together). Local files don't use fetch.
    const timed = (req: Request, init?: RequestInit) => {
      const signal = AbortSignal.timeout(DB_TIMEOUT_MS);
      return fetch(req, { ...init, signal: req.signal ? AbortSignal.any([req.signal, signal]) : signal });
    };
    const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN, fetch: timed });
    try {
      // A normal start reads one number; the setup below runs only when SCHEMA_VERSION is newer than the database's.
      // It used to run on every new instance, and its "already there" ALTERs and CREATE INDEXes still wait in line
      // for the write lock behind busy traffic.
      const had = await client
        .execute("SELECT v FROM schema_meta WHERE k = 'version'")
        .then((r) => Number(r.rows[0]?.v ?? 0))
        .catch(() => 0);
      if (had >= SCHEMA_VERSION) return client;
      await client.executeMultiple(SCHEMA);
      // Columns added after a table first shipped; "duplicate column" just means it's already there.
      for (const sql of [
        "ALTER TABLE fb_posts ADD COLUMN video_id TEXT",
        "ALTER TABLE repos ADD COLUMN rising_at INTEGER", // when the daily trending job last found it rising
        "ALTER TABLE repos ADD COLUMN facets TEXT", // searchable facts for lists and suggestions (lib/facets.ts)
        "ALTER TABLE chat_spend ADD COLUMN repo TEXT", // lower-case owner/repo the answer was about (public repos only)
        "ALTER TABLE problems ADD COLUMN page TEXT", // the page a report was sent from
        "ALTER TABLE problems ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual'", // manual | site | contact (lib/problems.ts)
        "ALTER TABLE problems ADD COLUMN name TEXT", // contact: the name they gave
      ])
        await client.execute(sql).catch(() => {});
      // "Got it running" counts kept on the repo, so lists and the shelf don't join and group the votes table.
      // Filled from the votes once, when the columns are first added; addVote keeps them current after that.
      const counted = await client.execute("ALTER TABLE repos ADD COLUMN worked INTEGER NOT NULL DEFAULT 0").then(
        () => true,
        () => false,
      );
      await client.execute("ALTER TABLE repos ADD COLUMN stuck INTEGER NOT NULL DEFAULT 0").catch(() => {});
      if (counted)
        await client.execute(`UPDATE repos SET
          worked = (SELECT COALESCE(SUM(worked), 0) FROM votes WHERE votes.key = repos.key),
          stuck = (SELECT COUNT(*) - COALESCE(SUM(worked), 0) FROM votes WHERE votes.key = repos.key)`);
      // API key owners signed in before sign-ins were recorded: they're users too. Checked first, so a normal start
      // only reads; the write happens once, when someone's missing.
      const missing = await client.execute("SELECT 1 FROM api_keys WHERE github_id NOT IN (SELECT github_id FROM users) LIMIT 1");
      if (missing.rows.length)
        await client.execute(
          "INSERT OR IGNORE INTO users (github_id, login, first_seen, last_seen, sign_ins) SELECT github_id, login, created_at, COALESCE(last_used, created_at), 0 FROM api_keys",
        );
      // Indexes for the sort orders, so a page of results reads that page instead of the whole table.
      await client.executeMultiple(`
        CREATE INDEX IF NOT EXISTS repos_last_viewed ON repos (last_viewed);
        CREATE INDEX IF NOT EXISTS repos_views ON repos (views, stars);
        CREATE INDEX IF NOT EXISTS repos_worked ON repos (worked, stars);
        CREATE INDEX IF NOT EXISTS repos_popular ON repos ((views + 3 * worked));
        CREATE INDEX IF NOT EXISTS repos_rising ON repos (rising_at);
      `);
      // Every small column the shelf, the lists, the sitemap and the suggestions read, so those queries read this
      // index instead of the table. Each row also holds the whole analysis (data, ~70 KB on average), and facets
      // and rising_at sit after it, so a table scan read the lot: ~6–40 s a query on 2026-11-17.
      // On a big database, create it by hand first (turso db shell): building it can take longer than DB_TIMEOUT_MS.
      await client.execute(
        "CREATE INDEX IF NOT EXISTS repos_shelf ON repos (stars, key, language, rising_at, facets, full_name, description, difficulty, views, analyzed_at, worked, stuck)",
      );
      // Cleanups delete by expiry time; without these they scan the whole table.
      await client.executeMultiple(`
        CREATE INDEX IF NOT EXISTS hits_reset ON hits (reset_at);
        CREATE INDEX IF NOT EXISTS chat_conversations_expires ON chat_conversations (expires_at);
        DROP INDEX IF EXISTS repos_stars; -- repos_shelf starts with stars, so this one only cost writes
      `);
      // The Finds list without the images: synced_at and video_id sit after the image in each row, so reading the list
      // from the table read every image (~20 MB, 3.5 s on average, once per manual view on 2026-11-18).
      await client.execute(
        "CREATE INDEX IF NOT EXISTS fb_posts_list ON fb_posts (created_at, id, repo, kind, caption, permalink, synced_at, video_id)",
      );
      // Fresh statistics for the query planner, so it picks the right index (it chose the key's index over
      // repos_shelf on 2026-11-17). Only analyzes what needs it.
      await client.execute("PRAGMA optimize").catch(() => {});
      await client.execute("CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
      await client.execute({ sql: "INSERT OR REPLACE INTO schema_meta (k, v) VALUES ('version', ?)", args: [SCHEMA_VERSION] });
    } catch (e) {
      client.close();
      throw e;
    }
    return client;
  })().catch((e) => {
    console.error("gitmanual db:", e);
    store.gitmanualDb = null; // try again on the next request
    return null;
  });
  return store.gitmanualDb;
}

// For what must not happen without the database, like spending on chat (lib/budget.ts): it throws instead of
// falling back, so a missing or failing database stops the action rather than letting it through unrecorded.
export async function strictly<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await db();
  if (!c) throw new Error("The database is not available.");
  return fn(c);
}

export type Conversation = {
  id: string;
  account: string;
  repo: string;
  sha: string;
  paths: string[];
  messages: unknown[];
  answers: number;
  expiresAt: number;
};

// Starts a chat and clears out expired ones, so no history outlives its hour.
export async function createConversation(c: Omit<Conversation, "messages" | "answers">, now = Date.now()): Promise<void> {
  await strictly(async (db) => {
    await db.execute({ sql: "DELETE FROM chat_conversations WHERE expires_at < ?", args: [now] });
    await db.execute({
      sql: `INSERT INTO chat_conversations (id, account, repo, sha, paths, messages, answers, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, '[]', 0, ?, ?)`,
      args: [c.id, c.account, c.repo, c.sha, JSON.stringify(c.paths), now, c.expiresAt],
    });
  });
}

// Only the account that started it, and only before it expires.
export async function getConversation(id: string, account: string, now = Date.now()): Promise<Conversation | null> {
  return strictly(async (db) => {
    const { rows } = await db.execute({
      sql: "SELECT * FROM chat_conversations WHERE id = ? AND account = ? AND expires_at >= ?",
      args: [id, account, now],
    });
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      account: String(r.account),
      repo: String(r.repo),
      sha: String(r.sha),
      paths: JSON.parse(String(r.paths)),
      messages: JSON.parse(String(r.messages)),
      answers: Number(r.answers),
      expiresAt: Number(r.expires_at),
    };
  });
}

export async function saveConversation(id: string, messages: unknown[], answers: number): Promise<void> {
  await strictly((db) =>
    db.execute({ sql: "UPDATE chat_conversations SET messages = ?, answers = ? WHERE id = ?", args: [JSON.stringify(messages), answers, id] }),
  );
}

// How long a page waits for the database before going on without it. The request itself keeps going until
// DB_TIMEOUT_MS (a write still lands), but a busy database costs a visitor seconds, not the minute it used to
// (2026-11-18: five 15-second waits in a row hit Vercel's 60-second limit).
const PAGE_WAIT_MS = 5_000;
const clipError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);

// The database is a cache and a counter: if it fails or is slow, the request should still succeed.
async function safely<T>(fallback: T, fn: (c: Client) => Promise<T>, waitMs = PAGE_WAIT_MS): Promise<T> {
  const c = await db();
  if (!c) return fallback;
  const run = fn(c).catch((e) => {
    console.error("gitmanual db:", e);
    notifyDbTrouble(clipError(e));
    return fallback;
  });
  if (!Number.isFinite(waitMs)) return run;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.error(`gitmanual db: no answer in ${waitMs / 1000} s, went on without it`);
      notifyDbTrouble(`no answer in ${waitMs / 1000} s`);
      resolve(fallback);
    }, waitMs);
  });
  return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

export function repoKey(owner: string, repo: string, ref?: string): string {
  return `${owner}/${repo}`.toLowerCase() + (ref ? `@${ref}` : "");
}

// Whether a repo is on the shelf, without loading its manual. A manual an admin took down isn't.
export function hasRepo(key: string): Promise<boolean> {
  return safely(
    false,
    async (c) =>
      (
        await c.execute({
          sql: "SELECT 1 FROM repos WHERE key = ? AND NOT EXISTS (SELECT 1 FROM repo_gone WHERE key IN (?, ?) AND reason = 'hidden')",
          args: [key, key, baseKey(key)],
        })
      ).rows.length > 0,
  );
}

export async function getCached(key: string): Promise<{ data: unknown; analyzedAt: number } | null> {
  const read = await readSaved(key);
  return read === "error" || read.gone?.reason === "hidden" ? null : read.saved;
}

// ---- Repos gone from GitHub, or taken down by an admin (/admin/repos) ----
// Kept apart from repos so the shelf queries still read only the repos_shelf index (a column on repos would make them
// read every manual). Either kind is off the shelf, lists, suggestions and sitemap. "github": a re-read found the repo
// gone (deleted, private, or its owner's account hidden); the manual still shows, with a notice, and a later re-read
// that works clears it. "hidden": the manual is gone from gitmanual until an admin brings it back.
export type GoneReason = "github" | "hidden";
export type GoneMark = { reason: GoneReason; at: number; note: string | null };
export type GoneRepo = GoneMark & { key: string; fullName: string; by: string | null };
const baseKey = (key: string) => key.split("@")[0];

// The saved manual and any gone mark (its own or, for a branch view, the repo's), or "error" when the database
// didn't answer: loadRepo then builds the page without saving it, instead of adding a big write to a database
// that's already struggling.
export function readSaved(key: string): Promise<{ saved: { data: unknown; analyzedAt: number } | null; gone: GoneMark | null } | "error"> {
  return safely<{ saved: { data: unknown; analyzedAt: number } | null; gone: GoneMark | null } | "error">("error", async (c) => {
    const { rows } = await c.execute({
      sql: `SELECT r.data, r.analyzed_at, g.reason, g.at AS gone_at, g.note
            FROM (SELECT 1) LEFT JOIN repos r ON r.key = ?
            LEFT JOIN (SELECT reason, at, note FROM repo_gone WHERE key IN (?, ?) ORDER BY reason = 'hidden' DESC LIMIT 1) g`,
      args: [key, key, baseKey(key)],
    });
    const row = rows[0];
    return {
      saved: row && row.data != null ? { data: JSON.parse(String(row.data)), analyzedAt: Number(row.analyzed_at) } : null,
      gone: row && row.reason != null ? { reason: String(row.reason) as GoneReason, at: Number(row.gone_at), note: row.note == null ? null : String(row.note) } : null,
    };
  });
}

// Taken down by an admin: its inspection page and report are gone too. False when the database doesn't answer.
export function repoHidden(key: string): Promise<boolean> {
  return safely(false, async (c) => (await c.execute({ sql: "SELECT 1 FROM repo_gone WHERE key = ? AND reason = 'hidden'", args: [baseKey(key)] })).rows.length > 0);
}

// GitHub said the repo is gone. Never overwrites an admin's "hidden".
export function markGoneFromGitHub(key: string, fullName: string, note: string): Promise<void> {
  facetCache = null;
  return safely(undefined, async (c) => {
    await c.execute({
      sql: `INSERT INTO repo_gone (key, full_name, reason, at, note) VALUES (?, ?, 'github', ?, ?)
            ON CONFLICT (key) DO UPDATE SET at = excluded.at, note = excluded.note WHERE repo_gone.reason = 'github'`,
      args: [baseKey(key), fullName, Date.now(), note.slice(0, 300)],
    });
  });
}

export async function hideRepo(key: string, fullName: string, note: string | null, by: string): Promise<void> {
  facetCache = null;
  await strictly((c) =>
    c.execute({
      sql: `INSERT INTO repo_gone (key, full_name, reason, at, note, by) VALUES (?, ?, 'hidden', ?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET full_name = excluded.full_name, reason = 'hidden', at = excluded.at, note = excluded.note, by = excluded.by`,
      args: [baseKey(key), fullName, Date.now(), note?.slice(0, 300) || null, by],
    }),
  );
}

// Back on the shelf (either kind). A repo still gone from GitHub is marked again on its next re-read.
export async function unhideRepo(key: string): Promise<void> {
  facetCache = null;
  await strictly((c) => c.execute({ sql: "DELETE FROM repo_gone WHERE key = ?", args: [baseKey(key)] }));
}

export async function goneRepos(): Promise<GoneRepo[]> {
  return strictly(async (c) => {
    const { rows } = await c.execute("SELECT * FROM repo_gone ORDER BY reason = 'hidden' DESC, at DESC LIMIT 500");
    return rows.map((r) => ({
      key: String(r.key),
      fullName: String(r.full_name),
      reason: String(r.reason) as GoneReason,
      at: Number(r.at),
      note: r.note == null ? null : String(r.note),
      by: r.by == null ? null : String(r.by),
    }));
  });
}

export async function saveRepo(
  key: string,
  r: { fullName: string; description: string | null; stars: number; language: string | null; difficulty: string },
  data: unknown,
): Promise<number> {
  const now = Date.now();
  // One round trip: the save and dropping the AI guides it outdates (a new analysis may change the steps).
  await safely(null, (c) =>
    c.batch(
      [
        {
          sql: `INSERT INTO repos (key, full_name, description, stars, language, difficulty, data, analyzed_at, views, last_viewed, facets)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(key) DO UPDATE SET full_name = excluded.full_name, description = excluded.description,
              stars = excluded.stars, language = excluded.language, difficulty = excluded.difficulty,
              data = excluded.data, analyzed_at = excluded.analyzed_at, facets = excluded.facets`,
          args: [key, r.fullName, r.description, r.stars, r.language, r.difficulty, JSON.stringify(data), now, now, facetsOf(data as Parameters<typeof facetsOf>[0])],
        },
        { sql: "DELETE FROM guides WHERE key = ?", args: [key] },
        // Read from GitHub just now, so it isn't gone (an admin's "hidden" stays).
        { sql: "DELETE FROM repo_gone WHERE key = ? AND reason = 'github'", args: [baseKey(key)] },
      ],
      "write",
    ),
  );
  return now;
}

export function countView(key: string): Promise<unknown> {
  return safely(null, (c) => c.execute({ sql: "UPDATE repos SET views = views + 1, last_viewed = ? WHERE key = ?", args: [Date.now(), key] }));
}

export function addVote(key: string, os: string, worked: boolean): Promise<unknown> {
  return safely(null, (c) =>
    c.batch(
      [
        { sql: "INSERT INTO votes (key, os, worked, created_at) VALUES (?, ?, ?, ?)", args: [key, os, worked ? 1 : 0, Date.now()] },
        { sql: `UPDATE repos SET ${worked ? "worked = worked + 1" : "stuck = stuck + 1"} WHERE key = ?`, args: [key] },
      ],
      "write",
    ),
  );
}

export function getVotes(key: string): Promise<Votes> {
  return safely({ worked: 0, stuck: 0, byOs: {} }, async (c) => {
    const { rows } = await c.execute({
      sql: "SELECT os, SUM(worked) AS w, COUNT(*) - SUM(worked) AS s FROM votes WHERE key = ? GROUP BY os",
      args: [key],
    });
    const list = rows.map((r) => ({ os: String(r.os), w: Number(r.w), s: Number(r.s) }));
    return {
      worked: list.reduce((n, r) => n + r.w, 0),
      stuck: list.reduce((n, r) => n + r.s, 0),
      byOs: Object.fromEntries(list.map((r) => [r.os, { worked: r.w, stuck: r.s }])),
    };
  });
}

export function getGuide(key: string, os: string): Promise<string | null> {
  return safely(null, async (c) => {
    const { rows } = await c.execute({ sql: "SELECT text FROM guides WHERE key = ? AND os = ?", args: [key, os] });
    return rows[0] ? String(rows[0].text) : null;
  });
}

export function saveGuide(key: string, os: string, text: string): Promise<unknown> {
  return safely(null, (c) =>
    c.execute({
      sql: "INSERT INTO guides (key, os, text, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key, os) DO UPDATE SET text = excluded.text, created_at = excluded.created_at",
      args: [key, os, text, Date.now()],
    }),
  );
}

// The trending job marks repos it finds rising. A repo keeps its date while it's still rising, and gets a fresh
// one if it rises again a month later, so "Rising this week" is a rolling week.
export function markRising(key: string): Promise<unknown> {
  const now = Date.now();
  return safely(null, (c) =>
    c.execute({
      sql: "UPDATE repos SET rising_at = ? WHERE key = ? AND (rising_at IS NULL OR rising_at < ?)",
      args: [now, key, now - 30 * 864e5],
    }),
  );
}

// How many repos are rising this week, for "See all N on the shelf".
export function countRising(): Promise<number> {
  return safely(0, async (c) => {
    const { rows } = await c.execute({ sql: "SELECT COUNT(*) AS n FROM repos WHERE key NOT LIKE '%@%' AND key NOT IN (SELECT key FROM repo_gone) AND rising_at > ?", args: [Date.now() - 7 * 864e5] });
    return Number(rows[0]?.n ?? 0);
  });
}

export function listRepos(order: "recent" | "popular" | "rising", limit = 6): Promise<RepoCard[]> {
  return safely([], async (c) => {
    const { rows } = await c.execute({
      sql: `SELECT r.full_name, r.description, r.stars, r.language, r.difficulty, r.views, r.analyzed_at, r.rising_at,
                   r.worked, r.stuck
            FROM repos r
            WHERE r.key NOT LIKE '%@%' AND r.key NOT IN (SELECT key FROM repo_gone) ${order === "rising" ? "AND r.rising_at > ?" : ""}
            ORDER BY ${order === "recent" ? "r.last_viewed" : order === "rising" ? "r.stars" : "r.views + 3 * r.worked"} DESC
            LIMIT ?`,
      args: order === "rising" ? [Date.now() - 7 * 864e5, limit] : [limit],
    });
    return rows.map((r) => ({
      fullName: String(r.full_name),
      description: r.description == null ? null : String(r.description),
      stars: Number(r.stars),
      language: r.language == null ? null : String(r.language),
      difficulty: String(r.difficulty),
      views: Number(r.views),
      worked: Number(r.worked),
      stuck: Number(r.stuck),
      analyzedAt: Number(r.analyzed_at),
      risingAt: r.rising_at == null ? null : Number(r.rising_at),
    }));
  });
}

// Fills in facets for repos saved before they existed (or with an older format), from the stored manual.
// The check selects only key, so it reads repos_shelf (key and facets) instead of the table: a table scan reads every row's
// manual (~70 KB each, ~160 MB on 2026-11-18), and a crawler opening 20 lists at once on a fresh instance ran 20 of
// those together and timed out the whole site. Calls made while one is running share it. Once nothing is left to
// fill, this instance stops asking; new repos get their facets in saveRepo, and a new FACETS_VERSION comes with a deploy.
let facetsFilled = false;
let facetsRun: Promise<number> | null = null;
export function ensureFacets(maxRows = 400): Promise<number> {
  if (facetsFilled) return Promise.resolve(0);
  facetsRun ??= safely(0, async (c) => {
    let done = 0;
    while (done < maxRows) {
      const { rows: keys } = await c.execute({
        sql: "SELECT key FROM repos WHERE facets IS NULL OR facets NOT LIKE ? LIMIT 25",
        args: [` ${FACETS_VERSION} %`],
      });
      if (!keys.length) {
        facetsFilled = true;
        break;
      }
      for (const k of keys) {
        const key = String(k.key);
        const { rows } = await c.execute({ sql: "SELECT data FROM repos WHERE key = ?", args: [key] });
        let facets = ` ${FACETS_VERSION} `;
        try {
          facets = facetsOf(JSON.parse(String(rows[0]?.data)));
        } catch {} // an unreadable manual just gets no facts, so it isn't retried forever
        await c.execute({ sql: "UPDATE repos SET facets = ? WHERE key = ?", args: [facets, key] });
      }
      done += keys.length;
    }
    return done;
  }, Infinity).finally(() => (facetsRun = null));
  return facetsRun;
}

// Repos whose facets include every token in `all` and at least one in `any`, most-starred first.
export function facetRepos(q: { all: string[]; any?: string[]; difficulty?: string; limit?: number }): Promise<RepoCard[]> {
  return safely([], async (c) => {
    const where = ["r.key NOT LIKE '%@%' AND r.key NOT IN (SELECT key FROM repo_gone)", ...q.all.map(() => "r.facets LIKE ?")];
    const args: (string | number)[] = q.all.map((t) => `% ${t} %`);
    if (q.any?.length) {
      where.push(`(${q.any.map(() => "r.facets LIKE ?").join(" OR ")})`);
      args.push(...q.any.map((t) => `% ${t} %`));
    }
    if (q.difficulty) {
      where.push("r.difficulty = ?");
      args.push(q.difficulty);
    }
    const { rows } = await c.execute({
      sql: `SELECT r.full_name, r.description, r.stars, r.language, r.difficulty, r.views, r.analyzed_at, r.rising_at,
                   r.worked, r.stuck
            FROM repos r
            WHERE ${where.join(" AND ")}
            ORDER BY r.stars DESC
            LIMIT ?`,
      args: [...args, q.limit ?? 60],
    });
    return rows.map(toCard);
  });
}

export type Alternative = { fullName: string; description: string | null; stars: number };

// The small facts of every repo on the shelf (all read from repos_shelf, never the manuals), kept in memory: the
// suggestions on every manual view, the homepage counts and the shelf's counts are worked out from it instead of
// counting the shelf in the database each time (those counts took 30–60 s each on a busy 2026-11-18).
type FacetRow = {
  key: string;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  difficulty: string;
  risingAt: number | null;
  facets: string;
};
type FacetIndex = { at: number; rows: FacetRow[]; df: Map<string, number> };
const FACET_INDEX_MS = 10 * 60e3;
let facetCache: FacetIndex | null = null;
let facetLoad: Promise<FacetIndex | null> | null = null;

// One read at a time per server. A failed read keeps the last good copy (it used to keep an empty one for an hour,
// which hid every suggestion), and the next call tries again.
function loadFacetIndex(): Promise<FacetIndex | null> {
  facetLoad ??= safely<FacetIndex | null>(
    null,
    async (c) => {
      const { rows } = await c.execute("SELECT key, full_name, description, stars, language, difficulty, rising_at, facets FROM repos WHERE key NOT LIKE '%@%' AND key NOT IN (SELECT key FROM repo_gone)");
      const list: FacetRow[] = rows.map((r) => ({
        key: String(r.key),
        fullName: String(r.full_name),
        description: r.description == null ? null : String(r.description),
        stars: Number(r.stars),
        language: r.language == null ? null : String(r.language),
        difficulty: String(r.difficulty),
        risingAt: r.rising_at == null ? null : Number(r.rising_at),
        facets: r.facets == null ? "" : String(r.facets),
      }));
      // How many repos share each topic: rare topics ("fediverse") say much more about a repo than common ones ("ai").
      const df = new Map<string, number>();
      for (const r of list) for (const t of r.facets.split(" ")) if (t.startsWith("t:")) df.set(t, (df.get(t) ?? 0) + 1);
      return { at: Date.now(), rows: list, df };
    },
    Infinity,
  )
    .then((index) => (index ? (facetCache = index) : null))
    .finally(() => (facetLoad = null));
  return facetLoad;
}

// The index, or null when there's none yet and the first read takes longer than a page waits. An older copy is
// used straight away while a newer one is read in the background.
async function facetIndex(): Promise<FacetIndex | null> {
  if (facetCache) {
    if (Date.now() - facetCache.at > FACET_INDEX_MS) void loadFacetIndex();
    return facetCache;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), PAGE_WAIT_MS)));
  return Promise.race([loadFacetIndex(), late]).finally(() => clearTimeout(timer));
}

// How many repos match each facets query (same rules as facetRepos), from the in-memory index: cheap enough for the homepage.
export async function facetCounts(queries: { all: string[]; any?: string[] }[]): Promise<number[]> {
  const index = await facetIndex();
  if (!index) return queries.map(() => 0);
  const { rows } = index;
  const has = (r: FacetRow, t: string) => r.facets.includes(` ${t} `);
  return queries.map((q) => rows.filter((r) => q.all.every((t) => has(r, t)) && (!q.any?.length || q.any.some((t) => has(r, t)))).length);
}

// Repos that run on `os` and do a similar job, judged by shared GitHub topics weighted by rarity.
// Only fairly close matches count, so a repo with nothing similar on the shelf gets no suggestions.
export async function alternativesFor(key: string, os: string, topics: string[], limit = 3): Promise<Alternative[]> {
  if (!topics.length) return [];
  const index = await facetIndex();
  if (!index?.rows.length) return [];
  const { rows, df } = index;
  const weight = (t: string) => Math.log(rows.length / (df.get(t) ?? 1));
  const minScore = 2 * Math.log(20); // about two topics that fewer than 1 in 20 repos share
  return rows
    .filter((r) => r.key !== key && r.facets.includes(` os:${os} `))
    .map((r) => ({ r, score: topics.reduce((sum, t) => sum + (r.facets.includes(` ${t} `) ? weight(t) : 0), 0) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || b.r.stars - a.r.stars)
    .slice(0, limit)
    .map(({ r }) => ({ fullName: r.fullName, description: r.description, stars: r.stars }));
}

function toCard(r: Record<string, unknown>): RepoCard {
  return {
    fullName: String(r.full_name),
    description: r.description == null ? null : String(r.description),
    stars: Number(r.stars),
    language: r.language == null ? null : String(r.language),
    difficulty: String(r.difficulty),
    views: Number(r.views),
    worked: Number(r.worked),
    stuck: Number(r.stuck),
    analyzedAt: Number(r.analyzed_at),
    risingAt: r.rising_at == null ? null : Number(r.rising_at),
  };
}

export type ShelfQuery = {
  q?: string;
  language?: string;
  topic?: string; // a GitHub topic, from the "#tag" links on a manual
  difficulty?: string;
  minStars?: number;
  sort?: "stars" | "recent" | "popular" | "worked";
  rising?: boolean; // only repos rising this week
  os?: string; // only repos that run on this system (verdict yes), for the API
  page?: number;
  perPage?: number; // defaults to SHELF_PAGE
};

export const SHELF_PAGE = 24;

const SHELF_ORDER: Record<NonNullable<ShelfQuery["sort"]>, string> = {
  stars: "r.stars DESC",
  recent: "r.last_viewed DESC",
  popular: "r.views DESC, r.stars DESC",
  worked: "r.worked DESC, r.stars DESC",
};

// Every repo people have looked up, filtered and sorted for the /shelf page.
export function browseRepos(
  query: ShelfQuery,
): Promise<{ repos: RepoCard[]; total: number; languages: { name: string; count: number }[]; all: number; rising: number }> {
  return safely({ repos: [], total: 0, languages: [], all: 0, rising: 0 }, async (c) => {
    const where = ["r.key NOT LIKE '%@%' AND r.key NOT IN (SELECT key FROM repo_gone)"];
    const args: (string | number)[] = [];
    if (query.q) {
      where.push("(r.full_name LIKE ? OR r.description LIKE ?)");
      args.push(`%${query.q}%`, `%${query.q}%`);
    }
    if (query.language) {
      where.push("r.language = ?");
      args.push(query.language);
    }
    if (query.topic) {
      where.push("r.facets LIKE ?");
      args.push(`% t:${query.topic} %`);
    }
    if (query.difficulty) {
      where.push("r.difficulty = ?");
      args.push(query.difficulty);
    }
    if (query.minStars) {
      where.push("r.stars >= ?");
      args.push(query.minStars);
    }
    if (query.os) {
      where.push("r.facets LIKE ?");
      args.push(`% os:${query.os} %`);
    }
    const weekAgo = Date.now() - 7 * 864e5;
    if (query.rising) {
      where.push("r.rising_at > ?");
      args.push(weekAgo);
    }
    const filter = where.join(" AND ");
    const page = Math.max(1, query.page ?? 1);
    const perPage = query.perPage ?? SHELF_PAGE;
    const [rows, total, totals] = await Promise.all([
      c.execute({
        sql: `SELECT r.full_name, r.description, r.stars, r.language, r.difficulty, r.views, r.analyzed_at, r.rising_at,
                     r.worked, r.stuck
              FROM repos r
              WHERE ${filter}
              ORDER BY ${SHELF_ORDER[query.sort ?? "stars"]}
              LIMIT ? OFFSET ?`,
        args: [...args, perPage, (page - 1) * perPage],
      }),
      shelfMatches(query, weekAgo).then(
        async (n) => n ?? Number((await c.execute({ sql: `SELECT COUNT(*) AS n FROM repos r WHERE ${filter}`, args })).rows[0]?.n ?? 0),
      ),
      shelfTotals(c, weekAgo),
    ]);
    return {
      repos: rows.rows.map((r) => ({
        fullName: String(r.full_name),
        description: r.description == null ? null : String(r.description),
        stars: Number(r.stars),
        language: r.language == null ? null : String(r.language),
        difficulty: String(r.difficulty),
        views: Number(r.views),
        worked: Number(r.worked),
        stuck: Number(r.stuck),
        analyzedAt: Number(r.analyzed_at),
        risingAt: r.rising_at == null ? null : Number(r.rising_at),
      })),
      total,
      ...totals,
    };
  });
}

// How many repos match a shelf query, from the in-memory index (same rules as browseRepos' WHERE); null without one.
async function shelfMatches(query: ShelfQuery, weekAgo: number): Promise<number | null> {
  const index = await facetIndex();
  if (!index) return null;
  const q = query.q?.toLowerCase();
  const tokens = [query.topic && `t:${query.topic}`, query.os && `os:${query.os}`].filter(Boolean).map((t) => ` ${String(t).toLowerCase()} `);
  return index.rows.filter(
    (r) =>
      (!q || r.fullName.toLowerCase().includes(q) || Boolean(r.description?.toLowerCase().includes(q))) &&
      (!query.language || r.language === query.language) &&
      (!query.difficulty || r.difficulty === query.difficulty) &&
      (!query.minStars || r.stars >= query.minStars) &&
      (!query.rising || (r.risingAt != null && r.risingAt > weekAgo)) &&
      tokens.every((t) => r.facets.toLowerCase().includes(t)),
  ).length;
}

// Just the shelf's header numbers (the language filter, All / Rising), so the page can show them and its filters
// while the repos themselves are still being read.
export function shelfCounts(): Promise<{ languages: { name: string; count: number }[]; all: number; rising: number }> {
  return safely({ languages: [], all: 0, rising: 0 }, (c) => shelfTotals(c, Date.now() - 7 * 864e5));
}

type ShelfTotals = { languages: { name: string; count: number }[]; all: number; rising: number };

// The language filter and the All / Rising counts are the same for every visitor: worked out from the in-memory
// index, or, until there is one, counted in the database and kept for 5 minutes.
let totalsCache: { at: number; value: Promise<ShelfTotals> } | null = null;
async function shelfTotals(c: Client, weekAgo: number): Promise<ShelfTotals> {
  const index = await facetIndex();
  if (index) {
    const langs = new Map<string, number>();
    for (const r of index.rows) if (r.language != null) langs.set(r.language, (langs.get(r.language) ?? 0) + 1);
    return {
      languages: [...langs]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      all: index.rows.length,
      rising: index.rows.filter((r) => r.risingAt != null && r.risingAt > weekAgo).length,
    };
  }
  if (totalsCache && Date.now() - totalsCache.at < 300e3) return totalsCache.value;
  const value = Promise.all([
    c.execute("SELECT language, COUNT(*) AS n FROM repos WHERE key NOT LIKE '%@%' AND key NOT IN (SELECT key FROM repo_gone) AND language IS NOT NULL GROUP BY language ORDER BY n DESC, language"),
    // The whole shelf and this week's rising repos, for the All / Rising switch.
    c.execute({ sql: "SELECT COUNT(*) AS n, COALESCE(SUM(rising_at > ?), 0) AS rising FROM repos WHERE key NOT LIKE '%@%' AND key NOT IN (SELECT key FROM repo_gone)", args: [weekAgo] }),
  ]).then(([langs, rising]) => ({
    languages: langs.rows.map((r) => ({ name: String(r.language), count: Number(r.n) })),
    all: Number(rising.rows[0]?.n ?? 0),
    rising: Number(rising.rows[0]?.rising ?? 0),
  }));
  totalsCache = { at: Date.now(), value };
  value.catch(() => (totalsCache = null)); // a failed count is asked again next time
  return value;
}

// Every repo page for the sitemap, most looked-up first (search engines read the top of big sitemaps first).
export function sitemapRepos(limit = 45000): Promise<{ fullName: string; analyzedAt: number }[]> {
  return safely([], async (c) => {
    const { rows } = await c.execute({
      sql: "SELECT full_name, analyzed_at FROM repos WHERE key NOT LIKE '%@%' AND key NOT IN (SELECT key FROM repo_gone) ORDER BY views DESC, stars DESC LIMIT ?",
      args: [limit],
    });
    return rows.map((r) => ({ fullName: String(r.full_name), analyzedAt: Number(r.analyzed_at) }));
  });
}

// ---------- Facebook page posts (see lib/facebook.ts) ----------

export type FbPost = {
  id: string;
  repo: string;
  kind: "poster" | "reel";
  caption: string | null;
  permalink: string;
  createdAt: number;
  videoId?: string | null; // Reels: the video, for playing it on the page
  syncedAt?: number;
};

export function fbKnownIds(): Promise<Set<string>> {
  return safely(new Set<string>(), async (c) => new Set((await c.execute("SELECT id FROM fb_posts")).rows.map((r) => String(r.id))));
}

export function saveFbPost(p: FbPost, image: { bytes: Uint8Array; type: string } | null): Promise<unknown> {
  fbCache = null;
  return safely(null, (c) =>
    c.execute({
      sql: `INSERT INTO fb_posts (id, repo, kind, caption, permalink, created_at, image, image_type, synced_at, video_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET repo = excluded.repo, kind = excluded.kind, caption = excluded.caption, video_id = excluded.video_id,
              permalink = excluded.permalink, image = COALESCE(excluded.image, fb_posts.image),
              image_type = COALESCE(excluded.image_type, fb_posts.image_type), synced_at = excluded.synced_at`,
      args: [p.id, p.repo, p.kind, p.caption, p.permalink, p.createdAt, image?.bytes ?? null, image?.type ?? null, Date.now(), p.videoId ?? null],
    }),
  );
}

// Read for every manual (does this repo have a Finds post?), so kept in memory for 5 minutes; a sync clears it.
let fbCache: { at: number; posts: Promise<FbPost[]> } | null = null;
export function listFbPosts(): Promise<FbPost[]> {
  if (fbCache && Date.now() - fbCache.at < 300e3) return fbCache.posts;
  const posts = readFbPosts().then((list) => {
    if (!list) fbCache = null; // didn't answer: asked again next time
    return list ?? [];
  });
  fbCache = { at: Date.now(), posts };
  return posts;
}

function readFbPosts(): Promise<FbPost[] | null> {
  return safely<FbPost[] | null>(null, async (c) =>
    (await c.execute("SELECT id, repo, kind, caption, permalink, created_at, synced_at, video_id FROM fb_posts ORDER BY created_at DESC LIMIT 500")).rows.map((r) => ({
      id: String(r.id),
      repo: String(r.repo),
      kind: r.kind === "reel" ? ("reel" as const) : ("poster" as const),
      caption: r.caption == null ? null : String(r.caption),
      permalink: String(r.permalink),
      createdAt: Number(r.created_at),
      syncedAt: Number(r.synced_at),
      videoId: r.video_id == null ? null : String(r.video_id),
    })),
  );
}

export function fbImage(id: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  return safely(null, async (c) => {
    const row = (await c.execute({ sql: "SELECT image, image_type FROM fb_posts WHERE id = ?", args: [id] })).rows[0];
    return row?.image ? { bytes: row.image as ArrayBuffer, type: String(row.image_type ?? "image/jpeg") } : null;
  });
}

// Repo names on the shelf, for matching a post that names a project without linking it ("Peekaboo lets agents…").
// Only names that belong to exactly one repo.
export function shelfNames(): Promise<Map<string, string>> {
  return safely(new Map<string, string>(), async (c) => {
    const rows = (await c.execute("SELECT full_name FROM repos WHERE key NOT LIKE '%@%' AND key NOT IN (SELECT key FROM repo_gone)")).rows.map((r) => String(r.full_name));
    const byName = new Map<string, string[]>();
    for (const full of rows) {
      // "lossless-cut", "LosslessCut" and "losslesscut" are the same name.
      const name = full.split("/")[1].toLowerCase().replace(/[-_.]/g, "");
      byName.set(name, [...(byName.get(name) ?? []), full]);
    }
    return new Map([...byName].filter(([, list]) => list.length === 1).map(([name, [full]]) => [name, full]));
  });
}

// Counts one use of a limited action in a fixed time window; returns the count so far, or 0 when the
// database is unavailable (limits then let requests through rather than blocking everyone).
export function hit(bucket: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
  return safely({ count: 0, resetAt: 0 }, async (c) => {
    const now = Date.now();
    const { rows } = await c.execute({
      sql: `INSERT INTO hits (bucket, count, reset_at) VALUES (?, 1, ?)
            ON CONFLICT (bucket) DO UPDATE SET
              count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
              reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
            RETURNING count, reset_at`,
      args: [bucket, now + windowMs, now, now],
    });
    // Now and then, clear out windows that have ended.
    if (Math.random() < 0.02) await c.execute({ sql: "DELETE FROM hits WHERE reset_at <= ?", args: [now] });
    return { count: Number(rows[0].count), resetAt: Number(rows[0].reset_at) };
  });
}

// API keys (lib/apikeys.ts). Lookups say "error" rather than "no key" when the database can't answer, so an
// outage doesn't turn every key away as wrong.
export type ApiKey = { prefix: string; githubId: number; login: string; createdAt: number; lastUsed: number | null; uses: number; blocked: boolean };

const toKey = (r: Record<string, unknown>): ApiKey => ({
  prefix: String(r.prefix),
  githubId: Number(r.github_id),
  login: String(r.login),
  createdAt: Number(r.created_at),
  lastUsed: r.last_used == null ? null : Number(r.last_used),
  uses: Number(r.uses),
  blocked: Number(r.blocked) === 1,
});

export async function keyByHash(hash: string): Promise<ApiKey | null | "error"> {
  return safely<ApiKey | null | "error">("error", async (c) => {
    const { rows } = await c.execute({ sql: "SELECT * FROM api_keys WHERE hash = ?", args: [hash] });
    return rows[0] ? toKey(rows[0]) : null;
  });
}

export async function keyForUser(githubId: number): Promise<ApiKey | null> {
  return safely(null, async (c) => {
    const { rows } = await c.execute({ sql: "SELECT * FROM api_keys WHERE github_id = ?", args: [githubId] });
    return rows[0] ? toKey(rows[0]) : null;
  });
}

// A new key replaces the account's old one; a blocked account stays blocked.
export async function saveKey(k: { hash: string; prefix: string; githubId: number; login: string }): Promise<boolean> {
  return safely(false, async (c) => {
    const old = await keyForUser(k.githubId);
    if (old?.blocked) return false;
    await c.batch(
      [
        { sql: "DELETE FROM api_keys WHERE github_id = ?", args: [k.githubId] },
        { sql: "INSERT INTO api_keys (hash, prefix, github_id, login, created_at) VALUES (?, ?, ?, ?, ?)", args: [k.hash, k.prefix, k.githubId, k.login, Date.now()] },
      ],
      "write",
    );
    return true;
  });
}

export async function deleteKey(githubId: number): Promise<void> {
  await safely(null, (c) => c.execute({ sql: "DELETE FROM api_keys WHERE github_id = ? AND blocked = 0", args: [githubId] }));
}

export async function useKey(hash: string): Promise<void> {
  await safely(null, (c) => c.execute({ sql: "UPDATE api_keys SET uses = uses + 1, last_used = ? WHERE hash = ?", args: [Date.now(), hash] }));
}

export async function listKeys(): Promise<ApiKey[]> {
  return safely([], async (c) => (await c.execute("SELECT * FROM api_keys ORDER BY last_used DESC NULLS LAST, created_at DESC")).rows.map(toKey));
}

export async function blockKey(githubId: number, blocked: boolean): Promise<void> {
  await safely(null, (c) => c.execute({ sql: "UPDATE api_keys SET blocked = ? WHERE github_id = ?", args: [blocked ? 1 : 0, githubId] }));
}

// Someone signed in with GitHub (app/api/github/callback), or used chat while signed in (sign_ins unchanged).
// Their GitHub id, username and when: nothing else is kept about them here.
export async function seeUser(githubId: number, login: string, signIn: boolean, now = Date.now()): Promise<void> {
  await safely(null, (c) =>
    c.execute({
      sql: `INSERT INTO users (github_id, login, first_seen, last_seen, sign_ins) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, last_seen = excluded.last_seen, sign_ins = sign_ins + excluded.sign_ins`,
      args: [githubId, login, now, now, signIn ? 1 : 0],
    }),
  );
}

export type UserRow = {
  githubId: number;
  login: string;
  firstSeen: number;
  lastSeen: number;
  signIns: number;
  answers: number; // chat answers in the last 14 days
  repos: string[]; // the repos those answers were about, most asked first
  apiKey: boolean;
  pro: { status: string; plan: string | null; periodEnd: number } | null; // their GitManual Pro subscription, if they ever had one
};

// For /admin/users: everyone who signed in, newest first, with their recent chat use and whether they have an API key.
export async function listUsers(now = Date.now()): Promise<UserRow[]> {
  return strictly(async (c) => {
    const since = new Date(now - 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { rows } = await c.execute({
      sql: `SELECT u.github_id, u.login, u.first_seen, u.last_seen, u.sign_ins,
              (SELECT COUNT(*) FROM chat_spend s WHERE s.pool IN ('user', 'pro') AND s.account = CAST(u.github_id AS TEXT) AND s.day >= ?) AS answers,
              (SELECT GROUP_CONCAT(repo, ' ') FROM (SELECT repo, COUNT(*) AS n FROM chat_spend s
                 WHERE s.pool IN ('user', 'pro') AND s.account = CAST(u.github_id AS TEXT) AND s.day >= ? AND repo IS NOT NULL
                 GROUP BY repo ORDER BY n DESC LIMIT 5)) AS repos,
              EXISTS (SELECT 1 FROM api_keys k WHERE k.github_id = u.github_id) AS api_key,
              p.status AS pro_status, p.plan AS pro_plan, p.period_end AS pro_end
            FROM users u LEFT JOIN subscriptions p ON p.github_id = u.github_id ORDER BY u.first_seen DESC LIMIT 1000`,
      args: [since, since],
    });
    return rows.map((r) => ({
      githubId: Number(r.github_id),
      login: String(r.login),
      firstSeen: Number(r.first_seen),
      lastSeen: Number(r.last_seen),
      signIns: Number(r.sign_ins),
      answers: Number(r.answers),
      repos: r.repos ? String(r.repos).split(" ") : [],
      apiKey: Boolean(Number(r.api_key)),
      pro: r.pro_status ? { status: String(r.pro_status), plan: r.pro_plan ? String(r.pro_plan) : null, periodEnd: Number(r.pro_end) } : null,
    }));
  });
}

// GitManual Pro (lib/stripe.ts). Written only from Stripe's webhooks, read on every chat answer and on /pro.
export type SubscriptionRow = {
  githubId: number;
  customer: string;
  subscription: string;
  status: string;
  plan: "month" | "year" | null;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
};

const toSubscription = (r: Record<string, unknown>): SubscriptionRow => ({
  githubId: Number(r.github_id),
  customer: String(r.customer),
  subscription: String(r.subscription),
  status: String(r.status),
  plan: r.plan === "month" || r.plan === "year" ? r.plan : null,
  periodEnd: Number(r.period_end),
  cancelAtPeriodEnd: Boolean(Number(r.cancel_at_period_end)),
});

// One row per GitHub account. A newer subscription replaces an older, ended one; an event for an old subscription
// never overwrites a newer one that's still running.
export async function saveSubscription(s: SubscriptionRow, now = Date.now()): Promise<void> {
  await strictly((c) =>
    c.execute({
      sql: `INSERT INTO subscriptions (github_id, customer, subscription, status, plan, period_end, cancel_at_period_end, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (github_id) DO UPDATE SET customer = excluded.customer, subscription = excluded.subscription, status = excluded.status,
          plan = excluded.plan, period_end = excluded.period_end, cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at
        WHERE subscriptions.subscription = excluded.subscription
          OR subscriptions.status NOT IN ('active', 'trialing', 'past_due')
          OR excluded.status IN ('active', 'trialing', 'past_due')`,
      args: [s.githubId, s.customer, s.subscription, s.status, s.plan, s.periodEnd, s.cancelAtPeriodEnd ? 1 : 0, now],
    }),
  );
}

// ── One-time repo reports (lib/pro.ts recordPurchase, /profile/reports) ────────────────────────────────────────────

export type Purchase = { session: string; githubId: number; repo: string; fullName: string; amount: number; currency: string; paidAt: number };

// Idempotent: the return from checkout and Stripe's webhook both record the same session.
export async function savePurchase(p: Purchase): Promise<void> {
  await strictly((c) =>
    c.execute({
      sql: "INSERT OR IGNORE INTO purchases (session, github_id, repo, full_name, amount, currency, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [p.session, p.githubId, p.repo.toLowerCase(), p.fullName, p.amount, p.currency, p.paidAt],
    }),
  );
}

// Strict: a failing database answers with an error rather than "not bought", and callers treat errors as no access.
export async function hasPurchase(githubId: number, repo: string): Promise<boolean> {
  return strictly(async (c) => {
    const { rows } = await c.execute({ sql: "SELECT 1 FROM purchases WHERE github_id = ? AND repo = ? LIMIT 1", args: [githubId, repo.toLowerCase()] });
    return rows.length > 0;
  });
}

// For /admin/purchases: every one-time purchase and every Pro subscription, newest first, with the buyer's GitHub
// username. Throws when the database doesn't answer, so the page says so instead of showing "no purchases".
export type AdminPurchase = Purchase & { login: string | null };
export type AdminSubscription = SubscriptionRow & { login: string | null; updatedAt: number };
export async function listPayments(limit = 1000): Promise<{ purchases: AdminPurchase[]; subscriptions: AdminSubscription[] }> {
  return strictly(async (c) => {
    const [purchases, subscriptions] = await Promise.all([
      c.execute({
        sql: "SELECT p.*, u.login FROM purchases p LEFT JOIN users u ON u.github_id = p.github_id ORDER BY p.paid_at DESC LIMIT ?",
        args: [limit],
      }),
      c.execute("SELECT s.*, u.login FROM subscriptions s LEFT JOIN users u ON u.github_id = s.github_id ORDER BY s.updated_at DESC"),
    ]);
    const login = (r: Record<string, unknown>) => (r.login == null ? null : String(r.login));
    return {
      purchases: purchases.rows.map((r) => ({
        session: String(r.session),
        githubId: Number(r.github_id),
        repo: String(r.repo),
        fullName: String(r.full_name),
        amount: Number(r.amount),
        currency: String(r.currency),
        paidAt: Number(r.paid_at),
        login: login(r),
      })),
      subscriptions: subscriptions.rows.map((r) => ({ ...toSubscription(r), login: login(r), updatedAt: Number(r.updated_at) })),
    };
  });
}

export async function purchasesFor(githubId: number): Promise<Purchase[]> {
  return strictly(async (c) => {
    const { rows } = await c.execute({ sql: "SELECT * FROM purchases WHERE github_id = ? ORDER BY paid_at DESC", args: [githubId] });
    return rows.map((r) => ({
      session: String(r.session),
      githubId: Number(r.github_id),
      repo: String(r.repo),
      fullName: String(r.full_name),
      amount: Number(r.amount),
      currency: String(r.currency),
      paidAt: Number(r.paid_at),
    }));
  });
}

// For /admin/email: what an email is about, so the template can name the repo and the plan.
export async function purchaseBySession(session: string): Promise<(Purchase & { login: string | null }) | null> {
  return strictly(async (c) => {
    const { rows } = await c.execute({
      sql: "SELECT p.*, u.login FROM purchases p LEFT JOIN users u ON u.github_id = p.github_id WHERE p.session = ?",
      args: [session],
    });
    const r = rows[0];
    if (!r) return null;
    return {
      session: String(r.session),
      githubId: Number(r.github_id),
      repo: String(r.repo),
      fullName: String(r.full_name),
      amount: Number(r.amount),
      currency: String(r.currency),
      paidAt: Number(r.paid_at),
      login: r.login == null ? null : String(r.login),
    };
  });
}

export async function subscriptionById(subscription: string): Promise<(SubscriptionRow & { login: string | null }) | null> {
  return strictly(async (c) => {
    const { rows } = await c.execute({
      sql: "SELECT s.*, u.login FROM subscriptions s LEFT JOIN users u ON u.github_id = s.github_id WHERE s.subscription = ?",
      args: [subscription],
    });
    return rows.length ? { ...toSubscription(rows[0]), login: rows[0].login == null ? null : String(rows[0].login) } : null;
  });
}

// Emails sent from /admin/email. The address is kept masked: enough to tell which one it went to.
export type EmailRef = { kind: "problem" | "purchase" | "subscription" | "custom"; id: string };
export type EmailSent = { id: number; sentAt: number; ref: EmailRef; toHint: string; fromAddress: string | null; subject: string; admin: string; resendId: string | null };

export async function logEmail(e: Omit<EmailSent, "id" | "sentAt">): Promise<void> {
  await strictly((c) =>
    c.execute({
      sql: "INSERT INTO email_log (sent_at, ref_kind, ref_id, to_hint, from_address, subject, admin, resend_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [Date.now(), e.ref.kind, e.ref.id, e.toHint, e.fromAddress, e.subject, e.admin, e.resendId],
    }),
  );
}

const toEmailSent = (r: Record<string, unknown>): EmailSent => ({
  id: Number(r.id),
  sentAt: Number(r.sent_at),
  ref: { kind: String(r.ref_kind) as EmailRef["kind"], id: String(r.ref_id) },
  toHint: String(r.to_hint),
  fromAddress: r.from_address == null ? null : String(r.from_address),
  subject: String(r.subject),
  admin: String(r.admin),
  resendId: r.resend_id == null ? null : String(r.resend_id),
});

export async function listEmails(ref?: EmailRef, max = 500): Promise<EmailSent[]> {
  return strictly(async (c) => {
    const { rows } = await c.execute({
      sql: `SELECT * FROM email_log ${ref ? "WHERE ref_kind = ? AND ref_id = ?" : ""} ORDER BY sent_at DESC LIMIT ?`,
      args: ref ? [ref.kind, ref.id, max] : [max],
    });
    return rows.map(toEmailSent);
  });
}

export async function subscriptionFor(githubId: number): Promise<SubscriptionRow | null> {
  return strictly(async (c) => {
    const { rows } = await c.execute({ sql: "SELECT * FROM subscriptions WHERE github_id = ?", args: [githubId] });
    return rows.length ? toSubscription(rows[0]) : null;
  });
}

export async function githubIdForSubscription(subscription: string): Promise<number | null> {
  return strictly(async (c) => {
    const { rows } = await c.execute({ sql: "SELECT github_id FROM subscriptions WHERE subscription = ?", args: [subscription] });
    return rows.length ? Number(rows[0].github_id) : null;
  });
}

// Demand tests: a button for a feature that isn't built yet counts who presses it (app/api/interest).
export function countInterest(feature: string, repo: string, now = Date.now()): Promise<unknown> {
  return safely(null, (c) =>
    c.execute({
      sql: `INSERT INTO interest (feature, day, repo, clicks) VALUES (?, ?, ?, 1)
        ON CONFLICT (feature, day, repo) DO UPDATE SET clicks = clicks + 1`,
      args: [feature, new Date(now).toISOString().slice(0, 10), repo.toLowerCase()],
    }),
  );
}

export type InterestStats = { total: number; days: { day: string; clicks: number }[]; repos: { repo: string; clicks: number }[] };

export async function interestStats(feature: string, days = 30, now = Date.now()): Promise<InterestStats> {
  const since = new Date(now - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return strictly(async (c) => {
    const byDay = await c.execute({
      sql: "SELECT day, SUM(clicks) AS clicks FROM interest WHERE feature = ? AND day >= ? GROUP BY day ORDER BY day DESC",
      args: [feature, since],
    });
    const byRepo = await c.execute({
      sql: "SELECT repo, SUM(clicks) AS clicks FROM interest WHERE feature = ? AND day >= ? GROUP BY repo ORDER BY clicks DESC LIMIT 15",
      args: [feature, since],
    });
    const list = byDay.rows.map((r) => ({ day: String(r.day), clicks: Number(r.clicks) }));
    return { total: list.reduce((n, d) => n + d.clicks, 0), days: list, repos: byRepo.rows.map((r) => ({ repo: String(r.repo), clicks: Number(r.clicks) })) };
  });
}

// Deep Inspection reports (lib/inspection), one per repo, shared by every Pro member who opens it.
export function getInspection(key: string): Promise<{ version: number; data: unknown; scannedAt: number } | null> {
  return safely(null, async (c) => {
    const r = (await c.execute({ sql: "SELECT version, data, scanned_at FROM inspections WHERE key = ?", args: [key] })).rows[0];
    return r ? { version: Number(r.version), data: JSON.parse(String(r.data)), scannedAt: Number(r.scanned_at) } : null;
  });
}

export function saveInspection(key: string, version: number, data: unknown, scannedAt: number, snapshot: unknown): Promise<unknown> {
  return safely(null, (c) =>
    c.batch(
      [
        {
          sql: "INSERT INTO inspections (key, version, data, scanned_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET version = excluded.version, data = excluded.data, scanned_at = excluded.scanned_at",
          args: [key, version, JSON.stringify(data), scannedAt],
        },
        { sql: "INSERT OR IGNORE INTO inspection_snapshots (key, scanned_at, data) VALUES (?, ?, ?)", args: [key, scannedAt, JSON.stringify(snapshot)] },
      ],
      "write",
    ),
  );
}

// ── Saved repos (/profile/saved) ─────────────────────────────────────────────────────────────────────────────────
// A signed-in person's shortlist: what they want to try, have installed or gave up on. Public repos only.

export const SAVE_STATUSES = ["try", "installed", "dropped"] as const;
export type SaveStatus = (typeof SAVE_STATUSES)[number];
export const MAX_SAVES = 500;

export type Save = { key: string; os: string; status: SaveStatus; savedAt: number; updatedAt: number; releaseTag: string | null };
export type SavedCard = Save & { card: RepoCard | null; latestTag: string | null; latestAt: string | null };

const latestTag = "json_extract(r.data, '$.install.release.tag')";

export function getSave(githubId: number, key: string): Promise<Save | null> {
  return strictly(async (c) => {
    const r = (await c.execute({ sql: "SELECT * FROM saves WHERE github_id = ? AND key = ?", args: [githubId, key] })).rows[0];
    return r ? toSave(r) : null;
  });
}

const toSave = (r: Record<string, unknown>): Save => ({
  key: String(r.key),
  os: String(r.os),
  status: String(r.status) as SaveStatus,
  savedAt: Number(r.saved_at),
  updatedAt: Number(r.updated_at),
  releaseTag: r.release_tag == null ? null : String(r.release_tag),
});

// Saves a repo, or changes the status or computer of one already saved. The release tag is the one known when it was
// first saved, so "new release" means new since then. `null` when the list is full.
export function putSave(githubId: number, key: string, os: string, status: SaveStatus, now = Date.now()): Promise<Save | null> {
  return strictly(async (c) => {
    const had = (await c.execute({ sql: "SELECT 1 FROM saves WHERE github_id = ? AND key = ?", args: [githubId, key] })).rows.length > 0;
    if (!had) {
      const n = Number((await c.execute({ sql: "SELECT COUNT(*) AS n FROM saves WHERE github_id = ?", args: [githubId] })).rows[0].n);
      if (n >= MAX_SAVES) return null;
    }
    await c.execute({
      sql: `INSERT INTO saves (github_id, key, os, status, release_tag, saved_at, updated_at)
            VALUES (?, ?, ?, ?, (SELECT ${latestTag} FROM repos r WHERE r.key = ?), ?, ?)
            ON CONFLICT (github_id, key) DO UPDATE SET os = excluded.os, status = excluded.status, updated_at = excluded.updated_at`,
      args: [githubId, key, os, status, key, now, now],
    });
    const r = (await c.execute({ sql: "SELECT * FROM saves WHERE github_id = ? AND key = ?", args: [githubId, key] })).rows[0];
    return toSave(r);
  });
}

export function deleteSave(githubId: number, key: string): Promise<void> {
  return strictly(async (c) => {
    await c.execute({ sql: "DELETE FROM saves WHERE github_id = ? AND key = ?", args: [githubId, key] });
  });
}

// Undo for "Remove": puts saves back exactly as they were (when saved, status, computer, release seen). `false`, and
// nothing changed, when that would take the list past MAX_SAVES.
export function restoreSaves(githubId: number, saves: Save[]): Promise<boolean> {
  return strictly(async (c) => {
    const keys = [...new Set(saves.map((x) => x.key))];
    const n = Number((await c.execute({ sql: "SELECT COUNT(*) AS n FROM saves WHERE github_id = ?", args: [githubId] })).rows[0].n);
    const had = Number(
      (await c.execute({ sql: `SELECT COUNT(*) AS n FROM saves WHERE github_id = ? AND key IN (${keys.map(() => "?").join(",")})`, args: [githubId, ...keys] }))
        .rows[0].n,
    );
    if (n - had + keys.length > MAX_SAVES) return false;
    await c.batch(
      saves.map((x) => ({
        sql: `INSERT OR REPLACE INTO saves (github_id, key, os, status, release_tag, saved_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [githubId, x.key, x.os, x.status, x.releaseTag, x.savedAt, x.updatedAt],
      })),
      "write",
    );
    return true;
  });
}

// "Seen the release": the saved tag moves to the latest one.
export function ackRelease(githubId: number, key: string): Promise<void> {
  return strictly(async (c) => {
    await c.execute({
      sql: `UPDATE saves SET release_tag = (SELECT ${latestTag} FROM repos r WHERE r.key = saves.key) WHERE github_id = ? AND key = ?`,
      args: [githubId, key],
    });
  });
}

export function listSaves(githubId: number): Promise<SavedCard[]> {
  return strictly(async (c) => {
    const rows = await c.execute({
      sql: `SELECT s.*, r.full_name, r.description, r.stars, r.language, r.difficulty, r.views, r.analyzed_at, r.rising_at,
                   r.worked, r.stuck, ${latestTag} AS latest_tag, json_extract(r.data, '$.install.release.publishedAt') AS latest_at
            FROM saves s LEFT JOIN repos r ON r.key = s.key
            WHERE s.github_id = ?
            ORDER BY s.updated_at DESC`,
      args: [githubId],
    });
    return rows.rows.map((r) => ({
      ...toSave(r),
      latestTag: r.latest_tag == null ? null : String(r.latest_tag),
      latestAt: r.latest_at == null ? null : String(r.latest_at),
      card:
        r.full_name == null
          ? null
          : {
              fullName: String(r.full_name),
              description: r.description == null ? null : String(r.description),
              stars: Number(r.stars),
              language: r.language == null ? null : String(r.language),
              difficulty: String(r.difficulty),
              views: Number(r.views),
              worked: Number(r.worked),
              stuck: Number(r.stuck),
              analyzedAt: Number(r.analyzed_at),
              risingAt: r.rising_at == null ? null : Number(r.rising_at),
            },
    }));
  });
}

// For /admin: how many saves, by how many people, and what's saved most.
export type SaveStats = { total: number; people: number; recent: number; top: { repo: string; saves: number }[] };
export function saveStats(days = 30, now = Date.now()): Promise<SaveStats> {
  return strictly(async (c) => {
    const [all, recent, top] = await Promise.all([
      c.execute("SELECT COUNT(*) AS n, COUNT(DISTINCT github_id) AS p FROM saves"),
      c.execute({ sql: "SELECT COUNT(*) AS n FROM saves WHERE saved_at > ?", args: [now - days * 864e5] }),
      c.execute("SELECT key, COUNT(*) AS n FROM saves GROUP BY key ORDER BY n DESC, key LIMIT 10"),
    ]);
    return {
      total: Number(all.rows[0].n),
      people: Number(all.rows[0].p),
      recent: Number(recent.rows[0].n),
      top: top.rows.map((r) => ({ repo: String(r.key), saves: Number(r.n) })),
    };
  });
}

// "Something wrong?" reports from a manual (app/report-problem.tsx, app/api/problems), read on /admin/problems.
export type ProblemStatus = "open" | "fixed" | "closed";
export type Problem = {
  id: number;
  createdAt: number;
  repo: string;
  os: string;
  kind: string;
  step: number | null;
  stepTitle: string | null;
  message: string;
  error: string | null;
  email: string | null;
  githubLogin: string | null;
  page: string | null;
  mode: string;
  name: string | null;
  version: number;
  status: ProblemStatus;
  repliedAt: number | null; // the last email sent about it from /admin/email
};

// The new report's id.
export async function saveProblem(p: Omit<Problem, "id" | "createdAt" | "status" | "repliedAt">): Promise<number> {
  const r = await strictly((c) =>
    c.execute({
      sql: `INSERT INTO problems (created_at, mode, repo, os, kind, step, step_title, name, message, error, email, github_login, page, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [Date.now(), p.mode, p.repo, p.os, p.kind, p.step, p.stepTitle, p.name, p.message, p.error, p.email, p.githubLogin, p.page, p.version],
    }),
  );
  return Number(r.lastInsertRowid ?? 0);
}

const toProblem = (r: Record<string, unknown>): Problem => ({
  id: Number(r.id),
  createdAt: Number(r.created_at),
  repo: String(r.repo),
  os: String(r.os),
  kind: String(r.kind),
  step: r.step == null ? null : Number(r.step),
  stepTitle: r.step_title == null ? null : String(r.step_title),
  message: String(r.message),
  error: r.error == null ? null : String(r.error),
  email: r.email == null ? null : String(r.email),
  githubLogin: r.github_login == null ? null : String(r.github_login),
  page: r.page == null ? null : String(r.page),
  mode: String(r.mode ?? "manual"),
  name: r.name == null ? null : String(r.name),
  version: Number(r.version),
  status: String(r.status) as ProblemStatus,
  repliedAt: r.replied_at == null ? null : Number(r.replied_at),
});
const REPLIED = "(SELECT MAX(sent_at) FROM email_log e WHERE e.ref_kind = 'problem' AND e.ref_id = CAST(problems.id AS TEXT)) AS replied_at";

export async function listProblems(status: ProblemStatus | "all", max = 300): Promise<Problem[]> {
  return strictly(async (c) => {
    const { rows } = await c.execute({
      sql: `SELECT *, ${REPLIED} FROM problems ${status === "all" ? "" : "WHERE status = ?"} ORDER BY created_at DESC LIMIT ?`,
      args: status === "all" ? [max] : [status, max],
    });
    return rows.map(toProblem);
  });
}

export async function getProblem(id: number): Promise<Problem | null> {
  return strictly(async (c) => {
    const { rows } = await c.execute({ sql: `SELECT *, ${REPLIED} FROM problems WHERE id = ?`, args: [id] });
    return rows.length ? toProblem(rows[0]) : null;
  });
}

// For a user's page on /admin: what they reported while signed in.
export async function problemsByLogin(login: string, max = 100): Promise<Problem[]> {
  return strictly(async (c) => {
    const { rows } = await c.execute({
      sql: `SELECT *, ${REPLIED} FROM problems WHERE github_login = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`,
      args: [login, max],
    });
    return rows.map(toProblem);
  });
}

export async function setProblemStatus(id: number, status: ProblemStatus): Promise<void> {
  await strictly((c) => c.execute({ sql: "UPDATE problems SET status = ? WHERE id = ?", args: [status, id] }));
}

// ---- /admin home and /admin/health ----

// When a background part last ran (the Stripe webhook, the cron jobs). Never in the way: a failed write is only logged.
export function markHealth(name: string, ok: boolean, note?: string): Promise<void> {
  return safely(undefined, async (c) => {
    await c.execute({
      sql: "INSERT INTO health_marks (name, at, ok, note) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET at = excluded.at, ok = excluded.ok, note = excluded.note",
      args: [name, Date.now(), ok ? 1 : 0, note?.slice(0, 300) ?? null],
    });
  });
}

export type HealthMark = { name: string; at: number; ok: boolean; note: string | null };
export async function healthMarks(): Promise<HealthMark[]> {
  return strictly(async (c) => {
    const { rows } = await c.execute("SELECT * FROM health_marks ORDER BY name");
    return rows.map((r) => ({ name: String(r.name), at: Number(r.at), ok: Boolean(Number(r.ok)), note: r.note == null ? null : String(r.note) }));
  });
}

// How long the database takes to answer a trivial query, in ms.
export async function dbPing(): Promise<number> {
  const t = Date.now();
  await strictly((c) => c.execute("SELECT 1"));
  return Date.now() - t;
}

export type AdminOverview = {
  openProblems: number;
  unanswered: number; // open, and no email sent about it yet
  purchases7d: { count: number; totals: { currency: string; cents: number }[] };
  proRunning: number;
  users: number;
  newUsers7d: number;
  emails7d: number;
  chatSpendToday: number; // dollars
  attention: { id: number; createdAt: number; repo: string; kind: string; mode: string; message: string; hasEmail: boolean; login: string | null }[];
};

const RUNNING_SQL = "status IN ('active', 'trialing', 'past_due') AND period_end > ?";

export async function adminOverview(now = Date.now()): Promise<AdminOverview> {
  return strictly(async (c) => {
    const week = now - 7 * 864e5;
    const one = async (sql: string, args: (string | number)[] = []) => Number((await c.execute({ sql, args })).rows[0]?.n ?? 0);
    const unansweredSql = "status = 'open' AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.ref_kind = 'problem' AND e.ref_id = CAST(problems.id AS TEXT))";
    const [openProblems, unanswered, proRunning, users, newUsers7d, emails7d] = await Promise.all([
      one("SELECT COUNT(*) AS n FROM problems WHERE status = 'open'"),
      one(`SELECT COUNT(*) AS n FROM problems WHERE ${unansweredSql}`),
      one(`SELECT COUNT(*) AS n FROM subscriptions WHERE ${RUNNING_SQL}`, [now]),
      one("SELECT COUNT(*) AS n FROM users"),
      one("SELECT COUNT(*) AS n FROM users WHERE first_seen >= ?", [week]),
      one("SELECT COUNT(*) AS n FROM email_log WHERE sent_at >= ?", [week]),
    ]);
    // Test-mode checkouts (cs_test_) are left out, as on /admin/purchases.
    const bought = await c.execute({
      sql: "SELECT currency, COUNT(*) AS n, SUM(amount) AS cents FROM purchases WHERE paid_at >= ? AND session NOT LIKE 'cs\\_test\\_%' ESCAPE '\\' GROUP BY currency",
      args: [week],
    });
    const spend = await c.execute({
      sql: "SELECT COALESCE(SUM(COALESCE(cost, reserved)), 0) AS m FROM chat_spend WHERE day = ?",
      args: [new Date(now).toISOString().slice(0, 10)],
    });
    const att = await c.execute(
      `SELECT id, created_at, repo, kind, mode, substr(message, 1, 200) AS message, email IS NOT NULL AS has_email, github_login FROM problems
       WHERE ${unansweredSql} ORDER BY created_at ASC LIMIT 10`,
    );
    return {
      openProblems,
      unanswered,
      purchases7d: {
        count: bought.rows.reduce((n, r) => n + Number(r.n), 0),
        totals: bought.rows.map((r) => ({ currency: String(r.currency), cents: Number(r.cents) })),
      },
      proRunning,
      users,
      newUsers7d,
      emails7d,
      chatSpendToday: Number(spend.rows[0]?.m ?? 0) / 1e6,
      attention: att.rows.map((r) => ({
        id: Number(r.id),
        createdAt: Number(r.created_at),
        repo: String(r.repo),
        kind: String(r.kind),
        mode: String(r.mode ?? "manual"),
        message: String(r.message),
        hasEmail: Boolean(Number(r.has_email)),
        login: r.github_login == null ? null : String(r.github_login),
      })),
    };
  });
}

// Everything on one person, for /admin/user. Null when the GitHub id isn't a user here and never bought anything.
export async function userById(githubId: number): Promise<{ githubId: number; login: string | null; firstSeen: number | null; lastSeen: number | null; signIns: number } | null> {
  return strictly(async (c) => {
    const { rows } = await c.execute({ sql: "SELECT * FROM users WHERE github_id = ?", args: [githubId] });
    const r = rows[0];
    if (!r) return null;
    return { githubId, login: String(r.login), firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen), signIns: Number(r.sign_ins) };
  });
}

export async function githubIdForLogin(login: string): Promise<number | null> {
  return strictly(async (c) => {
    const { rows } = await c.execute({ sql: "SELECT github_id FROM users WHERE login = ? COLLATE NOCASE", args: [login] });
    return rows.length ? Number(rows[0].github_id) : null;
  });
}

// Emails sent about any of these (a user's problems, purchases and subscription).
export async function emailsAbout(refs: EmailRef[], max = 200): Promise<EmailSent[]> {
  if (!refs.length) return [];
  const keys = [...new Set(refs.map((r) => `${r.kind}:${r.id}`))].slice(0, 500);
  return strictly(async (c) => {
    const { rows } = await c.execute({
      sql: `SELECT * FROM email_log WHERE ref_kind || ':' || ref_id IN (${keys.map(() => "?").join(", ")}) ORDER BY sent_at DESC LIMIT ?`,
      args: [...keys, max],
    });
    return rows.map(toEmailSent);
  });
}

// The daily summary email (app/api/cron/digest): what came in since `since`.
export async function sinceNumbers(since: number): Promise<{ problems: number; purchases: number; totals: { currency: string; cents: number }[]; newUsers: number }> {
  return strictly(async (c) => {
    const n = async (sql: string) => Number((await c.execute({ sql, args: [since] })).rows[0]?.n ?? 0);
    const [problems, newUsers] = await Promise.all([n("SELECT COUNT(*) AS n FROM problems WHERE created_at >= ?"), n("SELECT COUNT(*) AS n FROM users WHERE first_seen >= ?")]);
    const bought = await c.execute({
      sql: "SELECT currency, COUNT(*) AS n, SUM(amount) AS cents FROM purchases WHERE paid_at >= ? AND session NOT LIKE 'cs\\_test\\_%' ESCAPE '\\' GROUP BY currency",
      args: [since],
    });
    return {
      problems,
      purchases: bought.rows.reduce((t, r) => t + Number(r.n), 0),
      totals: bought.rows.map((r) => ({ currency: String(r.currency), cents: Number(r.cents) })),
      newUsers,
    };
  });
}

// A user's chat in the last 14 days, for /admin/user.
export async function chatUsageFor(githubId: number, now = Date.now()): Promise<{ answers: number; spent: number; repos: { repo: string; answers: number }[] }> {
  return strictly(async (c) => {
    const since = new Date(now - 13 * 864e5).toISOString().slice(0, 10);
    const args = [String(githubId), since];
    const total = await c.execute({
      sql: "SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(cost, reserved)), 0) AS m FROM chat_spend WHERE pool IN ('user', 'pro') AND account = ? AND day >= ?",
      args,
    });
    const repos = await c.execute({
      sql: "SELECT repo, COUNT(*) AS n FROM chat_spend WHERE pool IN ('user', 'pro') AND account = ? AND day >= ? AND repo IS NOT NULL GROUP BY repo ORDER BY n DESC LIMIT 10",
      args,
    });
    return {
      answers: Number(total.rows[0]?.n ?? 0),
      spent: Number(total.rows[0]?.m ?? 0) / 1e6,
      repos: repos.rows.map((r) => ({ repo: String(r.repo), answers: Number(r.n) })),
    };
  });
}
