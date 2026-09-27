import { RTC_CONFIG } from './config.js';

const KEY = 'kalo-turn-config';

export function loadTurnConfig() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!parsed?.url) return null;
    return {
      url: String(parsed.url || '').trim(),
      username: String(parsed.username || ''),
      credential: String(parsed.credential || ''),
    };
  } catch {
    return null;
  }
}

export function saveTurnConfig(config = null) {
  if (!config?.url) {
    localStorage.removeItem(KEY);
    return;
  }
  localStorage.setItem(KEY, JSON.stringify({
    url: String(config.url || '').trim(),
    username: String(config.username || ''),
    credential: String(config.credential || ''),
  }));
}

export function getRtcConfig() {
  const base = structuredClone(RTC_CONFIG);
  const turn = loadTurnConfig();
  if (turn?.url) {
    base.iceServers = [
      ...(base.iceServers || []),
      { urls: turn.url, username: turn.username || undefined, credential: turn.credential || undefined },
    ];
  }
  return base;
}
