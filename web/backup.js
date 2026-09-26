const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveBackupKey(password, salt, iterations = 150000) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function protectPayload(payload, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 150000;
  const key = await deriveBackupKey(password, salt, iterations);
  const clear = encoder.encode(JSON.stringify(payload));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, clear));
  return {
    app: 'KaloBackupEncrypted',
    version: 1,
    cipher: 'AES-GCM-256',
    kdf: 'PBKDF2-SHA-256',
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(encrypted),
  };
}

async function unprotectPayload(container, password) {
  if (!password) {
    const error = new Error('File backup này có mật khẩu.');
    error.code = 'KALO_BACKUP_PASSWORD_REQUIRED';
    throw error;
  }
  try {
    const salt = base64ToBytes(container.salt);
    const iv = base64ToBytes(container.iv);
    const encrypted = base64ToBytes(container.ciphertext);
    const key = await deriveBackupKey(password, salt, Number(container.iterations || 150000));
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    return JSON.parse(decoder.decode(clear));
  } catch {
    const error = new Error('Mật khẩu backup không đúng hoặc file đã bị hỏng.');
    error.code = 'KALO_BACKUP_PASSWORD_INVALID';
    throw error;
  }
}

export async function downloadBackup(payload, fileName = 'Kalo_Backup.json', password = '') {
  const body = password ? await protectPayload(payload, password) : payload;
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function readBackupFile(file, password = '') {
  if (!file) throw new Error('Chưa chọn file backup.');
  if (file.size > 10 * 1024 * 1024) throw new Error('File backup quá lớn.');
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('File backup không phải JSON hợp lệ.'); }

  if (data?.app === 'KaloBackupEncrypted') {
    data = await unprotectPayload(data, password);
  }
  if (!data || data.app !== 'Kalo' || Number(data.version || 0) < 1) {
    throw new Error('Đây không phải file backup Kalo hợp lệ.');
  }
  return data;
}
