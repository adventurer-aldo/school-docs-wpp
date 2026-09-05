import { Hono } from 'hono';
import { getSignedDownloadUrl } from './b2.js';

const app = new Hono();

// ---------- helpers ----------

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

async function setSetting(db, key, value) {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

async function getAllSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of results) map[r.key] = r.value;
  return map;
}

// Require the shared runner token — used only on the endpoints the runner (bot) calls.
async function requireRunnerAuth(c, next) {
  const auth = c.req.header('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || token !== c.env.RUNNER_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
}

// ---------- status & QR (public — read only, no secrets exposed) ----------

app.get('/api/status', async (c) => {
  const s = await getAllSettings(c.env.DB);
  const status = s.connection_status || 'disconnected';
  return c.json({
    status,
    lastSyncAt: s.last_sync_at || null,
    qr: status === 'connected' ? null : { data: s.qr_data || null, generatedAt: s.qr_generated_at || null },
  });
});

// ---------- runner -> worker ingest (authenticated) ----------

app.post('/api/ingest/qr', requireRunnerAuth, async (c) => {
  const { data } = await c.req.json();
  await setSetting(c.env.DB, 'qr_data', data || '');
  await setSetting(c.env.DB, 'qr_generated_at', nowIso());
  const status = await getSetting(c.env.DB, 'connection_status');
  if (status !== 'connected') await setSetting(c.env.DB, 'connection_status', 'connecting');
  return c.json({ ok: true });
});

app.post('/api/ingest/status', requireRunnerAuth, async (c) => {
  const { status, heartbeat } = await c.req.json();
  if (status) {
    await setSetting(c.env.DB, 'connection_status', status);
    if (status === 'connected') {
      await setSetting(c.env.DB, 'qr_data', '');
    }
  }
  if (heartbeat) {
    await setSetting(c.env.DB, 'last_sync_at', nowIso());
  }
  return c.json({ ok: true });
});

app.post('/api/ingest/group', requireRunnerAuth, async (c) => {
  const { jid, name } = await c.req.json();
  if (!jid) return c.json({ error: 'jid required' }, 400);
  const existing = await c.env.DB.prepare('SELECT jid FROM groups WHERE jid = ?').bind(jid).first();
  if (existing) {
    await c.env.DB.prepare('UPDATE groups SET name = ?, updated_at = ? WHERE jid = ?')
      .bind(name || jid, nowIso(), jid)
      .run();
  } else {
    await c.env.DB.prepare(
      'INSERT INTO groups (jid, name, hidden, download_enabled, catcher_id, created_at, updated_at) VALUES (?, ?, 0, 1, NULL, ?, ?)'
    )
      .bind(jid, name || jid, nowIso(), nowIso())
      .run();
  }
  return c.json({ ok: true });
});

// Runner calls this to find out, for a given group, whether it should bother
// downloading at all and which media types are enabled — kept server-side so
// settings changes apply immediately without redeploying the runner.
app.get('/api/ingest/group-config/:jid', requireRunnerAuth, async (c) => {
  const jid = c.req.param('jid');
  const group = await c.env.DB.prepare('SELECT * FROM groups WHERE jid = ?').bind(jid).first();
  const s = await getAllSettings(c.env.DB);
  return c.json({
    downloadEnabled: group ? !!group.download_enabled : true,
    catcherId: group ? group.catcher_id : null,
    downloadDocuments: s.download_documents === '1',
    downloadImages: s.download_images === '1',
    downloadVideos: s.download_videos === '1',
    desyncMessage: s.desync_message || '',
  });
});

app.post('/api/ingest/file', requireRunnerAuth, async (c) => {
  const body = await c.req.json();
  const {
    jid, originalName, baseName, b2Key, mimetype, mediaType,
    sizeBytes, senderName, senderId, caption, sentAt,
  } = body;
  if (!jid || !b2Key || !originalName) {
    return c.json({ error: 'jid, originalName and b2Key are required' }, 400);
  }

  const group = await c.env.DB.prepare('SELECT * FROM groups WHERE jid = ?').bind(jid).first();
  const folderType = group?.catcher_id ? 'catcher' : 'group';
  const folderId = group?.catcher_id || jid;

  await c.env.DB.prepare(
    `INSERT INTO files
      (id, jid, folder_type, folder_id, original_name, base_name, b2_key, mimetype, media_type, size_bytes, sender_name, sender_id, caption, sent_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      uuid(), jid, folderType, folderId, originalName, baseName || originalName, b2Key,
      mimetype || null, mediaType || 'document', sizeBytes || null, senderName || null,
      senderId || null, caption || null, sentAt || null, nowIso()
    )
    .run();

  await setSetting(c.env.DB, 'last_sync_at', nowIso());
  return c.json({ ok: true });
});

// ---------- commands (de-sync) ----------

// Web UI triggers this.
app.post('/api/commands/desync', async (c) => {
  await c.env.DB.prepare('INSERT INTO commands (id, type, created_at, acknowledged) VALUES (?, ?, ?, 0)')
    .bind(uuid(), 'desync', nowIso())
    .run();
  return c.json({ ok: true });
});

// Runner polls this.
app.get('/api/commands/pending', requireRunnerAuth, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM commands WHERE acknowledged = 0 ORDER BY created_at ASC').all();
  return c.json(results);
});

app.post('/api/commands/:id/ack', requireRunnerAuth, async (c) => {
  await c.env.DB.prepare('UPDATE commands SET acknowledged = 1 WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---------- settings (web UI) ----------

app.get('/api/settings', async (c) => {
  const s = await getAllSettings(c.env.DB);
  const { results: groups } = await c.env.DB.prepare('SELECT * FROM groups ORDER BY name COLLATE NOCASE').all();
  const { results: catchers } = await c.env.DB.prepare('SELECT * FROM catchers ORDER BY name COLLATE NOCASE').all();
  return c.json({
    downloadDocuments: s.download_documents === '1',
    downloadImages: s.download_images === '1',
    downloadVideos: s.download_videos === '1',
    desyncMessage: s.desync_message || '',
    groups: groups.map((g) => ({
      jid: g.jid,
      name: g.name,
      hidden: !!g.hidden,
      downloadEnabled: !!g.download_enabled,
      catcherId: g.catcher_id,
    })),
    catchers,
  });
});

app.post('/api/settings/media', async (c) => {
  const { downloadDocuments, downloadImages, downloadVideos } = await c.req.json();
  if (downloadDocuments !== undefined) await setSetting(c.env.DB, 'download_documents', downloadDocuments ? '1' : '0');
  if (downloadImages !== undefined) await setSetting(c.env.DB, 'download_images', downloadImages ? '1' : '0');
  if (downloadVideos !== undefined) await setSetting(c.env.DB, 'download_videos', downloadVideos ? '1' : '0');
  return c.json({ ok: true });
});

app.post('/api/settings/desync-message', async (c) => {
  const { message } = await c.req.json();
  await setSetting(c.env.DB, 'desync_message', message || '');
  return c.json({ ok: true });
});

app.post('/api/groups/:jid', async (c) => {
  const jid = c.req.param('jid');
  const { hidden, downloadEnabled, catcherId } = await c.req.json();
  const fields = [];
  const values = [];
  if (hidden !== undefined) { fields.push('hidden = ?'); values.push(hidden ? 1 : 0); }
  if (downloadEnabled !== undefined) { fields.push('download_enabled = ?'); values.push(downloadEnabled ? 1 : 0); }
  if (catcherId !== undefined) { fields.push('catcher_id = ?'); values.push(catcherId || null); }
  if (!fields.length) return c.json({ ok: true });
  fields.push('updated_at = ?'); values.push(nowIso());
  values.push(jid);
  await c.env.DB.prepare(`UPDATE groups SET ${fields.join(', ')} WHERE jid = ?`).bind(...values).run();

  // A group's files should move with it if its catcher mapping changes.
  if (catcherId !== undefined) {
    const folderType = catcherId ? 'catcher' : 'group';
    const folderId = catcherId || jid;
    await c.env.DB.prepare('UPDATE files SET folder_type = ?, folder_id = ? WHERE jid = ?')
      .bind(folderType, folderId, jid)
      .run();
  }
  return c.json({ ok: true });
});

app.post('/api/catchers', async (c) => {
  const { name } = await c.req.json();
  if (!name || !name.trim()) return c.json({ error: 'name required' }, 400);
  const id = uuid();
  await c.env.DB.prepare('INSERT INTO catchers (id, name, created_at) VALUES (?, ?, ?)').bind(id, name.trim(), nowIso()).run();
  return c.json({ id, name: name.trim() });
});

app.delete('/api/catchers/:id', async (c) => {
  const id = c.req.param('id');
  const groups = await c.env.DB.prepare('SELECT jid FROM groups WHERE catcher_id = ?').bind(id).all();
  for (const g of groups.results) {
    await c.env.DB.prepare('UPDATE groups SET catcher_id = NULL WHERE jid = ?').bind(g.jid).run();
    await c.env.DB.prepare('UPDATE files SET folder_type = ?, folder_id = ? WHERE jid = ?').bind('group', g.jid, g.jid).run();
  }
  await c.env.DB.prepare('DELETE FROM catchers WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// ---------- folders & files (web UI) ----------

// hidden: 'exclude' (default) | 'include' | 'only'
app.get('/api/folders', async (c) => {
  const hiddenMode = c.req.query('hidden') || 'exclude';
  const { results: groups } = await c.env.DB.prepare('SELECT * FROM groups').all();
  const { results: catchers } = await c.env.DB.prepare('SELECT * FROM catchers').all();

  const folders = [];
  for (const cat of catchers) {
    folders.push({ id: cat.id, type: 'catcher', name: cat.name, hidden: false });
  }
  for (const g of groups) {
    if (g.catcher_id) continue; // absorbed into its catcher, not shown standalone
    if (hiddenMode === 'exclude' && g.hidden) continue;
    if (hiddenMode === 'only' && !g.hidden) continue;
    folders.push({ id: g.jid, type: 'group', name: g.name, hidden: !!g.hidden });
  }

  for (const f of folders) {
    const row = await c.env.DB
      .prepare('SELECT COUNT(*) as count, MAX(received_at) as last FROM files WHERE folder_type = ? AND folder_id = ?')
      .bind(f.type, f.id)
      .first();
    f.fileCount = row?.count || 0;
    f.lastReceivedAt = row?.last || null;
  }

  folders.sort((a, b) => new Date(b.lastReceivedAt || 0) - new Date(a.lastReceivedAt || 0));
  return c.json(folders);
});

app.get('/api/folders/:type/:id/files', async (c) => {
  const { type, id } = c.req.param();
  const sort = c.req.query('sort') || 'date';
  const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';
  const sortCol = sort === 'name' ? 'original_name COLLATE NOCASE' : 'sent_at';

  const { results } = await c.env.DB
    .prepare(`SELECT * FROM files WHERE folder_type = ? AND folder_id = ? ORDER BY ${sortCol} ${order}`)
    .bind(type, id)
    .all();

  return c.json(results);
});

// scope: 'all' | 'group:<jid>' | 'catcher:<id>'
// hidden: 'exclude' (default, skips files whose group is hidden and unmapped) | 'include' | 'only'
app.get('/api/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const scope = c.req.query('scope') || 'all';
  const hiddenMode = c.req.query('hidden') || 'exclude';
  if (!q) return c.json([]);

  const like = `%${q}%`;
  let sql = `
    SELECT files.*, groups.name as group_name, groups.hidden as group_hidden, catchers.name as catcher_name
    FROM files
    LEFT JOIN groups ON groups.jid = files.jid
    LEFT JOIN catchers ON catchers.id = files.folder_id AND files.folder_type = 'catcher'
    WHERE (files.original_name LIKE ? OR files.base_name LIKE ? OR files.sender_name LIKE ? OR files.caption LIKE ?)
  `;
  const params = [like, like, like, like];

  if (scope.startsWith('group:')) {
    sql += ' AND files.folder_type = "group" AND files.folder_id = ?';
    params.push(scope.slice(6));
  } else if (scope.startsWith('catcher:')) {
    sql += ' AND files.folder_type = "catcher" AND files.folder_id = ?';
    params.push(scope.slice(8));
  }

  if (hiddenMode === 'exclude') sql += ' AND (files.folder_type = "catcher" OR groups.hidden = 0)';
  if (hiddenMode === 'only') sql += ' AND (files.folder_type = "group" AND groups.hidden = 1)';

  sql += ' ORDER BY files.sent_at DESC LIMIT 200';

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(
    results.map((r) => ({
      ...r,
      folderName: r.folder_type === 'catcher' ? r.catcher_name : r.group_name,
    }))
  );
});

app.get('/api/files/:id/download', async (c) => {
  const file = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(c.req.param('id')).first();
  if (!file) return c.json({ error: 'Not found' }, 404);
  const url = await getSignedDownloadUrl(c.env, file.b2_key);
  return c.redirect(url, 302);
});

export default app;
