export const SUPABASE_URL = 'https://qjpcxhackvoewcxlatis.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_TArSkv7lbokFpK9KZxp5Iw_iJ7f29wh';
export const AUTH_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/kalo-auth`;
export const APP_NAME = 'Kalo';
export const MAX_LOCAL_BLOB_FALLBACK = 200 * 1024 * 1024;
export const FILE_CHUNK_SIZE = 64 * 1024;
export const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};
