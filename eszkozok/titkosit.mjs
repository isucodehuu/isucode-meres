// A mérési eredmények (oldalszöveg, e-mail-címek) titkosítása, hogy ebben a nyilvános tárolóban csak olvashatatlan
// formában legyenek: AES-256-GCM véletlen kulccsal, a kulcs RSA-OAEP-pel az IsuCode nyilvános kulcsára titkosítva.
// Visszafejteni csak a privát tárolóban lévő kulccsal lehet. Használat: node eszkozok/titkosit.mjs <mappa>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const pub = fs.readFileSync(new URL('./meres-kulcs.pub.pem', import.meta.url), 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) process.exit(0);
let n = 0;
for (const f of walk(dir).filter((f) => f.endsWith('.json'))) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(fs.readFileSync(f)), c.final()]);
  const k = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  fs.writeFileSync(f + '.enc', JSON.stringify({ v: 1, k: k.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), d: data.toString('base64') }));
  fs.unlinkSync(f);
  n++;
}
console.log(`Titkosítva: ${n} fájl`);
