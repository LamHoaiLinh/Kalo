const DB_NAME = 'kalo-local';
const STORE = 'secure';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearLocalIdentity(userId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(`identity:${userId}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function exportIdentity(keyPair) {
  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', keyPair.publicKey),
    crypto.subtle.exportKey('jwk', keyPair.privateKey),
  ]);
  return { publicJwk, privateJwk };
}

async function importIdentity(record) {
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.importKey(
      'jwk',
      record.publicJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    ),
    crypto.subtle.importKey(
      'jwk',
      record.privateJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    ),
  ]);
  return { publicKey, privateKey, publicJwk: record.publicJwk, privateJwk: record.privateJwk };
}

async function deriveBackupKey(secret, salt, iterations = 250000) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function saveLocalIdentity(userId, record) {
  await idbPut(`identity:${userId}`, {
    publicJwk: record.publicJwk,
    privateJwk: record.privateJwk,
    savedAt: Date.now(),
  });
}

export async function loadLocalIdentity(userId) {
  const record = await idbGet(`identity:${userId}`);
  if (!record?.publicJwk || !record?.privateJwk) return null;
  try {
    return await importIdentity(record);
  } catch {
    return null;
  }
}

export async function getBackupInfo(supabase, userId) {
  const { data, error } = await supabase
    .from('kalo_key_backups')
    .select('user_id,public_key,updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function backupIdentity(supabase, userId, identity, recoveryCode) {
  if (!recoveryCode || recoveryCode.trim().length < 8) {
    throw new Error('Mã khôi phục chưa hợp lệ.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(recoveryCode.trim().toUpperCase(), salt);
  const plaintext = encoder.encode(JSON.stringify(identity.privateJwk));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  );
  const publicKey = JSON.stringify(identity.publicJwk);

  const { error } = await supabase.from('kalo_key_backups').upsert({
    user_id: userId,
    encrypted_private_key: bytesToBase64(encrypted),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    kdf_iterations: 250000,
    public_key: publicKey,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;

  const { error: profileError } = await supabase
    .from('kalo_profiles')
    .update({ public_key: publicKey, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (profileError) throw profileError;
}

export async function generateIdentity(supabase, userId, recoveryCode) {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
  const exported = await exportIdentity(keyPair);
  const identity = { ...keyPair, ...exported };
  await saveLocalIdentity(userId, identity);
  await backupIdentity(supabase, userId, identity, recoveryCode);
  return identity;
}

export async function restoreIdentity(supabase, userId, recoveryCode) {
  const { data, error } = await supabase
    .from('kalo_key_backups')
    .select('encrypted_private_key,salt,iv,kdf_iterations,public_key')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Tài khoản chưa có khóa bảo mật để khôi phục.');

  try {
    const salt = base64ToBytes(data.salt);
    const iv = base64ToBytes(data.iv);
    const encrypted = base64ToBytes(data.encrypted_private_key);
    const key = await deriveBackupKey(
      recoveryCode.trim().toUpperCase(),
      salt,
      data.kdf_iterations || 250000
    );
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    const privateJwk = JSON.parse(decoder.decode(clear));
    const publicJwk = JSON.parse(data.public_key);
    const identity = await importIdentity({ privateJwk, publicJwk });
    await saveLocalIdentity(userId, identity);

    const { error: profileError } = await supabase
      .from('kalo_profiles')
      .update({ public_key: data.public_key, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (profileError) throw profileError;
    return identity;
  } catch {
    throw new Error('Mã khôi phục không đúng hoặc khóa bảo mật đã thay đổi.');
  }
}

export async function ensureIdentity(supabase, userId) {
  const local = await loadLocalIdentity(userId);
  if (local) {
    const publicKey = JSON.stringify(local.publicJwk);
    await supabase
      .from('kalo_profiles')
      .update({ public_key: publicKey, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    return { identity: local, needsRecovery: false, hasBackup: true };
  }

  const backup = await getBackupInfo(supabase, userId);
  return { identity: null, needsRecovery: true, hasBackup: !!backup };
}

async function importPublicJwk(value) {
  const jwk = typeof value === 'string' ? JSON.parse(value) : value;
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

async function deriveMessageKey(privateKey, publicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptPayload(payload, recipients) {
  const usable = recipients.filter((p) => p?.user_id && p?.public_key);
  if (usable.length !== recipients.length) {
    throw new Error('Có người nhận chưa mở Kalo lần đầu nên chưa thể nhận tin mã hóa.');
  }

  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
  const epk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const boxes = {};

  await Promise.all(
    usable.map(async (profile) => {
      const recipientPublic = await importPublicJwk(profile.public_key);
      const key = await deriveMessageKey(ephemeral.privateKey, recipientPublic);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
      );
      boxes[profile.user_id] = {
        iv: bytesToBase64(iv),
        data: bytesToBase64(encrypted),
      };
    })
  );

  return { v: 1, alg: 'P256-AESGCM', epk, boxes };
}

export async function decryptPayload(envelope, userId, identity) {
  if (!envelope?.boxes?.[userId] || !envelope?.epk) {
    throw new Error('Tin nhắn không có dữ liệu dành cho thiết bị này.');
  }
  const box = envelope.boxes[userId];
  const ephemeralPublic = await importPublicJwk(envelope.epk);
  const key = await deriveMessageKey(identity.privateKey, ephemeralPublic);
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(box.iv) },
    key,
    base64ToBytes(box.data)
  );
  return JSON.parse(decoder.decode(clear));
}
