import { AwsClient } from 'aws4fetch';

function client(env) {
  return new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APPLICATION_KEY,
    service: 's3',
    region: env.B2_REGION,
  });
}

// Returns a short-lived, signed GET URL for a file — the browser downloads
// directly from Backblaze, the Worker never proxies the file bytes.
export async function getSignedDownloadUrl(env, key, expiresSeconds = 300) {
  const aws = client(env);
  const url = new URL(`https://${env.B2_ENDPOINT}/${env.B2_BUCKET}/${encodeURIComponent(key)}`);
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  const signed = await aws.sign(url.toString(), {
    method: 'GET',
    aws: { signQuery: true },
  });
  return signed.url;
}
