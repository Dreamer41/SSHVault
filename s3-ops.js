// S3 backend with the same "ops" shape as the SFTP/local ones in sftp-main.js, so panes and transfers treat a bucket like any folder tree.
const { Writable, PassThrough } = require('stream');
const posix = require('path').posix;
const {
  S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand,
  DeleteObjectsCommand, CopyObjectCommand, RestoreObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const MB = 1024 * 1024;
const keyOf = (p) => p.replace(/^\/+/, '').replace(/\/+$/, '');
const prefixOf = (p) => { const k = keyOf(p); return k ? k + '/' : ''; };
const ARCHIVED = new Set(['GLACIER', 'DEEP_ARCHIVE']);

function friendly(e) {
  if (e.name === 'InvalidObjectState') return new Error('This object is archived (Glacier / Deep Archive). Use "Restore" first, then download it once the restore has finished.');
  if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return Object.assign(new Error('No such file or folder'), { code: 'ENOENT' });
  return e;
}

function makeS3(cfg) {
  const client = new S3Client({
    region: cfg.region || 'us-east-1',
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // only add checksums when S3 demands them: the default breaks multipart uploads on several S3-compatible servers
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
  });
  const Bucket = cfg.bucket;
  const StorageClass = cfg.storageClass && cfg.storageClass !== 'STANDARD' ? cfg.storageClass : undefined;
  const send = (cmd) => client.send(cmd);

  async function listAll(Prefix) {
    const out = [];
    let tok;
    do {
      const r = await send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: tok }));
      out.push(...(r.Contents || []));
      tok = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (tok);
    return out;
  }
  const copySource = (key) => `${Bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

  async function removeKeys(keys) {
    for (let i = 0; i < keys.length; i += 1000) {
      const r = await send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
      if (r.Errors?.length) throw new Error(r.Errors[0].Message || 'Delete failed');
    }
  }

  const ops = {
    sep: '/',
    join: (a, b) => posix.join(a, b),
    basename: posix.basename,
    parent: (d) => (d === '/' ? null : posix.dirname(d)),
    async home() { return '/' + keyOf(cfg.prefix || ''); },
    async normalize(d) { return '/' + keyOf(d || ''); },
    async list(dir) {
      const Prefix = prefixOf(dir);
      const out = [];
      let tok;
      do {
        const r = await send(new ListObjectsV2Command({ Bucket, Prefix, Delimiter: '/', ContinuationToken: tok }));
        for (const c of r.CommonPrefixes || []) out.push({ name: c.Prefix.slice(Prefix.length).replace(/\/$/, ''), size: 0, mtime: 0, isDir: true });
        for (const o of r.Contents || []) {
          if (o.Key === Prefix) continue; // the "folder" marker object itself
          out.push({ name: o.Key.slice(Prefix.length), size: o.Size, mtime: o.LastModified?.getTime() || 0, isDir: false,
            cls: o.StorageClass && o.StorageClass !== 'STANDARD' ? o.StorageClass : undefined });
        }
        tok = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (tok);
      return out;
    },
    async stat(p) {
      const Key = keyOf(p);
      if (!Key) return { isDir: true, size: 0 };
      try {
        const h = await send(new HeadObjectCommand({ Bucket, Key }));
        return { isDir: false, size: h.ContentLength };
      } catch (e) { if (friendly(e).code !== 'ENOENT') throw e; }
      const r = await send(new ListObjectsV2Command({ Bucket, Prefix: Key + '/', MaxKeys: 1 }));
      if (r.KeyCount) return { isDir: true, size: 0 };
      throw friendly({ name: 'NotFound' });
    },
    async mkdir(p) { await send(new PutObjectCommand({ Bucket, Key: prefixOf(p), Body: '' })); },
    async rename(a, b) {
      const from = keyOf(a), to = keyOf(b);
      const s = await ops.stat(a);
      const pairs = s.isDir
        ? (await listAll(from + '/')).map((o) => [o.Key, to + '/' + o.Key.slice(from.length + 1), o.StorageClass])
        : [[from, to, undefined]];
      for (const [src, dst, cls] of pairs) {
        await send(new CopyObjectCommand({ Bucket, Key: dst, CopySource: copySource(src), ...(cls && cls !== 'STANDARD' ? { StorageClass: cls } : {}) }));
      }
      await removeKeys(pairs.map((x) => x[0]));
    },
    async remove(p) {
      const Key = keyOf(p);
      const keys = (await listAll(Key + '/')).map((o) => o.Key);
      try { await send(new HeadObjectCommand({ Bucket, Key })); keys.push(Key); } catch { /* it was only a folder */ }
      await removeKeys(keys);
    },
    read(p) {
      const pt = new PassThrough();
      send(new GetObjectCommand({ Bucket, Key: keyOf(p) })).then(
        (r) => { r.Body.on('error', (e) => pt.destroy(e)); r.Body.pipe(pt); },
        (e) => pt.destroy(friendly(e)),
      );
      return pt;
    },
    write(p, size) {
      const pt = new PassThrough();
      const up = new Upload({
        client, queueSize: 4, partSize: Math.max(8 * MB, Math.ceil((size || 0) / 9000)), // stay under S3's 10,000-part limit
        params: { Bucket, Key: keyOf(p), Body: pt, ...(StorageClass ? { StorageClass } : {}) },
      });
      const done = up.done();
      const w = new Writable({
        write(chunk, _enc, cb) { pt.write(chunk) ? cb() : pt.once('drain', cb); },
        final(cb) { pt.end(); done.then(() => cb(), cb); },
        destroy(err, cb) { if (err) { up.abort().catch(() => {}); pt.destroy(); } cb(err); },
      });
      done.catch((e) => w.destroy(e));
      return w;
    },
  };

  // Asks S3 to make archived objects (Glacier / Deep Archive) downloadable for a while.
  async function restore(paths, days, tier) {
    const res = { requested: 0, inProgress: 0, skipped: 0 };
    const objs = [];
    for (const p of paths) {
      const Key = keyOf(p);
      const s = await ops.stat(p);
      if (s.isDir) objs.push(...(await listAll(Key + '/')).map((o) => ({ Key: o.Key, cls: o.StorageClass })));
      else objs.push({ Key, cls: (await send(new HeadObjectCommand({ Bucket, Key }))).StorageClass });
    }
    for (const o of objs) {
      if (!ARCHIVED.has(o.cls)) { res.skipped++; continue; }
      try {
        await send(new RestoreObjectCommand({ Bucket, Key: o.Key, RestoreRequest: { Days: days, GlacierJobParameters: { Tier: tier } } }));
        res.requested++;
      } catch (e) {
        if (e.name === 'RestoreAlreadyInProgress') res.inProgress++;
        else throw e;
      }
    }
    return res;
  }

  return {
    ops,
    restore,
    test: () => send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 })),
    close: () => client.destroy(),
  };
}

module.exports = { makeS3 };
