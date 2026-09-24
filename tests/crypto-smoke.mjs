import { encryptPayload, decryptPayload } from '../web/crypto.js';

const keyPair = await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' },
  true,
  ['deriveKey']
);
const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
const identity = { ...keyPair, publicJwk };

const secret = { type: 'text', text: 'KALO_SECRET_SMOKE_2026' };
const envelope = await encryptPayload(secret, [{
  user_id: 'smoke-user',
  public_key: JSON.stringify(publicJwk),
}]);

const serialized = JSON.stringify(envelope);
if (serialized.includes(secret.text)) {
  throw new Error('Plaintext leaked into encrypted envelope');
}

const decoded = await decryptPayload(envelope, 'smoke-user', identity);
if (decoded.text !== secret.text) {
  throw new Error('Encrypted payload roundtrip failed');
}

console.log('Kalo crypto roundtrip smoke test passed.');
