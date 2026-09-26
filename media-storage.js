const AVATAR_BUCKET = 'kalo-avatars';
const RELAY_BUCKET = 'kalo-small-files';
export const SMALL_FILE_RELAY_LIMIT = 10 * 1024 * 1024;

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl || '').split(',');
  const mime = head?.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
  const bytes = base64ToBytes(body || '');
  return new Blob([bytes], { type: mime });
}

export async function uploadAvatar(supabase, userId, dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  const path = `${userId}/avatar.jpg`;
  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, blob, {
    upsert: true,
    contentType: 'image/jpeg',
    cacheControl: '3600',
  });
  if (error) throw error;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}

export async function removeAvatarObject(supabase, userId) {
  const { error } = await supabase.storage.from(AVATAR_BUCKET).remove([`${userId}/avatar.jpg`]);
  if (error && !/not.?found/i.test(error.message || '')) throw error;
}

export async function uploadEncryptedRelay(supabase, conversationId, userId, file) {
  if (!file || file.size > SMALL_FILE_RELAY_LIMIT) return null;
  const clear = new Uint8Array(await file.arrayBuffer());
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, clear));
  const relayId = crypto.randomUUID();
  const path = `${conversationId}/${userId}/${relayId}.bin`;
  const { error } = await supabase.storage.from(RELAY_BUCKET).upload(path, encrypted, {
    upsert: false,
    contentType: 'application/octet-stream',
    cacheControl: '3600',
  });
  if (error) throw error;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const { error: metaError } = await supabase.from('kalo_file_relays').insert({
    id: relayId,
    conversation_id: conversationId,
    sender_id: userId,
    storage_path: path,
    size_bytes: file.size,
    expires_at: expiresAt,
  });
  if (metaError) {
    await supabase.storage.from(RELAY_BUCKET).remove([path]).catch(() => {});
    throw metaError;
  }
  return {
    bucket: RELAY_BUCKET,
    path,
    key: bytesToBase64(keyBytes),
    iv: bytesToBase64(iv),
    expiresAt,
  };
}

export async function downloadEncryptedRelay(supabase, relay, meta = {}) {
  if (!relay?.path || !relay?.key || !relay?.iv) throw new Error('File tạm không hợp lệ.');
  const { data, error } = await supabase.storage.from(relay.bucket || RELAY_BUCKET).download(relay.path);
  if (error) throw error;
  const encrypted = new Uint8Array(await data.arrayBuffer());
  const key = await crypto.subtle.importKey('raw', base64ToBytes(relay.key), { name: 'AES-GCM' }, false, ['decrypt']);
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(relay.iv) }, key, encrypted);
  return new File([clear], meta.name || 'Kalo-file', { type: meta.mime || 'application/octet-stream' });
}

export async function cleanupExpiredRelays(supabase, userId) {
  const now = new Date().toISOString();
  const { data, error } = await supabase.from('kalo_file_relays')
    .select('id,storage_path')
    .eq('sender_id', userId)
    .lt('expires_at', now)
    .limit(100);
  if (error) return;
  const paths = (data || []).map((x) => x.storage_path).filter(Boolean);
  if (paths.length) await supabase.storage.from(RELAY_BUCKET).remove(paths).catch(() => {});
  const ids = (data || []).map((x) => x.id);
  if (ids.length) await supabase.from('kalo_file_relays').delete().in('id', ids).catch(() => {});
}
