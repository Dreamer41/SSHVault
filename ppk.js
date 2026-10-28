// Converts PuTTY .ppk private keys (format v2 and v3) to unencrypted OpenSSH-format keys that ssh2 understands.
const crypto = require('crypto');
const { argon2d, argon2i, argon2id } = require('@noble/hashes/argon2');

const sha1 = (...parts) => { const h = crypto.createHash('sha1'); parts.forEach((p) => h.update(p)); return h.digest(); };
const str = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
const b64u = (b) => b.toString('base64url');
const big = (b) => BigInt('0x' + (b.toString('hex') || '0'));
const unbig = (n) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); };
const leftPad = (b, n) => (b.length >= n ? b.subarray(b.length - n) : Buffer.concat([Buffer.alloc(n - b.length), b]));
const stripZeros = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };

function reader(buf) {
  let o = 0;
  return {
    string() {
      if (o + 4 > buf.length) throw new Error('Truncated key data');
      const n = buf.readUInt32BE(o);
      o += 4;
      if (o + n > buf.length) throw new Error('Truncated key data');
      const s = buf.subarray(o, o + n);
      o += n;
      return s;
    },
  };
}

function parseFile(text) {
  const lines = text.trim().split(/\r?\n/);
  const first = lines[0].match(/^PuTTY-User-Key-File-(\d+): (.+)$/);
  if (!first) throw new Error('Not a PuTTY key file');
  const h = { version: Number(first[1]), algo: first[2].trim() };
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/^([\w-]+): ?(.*)$/);
    if (!m) continue;
    if (m[1] === 'Public-Lines' || m[1] === 'Private-Lines') {
      const n = Number(m[2]);
      h[m[1] === 'Public-Lines' ? 'pub' : 'priv'] = lines.slice(i + 1, i + 1 + n).join('');
      i += n;
    } else h[m[1]] = m[2].trim();
  }
  if (![2, 3].includes(h.version)) throw new Error(`Unsupported PPK version ${h.version}`);
  if (!h.pub || !h.priv || !h['Private-MAC']) throw new Error('Malformed PPK file');
  return h;
}

// Returns the decrypted private blob, or { needsPassphrase, error }.
function unlock(h, passphrase) {
  const pubBlob = Buffer.from(h.pub, 'base64');
  let priv = Buffer.from(h.priv, 'base64');
  const enc = h.Encryption || 'none';
  let macKey;
  if (enc === 'none') {
    macKey = h.version === 2 ? sha1(Buffer.from('putty-private-key-file-mac-key')) : Buffer.alloc(0);
  } else if (enc === 'aes256-cbc') {
    if (!passphrase) return { needsPassphrase: true, error: 'Encrypted PuTTY key: passphrase needed' };
    let key, iv;
    if (h.version === 2) {
      key = Buffer.concat([sha1(Buffer.from([0, 0, 0, 0]), passphrase), sha1(Buffer.from([0, 0, 0, 1]), passphrase)]).subarray(0, 32);
      iv = Buffer.alloc(16);
      macKey = sha1(Buffer.from('putty-private-key-file-mac-key'), passphrase);
    } else {
      const fn = { Argon2d: argon2d, Argon2i: argon2i, Argon2id: argon2id }[h['Key-Derivation']];
      if (!fn) throw new Error(`Unsupported key derivation: ${h['Key-Derivation']}`);
      const out = Buffer.from(fn(passphrase, Buffer.from(h['Argon2-Salt'], 'hex'), {
        t: Number(h['Argon2-Passes']), m: Number(h['Argon2-Memory']), p: Number(h['Argon2-Parallelism']), dkLen: 80,
      }));
      key = out.subarray(0, 32);
      iv = out.subarray(32, 48);
      macKey = out.subarray(48, 80);
    }
    const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
    d.setAutoPadding(false);
    priv = Buffer.concat([d.update(priv), d.final()]);
  } else throw new Error(`Unsupported PPK encryption: ${enc}`);

  const macData = Buffer.concat([str(Buffer.from(h.algo)), str(Buffer.from(enc)), str(Buffer.from(h.Comment || '')), str(pubBlob), str(priv)]);
  const mac = crypto.createHmac(h.version === 2 ? 'sha1' : 'sha256', macKey).update(macData).digest();
  const want = Buffer.from(h['Private-MAC'], 'hex');
  if (want.length !== mac.length || !crypto.timingSafeEqual(want, mac)) {
    return enc === 'none'
      ? { error: 'PuTTY key file is corrupt (MAC mismatch)' }
      : { needsPassphrase: true, error: 'Wrong passphrase' };
  }
  return { pubBlob, priv };
}

const CURVES = { nistp256: 32, nistp384: 48, nistp521: 66 };

// SSH wire-format mpint: unsigned big-endian, leading zero byte if the top bit is set
const mpint = (b) => { b = stripZeros(b); return str(b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b); };

// ssh2 can only read OpenSSH-format (not PKCS#8) Ed25519 keys, so every type is re-encoded as an unencrypted OpenSSH key.
function toOpenSsh(pubBlob, privBlob, comment) {
  const pr = reader(pubBlob);
  const pv = reader(privBlob);
  const alg = pr.string().toString();
  let fields;
  if (alg === 'ssh-rsa') {
    const e = pr.string(), n = pr.string();
    const d = pv.string(), p = pv.string(), q = pv.string(), iqmp = pv.string();
    fields = [str(Buffer.from(alg)), mpint(n), mpint(e), mpint(d), mpint(iqmp), mpint(p), mpint(q)];
  } else if (alg === 'ssh-ed25519') {
    const pk = pr.string();
    const raw = leftPad(pv.string(), 32);
    // PuTTY's byte order for the seed is easy to get wrong, so accept whichever order reproduces the public key
    const seed = [raw, Buffer.from(raw).reverse()].find((s) => {
      const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', d: b64u(s), x: b64u(pk) } });
      return Buffer.from(crypto.createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').equals(pk);
    });
    if (!seed) throw new Error('Ed25519 key does not match its public half');
    fields = [str(Buffer.from(alg)), str(pk), str(Buffer.concat([seed, pk]))];
  } else if (alg.startsWith('ecdsa-sha2-')) {
    const curve = pr.string();
    const len = CURVES[curve.toString()];
    if (!len) throw new Error(`Unsupported curve in ${alg}`);
    fields = [str(Buffer.from(alg)), str(curve), str(pr.string()), mpint(pv.string())];
  } else throw new Error(`Unsupported PuTTY key type: ${alg}`);

  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([check, check, ...fields, str(Buffer.from(comment))]);
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), str(Buffer.from('none')), str(Buffer.from('none')), str(Buffer.alloc(0)), count, str(pubBlob), str(priv)]);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function convertPpk(text, passphrase) {
  try {
    const h = parseFile(text);
    const u = unlock(h, passphrase);
    if (u.error) return { error: u.error, needsPassphrase: !!u.needsPassphrase };
    return {
      privateKey: toOpenSsh(u.pubBlob, u.priv, h.Comment || ''),
      publicKey: `${h.algo} ${u.pubBlob.toString('base64')} ${h.Comment || ''}`.trim() + '\n',
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { convertPpk, isPpk: (t) => /^\s*PuTTY-User-Key-File-\d+:/.test(t) };
