require('dotenv').config();
const { startBot } = require('./whatsapp');

async function main() {
  console.log('Starting WhatsApp bridge. QR codes will appear on the web dashboard, not here.');
  await startBot({ onLog: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
