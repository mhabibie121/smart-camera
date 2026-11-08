// Darurat: reset password user "admin" kalau lupa.
//   npm run reset-admin -- [password]
//   cctv.exe reset-admin [password]
import crypto from 'node:crypto';
import { db } from './db.js';
import { hashPassword } from './auth.js';

const idx = process.argv.indexOf('reset-admin');
const given = idx >= 0 ? process.argv[idx + 1] : process.argv[2];
const pw = given || crypto.randomBytes(6).toString('base64url');
const existing = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
if (existing) {
  db.prepare('UPDATE users SET password_hash = ?, is_admin = 1, session_version = session_version + 1 WHERE id = ?')
    .run(hashPassword(pw), existing.id);
} else {
  db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES ('admin', ?, 1)").run(hashPassword(pw));
}
console.log(`Password admin direset. username: admin  password: ${pw}`);
