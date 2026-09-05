-- Run once with: wrangler d1 execute school-docs --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('download_documents', '1'),   -- documents are on by default
  ('download_images', '0'),
  ('download_videos', '0'),
  ('desync_message', ''),
  ('connection_status', 'disconnected'),  -- disconnected | connecting | connected
  ('last_sync_at', ''),
  ('qr_data', ''),
  ('qr_generated_at', '');

CREATE TABLE IF NOT EXISTS catchers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per WhatsApp group the bot has ever seen a file from.
CREATE TABLE IF NOT EXISTS groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,           -- hide from the folder list
  download_enabled INTEGER NOT NULL DEFAULT 1, -- whether the runner should save files from this group at all
  catcher_id TEXT REFERENCES catchers(id),     -- if set, this group's files are filed under the catcher instead
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  jid TEXT NOT NULL,             -- the group the file actually came from
  folder_type TEXT NOT NULL,     -- 'group' | 'catcher' — which kind of bucket it displays under
  folder_id TEXT NOT NULL,       -- jid or catcher id
  original_name TEXT NOT NULL,
  base_name TEXT NOT NULL,       -- name without extension, used to group re-sent/updated versions together
  b2_key TEXT NOT NULL,          -- object key in the Backblaze bucket
  mimetype TEXT,
  media_type TEXT NOT NULL,      -- document | image | video | audio
  size_bytes INTEGER,
  sender_name TEXT,
  sender_id TEXT,
  caption TEXT,
  sent_at TEXT,                  -- WhatsApp message timestamp
  received_at TEXT NOT NULL      -- when the runner downloaded it
);

CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_type, folder_id);
CREATE INDEX IF NOT EXISTS idx_files_basename ON files(base_name);

-- Simple outbox so the web UI can ask the runner to do something (currently just "de-sync").
-- The runner polls this since Cloudflare can't reach into a box behind a home/office NAT.
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
