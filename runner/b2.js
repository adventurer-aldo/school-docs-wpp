const { AwsClient } = require('aws4fetch');

const client = new AwsClient({
  accessKeyId: process.env.B2_KEY_ID,
  secretAccessKey: process.env.B2_APPLICATION_KEY,
  service: 's3',
  region: process.env.B2_REGION,
});

async function uploadBuffer(key, buffer, contentType) {
  const url = `https://${process.env.B2_ENDPOINT}/${process.env.B2_BUCKET}/${encodeURIComponent(key)}`;
  const res = await client.fetch(url, {
    method: 'PUT',
    body: buffer,
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`B2 upload failed (${res.status}): ${text}`);
  }
  return key;
}

module.exports = { uploadBuffer };
