const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let webpush = null;
try {
  webpush = require('web-push');
} catch (_) {
  webpush = null;
}

function generateVapidKeys() {
  if (webpush && typeof webpush.generateVAPIDKeys === 'function') {
    return webpush.generateVAPIDKeys();
  }
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  });
  const jwk = privateKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const uncompressedPub = Buffer.concat([Buffer.from([0x04]), x, y]);
  return {
    publicKey: uncompressedPub.toString('base64url'),
    privateKey: Buffer.from(jwk.d, 'base64url').toString('base64url')
  };
}

const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const dataDir = path.join(rootDir, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('[setup] Created ./data directory.');
} else {
  console.log('[setup] ./data directory already exists.');
}

if (fs.existsSync(envPath)) {
  console.log('[setup] .env already exists. Skipping VAPID generation.');
} else {
  const vapidKeys = generateVapidKeys();
  const envContent = [
    '# Church Venue Security & Classroom Alert PWA Configuration',
    'PORT=3000',
    'TEAM_PIN=1234',
    'ON_DUTY_TIMEOUT_HOURS=6',
    'DB_PATH=./data/alerts.db',
    'VAPID_SUBJECT=mailto:security@gallatinvalleychurch.org',
    `VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`,
    `VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`,
    'CLOUDFLARE_TUNNEL_TOKEN=',
    ''
  ].join('\n');

  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log('[setup] Generated fresh VAPID keys and wrote .env (default TEAM_PIN=1234).');
}
