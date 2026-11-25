// Local HTTPS without installing anything: the Hub makes its own small
// certificate authority ("Recompute Local CA"), the same idea as mkcert, in
// pure JavaScript. Each device trusts that CA once; the Hub then issues itself
// a certificate for its current Wi-Fi addresses whenever they change.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import { CERT_DIR } from './config';

const pki = forge.pki;

export interface CertBundle {
  key: string;
  cert: string;
  caCertPem: string;
  caCertDer: Buffer;
  caFingerprint: string; // SHA-256, shown so people can check what they install
  names: string[];
}

function rsaKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()),
    publicKey: pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  };
}

function serial() {
  // Positive, 16 bytes.
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f;
  return b.toString('hex');
}

function loadOrMakeCa() {
  const keyPath = path.join(CERT_DIR, 'ca.key.pem');
  const certPath = path.join(CERT_DIR, 'ca.crt.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const cert = pki.certificateFromPem(fs.readFileSync(certPath, 'utf8'));
    if (cert.validity.notAfter.getTime() > Date.now() + 30 * 86400e3) {
      return { key: pki.privateKeyFromPem(fs.readFileSync(keyPath, 'utf8')), cert };
    }
  }
  const keys = rsaKeys();
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 86400e3);
  const attrs = [
    { name: 'commonName', value: 'Recompute Local CA' },
    { name: 'organizationName', value: 'Recompute (this classroom only)' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true, pathLenConstraint: 0 },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  fs.writeFileSync(certPath, pki.certificateToPem(cert));
  return { key: keys.privateKey, cert };
}

/** Get a server certificate covering `names` (hostnames and IPs), reusing the last one if it still fits. */
export function ensureCerts(names: string[]): CertBundle {
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  const ca = loadOrMakeCa();
  const caCertPem = pki.certificateToPem(ca.cert);
  const caCertDer = Buffer.from(forge.asn1.toDer(pki.certificateToAsn1(ca.cert)).getBytes(), 'binary');
  const caFingerprint = crypto
    .createHash('sha256')
    .update(caCertDer)
    .digest('hex')
    .toUpperCase()
    .match(/.{2}/g)!
    .join(':');

  const wanted = [...new Set(names)].sort();
  const leafKeyPath = path.join(CERT_DIR, 'hub.key.pem');
  const leafCertPath = path.join(CERT_DIR, 'hub.crt.pem');
  const leafNamesPath = path.join(CERT_DIR, 'hub.names.json');
  if (fs.existsSync(leafKeyPath) && fs.existsSync(leafCertPath) && fs.existsSync(leafNamesPath)) {
    try {
      const had: string[] = JSON.parse(fs.readFileSync(leafNamesPath, 'utf8'));
      const cert = pki.certificateFromPem(fs.readFileSync(leafCertPath, 'utf8'));
      const sameIssuer = cert.issuer.hash === ca.cert.subject.hash && ca.cert.verify(cert);
      if (sameIssuer && wanted.every((n) => had.includes(n)) && cert.validity.notAfter.getTime() > Date.now() + 14 * 86400e3) {
        return { key: fs.readFileSync(leafKeyPath, 'utf8'), cert: fs.readFileSync(leafCertPath, 'utf8'), caCertPem, caCertDer, caFingerprint, names: had };
      }
    } catch {
      /* regenerate */
    }
  }

  const keys = rsaKeys();
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  // Apple rejects server certificates valid for more than 398 days.
  cert.validity.notAfter = new Date(Date.now() + 397 * 86400e3);
  cert.setSubject([{ name: 'commonName', value: 'Recompute Hub' }, { name: 'organizationName', value: 'Recompute' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  const isIp = (n: string) => /^[\d.]+$/.test(n) || n.includes(':');
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: wanted.map((n) => (isIp(n) ? { type: 7, ip: n } : { type: 2, value: n })) },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  const key = pki.privateKeyToPem(keys.privateKey);
  const certPem = pki.certificateToPem(cert) + caCertPem; // full chain
  fs.writeFileSync(leafKeyPath, key, { mode: 0o600 });
  fs.writeFileSync(leafCertPath, certPem);
  fs.writeFileSync(leafNamesPath, JSON.stringify(wanted));
  return { key, cert: certPem, caCertPem, caCertDer, caFingerprint, names: wanted };
}
