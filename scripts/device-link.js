// Camera link for a cart: issues (rotates) the cart's device token and prints the HTTPS URL + QR for the phone.
//   npm run device-link -- A-07            (LAN address detected from the Wi-Fi adapter)
//   npm run device-link -- A-07 --ip 192.168.1.20
// Same as POST /api/admin/carts/:label/device-token (button "เพิ่ม device (กล้องมือถือ)" on Admin > Live).
// A new token makes the previous link invalid for new connections.
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import qrcode from 'qrcode-terminal';
import { config } from '../server/src/config.js';
import { openDb } from '../server/src/db/connection.js';
import { migrate } from '../server/src/db/migrate.js';
import { issueDeviceToken, lanAddress } from '../server/src/services/devices.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { ip: { type: 'string' } } });
const label = (positionals[0] ?? '').toUpperCase();
if (!/^[A-Z]-\d{2}$/.test(label)) { console.error('usage: npm run device-link -- A-07'); process.exit(1); }

const db = openDb();
migrate(db);
const { url } = issueDeviceToken(db, label);
db.close();
const https = existsSync(config.tlsCert) && existsSync(config.tlsKey);
const host = values.ip ?? lanAddress();
if (!https) console.warn('⚠ no TLS certificate yet: run scripts\lan-https.ps1 first, phones need https:// for the camera');
if (!host) console.warn('⚠ no LAN address found; using localhost');
const base = config.PUBLIC_URL ? config.PUBLIC_URL.replace(/\/+$/, '') : `${https ? 'https' : 'http'}://${https && host ? host : 'localhost'}:${config.PORT}`;
const full = base + url;
console.log(`camera link for cart ${label} (open on the phone; the old link stops working):\n`);
qrcode.generate(full, { small: true }, (q) => console.log(q + '\n' + full + '\n'));
