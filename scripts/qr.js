// Print a URL as a QR code in the terminal: node scripts/qr.js <url>
import qrcode from 'qrcode-terminal';

const url = process.argv[2];
if (!url) { console.error('usage: node scripts/qr.js <url>'); process.exit(1); }
qrcode.generate(url, { small: true }, (q) => console.log(q + '\n' + url + '\n'));
