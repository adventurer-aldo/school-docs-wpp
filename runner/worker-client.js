const BASE = process.env.WORKER_URL?.replace(/\/$/, '');
const TOKEN = process.env.RUNNER_TOKEN;

if (!BASE || !TOKEN) {
  throw new Error('WORKER_URL and RUNNER_TOKEN must be set (see .env.example)');
}

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Worker call failed (${res.status}) ${path}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

module.exports = {
  reportQr: (data) => call('/api/ingest/qr', { method: 'POST', body: JSON.stringify({ data }) }),
  reportStatus: (status, heartbeat = false) =>
    call('/api/ingest/status', { method: 'POST', body: JSON.stringify({ status, heartbeat }) }),
  registerGroup: (jid, name) => call('/api/ingest/group', { method: 'POST', body: JSON.stringify({ jid, name }) }),
  getGroupConfig: (jid) => call(`/api/ingest/group-config/${encodeURIComponent(jid)}`),
  reportFile: (payload) => call('/api/ingest/file', { method: 'POST', body: JSON.stringify(payload) }),
  getPendingCommands: () => call('/api/commands/pending'),
  ackCommand: (id) => call(`/api/commands/${id}/ack`, { method: 'POST' }),
};
