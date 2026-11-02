// Environment check: npm run doctor
// Verifies Node version, native modules (better-sqlite3, bcrypt), a real SQLite write in the
// database folder, FTS5 trigram support, .env and migration state. Exit code 1 on any failure.
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
let failed = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const warn = (msg, fix) => console.log(`  ⚠ ${msg}${fix ? `\n      → ${fix}` : ''}`);
const fail = (msg, fix) => { failed++; console.log(`  ✖ ${msg}${fix ? `\n      → ${fix}` : ''}`); };

console.log('Smart Cart doctor\n');

// 1. Node version vs package.json engines
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const minMajor = Number(/>=\s*(\d+)/.exec(pkg.engines?.node ?? '')?.[1] ?? 0);
const major = Number(process.versions.node.split('.')[0]);
if (major >= minMajor) ok(`Node ${process.versions.node} (ต้องการ ${pkg.engines.node})`);
else fail(`Node ${process.versions.node} ต่ำกว่า ${pkg.engines.node}`, 'ติดตั้ง Node.js 22 LTS ขึ้นไปจาก https://nodejs.org แล้วรัน npm install ใหม่');

// 2. npm settings
const npmrc = existsSync(join(ROOT, '.npmrc')) ? readFileSync(join(ROOT, '.npmrc'), 'utf8') : '';
if (/^\s*ignore-scripts\s*=\s*true/m.test(npmrc)) ok('.npmrc: ignore-scripts=true (native module ใช้ prebuild ที่มากับแพ็กเกจ)');
else warn('.npmrc ไม่มี ignore-scripts=true', 'ถ้า npm install ล้มที่ node-gyp ให้คืนไฟล์ .npmrc จาก git: git checkout -- .npmrc');

// 3. better-sqlite3 native binary
let Database = null;
try {
  const Db = require('better-sqlite3'); // the native binary loads lazily on the first `new Database()`
  const pkgDir = dirname(require.resolve('better-sqlite3/package.json'));
  const { getPrebuildPath } = require(join(pkgDir, 'lib', 'binding.js'));
  const bin = getPrebuildPath() ?? join(pkgDir, 'build', 'Release', 'better_sqlite3.node');
  const ver = require('better-sqlite3/package.json').version;
  const db = new Db(':memory:');
  Database = Db;
  ok(`better-sqlite3 ${ver} · SQLite ${db.prepare('SELECT sqlite_version()').pluck().get()} · binary ${bin.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
  db.close();
} catch (err) {
  fail(`โหลด better-sqlite3 ไม่ได้: ${err.message.split('\n')[0]}`,
    `ลบ node_modules แล้ว npm install ใหม่ (platform นี้: ${process.platform}-${process.arch}; prebuild มีเฉพาะ win32/linux/darwin x64/arm64)`);
}

// 4. bcrypt native binary
try {
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('doctor', 4);
  if (await bcrypt.compare('doctor', hash)) ok(`bcrypt ${require('bcrypt/package.json').version} hash/compare ทำงาน`);
  else fail('bcrypt compare ให้ผลผิด');
} catch (err) {
  fail(`โหลด bcrypt ไม่ได้: ${err.message.split('\n')[0]}`, 'ลบ node_modules แล้ว npm install ใหม่');
}

// 5. .env + config (config.js exits with a readable message when a value is invalid)
if (existsSync(join(ROOT, '.env'))) ok('.env มีอยู่');
else warn('ยังไม่มี .env (ใช้ค่าเริ่มต้นทั้งหมด)', 'Copy-Item .env.example .env แล้วแก้ ADMIN_PASSWORD / SESSION_SECRET');
const { config } = await import('../server/src/config.js');
ok(`config ถูกต้อง · NODE_ENV=${config.NODE_ENV} · INFERENCE_MODE=${config.INFERENCE_MODE}`);
if (config.ADMIN_PASSWORD === 'change-me' || config.SESSION_SECRET === 'change-me') {
  (config.NODE_ENV === 'production' ? fail : warn)('ADMIN_PASSWORD หรือ SESSION_SECRET ยังเป็น change-me', 'แก้ใน .env');
}

// 6. real SQLite write in the database folder (same disk/permissions as smartcart.db)
if (Database) {
  const dbDir = dirname(config.dbPath);
  const probe = join(dbDir, `.doctor-${process.pid}.db`);
  try {
    const { openDb, supportsTrigram } = await import('../server/src/db/connection.js');
    const db = openDb(probe);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('ทดสอบภาษาไทย');
    const back = db.prepare('SELECT name FROM t').pluck().get();
    const mode = db.pragma('journal_mode', { simple: true });
    const fk = db.pragma('foreign_keys', { simple: true });
    const trigram = supportsTrigram(db);
    db.close();
    if (back === 'ทดสอบภาษาไทย') ok(`เขียน/อ่าน SQLite ใน ${dbDir} ได้ · journal_mode=${mode} · foreign_keys=${fk}`);
    else fail('อ่านค่าที่เขียนกลับมาไม่ตรง');
    if (trigram) ok('FTS5 trigram รองรับ (ค้นชื่อไทยด้วย products_fts)');
    else warn('SQLite ไม่รองรับ trigram', 'การค้นหาสินค้าจะใช้ LIKE แทน');
  } catch (err) {
    fail(`เขียน SQLite ใน ${dbDir} ไม่ได้: ${err.message}`, 'ตรวจสิทธิ์เขียนโฟลเดอร์ / DB_PATH ใน .env / โปรแกรม antivirus ที่ล็อกไฟล์');
  } finally {
    for (const s of ['', '-wal', '-shm']) rmSync(probe + s, { force: true });
  }

  // 7. migration state of the real database
  if (!existsSync(config.dbPath)) {
    warn(`ยังไม่มีฐานข้อมูล ${config.dbPath}`, 'npm run db:init; npm run db:seed');
  } else {
    try {
      const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
      const done = new Set(db.prepare("SELECT version FROM schema_migrations WHERE status = 'applied'").pluck().all());
      const files = readdirSync(config.migrationsDir).filter((f) => /^\d{3}_.+\.sql$/.test(f));
      const pending = files.filter((f) => !done.has(f));
      const products = db.prepare('SELECT COUNT(*) FROM products').pluck().get();
      db.close();
      if (pending.length) warn(`มี migration ที่ยังไม่รัน: ${pending.join(', ')}`, 'npm run db:init');
      else ok(`ฐานข้อมูลเป็นปัจจุบัน (${done.size} migrations · ${products} สินค้า)`);
    } catch (err) {
      fail(`เปิด ${config.dbPath} ไม่ได้: ${err.message}`, 'ถ้าไฟล์เสีย: ย้ายไฟล์เดิมไปเก็บ แล้วรัน npm run db:init; npm run db:seed');
    }
  }
}

console.log(failed ? `\n${failed} รายการไม่ผ่าน ดูวิธีแก้ด้านบน` : '\nพร้อมใช้งาน');
process.exit(failed ? 1 : 0);
