// Trust-on-first-use host key checking. Fingerprints are kept in the vault (data.knownHosts), keyed by "host:port".

const fingerprint = (hexSha256) => 'SHA256:' + Buffer.from(hexSha256, 'hex').toString('base64').replace(/=+$/, '');

// ask({ changed, label, hostPort, fp, old }) -> Promise<boolean>: shows the trust prompt
function createChecker({ getData, save, ask }) {
  const queue = new Map(); // hostPort -> promise, so several connections to a new server only ask once

  return function check(hostPort, label, hexSha256) {
    const fp = fingerprint(hexSha256);
    const run = async () => {
      const known = getData()?.knownHosts?.[hostPort];
      if (known === fp) return true;
      if (!getData()) return false; // vault locked
      if (!(await ask({ changed: !!known, label, hostPort, fp, old: known }))) return false;
      const d = getData();
      if (!d) return false;
      (d.knownHosts ||= {})[hostPort] = fp;
      save();
      return true;
    };
    const p = (queue.get(hostPort) || Promise.resolve()).then(run, run);
    queue.set(hostPort, p.catch(() => {}));
    return p;
  };
}

// ssh2 reports a rejected host key as a vague handshake error
const friendly = (msg) => (/verification failed|host denied|handshake failed/i.test(msg) ? 'Server identity not trusted (host key was rejected)' : msg);

module.exports = { createChecker, fingerprint, friendly };
