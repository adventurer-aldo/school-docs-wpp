const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const P = require('pino');
const path = require('path');
const fs = require('fs');
const worker = require('./worker-client');
const { uploadBuffer } = require('./b2');

const AUTH_DIR = path.join(__dirname, 'auth_info');
const logger = P({ level: 'silent' });

// ---------- cached settings (refreshed periodically so changes on the web UI apply live) ----------

let cache = {
  downloadDocuments: true,
  downloadImages: false,
  downloadVideos: false,
  desyncMessage: '',
  groupDownloadEnabled: new Map(), // jid -> boolean
};
const knownGroups = new Set(); // jids already registered with the worker this run

async function refreshSettings(onLog) {
  try {
    const res = await fetch(`${process.env.WORKER_URL.replace(/\/$/, '')}/api/settings`);
    if (!res.ok) return;
    const s = await res.json();
    cache.downloadDocuments = s.downloadDocuments;
    cache.downloadImages = s.downloadImages;
    cache.downloadVideos = s.downloadVideos;
    cache.desyncMessage = s.desyncMessage;
    cache.groupDownloadEnabled = new Map(s.groups.map((g) => [g.jid, g.downloadEnabled]));
  } catch (err) {
    onLog(`Could not refresh settings: ${err.message}`);
  }
}

// ---------- media extraction ----------

function extractMediaInfo(message) {
  if (!message) return null;
  const typeMap = { documentMessage: 'document', imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio' };
  for (const [key, mediaType] of Object.entries(typeMap)) {
    if (message[key]) return { rawType: key, mediaType, content: message[key] };
  }
  if (message.documentWithCaptionMessage?.message?.documentMessage) {
    return { rawType: 'documentMessage', mediaType: 'document', content: message.documentWithCaptionMessage.message.documentMessage };
  }
  return null;
}

const MIME_EXT_MAP = {
  'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'video/mp4': '.mp4', 'audio/ogg': '.ogg',
};
function guessExtension(mimetype, filename) {
  if (filename && path.extname(filename)) return path.extname(filename);
  return MIME_EXT_MAP[mimetype] || '';
}
function sanitize(name) {
  return (name || 'file').replace(/[\/\\?%*:|"<>]/g, '-').trim().slice(0, 120) || 'file';
}
function getMessageText(message) {
  return message?.conversation || message?.extendedTextMessage?.text || null;
}

// ---------- main bot ----------

async function startBot({ onLog = console.log } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state, logger });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      onLog('New QR code — posting to Worker.');
      await worker.reportQr(qr).catch((e) => onLog(`Failed to report QR: ${e.message}`));
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      onLog(`Connection closed (code ${statusCode}). Logged out: ${loggedOut}`);
      await worker.reportStatus('disconnected').catch(() => {});
      if (!loggedOut) {
        startBot({ onLog });
      } else {
        onLog('Session logged out — waiting to be relinked with a fresh QR.');
      }
    } else if (connection === 'open') {
      onLog('✅ WhatsApp connected.');
      await worker.reportStatus('connected', true).catch(() => {});
      await refreshSettings(onLog);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg, onLog);
      } catch (err) {
        onLog(`⚠️  Error handling a message: ${err.message}`);
      }
    }
  });

  // Periodic upkeep: pick up settings changes, remote commands, and send a heartbeat.
  const settingsInterval = setInterval(() => refreshSettings(onLog), 20_000);
  const commandsInterval = setInterval(() => checkPendingCommands(sock, onLog), 8_000);
  const heartbeatInterval = setInterval(() => worker.reportStatus('connected', true).catch(() => {}), 60_000);

  sock.ev.on('connection.update', (u) => {
    if (u.connection === 'close' && u.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
      clearInterval(settingsInterval);
      clearInterval(commandsInterval);
      clearInterval(heartbeatInterval);
    }
  });

  return sock;
}

async function checkPendingCommands(sock, onLog) {
  try {
    const commands = await worker.getPendingCommands();
    for (const cmd of commands) {
      if (cmd.type === 'desync') {
        onLog('🔌 De-sync requested from web UI — logging out.');
        await performDesync(sock, onLog);
      }
      await worker.ackCommand(cmd.id).catch(() => {});
    }
  } catch (err) {
    onLog(`Could not check pending commands: ${err.message}`);
  }
}

async function performDesync(sock, onLog) {
  try {
    await sock.logout();
  } catch (err) {
    onLog(`Logout error (continuing anyway): ${err.message}`);
  }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  await worker.reportStatus('disconnected').catch(() => {});
  onLog('De-synced. Restart the runner (or wait for reconnect) to get a fresh QR code.');
}

async function handleMessage(sock, msg, onLog) {
  if (!msg.message) return;

  // De-sync trigger: the owner (the linked account itself) sending the exact phrase, anywhere.
  if (msg.key.fromMe && cache.desyncMessage) {
    const text = getMessageText(msg.message);
    if (text && text === cache.desyncMessage) {
      onLog('🔌 De-sync phrase detected — logging out.');
      await performDesync(sock, onLog);
      return;
    }
  }

  if (msg.key.fromMe) return; // don't process our own other messages
  const jid = msg.key.remoteJid;
  if (!jid || !jid.endsWith('@g.us')) return; // only auto-save files from groups

  const media = extractMediaInfo(msg.message);
  if (!media) return;

  let groupName = jid;
  try {
    const meta = await sock.groupMetadata(jid);
    groupName = meta.subject;
  } catch (err) {
    onLog(`Could not resolve group name for ${jid}: ${err.message}`);
  }

  if (!knownGroups.has(jid)) {
    await worker.registerGroup(jid, groupName).catch((e) => onLog(`Failed to register group: ${e.message}`));
    knownGroups.add(jid);
  }

  const downloadEnabled = cache.groupDownloadEnabled.has(jid) ? cache.groupDownloadEnabled.get(jid) : true;
  if (!downloadEnabled) return;

  const mediaTypeAllowed =
    (media.mediaType === 'document' && cache.downloadDocuments) ||
    (media.mediaType === 'image' && cache.downloadImages) ||
    (media.mediaType === 'video' && cache.downloadVideos) ||
    media.mediaType === 'audio' && cache.downloadDocuments; // treat voice notes like documents by default
  if (!mediaTypeAllowed) return;

  const { content, mediaType } = media;
  const mimetype = content.mimetype;
  const originalName = content.fileName || `${mediaType}-${Date.now()}`;
  const caption = content.caption || '';

  onLog(`⬇️  Downloading "${originalName}" (${mediaType}) from "${groupName}"...`);
  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });

  const sentAt = new Date((Number(msg.messageTimestamp) || Date.now() / 1000) * 1000).toISOString();
  const ext = guessExtension(mimetype, originalName);
  const baseName = sanitize(path.basename(originalName, path.extname(originalName)));
  const storedFileName = `${Date.now()}-${baseName}${ext}`;
  const b2Key = `${sanitize(jid)}/${storedFileName}`;

  await uploadBuffer(b2Key, buffer, mimetype);

  const sender = msg.pushName || (msg.key.participant || jid).split('@')[0];

  await worker.reportFile({
    jid,
    originalName,
    baseName,
    b2Key,
    mimetype,
    mediaType,
    sizeBytes: buffer.length,
    senderName: sender,
    senderId: msg.key.participant || jid,
    caption,
    sentAt,
  });

  onLog(`✅ Saved "${originalName}" from "${groupName}" → B2:${b2Key}`);
}

module.exports = { startBot };
