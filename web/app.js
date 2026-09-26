import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  AUTH_FUNCTION_URL,
} from './config.js';
import {
  ensureIdentity,
  generateIdentity,
  restoreIdentity,
  encryptPayload,
  decryptPayload,
} from './crypto.js';
import { KaloFileTransfer } from './webrtc.js';
import { KaloDocuments } from './storage.js';
import { KaloCallManager } from './call.js';
import QrScanner from './vendor/qr-scanner.min.js';
import { KaloPreferences, getDraft, setDraft, clearDraft, exportDrafts, importDrafts } from './preferences.js';
import { KaloMessageService } from './message-service.js';
import { uploadAvatar, removeAvatarObject, uploadEncryptedRelay, downloadEncryptedRelay, cleanupExpiredRelays, SMALL_FILE_RELAY_LIMIT } from './media-storage.js';
import { downloadBackup, readBackupFile } from './backup.js';
import { loadTurnConfig, saveTurnConfig } from './rtc-config.js';

const REMEMBER_LOGIN_KEY = 'kalo-remember-login';
const rememberLoginEnabled = () => localStorage.getItem(REMEMBER_LOGIN_KEY) !== '0';

const authStorage = {
  getItem(key) {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key);
  },
  setItem(key, value) {
    if (rememberLoginEnabled()) {
      localStorage.setItem(key, value);
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, value);
      localStorage.removeItem(key);
    }
  },
  removeItem(key) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  },
};

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: authStorage,
  },
});

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  session: null,
  user: null,
  profile: null,
  identity: null,
  profiles: new Map(),
  friendships: [],
  conversations: [],
  members: new Map(),
  currentConversationId: null,
  messages: [],
  reactions: new Map(),
  previews: new Map(),
  presence: new Set(),
  realtimeChannels: [],
  presenceChannel: null,
  fileManager: null,
  documentsManager: null,
  documentItems: [],
  selectedDocumentName: null,
  myDocumentTimeline: [],
  myDocumentMessages: [],
  messageSearchCache: [],
  messageSearchSeq: 0,
  callManager: null,
  activeCall: null,
  incomingCall: null,
  starting: false,
  startedUserId: null,
  pendingRecoveryCode: null,
  currentView: 'chats',
  conversationCategories: [],
  conversationCategoryMap: {},
  activeCategoryFilter: 'all',
  categoryMenuConversationId: null,
  contactAliases: {},
  avatarPendingDataUrl: '',
  avatarCrop: null,
  avatarViewerZoom: 1,
  preferencesManager: null,
  messageService: null,
  conversationPrefs: {},
  unreadCounts: new Map(),
  currentReads: [],
  messagePageHasMore: false,
  loadingOlderMessages: false,
  replyingToId: null,
  messagePins: [],
  forwardingMessageId: null,
  qrScanner: null,
};

const STICKERS = [
  '😀','😄','😂','🤣','😊','😍','🥰','😘',
  '😎','🤩','🥳','😇','🤗','🤭','😋','🤔',
  '😴','🥺','😭','😤','😡','😱','🤯','🤦',
  '👍','👏','🙏','💪','❤️','💚','🔥','🎉',
  '🌷','🌻','🍀','☕','🎂','🎁','🚗','🏃'
];

const DEFAULT_CONVERSATION_CATEGORIES = [
  { id: 'family', name: 'Gia đình', color: '#43c77a' },
  { id: 'friends', name: 'Bạn bè', color: '#f5b400' },
  { id: 'work', name: 'Công việc', color: '#0f69ea' },
  { id: 'important', name: 'Quan trọng', color: '#e01b24' },
];

function show(el) {
  if (typeof el === 'string') el = $(el);
  el?.classList.remove('hidden');
}
function hide(el) {
  if (typeof el === 'string') el = $(el);
  el?.classList.add('hidden');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[c]));
}
function initials(value) {
  const text = String(value || 'K').trim();
  return text.split(/\s+/).slice(0, 2).map((x) => x[0] || '').join('').toUpperCase() || 'K';
}
function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function formatTime(value) {
  if (!value) return '';
  const d = new Date(value);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}
function notifyParentOfIncomingMessage(row) {
  if (!row || !state.user || row.sender_id === state.user.id) return;
  if (state.conversationPrefs?.[row.conversation_id]?.muted) return;
  const conv = state.conversations.find((item) => item.id === row.conversation_id) || null;
  const senderName = profileName(row.sender_id);
  const conversationName = conv ? conversationLabel(conv) : 'Kalo';
  window.parent?.postMessage?.({
    source: 'kalo',
    type: 'new-message',
    messageId: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName,
    conversationName,
    createdAt: row.created_at || new Date().toISOString(),
  }, '*');
}

function toast(message, type = '') {
  const host = $('#toastHost');
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  host.appendChild(item);
  setTimeout(() => item.remove(), 4200);
}
function setAuthMessage(message = '', error = false) {
  const el = $('#authMessage');
  el.textContent = message;
  el.classList.toggle('error', error);
}
function setBusy(button, busy, text = 'Đang xử lý...') {
  if (!button) return;
  if (busy) {
    button.dataset.oldText = button.textContent;
    button.textContent = text;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.oldText || button.textContent;
    button.disabled = false;
  }
}

function applyRememberLoginPreference() {
  const checkbox = $('#rememberLogin');
  const enabled = checkbox ? checkbox.checked : true;
  localStorage.setItem(REMEMBER_LOGIN_KEY, enabled ? '1' : '0');
  return enabled;
}

function initRememberLoginPreference() {
  const checkbox = $('#rememberLogin');
  if (!checkbox) return;
  checkbox.checked = rememberLoginEnabled();
  checkbox.addEventListener('change', () => {
    localStorage.setItem(REMEMBER_LOGIN_KEY, checkbox.checked ? '1' : '0');
  });
}


async function invokeAuth(action, payload = {}) {
  const response = await fetch(AUTH_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || 'Không thể xử lý yêu cầu.');
  return data;
}

function switchAuthTab(name) {
  $$('.auth-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.authTab === name));
  $$('[data-auth-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.authPanel !== name));
  setAuthMessage('');
}

function modalOpen() {
  return $$('.modal-backdrop:not(.hidden)').length > 0;
}
function closeTopModal() {
  const open = $$('.modal-backdrop:not(.hidden)');
  if (!open.length) return false;
  const top = open[open.length - 1];
  if (top.id === 'addFriendModal') stopQrScanner();
  top.classList.add('hidden');
  return true;
}

function currentConversation() {
  return state.conversations.find((c) => c.id === state.currentConversationId) || null;
}
function memberIds(conversationId) {
  return state.members.get(conversationId) || [];
}
function memberProfiles(conversationId) {
  return memberIds(conversationId).map((id) => state.profiles.get(id)).filter(Boolean);
}
function conversationLabel(conv) {
  if (!conv) return 'Kalo';
  if (conv.kind === 'group') return conv.title || 'Nhóm Kalo';
  const otherId = memberIds(conv.id).find((id) => id !== state.user?.id);
  return contactDisplayName(otherId);
}
function conversationAvatar(conv) {
  return initials(conversationLabel(conv));
}
function isOnline(userId) {
  return state.presence.has(userId);
}
function directPeerId(conv = currentConversation()) {
  if (!conv || conv.kind !== 'direct') return null;
  return memberIds(conv.id).find((id) => id !== state.user?.id) || null;
}
function profileName(userId) {
  return contactDisplayName(userId);
}
function acceptedFriendIds() {
  const ids = new Set();
  for (const row of state.friendships) {
    if (row.status !== 'accepted') continue;
    ids.add(row.requester_id === state.user?.id ? row.addressee_id : row.requester_id);
  }
  return ids;
}
function isFriend(userId) {
  return acceptedFriendIds().has(userId);
}
function friendRowWith(userId) {
  return state.friendships.find((row) =>
    (row.requester_id === state.user?.id && row.addressee_id === userId) ||
    (row.addressee_id === state.user?.id && row.requester_id === userId)
  ) || null;
}
function incomingFriendRequests() {
  return state.friendships.filter((row) =>
    row.status === 'pending' && row.addressee_id === state.user?.id
  );
}
function outgoingFriendRequests() {
  return state.friendships.filter((row) =>
    row.status === 'pending' && row.requester_id === state.user?.id
  );
}
function friendProfileFromRow(row) {
  const otherId = row.requester_id === state.user?.id ? row.addressee_id : row.requester_id;
  return state.profiles.get(otherId) || null;
}



function contactAliasStorageKey() {
  return state.user?.id ? `kalo-contact-aliases:${state.user.id}` : '';
}

function loadContactAliases() {
  const key = contactAliasStorageKey();
  try {
    const parsed = key ? JSON.parse(localStorage.getItem(key) || '{}') : {};
    state.contactAliases = parsed && typeof parsed === 'object' ? { ...parsed } : {};
  } catch {
    state.contactAliases = {};
  }
}

function saveContactAliases() {
  const key = contactAliasStorageKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(state.contactAliases || {}));
}

function contactAlias(userId) {
  const value = String(state.contactAliases?.[userId] || '').trim();
  return value || '';
}

function contactDisplayName(userId) {
  const alias = contactAlias(userId);
  if (alias) return alias;
  const p = state.profiles.get(userId);
  return p?.display_name || p?.username || 'Người dùng Kalo';
}

function safeAvatarUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('data:image/')) return url;
  if (/^https:\/\//i.test(url)) return url;
  return '';
}

function avatarContent(profile, fallbackLabel) {
  const url = safeAvatarUrl(profile?.avatar_url);
  if (url) return `<img class="avatar-image" src="${escapeHtml(url)}" alt="" />`;
  return escapeHtml(initials(fallbackLabel || profile?.display_name || profile?.username));
}

function setAvatarElement(element, profile, fallbackLabel) {
  if (!element) return;
  const url = safeAvatarUrl(profile?.avatar_url);
  if (url) {
    element.innerHTML = `<img class="avatar-image" src="${escapeHtml(url)}" alt="" />`;
    element.classList.add('has-image');
  } else {
    element.textContent = initials(fallbackLabel || profile?.display_name || profile?.username);
    element.classList.remove('has-image');
  }
}

function avatarViewerProfile(userId) {
  if (!userId) return null;
  if (userId === state.user?.id) return state.profile || state.profiles.get(userId) || null;
  return state.profiles.get(userId) || null;
}

function applyAvatarViewerZoom(nextZoom) {
  const image = $('#avatarViewerImage');
  const value = $('#avatarViewerZoomValue');
  if (!image) return;
  const zoom = Math.max(0.5, Math.min(5, Number(nextZoom) || 1));
  state.avatarViewerZoom = zoom;
  image.style.transform = `scale(${zoom})`;
  if (value) value.textContent = `${Math.round(zoom * 100)}%`;
}

function openAvatarViewer(userId) {
  const profile = avatarViewerProfile(userId);
  const url = safeAvatarUrl(profile?.avatar_url);
  if (!url) {
    toast('Tài khoản này chưa có ảnh đại diện.', 'error');
    return;
  }
  const name = userId === state.user?.id
    ? (state.profile?.display_name || state.profile?.username || 'Ảnh đại diện của tôi')
    : contactDisplayName(userId);
  $('#avatarViewerImage').src = url;
  $('#avatarViewerImage').alt = `Ảnh đại diện của ${name}`;
  $('#avatarViewerName').textContent = name;
  applyAvatarViewerZoom(1);
  show('#avatarViewerModal');
}

function closeAvatarViewer() {
  hide('#avatarViewerModal');
  applyAvatarViewerZoom(1);
  $('#avatarViewerImage').removeAttribute('src');
  $('#avatarViewerName').textContent = '';
}

function markAvatarClickable(element, userId) {
  if (!element) return;
  if (userId) element.dataset.avatarUser = userId;
  else delete element.dataset.avatarUser;
  const profile = avatarViewerProfile(userId);
  const hasImage = Boolean(safeAvatarUrl(profile?.avatar_url));
  element.classList.toggle('avatar-clickable', hasImage);
  if (hasImage) {
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    element.setAttribute('title', 'Bấm để xem ảnh đại diện');
  } else {
    element.removeAttribute('role');
    element.removeAttribute('tabindex');
    element.removeAttribute('title');
  }
}

function updateSelfAvatar() {
  const root = $('#selfAvatar');
  if (!root) return;
  const url = safeAvatarUrl(state.profile?.avatar_url);
  if (url) {
    root.innerHTML = `<img class="avatar-image" src="${escapeHtml(url)}" alt="Ảnh đại diện của tôi" />`;
    root.classList.add('has-image');
  } else {
    root.innerHTML = '<img src="./icon.svg" alt="Kalo" />';
    root.classList.remove('has-image');
  }
  const button = $('#selfAvatarBtn');
  if (button) {
    button.title = state.profile?.display_name
      ? `${state.profile.display_name} · Xem ảnh đại diện`
      : 'Xem ảnh đại diện';
    button.dataset.avatarUser = state.user?.id || '';
  }
  markAvatarClickable(root, state.user?.id);
}

function updateProfileAvatarPreview() {
  const preview = $('#profileAvatarPreview');
  if (!preview) return;
  if (state.avatarPendingDataUrl) {
    preview.innerHTML = `<img class="avatar-image" src="${escapeHtml(state.avatarPendingDataUrl)}" alt="" />`;
    preview.classList.add('has-image');
    preview.classList.remove('avatar-clickable');
    delete preview.dataset.avatarUser;
    preview.removeAttribute('title');
  } else {
    setAvatarElement(preview, state.profile, state.profile?.display_name || state.profile?.username || 'K');
    markAvatarClickable(preview, state.user?.id);
  }
  const removeBtn = $('#removeAvatarBtn');
  if (removeBtn) removeBtn.disabled = !state.avatarPendingDataUrl && !safeAvatarUrl(state.profile?.avatar_url);
  const cropBtn = $('#cropAvatarBtn');
  if (cropBtn) cropBtn.disabled = !state.avatarPendingDataUrl && !safeAvatarUrl(state.profile?.avatar_url) && !state.avatarCrop?.bitmap;
  const saveBtn = $('#saveAvatarBtn');
  if (saveBtn) saveBtn.disabled = !state.avatarPendingDataUrl;
  $('#avatarPendingHint')?.classList.toggle('hidden', !state.avatarPendingDataUrl);
}

function closeAvatarCropSource() {
  try { state.avatarCrop?.bitmap?.close?.(); } catch {}
  state.avatarCrop = null;
}

function clampAvatarCrop() {
  const crop = state.avatarCrop;
  const canvas = $('#avatarCropCanvas');
  if (!crop?.bitmap || !canvas) return;
  const drawW = crop.bitmap.width * crop.scale;
  const drawH = crop.bitmap.height * crop.scale;
  const maxX = Math.max(0, (drawW - canvas.width) / 2);
  const maxY = Math.max(0, (drawH - canvas.height) / 2);
  crop.offsetX = Math.max(-maxX, Math.min(maxX, crop.offsetX));
  crop.offsetY = Math.max(-maxY, Math.min(maxY, crop.offsetY));
}

function renderAvatarCrop() {
  const crop = state.avatarCrop;
  const canvas = $('#avatarCropCanvas');
  if (!crop?.bitmap || !canvas) return;
  clampAvatarCrop();
  const ctx = canvas.getContext('2d', { alpha: false });
  const drawW = crop.bitmap.width * crop.scale;
  const drawH = crop.bitmap.height * crop.scale;
  const x = (canvas.width - drawW) / 2 + crop.offsetX;
  const y = (canvas.height - drawH) / 2 + crop.offsetY;
  ctx.fillStyle = '#eaf3ee';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop.bitmap, x, y, drawW, drawH);
  const zoomPct = Math.round((crop.scale / crop.minScale) * 100);
  $('#avatarZoomValue').textContent = `${zoomPct}%`;
}

function resetAvatarCrop() {
  const crop = state.avatarCrop;
  if (!crop) return;
  crop.scale = crop.minScale;
  crop.offsetX = 0;
  crop.offsetY = 0;
  $('#avatarZoomRange').value = '100';
  renderAvatarCrop();
}

async function bitmapFromAvatarSource(source) {
  if (source instanceof File || source instanceof Blob) {
    return createImageBitmap(source, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(source));
  }
  const url = String(source || '');
  if (!url) throw new Error('Chưa có ảnh để crop.');
  const response = await fetch(url);
  if (!response.ok) throw new Error('Không đọc được ảnh đại diện.');
  const blob = await response.blob();
  return createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(blob));
}

async function openAvatarCrop(source, { replaceSource = true } = {}) {
  let bitmap = null;
  const settingsWasOpen = !$('#settingsModal')?.classList.contains('hidden');
  if (!replaceSource && state.avatarCrop?.bitmap) {
    state.avatarCrop.returnToSettings = settingsWasOpen || state.avatarCrop.returnToSettings;
    hide('#settingsModal');
    show('#avatarCropModal');
    renderAvatarCrop();
    return;
  }
  if (source instanceof File && source.size > 12 * 1024 * 1024) {
    throw new Error('Ảnh quá lớn. Vui lòng chọn ảnh dưới 12 MB.');
  }
  if (source instanceof File && !source.type.startsWith('image/')) {
    throw new Error('Hãy chọn file ảnh.');
  }
  bitmap = await bitmapFromAvatarSource(source);
  closeAvatarCropSource();
  const canvas = $('#avatarCropCanvas');
  const minScale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
  state.avatarCrop = {
    bitmap,
    minScale,
    scale: minScale,
    offsetX: 0,
    offsetY: 0,
    dragging: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    returnToSettings: settingsWasOpen,
  };
  $('#avatarZoomRange').value = '100';
  renderAvatarCrop();
  hide('#settingsModal');
  show('#avatarCropModal');
}

function applyAvatarCropPreview() {
  const source = $('#avatarCropCanvas');
  if (!state.avatarCrop?.bitmap || !source) return;
  const output = document.createElement('canvas');
  output.width = 256;
  output.height = 256;
  const ctx = output.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 256, 256);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, 256, 256);
  state.avatarPendingDataUrl = output.toDataURL('image/jpeg', 0.84);
  const returnToSettings = Boolean(state.avatarCrop?.returnToSettings);
  updateProfileAvatarPreview();
  hide('#avatarCropModal');
  if (returnToSettings) show('#settingsModal');
  toast('Đã áp dụng crop. Bấm “Lưu Avatar” để lưu chính thức.');
}

function cancelAvatarCrop() {
  const returnToSettings = Boolean(state.avatarCrop?.returnToSettings);
  hide('#avatarCropModal');
  if (returnToSettings) show('#settingsModal');
}

async function migrateLegacyAvatarIfNeeded() {
  const current = String(state.profile?.avatar_url || '');
  if (!current.startsWith('data:image/')) return;
  try {
    const storedUrl = await uploadAvatar(supabase, state.user.id, current);
    const { error } = await supabase.from('kalo_profiles')
      .update({ avatar_url: storedUrl, updated_at: new Date().toISOString() })
      .eq('user_id', state.user.id);
    if (error) throw error;
    state.profile.avatar_url = storedUrl;
  } catch (error) {
    console.warn('Kalo legacy avatar migration failed', error);
  }
}

async function saveOwnAvatar(avatarUrl) {
  let storedUrl = '';
  if (avatarUrl) {
    storedUrl = await uploadAvatar(supabase, state.user.id, avatarUrl);
  } else {
    await removeAvatarObject(supabase, state.user.id).catch(() => {});
  }
  const { error } = await supabase
    .from('kalo_profiles')
    .update({ avatar_url: storedUrl || null, updated_at: new Date().toISOString() })
    .eq('user_id', state.user.id);
  if (error) throw error;
  state.profile.avatar_url = storedUrl || null;
  state.avatarPendingDataUrl = '';
  closeAvatarCropSource();
  await loadProfiles();
  state.profile = state.profiles.get(state.user.id) || state.profile;
  updateProfileAvatarPreview();
  updateSelfAvatar();
  renderPeopleList();
  renderConversationList();
  renderChatHeader();
  renderMessages();
}

function openContactAliasModal() {
  const conv = currentConversation();
  const peerId = directPeerId(conv);
  if (!peerId) return;
  const p = state.profiles.get(peerId);
  const original = p?.display_name || p?.username || 'Người dùng Kalo';
  $('#contactOriginalName').textContent = `Tên gốc: ${original}`;
  $('#contactAliasInput').value = contactAlias(peerId);
  show('#contactAliasModal');
  setTimeout(() => $('#contactAliasInput')?.focus(), 60);
}

function saveCurrentContactAlias(value) {
  const peerId = directPeerId();
  if (!peerId) return;
  const clean = String(value || '').trim().slice(0, 60);
  if (clean) state.contactAliases[peerId] = clean;
  else delete state.contactAliases[peerId];
  saveContactAliases();
  state.preferencesManager?.saveAlias(peerId, clean).catch((error) => {
    console.warn('Kalo alias sync failed', error);
  });
  hide('#contactAliasModal');
  renderConversationList();
  renderPeopleList();
  renderChatHeader();
  renderMessages();
  toast(clean ? 'Đã lưu biệt danh.' : 'Đã dùng lại tên gốc.');
}

function categoryStorageKey() {
  return state.user?.id ? `kalo-conversation-categories:${state.user.id}` : '';
}

function safeCategoryColor(value, fallback = '#43c77a') {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function loadConversationCategories() {
  const key = categoryStorageKey();
  let parsed = null;
  try { parsed = key ? JSON.parse(localStorage.getItem(key) || 'null') : null; } catch {}
  const source = Array.isArray(parsed?.categories)
    ? parsed.categories
    : DEFAULT_CONVERSATION_CATEGORIES;
  state.conversationCategories = source.map((item) => ({
    id: String(item.id || crypto.randomUUID()),
    name: String(item.name || 'Phân loại').trim().slice(0, 30) || 'Phân loại',
    color: safeCategoryColor(item.color),
  }));
  state.conversationCategoryMap = parsed?.assignments && typeof parsed.assignments === 'object'
    ? { ...parsed.assignments }
    : {};
  state.activeCategoryFilter = 'all';
  state.categoryMenuConversationId = null;
  saveConversationCategories();
  updateCategoryFilterButton();
}

function saveConversationCategories() {
  const key = categoryStorageKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify({
    version: 2,
    categories: state.conversationCategories,
    assignments: state.conversationCategoryMap,
  }));
}

function categoryById(id) {
  return state.conversationCategories.find((item) => item.id === id) || null;
}

function conversationCategory(conversationId) {
  return categoryById(state.conversationCategoryMap[conversationId]);
}

function updateCategoryFilterButton() {
  const label = $('#categoryFilterLabel');
  const dot = $('#categoryFilterDot');
  if (!label || !dot) return;
  const active = categoryById(state.activeCategoryFilter);
  const archived = state.activeCategoryFilter === 'archived';
  label.textContent = archived ? 'Đã lưu trữ' : (active?.name || 'Phân loại');
  dot.style.background = archived ? '#7f9188' : (active?.color || 'transparent');
  dot.classList.toggle('empty', !active && !archived);
}

function setCategoryFilter(categoryId = 'all') {
  state.activeCategoryFilter = categoryId === 'archived'
    ? 'archived'
    : (categoryById(categoryId) ? categoryId : 'all');
  hide('#categoryFilterMenu');
  updateCategoryFilterButton();
  renderCategoryFilterMenu();
  renderConversationList();
}

function renderCategoryFilterMenu() {
  const root = $('#categoryFilterMenu');
  if (!root) return;
  root.innerHTML = `
    <button class="category-menu-item ${state.activeCategoryFilter === 'all' ? 'active' : ''}" type="button" data-category-filter="all">
      <span class="category-menu-icon all">●</span><span>Tất cả</span>
    </button>
    ${state.conversationCategories.map((item) => `
      <button class="category-menu-item ${state.activeCategoryFilter === item.id ? 'active' : ''}" type="button" data-category-filter="${escapeHtml(item.id)}">
        <span class="category-color-tag" style="--category-color:${safeCategoryColor(item.color)}"></span>
        <span>${escapeHtml(item.name)}</span>
      </button>`).join('')}
    <div class="category-menu-separator"></div>
    <button class="category-menu-item ${state.activeCategoryFilter === 'archived' ? 'active' : ''}" type="button" data-category-filter="archived">🗄 <span>Đã lưu trữ</span></button>
    <button class="category-menu-item manage" type="button" data-manage-categories>⚙ <span>Quản lý phân loại</span></button>
  `;
  $$('[data-category-filter]', root).forEach((btn) => btn.addEventListener('click', () => setCategoryFilter(btn.dataset.categoryFilter)));
  $('[data-manage-categories]', root)?.addEventListener('click', () => {
    hide('#categoryFilterMenu');
    openCategoryManager();
  });
  updateCategoryFilterButton();
}

function toggleCategoryFilterMenu() {
  const root = $('#categoryFilterMenu');
  if (!root) return;
  if (root.classList.contains('hidden')) {
    renderCategoryFilterMenu();
    show(root);
    hide('#conversationCategoryMenu');
  } else {
    hide(root);
  }
}

function renderCategoryManager() {
  const root = $('#categoryManagerList');
  if (!root) return;
  root.innerHTML = state.conversationCategories.map((item) => `
    <div class="category-manager-row" data-category-row="${escapeHtml(item.id)}">
      <input class="category-color-input" type="color" value="${safeCategoryColor(item.color)}" data-category-color="${escapeHtml(item.id)}" title="Đổi màu" />
      <input class="category-name-input" value="${escapeHtml(item.name)}" maxlength="30" data-category-name="${escapeHtml(item.id)}" aria-label="Tên phân loại" />
      <button class="category-delete-btn" type="button" data-category-delete="${escapeHtml(item.id)}" title="Xóa phân loại">🗑</button>
    </div>
  `).join('') || '<div class="category-empty">Chưa có phân loại. Hãy tạo một thẻ mới ở phía trên.</div>';

  $$('[data-category-color]', root).forEach((input) => {
    input.addEventListener('input', () => {
      const item = categoryById(input.dataset.categoryColor);
      if (!item) return;
      item.color = safeCategoryColor(input.value, item.color);
      saveConversationCategories();
      renderCategoryFilterMenu();
      renderConversationList();
    });
    input.addEventListener('change', () => {
      const item = categoryById(input.dataset.categoryColor);
      if (!item) return;
      const sortOrder = Math.max(0, state.conversationCategories.findIndex((x) => x.id === item.id));
      state.preferencesManager?.saveCategory(item, sortOrder).catch((error) => console.warn('Kalo category color sync failed', error));
    });
  });
  $$('[data-category-name]', root).forEach((input) => input.addEventListener('change', () => {
    const item = categoryById(input.dataset.categoryName);
    if (!item) return;
    const name = input.value.trim().slice(0, 30);
    if (!name) {
      input.value = item.name;
      return;
    }
    item.name = name;
    saveConversationCategories();
    const sortOrder = Math.max(0, state.conversationCategories.findIndex((x) => x.id === item.id));
    state.preferencesManager?.saveCategory(item, sortOrder).catch((error) => console.warn('Kalo category name sync failed', error));
    renderCategoryFilterMenu();
    renderConversationList();
  }));
  $$('[data-category-delete]', root).forEach((btn) => btn.addEventListener('click', () => {
    const item = categoryById(btn.dataset.categoryDelete);
    if (!item) return;
    if (!window.confirm(`Xóa phân loại “${item.name}”? Cuộc trò chuyện sẽ chỉ bị bỏ thẻ, không bị xóa.`)) return;
    deleteConversationCategory(item.id);
  }));
}

function openCategoryManager() {
  renderCategoryManager();
  $('#categoryCreateName').value = '';
  $('#categoryCreateColor').value = '#43c77a';
  show('#categoryManagerModal');
  setTimeout(() => $('#categoryCreateName')?.focus(), 60);
}

function createConversationCategory(name, color) {
  const cleanName = String(name || '').trim().slice(0, 30);
  if (!cleanName) throw new Error('Hãy nhập tên phân loại.');
  const item = { id: crypto.randomUUID(), name: cleanName, color: safeCategoryColor(color) };
  state.conversationCategories.push(item);
  saveConversationCategories();
  state.preferencesManager?.saveCategory(item, state.conversationCategories.length - 1).catch(() => {});
  renderCategoryManager();
  renderCategoryFilterMenu();
  renderConversationList();
  return item;
}

function deleteConversationCategory(categoryId) {
  state.conversationCategories = state.conversationCategories.filter((item) => item.id !== categoryId);
  for (const [conversationId, assigned] of Object.entries(state.conversationCategoryMap)) {
    if (assigned === categoryId) delete state.conversationCategoryMap[conversationId];
  }
  if (state.activeCategoryFilter === categoryId) state.activeCategoryFilter = 'all';
  saveConversationCategories();
  state.preferencesManager?.deleteCategory(categoryId).catch(() => {});
  renderCategoryManager();
  renderCategoryFilterMenu();
  renderConversationList();
  updateCategoryFilterButton();
}

function assignConversationCategory(conversationId, categoryId = '') {
  if (!conversationId) return;
  if (categoryId && categoryById(categoryId)) state.conversationCategoryMap[conversationId] = categoryId;
  else delete state.conversationCategoryMap[conversationId];
  saveConversationCategories();
  state.preferencesManager?.setConversationCategory(conversationId, categoryId || null).catch(() => {});
  hide('#conversationCategoryMenu');
  renderConversationList();
}

async function setConversationPreferenceFlag(conversationId, field, value) {
  if (!conversationId || !['pinned', 'muted', 'archived'].includes(field)) return;
  const previous = { ...(state.conversationPrefs?.[conversationId] || {}) };
  state.conversationPrefs[conversationId] = {
    ...previous,
    conversation_id: conversationId,
    [field]: Boolean(value),
  };
  renderConversationList();
  try {
    await state.preferencesManager?.setConversationFlag(conversationId, field, value);
  } catch (error) {
    state.conversationPrefs[conversationId] = previous;
    renderConversationList();
    toast('Không đồng bộ được tùy chọn cuộc trò chuyện.', 'error');
  }
}

function openConversationCategoryMenu(conversationId, anchor) {
  const root = $('#conversationCategoryMenu');
  if (!root || !anchor) return;
  state.categoryMenuConversationId = conversationId;
  const activeId = state.conversationCategoryMap[conversationId] || '';
  const pref = state.conversationPrefs?.[conversationId] || {};
  root.innerHTML = `
    <button class="category-menu-item ${!activeId ? 'active' : ''}" type="button" data-assign-category="">○ <span>Không phân loại</span></button>
    ${state.conversationCategories.map((item) => `
      <button class="category-menu-item ${activeId === item.id ? 'active' : ''}" type="button" data-assign-category="${escapeHtml(item.id)}">
        <span class="category-color-tag" style="--category-color:${safeCategoryColor(item.color)}"></span>
        <span>${escapeHtml(item.name)}</span>
      </button>`).join('')}
    <div class="category-menu-separator"></div>
    <button class="category-menu-item" type="button" data-conv-flag="pinned" data-conv-value="${pref.pinned ? '0' : '1'}">${pref.pinned ? '📍' : '📌'} <span>${pref.pinned ? 'Bỏ ghim cuộc trò chuyện' : 'Ghim cuộc trò chuyện'}</span></button>
    <button class="category-menu-item" type="button" data-conv-flag="muted" data-conv-value="${pref.muted ? '0' : '1'}">${pref.muted ? '🔔' : '🔕'} <span>${pref.muted ? 'Bật thông báo' : 'Tắt thông báo'}</span></button>
    <button class="category-menu-item" type="button" data-conv-flag="archived" data-conv-value="${pref.archived ? '0' : '1'}">${pref.archived ? '↩' : '🗄'} <span>${pref.archived ? 'Bỏ lưu trữ' : 'Lưu trữ cuộc trò chuyện'}</span></button>
    <div class="category-menu-separator"></div>
    <button class="category-menu-item manage" type="button" data-manage-categories>⚙ <span>Quản lý phân loại</span></button>
  `;
  $$('[data-assign-category]', root).forEach((btn) => btn.addEventListener('click', () => {
    assignConversationCategory(conversationId, btn.dataset.assignCategory || '');
  }));
  $$('[data-conv-flag]', root).forEach((btn) => btn.addEventListener('click', async () => {
    await setConversationPreferenceFlag(conversationId, btn.dataset.convFlag, btn.dataset.convValue === '1');
    hide(root);
  }));
  $('[data-manage-categories]', root)?.addEventListener('click', () => {
    hide(root);
    openCategoryManager();
  });

  const rect = anchor.getBoundingClientRect();
  show(root);
  const menuWidth = Math.max(190, root.offsetWidth || 220);
  const menuHeight = root.offsetHeight || 200;
  const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));
  const top = Math.max(8, Math.min(window.innerHeight - menuHeight - 8, rect.bottom + 5));
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  hide('#categoryFilterMenu');
}

async function reloadSyncedPreferences() {
  if (!state.preferencesManager) return;
  try {
    const remote = await state.preferencesManager.load();
    state.contactAliases = { ...(remote.aliases || {}) };
    if ((remote.categories || []).length || state.conversationCategories.length === 0) {
      state.conversationCategories = (remote.categories || []).map((item) => ({
        id: item.id,
        name: item.name,
        color: safeCategoryColor(item.color),
      }));
    }
    state.conversationPrefs = { ...(remote.conversationPrefs || {}) };
    state.conversationCategoryMap = Object.fromEntries(
      Object.entries(state.conversationPrefs)
        .filter(([, pref]) => pref?.category_id)
        .map(([conversationId, pref]) => [conversationId, pref.category_id])
    );
    state.messagePins = remote.pins || [];
    try {
      localStorage.setItem(contactAliasStorageKey(), JSON.stringify(state.contactAliases));
      localStorage.setItem(categoryStorageKey(), JSON.stringify({
        version: 2,
        categories: state.conversationCategories,
        assignments: state.conversationCategoryMap,
      }));
    } catch {}
    updateCategoryFilterButton();
    renderConversationList();
    renderPeopleList();
    renderChatHeader();
    renderMessages();
  } catch (error) {
    console.warn('Kalo preference realtime refresh failed', error);
  }
}

async function hydrateSyncedPreferences() {
  if (!state.user) return;
  state.preferencesManager = new KaloPreferences(supabase, state.user.id);
  try {
    const remote = await state.preferencesManager.load();
    const hasRemote = Object.keys(remote.aliases || {}).length
      || (remote.categories || []).length
      || Object.keys(remote.conversationPrefs || {}).length
      || (remote.pins || []).length;
    if (hasRemote) {
      state.contactAliases = { ...(remote.aliases || {}) };
      if ((remote.categories || []).length) {
        state.conversationCategories = remote.categories.map((item) => ({
          id: item.id,
          name: item.name,
          color: safeCategoryColor(item.color),
        }));
      }
      state.conversationPrefs = { ...(remote.conversationPrefs || {}) };
      state.conversationCategoryMap = Object.fromEntries(
        Object.entries(state.conversationPrefs)
          .filter(([, pref]) => pref?.category_id)
          .map(([conversationId, pref]) => [conversationId, pref.category_id])
      );
      state.messagePins = remote.pins || [];
      try {
        localStorage.setItem(contactAliasStorageKey(), JSON.stringify(state.contactAliases));
        localStorage.setItem(categoryStorageKey(), JSON.stringify({
          version: 2,
          categories: state.conversationCategories,
          assignments: state.conversationCategoryMap,
        }));
      } catch {}
    } else {
      await state.preferencesManager.replaceAliases(state.contactAliases);
      await state.preferencesManager.replaceCategories(state.conversationCategories, state.conversationCategoryMap);
      state.conversationPrefs = {};
      state.messagePins = [];
    }
  } catch (error) {
    console.warn('Kalo preference sync unavailable, using local cache', error);
  }
  updateCategoryFilterButton();
}

async function setSessionFromResponse(session) {
  if (!session?.access_token || !session?.refresh_token) throw new Error('Phiên đăng nhập không hợp lệ.');
  const { error } = await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw error;
}

async function getProfile(userId) {
  const { data, error } = await supabase
    .from('kalo_profiles')
    .select('user_id,username,display_name,public_key,avatar_url')
    .eq('user_id', userId)
    .single();
  if (error) throw error;
  return data;
}

function waitForIdentity(hasBackup) {
  return new Promise((resolve, reject) => {
    const modal = $('#identityModal');
    const input = $('#identityCode');
    const error = $('#identityError');
    $('#identityHint').textContent = hasBackup
      ? 'Nhập mã khôi phục Kalo để mở lịch sử riêng tư trên thiết bị này.'
      : 'Thiết bị này chưa có khóa tin nhắn. Nhập mã khôi phục Kalo bạn đã lưu để tạo khóa bảo mật.';
    input.value = '';
    error.textContent = '';
    show(modal);
    setTimeout(() => input.focus(), 50);

    const button = $('#identitySubmit');
    const handler = async () => {
      const code = input.value.trim().toUpperCase();
      if (code.length < 8) {
        error.textContent = 'Vui lòng nhập mã khôi phục Kalo.';
        return;
      }
      setBusy(button, true);
      try {
        const identity = hasBackup
          ? await restoreIdentity(supabase, state.user.id, code)
          : await generateIdentity(supabase, state.user.id, code);
        hide(modal);
        button.removeEventListener('click', handler);
        resolve(identity);
      } catch (e) {
        error.textContent = e.message;
      } finally {
        setBusy(button, false);
      }
    };
    button.addEventListener('click', handler);
  });
}

async function ensureUserIdentity(recoveryCode = null) {
  if (recoveryCode) {
    const info = await ensureIdentity(supabase, state.user.id);
    if (info.identity) return info.identity;
    if (info.hasBackup) return restoreIdentity(supabase, state.user.id, recoveryCode);
    return generateIdentity(supabase, state.user.id, recoveryCode);
  }
  const info = await ensureIdentity(supabase, state.user.id);
  if (info.identity) return info.identity;
  return waitForIdentity(info.hasBackup);
}

async function stopRealtime() {
  for (const channel of state.realtimeChannels) {
    try { await supabase.removeChannel(channel); } catch {}
  }
  state.realtimeChannels = [];
  if (state.presenceChannel) {
    try { await supabase.removeChannel(state.presenceChannel); } catch {}
    state.presenceChannel = null;
  }
  if (state.fileManager) {
    try { await state.fileManager.stop(); } catch {}
    state.fileManager = null;
  }
  if (state.callManager) {
    try { await state.callManager.stop(); } catch {}
    state.callManager = null;
  }
  state.activeCall = null;
  state.incomingCall = null;
}

async function startPresence() {
  const channel = supabase.channel('kalo-presence-v1', {
    config: { presence: { key: state.user.id } },
  });
  channel
    .on('presence', { event: 'sync' }, () => {
      const snapshot = channel.presenceState();
      state.presence = new Set(Object.keys(snapshot));
      renderOnlineSummary();
      renderConversationList();
      renderPeopleList();
      renderChatHeader();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({
          user_id: state.user.id,
          username: state.profile.username,
          at: new Date().toISOString(),
        });
      }
    });
  state.presenceChannel = channel;
}

function onFileStatus(info) {
  if (!info) return;
  const progress = $('#fileProgress');
  if (info.type === 'progress') {
    show(progress);
    const total = Number(info.total || 0);
    const loaded = Number(info.loaded || 0);
    const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    $('#fileProgressText').textContent = info.direction === 'send'
      ? `Đang gửi trực tiếp · ${formatBytes(loaded)} / ${formatBytes(total)}`
      : `Đang nhận trực tiếp · ${formatBytes(loaded)} / ${formatBytes(total)}`;
    $('#fileProgressPct').textContent = `${pct}%`;
    $('#fileProgressBar').value = pct;
    return;
  }
  if (info.type === 'done') {
    $('#fileProgressText').textContent = info.message || 'Hoàn tất.';
    $('#fileProgressPct').textContent = '100%';
    $('#fileProgressBar').value = 100;
    setTimeout(() => hide(progress), 2600);
    toast(info.message || 'Truyền file hoàn tất.');
  }
  if (info.type === 'error') {
    hide(progress);
    toast(info.message || 'Không thể truyền file.', 'error');
  }
}


async function initLocalDocuments() {
  state.documentsManager = new KaloDocuments(state.user.id, {
    onChanged: () => {
      refreshStorageUi().catch(console.error);
      if (state.currentView === 'documents') loadDocuments().catch(console.error);
    },
  });
  await state.documentsManager.init();
  state.myDocumentTimeline = await state.documentsManager.loadTimeline();
  state.myDocumentMessages = state.myDocumentTimeline.map(myDocumentMessageFromTimeline);
  await refreshStorageUi();
}

async function refreshStorageUi() {
  if (!state.documentsManager) return;
  const info = state.documentsManager.status();
  const label = info.label || 'Bộ nhớ Kalo trên thiết bị';
  if ($('#settingsStorageLabel')) $('#settingsStorageLabel').textContent = label;
  if ($('#documentsStorageLabel')) $('#documentsStorageLabel').textContent = label;

  const estimate = await state.documentsManager.storageEstimate();
  const usage = estimate.usage || 0;
  const quota = estimate.quota || 0;
  const pct = quota > 0 ? Math.min(100, Math.round((usage / quota) * 100)) : 0;
  if ($('#storageMeterBar')) $('#storageMeterBar').style.width = `${pct}%`;
  if ($('#storageUsageText')) {
    $('#storageUsageText').textContent = quota > 0
      ? `Bộ nhớ trình duyệt đang dùng khoảng ${formatBytes(usage)} / ${formatBytes(quota)}. File trong thư mục ổ đĩa không tính vào con số này.`
      : 'Kalo đang dùng bộ nhớ cục bộ của thiết bị.';
  }
}

async function chooseStorageFolder() {
  if (!state.documentsManager) return;
  try {
    const result = await state.documentsManager.chooseDirectory();
    await refreshStorageUi();
    await loadDocuments();
    toast(result.mode === 'folder'
      ? (result.moved > 0
          ? `Đã chuyển ${result.moved} file sang thư mục “${result.label}”.`
          : `Đã chuyển My Documents sang thư mục “${result.label}”.`)
      : 'Thiết bị này dùng bộ nhớ Kalo cục bộ.');
  } catch (e) {
    if (e?.name !== 'AbortError') toast(e.message || 'Không đổi được vị trí lưu trữ.', 'error');
  }
}

function documentIcon(item) {
  const type = item?.type || '';
  const name = item?.name?.toLowerCase?.() || '';
  if (type.startsWith('image/')) return '🖼';
  if (type.startsWith('video/')) return '🎬';
  if (type.startsWith('audio/')) return '🎵';
  if (name.endsWith('.pdf')) return '📕';
  if (/\.(doc|docx)$/i.test(name)) return '📘';
  if (/\.(xls|xlsx|csv)$/i.test(name)) return '📗';
  if (/\.(zip|rar|7z)$/i.test(name)) return '🗜';
  return '📄';
}

async function loadDocuments() {
  if (!state.documentsManager) return;
  try {
    state.documentItems = await state.documentsManager.list('');
    renderDocumentsList();
  } catch (e) {
    state.documentItems = [];
    renderDocumentsList();
    toast(e.message || 'Không đọc được My Documents.', 'error');
  }
}

function renderDocumentsList() {
  const root = $('#documentsList');
  if (!root) return;
  const latest = state.myDocumentMessages[state.myDocumentMessages.length - 1];
  const preview = latest
    ? messageSearchTextOf(latest) || (latest.decoded?.type === 'sticker' ? 'Sticker' : 'Đã lưu nội dung')
    : (state.documentItems.length ? `${state.documentItems.length} file đã lưu` : 'Gửi tin nhắn, ảnh hoặc file cho chính bạn');
  const when = latest?.created_at ? formatTime(latest.created_at) : '';
  root.innerHTML = `
    <button class="conv-item my-doc-conversation active" type="button" data-open-my-documents>
      <div class="avatar">🗂</div>
      <div class="conv-main">
        <div class="conv-name">My Documents</div>
        <div class="conv-preview">${escapeHtml(preview)}</div>
      </div>
      <div class="conv-meta">${escapeHtml(when)}</div>
    </button>`;
  $('[data-open-my-documents]', root)?.addEventListener('click', () => openMyDocumentsChat());
}

function selectDocument(name) {
  const item = state.documentItems.find((x) => x.name === name);
  if (!item) return;
  state.selectedDocumentName = name;
  renderDocumentsList();
  const detail = $('#documentsDetail');
  const canSend = !!state.currentConversationId;
  detail.innerHTML = `
    <div class="document-detail-card">
      <div class="document-detail-icon">${documentIcon(item)}</div>
      <h3>${escapeHtml(item.name)}</h3>
      <p>${formatBytes(item.size)}${item.modified ? ` · ${new Date(item.modified).toLocaleString('vi-VN')}` : ''}</p>
      <div class="document-detail-actions">
        <button class="secondary-btn" data-doc-open type="button">Mở</button>
        <button class="secondary-btn" data-doc-download type="button">Tải bản sao</button>
        <button class="secondary-btn" data-doc-send type="button" ${canSend ? '' : 'disabled'}>Gửi vào chat hiện tại</button>
        <button class="danger-btn" data-doc-delete type="button">Xóa</button>
      </div>
      ${canSend ? '' : '<small class="form-note">Chọn một cuộc trò chuyện trước nếu bạn muốn gửi file này.</small>'}
    </div>`;
  $('[data-doc-open]', detail)?.addEventListener('click', () => state.documentsManager.open(name).catch((e) => toast(e.message, 'error')));
  $('[data-doc-download]', detail)?.addEventListener('click', () => state.documentsManager.download(name).catch((e) => toast(e.message, 'error')));
  $('[data-doc-delete]', detail)?.addEventListener('click', async () => {
    try {
      await state.documentsManager.delete(name);
      state.selectedDocumentName = null;
      $('#documentsDetail').innerHTML = '<div class="documents-placeholder">Chọn một file ở bên trái để xem thao tác.</div>';
      await loadDocuments();
      toast('Đã xóa file khỏi My Documents.');
    } catch (e) {
      toast(e.message || 'Không xóa được file.', 'error');
    }
  });
  $('[data-doc-send]', detail)?.addEventListener('click', async () => {
    try {
      const file = await state.documentsManager.getFile(name);
      await sendTransferFile(file, file.type?.startsWith('image/') ? 'image' : 'file');
      toast('Đã đưa file vào cuộc trò chuyện hiện tại.');
    } catch (e) {
      toast(e.message || 'Không gửi được file.', 'error');
    }
  });
}

async function addDocuments(files) {
  if (!state.documentsManager || !files?.length) return;
  for (const file of files) {
    await sendMyDocumentFile(file, file.type?.startsWith('image/') ? 'image' : 'file');
  }
  await loadDocuments();
  await refreshStorageUi();
  toast(files.length > 1 ? `Đã thêm ${files.length} file vào My Documents.` : 'Đã thêm file vào My Documents.');
}

function myDocumentMessageFromTimeline(item) {
  const type = item.type || 'text';
  return {
    id: item.id,
    conversation_id: '__my_documents__',
    sender_id: state.user?.id,
    kind: type === 'file' || type === 'image' ? 'file_offer' : 'text',
    created_at: item.created_at || new Date().toISOString(),
    localDocument: true,
    decoded: {
      type,
      text: item.text || '',
      sticker: item.sticker || '',
      name: item.name || item.fileName || '',
      fileName: item.fileName || item.name || '',
      size: Number(item.size || 0),
      mime: item.mime || '',
      thumbnail: item.thumbnail || null,
    },
  };
}

async function persistMyDocumentTimeline() {
  if (!state.documentsManager) return;
  state.myDocumentTimeline = await state.documentsManager.saveTimeline(state.myDocumentTimeline);
}

async function syncLegacyDocumentsToTimeline() {
  if (!state.documentsManager) return;
  const existingNames = new Set(
    state.myDocumentTimeline
      .filter((item) => item.fileName)
      .map((item) => item.fileName)
  );
  let changed = false;
  for (const item of state.documentItems) {
    if (existingNames.has(item.name)) continue;
    state.myDocumentTimeline.push({
      id: crypto.randomUUID(),
      type: item.type?.startsWith('image/') ? 'image' : 'file',
      fileName: item.name,
      name: item.name,
      size: item.size,
      mime: item.type || 'application/octet-stream',
      thumbnail: null,
      created_at: new Date(item.modified || Date.now()).toISOString(),
      importedLegacy: true,
    });
    existingNames.add(item.name);
    changed = true;
  }
  if (changed) {
    state.myDocumentTimeline.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    await persistMyDocumentTimeline();
  }
}

async function loadMyDocumentMessages(syncLegacy = true) {
  if (!state.documentsManager) return;
  state.myDocumentTimeline = await state.documentsManager.loadTimeline();
  await loadDocuments();
  if (syncLegacy) await syncLegacyDocumentsToTimeline();
  state.myDocumentMessages = state.myDocumentTimeline.map(myDocumentMessageFromTimeline);
  if (state.currentView === 'documents') {
    state.messages = [...state.myDocumentMessages];
    state.reactions.clear();
    renderDocumentsList();
    renderMessages();
    renderMessageSearchResults();
    setTimeout(() => scrollMessagesToLatest({ smooth: false }), 0);
  }
}

async function appendMyDocumentItem(item) {
  state.myDocumentTimeline.push(item);
  state.myDocumentTimeline.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  await persistMyDocumentTimeline();
  state.myDocumentMessages = state.myDocumentTimeline.map(myDocumentMessageFromTimeline);
  state.messages = [...state.myDocumentMessages];
  renderDocumentsList();
  renderMessages();
  renderMessageSearchResults();
  setTimeout(() => scrollMessagesToLatest({ smooth: false }), 0);
}

async function sendMyDocumentText(text) {
  const value = String(text || '').trim();
  if (!value) return;
  await appendMyDocumentItem({
    id: crypto.randomUUID(),
    type: 'text',
    text: value,
    created_at: new Date().toISOString(),
  });
}

async function sendMyDocumentSticker(sticker) {
  if (!sticker) return;
  await appendMyDocumentItem({
    id: crypto.randomUUID(),
    type: 'sticker',
    sticker,
    created_at: new Date().toISOString(),
  });
  hide('#stickerPanel');
}

function normalizeLocalFile(file, type = 'file') {
  if (!file) return null;
  if (file.name) return file;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '_');
  const ext = type === 'image'
    ? (file.type === 'image/jpeg' ? '.jpg' : file.type === 'image/webp' ? '.webp' : '.png')
    : '';
  return new File([file], `Kalo_${type === 'image' ? 'Anh' : 'File'}_${stamp}${ext}`, { type: file.type || 'application/octet-stream' });
}

async function sendMyDocumentFile(inputFile, type = 'file') {
  if (!state.documentsManager || !inputFile) return;
  const file = normalizeLocalFile(inputFile, type);
  const savedName = await state.documentsManager.saveFile(file);
  const thumbnail = type === 'image' ? await makeImageThumbnail(file) : null;
  await appendMyDocumentItem({
    id: crypto.randomUUID(),
    type,
    fileName: savedName,
    name: savedName,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    thumbnail,
    created_at: new Date().toISOString(),
  });
  await refreshStorageUi();
}

async function removeMyDocumentMessage(messageId) {
  const item = state.myDocumentTimeline.find((x) => x.id === messageId);
  if (!item) return;
  state.myDocumentTimeline = state.myDocumentTimeline.filter((x) => x.id !== messageId);
  if (item.fileName && !state.myDocumentTimeline.some((x) => x.fileName === item.fileName)) {
    try { await state.documentsManager.delete(item.fileName); } catch {}
  }
  await persistMyDocumentTimeline();
  await loadMyDocumentMessages(false);
}

function renderMyDocumentsHeader() {
  $('#chatAvatar').textContent = 'M';
  $('#chatTitle').textContent = 'My Documents';
  $('#chatSubtitle').textContent = 'Chỉ mình bạn · lưu cục bộ trên thiết bị';
  hide('#audioCallBtn');
  hide('#videoCallBtn');
  hide('#chatInfoBtn');
  $('#messageInput').placeholder = 'Nhắn cho chính mình...';
}

async function openMyDocumentsChat() {
  state.currentView = 'documents';
  hide('#documentsHome');
  hide('#emptyChat');
  show('#activeChat');
  $('#appScreen').classList.add('chat-open');
  renderMyDocumentsHeader();
  await loadMyDocumentMessages(true);
}

function showIncomingCall(incoming) {
  state.incomingCall = incoming;
  const name = profileName(incoming.peerId);
  $('#incomingCallAvatar').textContent = initials(name);
  $('#incomingCallName').textContent = name;
  $('#incomingCallType').textContent = incoming.mode === 'video' ? 'Cuộc gọi video đến' : 'Cuộc gọi thoại đến';
  show('#incomingCallModal');
}

function updateCallUi(session, status = 'Đang kết nối...') {
  if (!session) return;
  const name = profileName(session.peerId);
  state.activeCall = session;
  $('#callPeerName').textContent = name;
  $('#activeCallName').textContent = name;
  $('#activeCallAvatar').textContent = initials(name);
  $('#callStatus').textContent = status;
  $('#callModeLabel').textContent = session.mode === 'video' ? 'Gọi video' : 'Gọi thoại';
  $('#cameraCallBtn').classList.toggle('hidden', session.mode !== 'video');
  $('#audioCallPlaceholder').classList.toggle('hidden', session.mode === 'video');
  $('#remoteCallVideo').classList.toggle('hidden', session.mode !== 'video');
  $('#localCallVideo').classList.toggle('hidden', session.mode !== 'video');
  if (session.localStream) $('#localCallVideo').srcObject = session.localStream;
  show('#callModal');
}

function clearCallUi(message = '') {
  state.activeCall = null;
  state.incomingCall = null;
  hide('#incomingCallModal');
  hide('#callModal');
  $('#remoteCallVideo').srcObject = null;
  $('#remoteCallAudio').srcObject = null;
  $('#localCallVideo').srcObject = null;
  if (message) toast(message);
}

function callCallbacks() {
  return {
    onIncoming: showIncomingCall,
    onOutgoing: ({ session }) => updateCallUi(session, 'Đang gọi...'),
    onAccepted: ({ session }) => {
      hide('#incomingCallModal');
      updateCallUi(session, 'Đang kết nối...');
    },
    onRemoteStream: ({ session, stream }) => {
      if (session.mode === 'video') $('#remoteCallVideo').srcObject = stream;
      else $('#remoteCallAudio').srcObject = stream;
    },
    onConnected: ({ session }) => updateCallUi(session, 'Đã kết nối'),
    onState: ({ session, state: connectionState }) => {
      if (state.activeCall?.callId !== session.callId) return;
      if (connectionState === 'connecting') $('#callStatus').textContent = 'Đang kết nối...';
    },
    onMediaState: ({ session }) => {
      $('#muteCallBtn').classList.toggle('active', session.muted);
      $('#muteCallBtn').textContent = session.muted ? '🔇' : '🎙';
      $('#cameraCallBtn').classList.toggle('active', session.cameraOff);
      $('#cameraCallBtn').textContent = session.cameraOff ? '🚫' : '📷';
    },
    onEnded: ({ reason }) => {
      clearCallUi(reason === 'rejected' ? 'Người nhận đã từ chối cuộc gọi.' : '');
    },
    onError: ({ message }) => {
      toast(message || 'Cuộc gọi gặp lỗi.', 'error');
    },
  };
}

async function startCurrentCall(mode) {
  const conv = currentConversation();
  const peerId = directPeerId(conv);
  if (!peerId) {
    toast('Hiện Kalo hỗ trợ gọi 1-1. Nhóm chưa hỗ trợ cuộc gọi.', 'error');
    return;
  }
  if (!isOnline(peerId)) {
    toast('Người này hiện không online nên chưa thể nhận cuộc gọi.', 'error');
    return;
  }
  try {
    const session = await state.callManager.startCall(peerId, mode);
    updateCallUi(session, 'Đang gọi...');
  } catch (e) {
    toast(e.message || 'Không bắt đầu được cuộc gọi.', 'error');
  }
}

async function startRealtime() {
  await stopRealtime();
  await startPresence();

  const dataChannel = supabase
    .channel(`kalo-data-${state.user.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_messages' }, async (payload) => {
      const row = payload.new || payload.old;
      if (!row) return;
      if (payload.eventType === 'INSERT') {
        await loadProfiles().catch(() => {});
        if (!state.conversations.some((conv) => conv.id === row.conversation_id)) {
          await loadConversations();
        }
        notifyParentOfIncomingMessage(row);
      }
      if (row.conversation_id === state.currentConversationId) {
        await loadMessages(row.conversation_id);
      } else {
        await refreshPreviews();
        await refreshUnreadCounts();
        renderConversationList();
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_reactions' }, async () => {
      if (state.currentConversationId) {
        await loadReactions();
        renderMessages();
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_reads' }, async (payload) => {
      const row = payload.new || payload.old;
      await refreshUnreadCounts();
      if (row?.conversation_id === state.currentConversationId && state.messageService) {
        state.currentReads = await state.messageService.reads(state.currentConversationId).catch(() => []);
        renderMessages();
      }
      renderConversationList();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_friendships' }, async () => {
      await loadFriendships();
      renderPeopleList();
      renderConversationList();
      renderOnlineSummary();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_profiles' }, async () => {
      await loadProfiles();
      updateSelfAvatar();
      updateProfileAvatarPreview();
      renderPeopleList();
      renderConversationList();
      renderChatHeader();
      renderMessages();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_contact_aliases', filter: `user_id=eq.${state.user.id}` }, reloadSyncedPreferences)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_categories', filter: `user_id=eq.${state.user.id}` }, reloadSyncedPreferences)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_conversation_prefs', filter: `user_id=eq.${state.user.id}` }, reloadSyncedPreferences)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_message_pins', filter: `user_id=eq.${state.user.id}` }, reloadSyncedPreferences)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_conversations' }, async () => {
      await loadConversations();
      await refreshUnreadCounts();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_conversation_members' }, async () => {
      await loadConversations();
      await refreshUnreadCounts();
    })
    .subscribe();
  state.realtimeChannels.push(dataChannel);

  state.fileManager = new KaloFileTransfer(supabase, state.user.id, {
    onStatus: onFileStatus,
    createReceiveTarget: (meta) => state.documentsManager?.createReceiveTarget(meta),
    onReceived: () => {
      if (state.currentView === 'documents') loadDocuments().catch(console.error);
      refreshStorageUi().catch(console.error);
    },
  });
  await state.fileManager.start();

  state.callManager = new KaloCallManager(supabase, state.user.id, callCallbacks());
  await state.callManager.start();
}

async function loadProfiles() {
  const { data, error } = await supabase
    .from('kalo_profiles')
    .select('user_id,username,display_name,public_key,avatar_url')
    .order('display_name');
  if (error) throw error;
  state.profiles = new Map((data || []).map((p) => [p.user_id, p]));
  state.profile = state.profiles.get(state.user.id) || state.profile;
}

async function loadFriendships() {
  const { data, error } = await supabase
    .from('kalo_friendships')
    .select('id,requester_id,addressee_id,status,created_at,accepted_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  state.friendships = data || [];
}


async function loadConversations() {
  const [{ data: convs, error: convError }, { data: members, error: memberError }] = await Promise.all([
    supabase.from('kalo_conversations').select('*').order('created_at', { ascending: false }),
    supabase.from('kalo_conversation_members').select('*'),
  ]);
  if (convError) throw convError;
  if (memberError) throw memberError;
  state.conversations = convs || [];
  const map = new Map();
  for (const row of members || []) {
    if (!map.has(row.conversation_id)) map.set(row.conversation_id, []);
    map.get(row.conversation_id).push(row.user_id);
  }
  state.members = map;
  await refreshPreviews();
  renderConversationList();
}

async function refreshPreviews() {
  state.previews.clear();
  const ids = state.conversations.map((c) => c.id);
  if (!ids.length || !state.identity) return;
  const { data, error } = await supabase
    .from('kalo_messages')
    .select('id,conversation_id,sender_id,kind,encrypted_payloads,created_at,deleted_at')
    .in('conversation_id', ids)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return;
  for (const row of data || []) {
    if (state.previews.has(row.conversation_id)) continue;
    try {
      if (row.deleted_at) {
        state.previews.set(row.conversation_id, { text: 'Tin nhắn đã xóa', created_at: row.created_at });
        continue;
      }
      const decoded = await decryptPayload(row.encrypted_payloads, state.user.id, state.identity);
      state.previews.set(row.conversation_id, {
        text:
          decoded.type === 'sticker'
            ? `${decoded.sticker || '🙂'} Sticker`
            : decoded.type === 'image'
              ? `🖼 ${decoded.name || 'Ảnh'}`
              : row.kind === 'file_offer'
                ? `📎 ${decoded.name || 'File'}`
                : decoded.text || 'Tin nhắn',
        created_at: row.created_at,
      });
    } catch {
      state.previews.set(row.conversation_id, { text: 'Tin nhắn riêng tư', created_at: row.created_at });
    }
  }
}

async function refreshUnreadCounts() {
  if (!state.messageService) return;
  try {
    state.unreadCounts = await state.messageService.unreadCounts();
  } catch (error) {
    console.warn('Kalo unread count refresh failed', error);
  }
}

async function markRead(conversationId) {
  const last = state.messages[state.messages.length - 1];
  if (!last || !state.messageService) return;
  await state.messageService.markRead(conversationId, last.id);
  state.unreadCounts.set(conversationId, 0);
  renderConversationList();
}

async function loadMessages(conversationId) {
  if (!state.identity) return;
  if (!state.messageService) {
    state.messageService = new KaloMessageService(supabase, state.user.id, state.identity, 100);
  }
  try {
    const result = await state.messageService.latest(conversationId, 100);
    state.messages = result.messages;
    state.messagePageHasMore = result.hasMore;
    state.currentReads = await state.messageService.reads(conversationId).catch(() => []);
    await loadReactions();
    renderMessages();
    await markRead(conversationId);
    await refreshUnreadCounts();
    setTimeout(() => scrollMessagesToLatest({ smooth: false }), 0);
  } catch (error) {
    console.error(error);
    toast('Không tải được tin nhắn.', 'error');
  }
}

async function loadOlderMessages() {
  if (state.loadingOlderMessages || !state.messagePageHasMore || !state.currentConversationId || !state.messageService) return;
  const first = state.messages[0];
  if (!first?.created_at) return;
  const list = $('#messageList');
  const previousHeight = list?.scrollHeight || 0;
  const previousTop = list?.scrollTop || 0;
  state.loadingOlderMessages = true;
  try {
    const result = await state.messageService.before(state.currentConversationId, first.created_at, 100);
    const existing = new Set(state.messages.map((m) => m.id));
    const older = result.messages.filter((m) => !existing.has(m.id));
    state.messages = [...older, ...state.messages];
    state.messagePageHasMore = result.hasMore;
    await loadReactions();
    renderMessages();
    requestAnimationFrame(() => {
      if (!list) return;
      list.scrollTop = previousTop + Math.max(0, list.scrollHeight - previousHeight);
    });
  } catch (error) {
    console.warn('Kalo load older messages failed', error);
  } finally {
    state.loadingOlderMessages = false;
  }
}

async function loadReactions() {
  const ids = state.messages.map((m) => m.id);
  state.reactions.clear();
  if (!ids.length) return;
  const { data } = await supabase.from('kalo_reactions').select('*').in('message_id', ids);
  for (const r of data || []) {
    if (!state.reactions.has(r.message_id)) state.reactions.set(r.message_id, []);
    state.reactions.get(r.message_id).push(r);
  }
}

function renderOnlineSummary() {
  const friends = acceptedFriendIds();
  const count = [...state.presence].filter((id) => friends.has(id)).length;
  const pending = incomingFriendRequests().length;
  if (state.currentView === 'people' && pending > 0) {
    $('#onlineSummary').textContent = `${pending} lời mời kết bạn`;
    return;
  }
  $('#onlineSummary').textContent = count > 0 ? `${count} bạn đang online` : 'Kalo đã sẵn sàng';
}

function renderConversationList() {
  const list = $('#conversationList');
  if (!list) return;
  const query = $('#conversationSearch')?.value.trim().toLowerCase() || '';
  const sorted = [...state.conversations].sort((a, b) => {
    const ap = Boolean(state.conversationPrefs?.[a.id]?.pinned);
    const bp = Boolean(state.conversationPrefs?.[b.id]?.pinned);
    if (ap !== bp) return bp - ap;
    const at = state.previews.get(a.id)?.created_at || a.created_at;
    const bt = state.previews.get(b.id)?.created_at || b.created_at;
    return new Date(bt) - new Date(at);
  });

  const visible = sorted.filter((conv) => {
    const queryOk = conversationLabel(conv).toLowerCase().includes(query);
    const archived = Boolean(state.conversationPrefs?.[conv.id]?.archived);
    const categoryOk = state.activeCategoryFilter === 'archived'
      ? archived
      : (!archived && (state.activeCategoryFilter === 'all'
        || state.conversationCategoryMap[conv.id] === state.activeCategoryFilter));
    return queryOk && categoryOk;
  });

  list.innerHTML = visible.map((conv) => {
    const label = conversationLabel(conv);
    const preview = state.previews.get(conv.id);
    const otherId = conv.kind === 'direct' ? memberIds(conv.id).find((id) => id !== state.user.id) : null;
    const online = otherId && isOnline(otherId);
    const category = conversationCategory(conv.id);
    const peerProfile = otherId ? state.profiles.get(otherId) : null;
    const avatarHtml = conv.kind === 'direct'
      ? avatarContent(peerProfile, label)
      : escapeHtml(initials(label));
    const categoryBadge = category
      ? `<span class="conv-category-badge" style="--category-color:${safeCategoryColor(category.color)}"><i></i>${escapeHtml(category.name)}</span>`
      : '';
    const draft = getDraft(state.user?.id, conv.id);
    const unread = Number(state.unreadCounts.get(conv.id) || 0);
    const pref = state.conversationPrefs?.[conv.id] || {};
    const previewText = draft ? `Bản nháp: ${draft}` : (preview?.text || 'Bắt đầu trò chuyện');
    const statusBits = `${pref.pinned ? '📌' : ''}${pref.muted ? '🔕' : ''}`;
    return `<div class="conv-row ${conv.id === state.currentConversationId ? 'active' : ''}">
      <button class="conv-item ${conv.id === state.currentConversationId ? 'active' : ''}" data-conv-id="${conv.id}" type="button">
        <div class="avatar ${safeAvatarUrl(peerProfile?.avatar_url) ? 'has-image avatar-clickable' : ''}" ${otherId ? `data-avatar-user="${escapeHtml(otherId)}" title="Bấm để xem ảnh đại diện"` : ''}>${avatarHtml}</div>
        <div class="conv-main">
          <div class="conv-name-line"><div class="conv-name">${escapeHtml(label)}${online ? ' · 🟢' : ''}</div>${categoryBadge}</div>
          <div class="conv-preview ${draft ? 'draft' : ''}">${escapeHtml(previewText)}</div>
        </div>
        <div class="conv-meta">${statusBits ? `<span class="conv-status-bits">${statusBits}</span>` : ''}<span>${escapeHtml(formatTime(preview?.created_at || conv.created_at))}</span>${unread > 0 ? `<b class="conv-unread-badge">${unread > 99 ? '99+' : unread}</b>` : ''}</div>
      </button>
      <button class="conv-classify-btn" type="button" data-classify-conv="${conv.id}" title="Phân loại cuộc trò chuyện" aria-label="Phân loại ${escapeHtml(label)}">
        <span style="--category-color:${category ? safeCategoryColor(category.color) : '#aebdb5'}"></span>🏷
      </button>
    </div>`;
  }).join('') || '<div class="empty-chat" style="padding:32px 10px"><p>Không có cuộc trò chuyện phù hợp.</p></div>';

  $$('[data-conv-id]', list).forEach((btn) => btn.addEventListener('click', () => openConversation(btn.dataset.convId)));
  $$('[data-classify-conv]', list).forEach((btn) => btn.addEventListener('click', (event) => {
    event.stopPropagation();
    openConversationCategoryMenu(btn.dataset.classifyConv, btn);
  }));
}

function renderPeopleList() {
  const root = $('#peopleList');
  if (!root || !state.user) return;
  const query = ($('#conversationSearch')?.value || '').trim().toLowerCase();

  const requests = incomingFriendRequests()
    .map((row) => ({ row, profile: friendProfileFromRow(row) }))
    .filter((x) => x.profile);

  const outgoing = outgoingFriendRequests()
    .map((row) => ({ row, profile: friendProfileFromRow(row) }))
    .filter((x) => x.profile);

  const friends = [...acceptedFriendIds()]
    .map((id) => state.profiles.get(id))
    .filter(Boolean)
    .filter((p) => {
      const display = contactDisplayName(p.user_id).toLowerCase();
      return !query || display.includes(query) || p.display_name.toLowerCase().includes(query) || p.username.includes(query);
    })
    .sort((a, b) => contactDisplayName(a.user_id).localeCompare(contactDisplayName(b.user_id), 'vi'));

  const requestHtml = requests.length ? `
    <div class="contact-section">
      <div class="contact-section-title">Lời mời kết bạn <span>${requests.length}</span></div>
      ${requests.map(({ row, profile: p }) => `<div class="person-item request-item">
        <div class="avatar ${safeAvatarUrl(p.avatar_url) ? 'has-image avatar-clickable' : ''}" data-avatar-user="${escapeHtml(p.user_id)}" ${safeAvatarUrl(p.avatar_url) ? 'title="Bấm để xem ảnh đại diện"' : ''}>${avatarContent(p, p.display_name)}</div>
        <div class="person-info">
          <strong>${escapeHtml(p.display_name)}</strong>
          <small>@${escapeHtml(p.username)}</small>
        </div>
        <div class="friend-actions">
          <button class="accept-btn" data-accept-friend="${row.id}" type="button">Đồng ý</button>
          <button class="decline-btn" data-decline-friend="${row.id}" type="button">Bỏ qua</button>
        </div>
      </div>`).join('')}
    </div>` : '';

  const friendHtml = `
    <div class="contact-section">
      <div class="contact-section-title">Bạn bè <span>${friends.length}</span></div>
      ${friends.map((p) => {
        const display = contactDisplayName(p.user_id);
        const original = p.display_name || p.username;
        return `<div class="person-item">
          <div class="avatar ${safeAvatarUrl(p.avatar_url) ? 'has-image avatar-clickable' : ''}" data-avatar-user="${escapeHtml(p.user_id)}" ${safeAvatarUrl(p.avatar_url) ? 'title="Bấm để xem ảnh đại diện"' : ''}>${avatarContent(p, display)}</div>
          <div class="person-info">
            <strong>${escapeHtml(display)} ${isOnline(p.user_id) ? '🟢' : ''}</strong>
            <small>${display !== original ? `${escapeHtml(original)} · ` : ''}@${escapeHtml(p.username)}</small>
          </div>
          <button data-message-user="${p.user_id}" type="button">Nhắn tin</button>
        </div>`;
      }).join('') || '<div class="contact-empty">Chưa có bạn bè. Bấm “Thêm bạn” để bắt đầu.</div>'}
    </div>`;

  const outgoingHtml = outgoing.length ? `
    <div class="contact-section">
      <div class="contact-section-title muted-title">Đang chờ đồng ý <span>${outgoing.length}</span></div>
      ${outgoing.map(({ row, profile: p }) => `<div class="person-item pending-item">
        <div class="avatar ${safeAvatarUrl(p.avatar_url) ? 'has-image avatar-clickable' : ''}" data-avatar-user="${escapeHtml(p.user_id)}" ${safeAvatarUrl(p.avatar_url) ? 'title="Bấm để xem ảnh đại diện"' : ''}>${avatarContent(p, p.display_name)}</div>
        <div class="person-info">
          <strong>${escapeHtml(p.display_name)}</strong>
          <small>@${escapeHtml(p.username)}</small>
        </div>
        <button class="decline-btn" data-cancel-friend="${row.id}" type="button">Hủy</button>
      </div>`).join('')}
    </div>` : '';

  root.innerHTML = requestHtml + friendHtml + outgoingHtml;

  $$('[data-message-user]', root).forEach((btn) => btn.addEventListener('click', () => {
    createOrOpenDirect(btn.dataset.messageUser).catch((e) => toast(e.message, 'error'));
  }));
  $$('[data-accept-friend]', root).forEach((btn) => btn.addEventListener('click', () => {
    acceptFriendRequest(btn.dataset.acceptFriend).catch((e) => toast(e.message, 'error'));
  }));
  $$('[data-decline-friend]', root).forEach((btn) => btn.addEventListener('click', () => {
    removeFriendship(btn.dataset.declineFriend, 'Đã bỏ qua lời mời.').catch((e) => toast(e.message, 'error'));
  }));
  $$('[data-cancel-friend]', root).forEach((btn) => btn.addEventListener('click', () => {
    removeFriendship(btn.dataset.cancelFriend, 'Đã hủy lời mời.').catch((e) => toast(e.message, 'error'));
  }));
}

function renderChatHeader() {
  const conv = currentConversation();
  if (!conv) return;
  const title = conversationLabel(conv);
  $('#chatTitle').textContent = title;
  $('#messageInput').placeholder = 'Nhập tin nhắn...';
  show('#chatInfoBtn');
  const direct = conv.kind === 'direct';
  $('#renameContactBtn').classList.toggle('hidden', !direct);
  $('#audioCallBtn').classList.toggle('hidden', !direct);
  $('#videoCallBtn').classList.toggle('hidden', !direct);
  if (conv.kind === 'group') {
    setAvatarElement($('#chatAvatar'), null, title);
    markAvatarClickable($('#chatAvatar'), null);
    $('#chatSubtitle').textContent = `${memberIds(conv.id).length} thành viên`;
  } else {
    const other = memberIds(conv.id).find((id) => id !== state.user.id);
    const profile = state.profiles.get(other);
    setAvatarElement($('#chatAvatar'), profile, title);
    markAvatarClickable($('#chatAvatar'), other);
    const original = profile?.display_name || profile?.username || '';
    const onlineText = other && isOnline(other) ? 'Đang online' : 'Riêng tư';
    $('#chatSubtitle').textContent = contactAlias(other) && original
      ? `${original} · ${onlineText}`
      : onlineText;
  }
}

function isMessageListNearBottom(threshold = 90) {
  const list = $('#messageList');
  if (!list) return true;
  return (list.scrollHeight - list.scrollTop - list.clientHeight) <= threshold;
}

function updateScrollToLatestButton() {
  const list = $('#messageList');
  const button = $('#scrollToLatestBtn');
  if (!list || !button) return;
  const showButton = list.scrollHeight > list.clientHeight + 20 && !isMessageListNearBottom(110);
  button.classList.toggle('hidden', !showButton);
}

function scrollMessagesToLatest({ smooth = true } = {}) {
  const list = $('#messageList');
  if (!list) return;
  list.scrollTo({ top: list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  setTimeout(updateScrollToLatestButton, smooth ? 240 : 0);
}

function renderMessages() {
  const list = $('#messageList');
  if (!list || (!state.currentConversationId && state.currentView !== 'documents')) return;
  list.innerHTML = state.messages.map((m) => {
    const own = m.sender_id === state.user.id;
    const sender = state.profiles.get(m.sender_id);
    const reactions = state.reactions.get(m.id) || [];
    const hearts = reactions.filter((r) => r.emoji === '❤️');
    const mine = hearts.some((r) => r.user_id === state.user.id);
    const deleted = Boolean(m.deleted_at);
    const pinned = isMessagePinned(m.id);
    const replyTarget = m.reply_to ? state.messages.find((x) => x.id === m.reply_to) : null;
    const replyHtml = m.reply_to
      ? `<button class="reply-quote" type="button" data-reply-jump="${m.reply_to}">
          <strong>${escapeHtml(replyTarget ? profileName(replyTarget.sender_id) : 'Tin nhắn trước')}</strong>
          <span>${escapeHtml(replyTarget ? messageActionText(replyTarget).slice(0, 130) : 'Tin nhắn cũ chưa được tải')}</span>
        </button>`
      : '';
    const forwardedHtml = m.decoded?.forwarded
      ? `<div class="forwarded-label">↗ Chuyển tiếp${m.decoded.originalSender ? ` từ ${escapeHtml(m.decoded.originalSender)}` : ''}</div>`
      : '';
    let body = '';

    if (deleted) {
      body = '<div class="bubble-text deleted-message">Tin nhắn đã được xóa.</div>';
    } else if (m.decoded.type === 'locked') {
      body = `<div class="bubble-text">${escapeHtml(m.decoded.text)}</div>`;
    } else if (m.decoded.type === 'sticker') {
      body = `<div class="sticker-message" aria-label="Sticker">${escapeHtml(m.decoded.sticker || '🙂')}</div>`;
    } else if (m.decoded.type === 'image') {
      const local = Boolean(m.localDocument);
      const canReceive = !local && !own;
      const hasRelay = Boolean(m.decoded.relay);
      const preview = typeof m.decoded.thumbnail === 'string' && m.decoded.thumbnail.startsWith('data:image/')
        ? `<img class="image-preview" src="${escapeHtml(m.decoded.thumbnail)}" alt="${escapeHtml(m.decoded.name || 'Ảnh')}" />`
        : '<div class="image-preview-placeholder">🖼</div>';
      body = `<div class="file-card image-card">
        ${preview}
        <div class="file-card-head image-meta">
          <div style="min-width:0">
            <div class="file-name">${escapeHtml(m.decoded.name || 'Ảnh')}</div>
            <div class="file-size">${escapeHtml(formatBytes(m.decoded.size))} · ${local ? 'lưu trên thiết bị' : (hasRelay ? 'relay mã hóa + P2P' : 'P2P trực tiếp')}</div>
          </div>
        </div>
        ${local ? `<div class="my-doc-file-actions">
          <button class="secondary-btn" data-my-doc-open="${escapeHtml(m.decoded.fileName)}" type="button">Mở</button>
          <button class="secondary-btn" data-my-doc-download="${escapeHtml(m.decoded.fileName)}" type="button">Tải bản sao</button>
        </div>` : (canReceive ? `<button class="secondary-btn" data-receive-file="${m.id}" type="button">${hasRelay ? 'Tải ảnh gốc' : 'Nhận ảnh gốc'}</button>` : `<div class="file-size" style="margin-top:8px">${hasRelay ? 'Người nhận có thể tải file mã hóa ngay cả khi bạn offline.' : 'Giữ Kalo mở để người nhận lấy ảnh gốc.'}</div>`)}
      </div>`;
    } else if (m.kind === 'file_offer' || m.decoded.type === 'file') {
      const local = Boolean(m.localDocument);
      const canReceive = !local && !own;
      const hasRelay = Boolean(m.decoded.relay);
      body = `<div class="file-card">
        <div class="file-card-head">
          <div class="file-icon">📎</div>
          <div style="min-width:0">
            <div class="file-name">${escapeHtml(m.decoded.name || 'File')}</div>
            <div class="file-size">${escapeHtml(formatBytes(m.decoded.size))} · ${local ? 'lưu trên thiết bị' : (hasRelay ? 'relay mã hóa + P2P' : 'P2P trực tiếp')}</div>
          </div>
        </div>
        ${local ? `<div class="my-doc-file-actions">
          <button class="secondary-btn" data-my-doc-open="${escapeHtml(m.decoded.fileName)}" type="button">Mở</button>
          <button class="secondary-btn" data-my-doc-download="${escapeHtml(m.decoded.fileName)}" type="button">Tải bản sao</button>
        </div>` : (canReceive ? `<button class="secondary-btn" data-receive-file="${m.id}" type="button">${hasRelay ? 'Tải file' : 'Nhận file'}</button>` : `<div class="file-size" style="margin-top:8px">${hasRelay ? 'Đã có bản relay mã hóa tạm thời.' : 'Giữ Kalo mở để người nhận tải file.'}</div>`)}
      </div>`;
    } else {
      body = `<div class="bubble-text">${escapeHtml(m.decoded.text || '')}</div>`;
    }

    const seen = own && !m.localDocument && state.currentReads.some((read) =>
      read.user_id !== state.user.id && new Date(read.read_at).getTime() >= new Date(m.created_at).getTime()
    );
    const timeBits = [
      formatTime(m.created_at),
      m.edited_at ? 'đã sửa' : '',
      own && !m.localDocument ? (seen ? 'Đã xem' : 'Đã gửi') : '',
    ].filter(Boolean).join(' · ');

    const actions = m.localDocument
      ? `<button class="my-doc-delete-btn" data-my-doc-remove="${m.id}" type="button" title="Xóa khỏi My Documents">🗑 Xóa khỏi My Documents</button>`
      : `${!deleted ? `<button class="mini-action" data-heart="${m.id}" type="button" title="Thả tim">${mine ? '❤️' : '♡'} ${hearts.length || ''}</button>
          <button class="mini-action" data-reply="${m.id}" type="button" title="Trả lời">↩</button>
          <button class="mini-action ${pinned ? 'active' : ''}" data-pin="${m.id}" type="button" title="${pinned ? 'Bỏ ghim' : 'Ghim'}">📌</button>
          <button class="mini-action" data-forward="${m.id}" type="button" title="Chuyển tiếp">↗</button>` : ''}
        ${own && !deleted && m.decoded?.type === 'text' ? `<button class="mini-action" data-edit="${m.id}" type="button" title="Sửa">✎</button>` : ''}
        ${own && !deleted ? `<button class="mini-action danger" data-delete-message="${m.id}" type="button" title="Xóa">🗑</button>` : ''}`;

    return `<div class="msg-row ${own ? 'own' : 'other'}" data-message-id="${m.id}">
      ${own ? '' : `<div class="msg-avatar ${safeAvatarUrl(sender?.avatar_url) ? 'has-image avatar-clickable' : ''}" data-avatar-user="${escapeHtml(m.sender_id)}" ${safeAvatarUrl(sender?.avatar_url) ? 'title="Bấm để xem ảnh đại diện"' : ''}>${avatarContent(sender, profileName(m.sender_id))}</div>`}
      <div class="msg-content">
        ${own ? '' : `<div class="msg-sender">${escapeHtml(profileName(m.sender_id))}</div>`}
        <div class="bubble ${pinned ? 'pinned' : ''}">
          ${forwardedHtml}
          ${replyHtml}
          ${body}
          <div class="bubble-time">${escapeHtml(timeBits)}</div>
        </div>
        <div class="msg-actions">${actions}</div>
      </div>
    </div>`;
  }).join('');

  $('[data-heart]', list).forEach((btn) => btn.addEventListener('click', () => toggleHeart(btn.dataset.heart)));
  $('[data-reply]', list).forEach((btn) => btn.addEventListener('click', () => startReply(btn.dataset.reply)));
  $('[data-edit]', list).forEach((btn) => btn.addEventListener('click', () => editMessage(btn.dataset.edit).catch((e) => toast(e.message || 'Không sửa được tin.', 'error'))));
  $('[data-delete-message]', list).forEach((btn) => btn.addEventListener('click', () => deleteMessage(btn.dataset.deleteMessage).catch((e) => toast(e.message || 'Không xóa được tin.', 'error'))));
  $('[data-pin]', list).forEach((btn) => btn.addEventListener('click', () => toggleMessagePin(btn.dataset.pin).catch((e) => toast(e.message || 'Không ghim được tin.', 'error'))));
  $('[data-forward]', list).forEach((btn) => btn.addEventListener('click', () => openForwardMessage(btn.dataset.forward)));
  $('[data-reply-jump]', list).forEach((btn) => btn.addEventListener('click', () => jumpToSearchMessage(btn.dataset.replyJump)));
  $('[data-receive-file]', list).forEach((btn) => btn.addEventListener('click', () => receiveFile(btn.dataset.receiveFile)));
  $('[data-my-doc-open]', list).forEach((btn) => btn.addEventListener('click', () => {
    state.documentsManager.open(btn.dataset.myDocOpen).catch((e) => toast(e.message || 'Không mở được file.', 'error'));
  }));
  $('[data-my-doc-download]', list).forEach((btn) => btn.addEventListener('click', () => {
    state.documentsManager.download(btn.dataset.myDocDownload).catch((e) => toast(e.message || 'Không tải được file.', 'error'));
  }));
  $('[data-my-doc-remove]', list).forEach((btn) => btn.addEventListener('click', () => {
    removeMyDocumentMessage(btn.dataset.myDocRemove).catch((e) => toast(e.message || 'Không xóa được nội dung.', 'error'));
  }));
  requestAnimationFrame(updateScrollToLatestButton);
}

async function openConversation(id) {
  state.currentConversationId = id;
  state.currentView = 'chats';
  clearReply();
  hide('#conversationCategoryMenu');
  closeMessageSearch(false);
  $$('.rail-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chats'));
  renderConversationList();
  renderChatHeader();
  hide('#documentsHome');
  hide('#emptyChat');
  show('#activeChat');
  $('#appScreen').classList.add('chat-open');
  const draft = getDraft(state.user?.id, id);
  const input = $('#messageInput');
  input.value = draft;
  input.style.height = 'auto';
  input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  await loadMessages(id);
}

async function createOrOpenDirect(userId) {
  if (!isFriend(userId)) {
    throw new Error('Bạn cần kết bạn trước khi nhắn tin.');
  }
  const existing = state.conversations.find((c) => {
    if (c.kind !== 'direct') return false;
    const ids = memberIds(c.id);
    return ids.length === 2 && ids.includes(state.user.id) && ids.includes(userId);
  });
  if (existing) {
    await openConversation(existing.id);
    return existing;
  }

  const id = crypto.randomUUID();
  const { error } = await supabase.from('kalo_conversations').insert({
    id,
    kind: 'direct',
    created_by: state.user.id,
  });
  if (error) throw error;

  const { error: memberError } = await supabase.from('kalo_conversation_members').insert([
    { conversation_id: id, user_id: state.user.id, role: 'owner' },
    { conversation_id: id, user_id: userId, role: 'member' },
  ]);
  if (memberError) throw memberError;
  await loadConversations();
  await openConversation(id);
  return state.conversations.find((c) => c.id === id);
}

async function acceptFriendRequest(friendshipId) {
  const { error } = await supabase
    .from('kalo_friendships')
    .update({ status: 'accepted', accepted_at: new Date().toISOString() })
    .eq('id', friendshipId);
  if (error) throw error;
  await loadFriendships();
  renderPeopleList();
  renderOnlineSummary();
  toast('Đã kết bạn.');
}

async function removeFriendship(friendshipId, message = 'Đã cập nhật.') {
  const { error } = await supabase.from('kalo_friendships').delete().eq('id', friendshipId);
  if (error) throw error;
  await loadFriendships();
  renderPeopleList();
  renderOnlineSummary();
  toast(message);
}

function normalizeFriendUsername(value) {
  let raw = String(value || '').trim();
  try {
    const url = new URL(raw);
    const fromQuery = url.searchParams.get('friend');
    if (fromQuery) raw = fromQuery;
  } catch {}
  raw = raw.replace(/^@/, '').trim().toLowerCase();
  if (raw.startsWith('kalo:friend:')) raw = raw.slice('kalo:friend:'.length);
  return raw.replace(/^@/, '').trim().toLowerCase();
}

async function sendFriendRequestByUsername(value) {
  const username = normalizeFriendUsername(value);
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new Error('ID Kalo không hợp lệ.');
  }
  const target = [...state.profiles.values()].find((p) => p.username === username);
  if (!target) throw new Error('Không tìm thấy ID Kalo này.');
  if (target.user_id === state.user.id) throw new Error('Đây là ID của bạn.');

  const existing = friendRowWith(target.user_id);
  if (existing?.status === 'accepted') {
    toast('Hai bạn đã là bạn bè.');
    return { status: 'accepted', target };
  }
  if (existing?.status === 'pending') {
    if (existing.addressee_id === state.user.id) {
      await acceptFriendRequest(existing.id);
      return { status: 'accepted', target };
    }
    toast('Lời mời đã được gửi trước đó.');
    return { status: 'pending', target };
  }

  const { error } = await supabase.from('kalo_friendships').insert({
    requester_id: state.user.id,
    addressee_id: target.user_id,
    status: 'pending',
  });
  if (error) throw error;
  await loadFriendships();
  renderPeopleList();
  renderOnlineSummary();
  toast(`Đã gửi lời mời kết bạn tới ${target.display_name}.`);
  return { status: 'pending', target };
}

function friendLink(username = state.profile?.username) {
  return `${location.origin}${location.pathname}?friend=${encodeURIComponent(username || '')}`;
}

function renderMyQr() {
  const root = $('#myQrCode');
  if (!root || !state.profile || !window.QRCode) return;
  root.innerHTML = '';
  new window.QRCode(root, {
    text: friendLink(state.profile.username),
    width: 220,
    height: 220,
    colorDark: '#173b2d',
    colorLight: '#ffffff',
    correctLevel: window.QRCode.CorrectLevel.M,
  });
  $('#myQrName').textContent = state.profile.display_name;
  $('#myQrId').textContent = `@${state.profile.username}`;
}

async function stopQrScanner() {
  if (!state.qrScanner) return;
  try {
    state.qrScanner.stop();
    state.qrScanner.destroy();
  } catch {}
  state.qrScanner = null;
  const video = $('#qrVideo');
  if (video) video.srcObject = null;
}

async function handleQrPayload(raw) {
  const username = normalizeFriendUsername(raw);
  if (!username) throw new Error('Mã QR này không phải mã kết bạn Kalo.');
  await stopQrScanner();
  $('#friendIdInput').value = username;
  await sendFriendRequestByUsername(username);
  hide('#addFriendModal');
  setView('people');
}

async function startQrScanner() {
  await stopQrScanner();
  const video = $('#qrVideo');
  const hint = $('#qrCameraHint');
  hint.textContent = 'Đang mở camera...';
  const hasCamera = await QrScanner.hasCamera();
  if (!hasCamera) throw new Error('Thiết bị không có camera khả dụng.');

  state.qrScanner = new QrScanner(
    video,
    (result) => {
      handleQrPayload(result.data).catch((e) => {
        toast(e.message || 'Không đọc được mã QR.', 'error');
        openAddFriendModal('scan');
      });
    },
    {
      preferredCamera: 'environment',
      highlightScanRegion: true,
      highlightCodeOutline: true,
      returnDetailedScanResult: true,
      maxScansPerSecond: 10,
    }
  );
  await state.qrScanner.start();
  hint.textContent = 'Đưa mã QR vào giữa khung.';
}

function switchFriendTab(tab) {
  $$('.friend-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.friendTab === tab));
  $$('[data-friend-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.friendPanel !== tab));
  if (tab !== 'scan') stopQrScanner();
  if (tab === 'mine') renderMyQr();
}

function openAddFriendModal(tab = 'scan') {
  switchFriendTab(tab);
  show('#addFriendModal');
  if (tab === 'id') setTimeout(() => $('#friendIdInput')?.focus(), 50);
}

function friendProfiles() {
  return [...acceptedFriendIds()]
    .map((id) => state.profiles.get(id))
    .filter(Boolean)
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'vi'));
}

function renderGroupFriendsPicker() {
  const q = ($('#groupPeopleSearch')?.value || '').trim().toLowerCase();
  const root = $('#groupFriendsPicker');
  const friends = friendProfiles()
    .filter((p) => !q || p.display_name.toLowerCase().includes(q) || p.username.includes(q));

  root.innerHTML = friends.map((p) => {
    const display = contactDisplayName(p.user_id);
    return `<div class="picker-row">
      <label>
        <input type="checkbox" data-pick-friend value="${p.user_id}" ${p.public_key ? '' : 'disabled'} />
        <div class="avatar ${safeAvatarUrl(p.avatar_url) ? 'has-image avatar-clickable' : ''}" data-avatar-user="${escapeHtml(p.user_id)}" ${safeAvatarUrl(p.avatar_url) ? 'title="Bấm để xem ảnh đại diện"' : ''}>${avatarContent(p, display)}</div>
        <span><strong>${escapeHtml(display)}</strong><br><small>@${escapeHtml(p.username)}${p.public_key ? '' : ' · cần mở Kalo trước'}</small></span>
      </label>
    </div>`;
  }).join('') || '<div class="contact-empty">Chưa có bạn bè phù hợp để thêm vào nhóm.</div>';
}

function openGroupModal() {
  const friends = friendProfiles();
  if (!friends.length) {
    toast('Bạn chưa có bạn bè. Hãy thêm bạn trước khi tạo nhóm.', 'error');
    setView('people');
    openAddFriendModal('scan');
    return;
  }
  $('#groupNameInput').value = '';
  $('#groupPeopleSearch').value = '';
  renderGroupFriendsPicker();
  show('#groupModal');
  setTimeout(() => $('#groupNameInput')?.focus(), 50);
}

async function createGroupFromPicker() {
  const selected = $$('[data-pick-friend]:checked', $('#groupFriendsPicker')).map((x) => x.value);
  const title = $('#groupNameInput').value.trim();
  if (!title) throw new Error('Vui lòng đặt tên nhóm.');
  if (!selected.length) throw new Error('Hãy chọn ít nhất một người bạn.');

  const notFriend = selected.find((id) => !isFriend(id));
  if (notFriend) throw new Error('Danh sách nhóm chỉ được chọn từ bạn bè.');

  const missingKey = selected.map((id) => state.profiles.get(id)).find((p) => !p?.public_key);
  if (missingKey) {
    throw new Error(`${missingKey.display_name} cần mở Kalo ít nhất một lần trước khi vào nhóm.`);
  }

  const id = crypto.randomUUID();
  const { error } = await supabase.from('kalo_conversations').insert({
    id,
    kind: 'group',
    title,
    created_by: state.user.id,
  });
  if (error) throw error;

  const rows = [
    { conversation_id: id, user_id: state.user.id, role: 'owner' },
    ...selected.map((userId) => ({ conversation_id: id, user_id: userId, role: 'member' })),
  ];
  const { error: memberError } = await supabase.from('kalo_conversation_members').insert(rows);
  if (memberError) throw memberError;

  hide('#groupModal');
  await loadConversations();
  await openConversation(id);
  toast('Đã tạo nhóm.');
}

function renderStickerGrid() {
  const root = $('#stickerGrid');
  if (!root) return;
  root.innerHTML = STICKERS.map((sticker) =>
    `<button class="sticker-choice" type="button" data-sticker="${escapeHtml(sticker)}" aria-label="Sticker ${escapeHtml(sticker)}">${escapeHtml(sticker)}</button>`
  ).join('');
  $$('[data-sticker]', root).forEach((btn) => btn.addEventListener('click', () => {
    sendSticker(btn.dataset.sticker).catch((e) => toast(e.message || 'Không gửi được sticker.', 'error'));
  }));
}

function messageActionText(message) {
  if (!message) return '';
  const d = message.decoded || {};
  if (message.deleted_at) return 'Tin nhắn đã xóa';
  if (d.type === 'text' || d.type === 'locked') return String(d.text || '');
  if (d.type === 'sticker') return String(d.sticker || 'Sticker');
  if (d.type === 'image') return d.name ? `Ảnh: ${d.name}` : 'Ảnh';
  if (d.type === 'file') return d.name ? `File: ${d.name}` : 'File';
  return 'Tin nhắn';
}

function clearReply() {
  state.replyingToId = null;
  hide('#replyComposerBar');
  $('#replyComposerText').textContent = '';
}

function startReply(messageId) {
  const message = state.messages.find((m) => m.id === messageId);
  if (!message || message.deleted_at) return;
  state.replyingToId = messageId;
  $('#replyComposerText').textContent = messageActionText(message).slice(0, 160);
  show('#replyComposerBar');
  $('#messageInput').focus();
}

function isMessagePinned(messageId) {
  return state.messagePins.some((x) => x.message_id === messageId);
}

async function toggleMessagePin(messageId) {
  const message = state.messages.find((m) => m.id === messageId);
  if (!message || !state.preferencesManager || !state.currentConversationId) return;
  if (isMessagePinned(messageId)) {
    await state.preferencesManager.unpinMessage(messageId);
    state.messagePins = state.messagePins.filter((x) => x.message_id !== messageId);
    toast('Đã bỏ ghim tin nhắn.');
  } else {
    await state.preferencesManager.pinMessage(state.currentConversationId, messageId);
    state.messagePins.unshift({
      conversation_id: state.currentConversationId,
      message_id: messageId,
      created_at: new Date().toISOString(),
    });
    toast('Đã ghim tin nhắn.');
  }
  renderMessages();
}

async function editMessage(messageId) {
  const message = state.messages.find((m) => m.id === messageId);
  if (!message || message.sender_id !== state.user.id || message.deleted_at || message.decoded?.type !== 'text') return;
  const next = window.prompt('Sửa tin nhắn', String(message.decoded.text || ''));
  if (next === null) return;
  const text = next.trim();
  if (!text) return;
  const profiles = memberProfiles(message.conversation_id);
  const envelope = await encryptPayload({
    ...message.decoded,
    type: 'text',
    text,
    editedAt: Date.now(),
  }, profiles);
  const { error } = await supabase.from('kalo_messages')
    .update({ encrypted_payloads: envelope, edited_at: new Date().toISOString() })
    .eq('id', messageId)
    .eq('sender_id', state.user.id);
  if (error) throw error;
  await loadMessages(message.conversation_id);
  await refreshPreviews();
  renderConversationList();
  toast('Đã sửa tin nhắn.');
}

async function deleteMessage(messageId) {
  const message = state.messages.find((m) => m.id === messageId);
  if (!message || message.sender_id !== state.user.id || message.deleted_at) return;
  if (!window.confirm('Xóa tin nhắn này?')) return;
  const { error } = await supabase.from('kalo_messages')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', messageId)
    .eq('sender_id', state.user.id);
  if (error) throw error;
  await loadMessages(message.conversation_id);
  await refreshPreviews();
  renderConversationList();
}

function renderPinnedMessages() {
  const root = $('#pinnedMessagesList');
  if (!root) return;
  const pins = state.messagePins.filter((x) => x.conversation_id === state.currentConversationId);
  root.innerHTML = pins.map((pin) => {
    const message = state.messages.find((m) => m.id === pin.message_id);
    const text = message ? messageActionText(message) : 'Tin cũ chưa được tải trong phiên hiện tại';
    return `<button class="pinned-message-item" type="button" data-pinned-jump="${pin.message_id}">
      <span>📌</span><div><strong>${escapeHtml(text.slice(0, 180))}</strong><small>${message ? escapeHtml(formatTime(message.created_at)) : 'Cuộn lên để tải tin cũ'}</small></div>
    </button>`;
  }).join('') || '<div class="category-empty">Chưa có tin nhắn nào được ghim.</div>';
  $('[data-pinned-jump]', root).forEach((btn) => btn.addEventListener('click', () => {
    hide('#pinnedMessagesModal');
    jumpToSearchMessage(btn.dataset.pinnedJump);
  }));
}

function openForwardMessage(messageId) {
  const message = state.messages.find((m) => m.id === messageId);
  if (!message || message.deleted_at) return;
  if (!['text','sticker'].includes(message.decoded?.type)) {
    toast('Hiện chuyển tiếp hỗ trợ tin chữ và sticker. File/ảnh có thể gửi lại trực tiếp.', 'error');
    return;
  }
  state.forwardingMessageId = messageId;
  $('#forwardConversationSearch').value = '';
  renderForwardConversationList();
  show('#forwardMessageModal');
}

function renderForwardConversationList() {
  const root = $('#forwardConversationList');
  if (!root) return;
  const q = ($('#forwardConversationSearch')?.value || '').trim().toLowerCase();
  const rows = state.conversations
    .filter((conv) => conv.id !== state.currentConversationId)
    .filter((conv) => !q || conversationLabel(conv).toLowerCase().includes(q));
  root.innerHTML = rows.map((conv) => `<button class="forward-conversation-item" type="button" data-forward-target="${conv.id}">
    <div class="avatar">${escapeHtml(initials(conversationLabel(conv)))}</div>
    <div><strong>${escapeHtml(conversationLabel(conv))}</strong><small>${conv.kind === 'group' ? 'Nhóm' : 'Trò chuyện riêng'}</small></div>
  </button>`).join('') || '<div class="category-empty">Không có cuộc trò chuyện phù hợp.</div>';
  $('[data-forward-target]', root).forEach((btn) => btn.addEventListener('click', () => {
    forwardMessageToConversation(state.forwardingMessageId, btn.dataset.forwardTarget).catch((e) => toast(e.message || 'Không chuyển tiếp được.', 'error'));
  }));
}

async function forwardMessageToConversation(messageId, conversationId) {
  const message = state.messages.find((m) => m.id === messageId);
  if (!message) return;
  const profiles = memberProfiles(conversationId);
  if (!profiles.length) throw new Error('Cuộc trò chuyện đích chưa sẵn sàng.');
  const payload = {
    ...message.decoded,
    forwarded: true,
    forwardedAt: Date.now(),
    originalSender: profileName(message.sender_id),
  };
  const envelope = await encryptPayload(payload, profiles);
  const { error } = await supabase.from('kalo_messages').insert({
    id: crypto.randomUUID(),
    conversation_id: conversationId,
    sender_id: state.user.id,
    kind: 'text',
    encrypted_payloads: envelope,
  });
  if (error) throw error;
  hide('#forwardMessageModal');
  state.forwardingMessageId = null;
  toast('Đã chuyển tiếp tin nhắn.');
  await refreshPreviews();
  renderConversationList();
}

async function sendSticker(sticker) {
  if (!sticker) return;
  if (state.currentView === 'documents') {
    await sendMyDocumentSticker(sticker);
    return;
  }
  if (!state.currentConversationId) return;
  const profiles = memberProfiles(state.currentConversationId);
  if (!profiles.length) return;
  const envelope = await encryptPayload({ type: 'sticker', sticker, createdAt: Date.now() }, profiles);
  const { error } = await supabase.from('kalo_messages').insert({
    id: crypto.randomUUID(),
    conversation_id: state.currentConversationId,
    sender_id: state.user.id,
    kind: 'text',
    encrypted_payloads: envelope,
    reply_to: state.replyingToId || null,
  });
  if (error) throw error;
  clearReply();
  hide('#stickerPanel');
  await loadMessages(state.currentConversationId);
  await refreshPreviews();
  renderConversationList();
}

async function makeImageThumbnail(file) {
  if (!file?.type?.startsWith('image/')) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const maxSide = 360;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', 0.58);
  } catch {
    return null;
  }
}

async function sendTransferFile(file, type = 'file') {
  if (!file || !state.currentConversationId) return;
  const profiles = memberProfiles(state.currentConversationId);
  if (!profiles.length) return;

  const transferId = crypto.randomUUID();
  const thumbnail = type === 'image' ? await makeImageThumbnail(file) : null;
  let relay = null;
  if (file.size <= SMALL_FILE_RELAY_LIMIT) {
    relay = await uploadEncryptedRelay(supabase, state.currentConversationId, state.user.id, file).catch((error) => {
      console.warn('Kalo encrypted relay upload failed; using P2P only', error);
      return null;
    });
  }
  const envelope = await encryptPayload({
    type,
    transferId,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    thumbnail,
    relay,
    createdAt: Date.now(),
  }, profiles);

  state.fileManager.registerOutgoing(transferId, file);
  const { error } = await supabase.from('kalo_messages').insert({
    id: crypto.randomUUID(),
    conversation_id: state.currentConversationId,
    sender_id: state.user.id,
    kind: 'file_offer',
    encrypted_payloads: envelope,
    reply_to: state.replyingToId || null,
  });
  if (error) throw error;
  clearReply();

  toast(relay
    ? 'Đã gửi file kèm bản relay mã hóa tạm thời; người nhận có thể tải ngay cả khi bạn offline.'
    : (type === 'image'
      ? 'Đã gửi ảnh xem trước. Hãy giữ Kalo mở để người nhận lấy ảnh gốc.'
      : 'Đã gửi lời mời nhận file. Hãy giữ Kalo mở cho tới khi truyền xong.'));
  await loadMessages(state.currentConversationId);
  await refreshPreviews();
  renderConversationList();
}

async function sendMessage() {
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text) return;
  if (state.currentView === 'documents') {
    try {
      await sendMyDocumentText(text);
      input.value = '';
      input.style.height = '';
    } catch (e) {
      toast(e.message || 'Không lưu được tin nhắn.', 'error');
    }
    return;
  }
  if (!state.currentConversationId) return;
  const profiles = memberProfiles(state.currentConversationId);
  if (!profiles.length) return;

  const button = $('#sendBtn');
  setBusy(button, true, '...');
  try {
    const envelope = await encryptPayload({ type: 'text', text, createdAt: Date.now() }, profiles);
    const { error } = await supabase.from('kalo_messages').insert({
      id: crypto.randomUUID(),
      conversation_id: state.currentConversationId,
      sender_id: state.user.id,
      kind: 'text',
      encrypted_payloads: envelope,
      reply_to: state.replyingToId || null,
    });
    if (error) throw error;
    input.value = '';
    input.style.height = '';
    clearDraft(state.user.id, state.currentConversationId);
    clearReply();
    await loadMessages(state.currentConversationId);
    await refreshPreviews();
    renderConversationList();
  } catch (e) {
    toast(e.message || 'Không gửi được tin nhắn.', 'error');
  } finally {
    setBusy(button, false);
  }
}

async function sendFile(file) {
  try {
    if (state.currentView === 'documents') await sendMyDocumentFile(file, 'file');
    else await sendTransferFile(file, 'file');
  } catch (e) {
    toast(e.message || 'Không thể gửi file.', 'error');
  }
}

async function sendImage(file) {
  try {
    if (state.currentView === 'documents') await sendMyDocumentFile(file, 'image');
    else await sendTransferFile(file, 'image');
  } catch (e) {
    toast(e.message || 'Không thể gửi ảnh.', 'error');
  }
}

async function receiveFile(messageId) {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return;
  try {
    if (msg.decoded?.relay) {
      const file = await downloadEncryptedRelay(supabase, msg.decoded.relay, {
        name: msg.decoded.name,
        mime: msg.decoded.mime,
      });
      if (state.documentsManager) {
        const saved = await state.documentsManager.saveFile(file);
        await appendMyDocumentItem({
          id: crypto.randomUUID(),
          type: msg.decoded.type === 'image' ? 'image' : 'file',
          fileName: saved,
          name: saved,
          size: file.size,
          mime: file.type,
          thumbnail: msg.decoded.thumbnail || null,
          created_at: new Date().toISOString(),
        });
        await refreshStorageUi();
        toast('Đã tải file mã hóa và lưu vào My Documents.');
        return;
      }
    }
    if (!msg.decoded?.transferId) throw new Error('File không còn bản tải khả dụng.');
    await state.fileManager.requestReceive(
      msg.decoded.transferId,
      msg.sender_id,
      {
        name: msg.decoded.name,
        size: msg.decoded.size,
        type: msg.decoded.mime,
      }
    );
  } catch (e) {
    toast(e.message || 'Không thể chuẩn bị nhận file.', 'error');
  }
}

async function toggleHeart(messageId) {
  const rows = state.reactions.get(messageId) || [];
  const mine = rows.find((r) => r.user_id === state.user.id && r.emoji === '❤️');
  if (mine) {
    await supabase.from('kalo_reactions').delete()
      .eq('message_id', messageId)
      .eq('user_id', state.user.id)
      .eq('emoji', '❤️');
  } else {
    await supabase.from('kalo_reactions').insert({
      message_id: messageId,
      user_id: state.user.id,
      emoji: '❤️',
    });
  }
  await loadReactions();
}

function setView(view) {
  state.currentView = view;
  $$('.rail-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const search = $('#conversationSearch');
  hide('#conversationList');
  hide('#peopleList');
  hide('#documentsList');
  hide('#addFriendBtn');
  hide('#createGroupBtn');
  hide('#categoryFilterWrap');
  hide('#categoryFilterMenu');
  hide('#conversationCategoryMenu');

  if (view === 'documents') {
    $('#leftPaneTitle').textContent = 'My Documents';
    $('#onlineSummary').textContent = 'Chat với chính bạn · lưu cục bộ';
    search.placeholder = 'My Documents';
    search.value = '';
    show('#documentsList');
    hide('#documentsHome');
    hide('#emptyChat');
    show('#activeChat');
    renderMyDocumentsHeader();
    openMyDocumentsChat().catch((e) => toast(e.message || 'Không mở được My Documents.', 'error'));
    refreshStorageUi().catch(console.error);
    return;
  }

  hide('#documentsHome');
  closeMessageSearch(false);
  if (state.currentConversationId) {
    show('#activeChat');
    hide('#emptyChat');
  } else {
    hide('#activeChat');
    show('#emptyChat');
  }

  if (view === 'people') {
    $('#leftPaneTitle').textContent = 'Bạn bè';
    search.placeholder = 'Tìm bạn bè...';
    show('#addFriendBtn');
    show('#peopleList');
    renderPeopleList();
  } else {
    $('#leftPaneTitle').textContent = 'Tin nhắn';
    search.placeholder = 'Tìm cuộc trò chuyện...';
    show('#createGroupBtn');
    show('#categoryFilterWrap');
    renderCategoryFilterMenu();
    show('#conversationList');
    renderConversationList();
  }
  renderOnlineSummary();
}

function messageSearchTextOf(message) {
  const d = message?.decoded || {};
  if (d.type === 'text' || d.type === 'locked') return String(d.text || '');
  if (d.type === 'sticker') return String(d.sticker || '');
  if (d.type === 'image' || d.type === 'file') return String(d.name || d.fileName || '');
  return '';
}

function localDateKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchConversationMessagesForSearch(dateValue = '') {
  if (!state.currentConversationId || !state.identity) return [];
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  let pages = 0;
  let startIso = '';
  let endIso = '';
  if (dateValue) {
    const start = new Date(`${dateValue}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    startIso = start.toISOString();
    endIso = end.toISOString();
  }

  while (pages < 10) {
    let query = supabase
      .from('kalo_messages')
      .select('*')
      .eq('conversation_id', state.currentConversationId)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (startIso) query = query.gte('created_at', startIso).lt('created_at', endIso);
    const { data, error } = await query;
    if (error) throw error;
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
    pages += 1;
  }

  const decoded = [];
  for (const row of rows) {
    let payload;
    try {
      payload = await decryptPayload(row.encrypted_payloads, state.user.id, state.identity);
    } catch {
      payload = { type: 'locked', text: 'Không mở được tin nhắn này trên thiết bị hiện tại.' };
    }
    decoded.push({ ...row, decoded: payload });
  }
  return decoded;
}

function renderMessageSearchResults(matches = null) {
  const root = $('#messageSearchResults');
  const summary = $('#messageSearchSummary');
  if (!root || !summary || $('#messageSearchPanel').classList.contains('hidden')) return;
  const textQuery = ($('#messageSearchText')?.value || '').trim().toLowerCase();
  const dateValue = $('#messageSearchDate')?.value || '';
  const source = matches || state.messageSearchCache || [];
  if (!textQuery && !dateValue) {
    summary.textContent = 'Nhập từ khóa hoặc chọn ngày.';
    root.innerHTML = '';
    return;
  }
  const filtered = source.filter((m) => {
    const textOk = !textQuery || messageSearchTextOf(m).toLowerCase().includes(textQuery);
    const dateOk = !dateValue || localDateKey(m.created_at) === dateValue;
    return textOk && dateOk;
  });
  summary.textContent = filtered.length
    ? `Tìm thấy ${filtered.length} kết quả${filtered.length >= 10000 ? ' (đã giới hạn 10.000 tin)' : ''}.`
    : 'Không tìm thấy kết quả phù hợp.';
  root.innerHTML = filtered.slice().reverse().map((m) => {
    const text = messageSearchTextOf(m) || (m.decoded?.type === 'sticker' ? 'Sticker' : 'Nội dung');
    return `<button class="message-search-result" type="button" data-search-message-id="${m.id}">
      <strong>${escapeHtml(text)}</strong>
      <small>${escapeHtml(new Date(m.created_at).toLocaleString('vi-VN'))}</small>
    </button>`;
  }).join('') || '<div class="message-search-empty">Không có tin nhắn phù hợp.</div>';
  $$('[data-search-message-id]', root).forEach((btn) => btn.addEventListener('click', () => jumpToSearchMessage(btn.dataset.searchMessageId)));
}

async function runMessageSearch() {
  const seq = ++state.messageSearchSeq;
  const textQuery = ($('#messageSearchText')?.value || '').trim();
  const dateValue = $('#messageSearchDate')?.value || '';
  if (!textQuery && !dateValue) {
    state.messageSearchCache = state.currentView === 'documents' ? [...state.myDocumentMessages] : [];
    renderMessageSearchResults();
    return;
  }
  $('#messageSearchSummary').textContent = 'Đang tìm...';
  try {
    const source = state.currentView === 'documents'
      ? [...state.myDocumentMessages]
      : await fetchConversationMessagesForSearch(dateValue);
    if (seq !== state.messageSearchSeq) return;
    state.messageSearchCache = source;
    renderMessageSearchResults(source);
  } catch (e) {
    if (seq !== state.messageSearchSeq) return;
    $('#messageSearchSummary').textContent = 'Không tìm được tin nhắn.';
    $('#messageSearchResults').innerHTML = '';
    toast(e.message || 'Không tìm được tin nhắn.', 'error');
  }
}

function jumpToSearchMessage(messageId) {
  const source = state.currentView === 'documents' ? state.myDocumentMessages : state.messageSearchCache;
  const found = source.find((m) => m.id === messageId);
  if (!found) return;
  if (!state.messages.some((m) => m.id === messageId)) {
    state.messages = [...source];
    renderMessages();
  }
  const row = $('[data-message-id]', $('#messageList')).find((el) => el.dataset.messageId === messageId);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('search-hit');
  setTimeout(() => row.classList.remove('search-hit'), 1800);
}

function openMessageSearch() {
  if ($('#activeChat').classList.contains('hidden')) return;
  show('#messageSearchPanel');
  state.messageSearchCache = state.currentView === 'documents' ? [...state.myDocumentMessages] : [];
  $('#messageSearchText').focus();
  runMessageSearch().catch(console.error);
}

function closeMessageSearch(clear = false) {
  hide('#messageSearchPanel');
  state.messageSearchSeq += 1;
  state.messageSearchCache = [];
  if (clear) {
    if ($('#messageSearchText')) $('#messageSearchText').value = '';
    if ($('#messageSearchDate')) $('#messageSearchDate').value = '';
    if ($('#messageSearchResults')) $('#messageSearchResults').innerHTML = '';
  }
}

function applyPrivacy(value) {
  const enabled = Boolean(value);
  document.body.classList.toggle('privacy-mode', enabled);
  localStorage.setItem('kalo-privacy', enabled ? '1' : '0');
  $('#privacyToggle').checked = enabled;
  const privacyBtn = $('#privacyBtn');
  privacyBtn.classList.toggle('active', enabled);
  privacyBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  privacyBtn.title = enabled ? 'Bỏ che tin nhắn (Alt+.)' : 'Che tin nhắn (Alt+.)';
}

function showRecoveryCode(code) {
  return new Promise((resolve) => {
    $('#recoveryCodeValue').textContent = code;
    show('#recoveryCodeModal');
    const done = () => {
      hide('#recoveryCodeModal');
      $('#recoveryCodeDone').removeEventListener('click', done);
      resolve();
    };
    $('#recoveryCodeDone').addEventListener('click', done);
  });
}

async function startApp(session) {
  if (!session?.user) return;
  if (state.starting) return;
  if (state.startedUserId === session.user.id && state.identity) return;
  state.starting = true;

  try {
    state.session = session;
    state.user = session.user;
    state.profile = await getProfile(session.user.id);
    await migrateLegacyAvatarIfNeeded();
    loadConversationCategories();
    loadContactAliases();
    await hydrateSyncedPreferences();
    state.identity = await ensureUserIdentity(state.pendingRecoveryCode);
    state.pendingRecoveryCode = null;
    state.messageService = new KaloMessageService(supabase, state.user.id, state.identity, 100);

    await loadProfiles();
    await initLocalDocuments();
    await Promise.all([loadFriendships(), loadConversations()]);
    await refreshUnreadCounts();
    cleanupExpiredRelays(supabase, state.user.id).catch(() => {});
    await startRealtime();

    hide('#authScreen');
    show('#appScreen');
    $('#settingsAccount').textContent = `@${state.profile.username}`;
    $('#displayNameInput').value = state.profile.display_name;
    updateProfileAvatarPreview();
    updateSelfAvatar();
    applyPrivacy(localStorage.getItem('kalo-privacy') === '1');
    setView('chats');
    renderOnlineSummary();
    state.startedUserId = session.user.id;
    const friendParam = new URLSearchParams(location.search).get('friend');
    if (friendParam && normalizeFriendUsername(friendParam) !== state.profile.username) {
      setView('people');
      $('#friendIdInput').value = normalizeFriendUsername(friendParam);
      openAddFriendModal('id');
      history.replaceState({}, '', location.pathname);
    }
    window.parent?.postMessage?.({ source: 'kalo', type: 'ready' }, '*');
  } catch (e) {
    console.error(e);
    setAuthMessage(e.message || 'Không thể mở Kalo.', true);
    show('#authScreen');
    hide('#appScreen');
  } finally {
    state.starting = false;
  }
}

function returnToKanban() {
  if (window.parent !== window) {
    window.parent.postMessage({ source: 'kalo', type: 'close' }, '*');
    return;
  }
  const target = location.hostname.endsWith('github.io')
    ? `${location.origin}/Kanban-QLCV-Linh/`
    : 'https://lamhoailinh.github.io/Kanban-QLCV-Linh/';
  location.href = target;
}

async function logout() {
  await stopRealtime();
  await supabase.auth.signOut();
  state.session = null;
  state.user = null;
  state.profile = null;
  state.identity = null;
  state.startedUserId = null;
  state.profiles.clear();
  state.friendships = [];
  state.conversations = [];
  state.members.clear();
  state.messages = [];
  state.documentsManager = null;
  state.documentItems = [];
  state.selectedDocumentName = null;
  state.conversationCategories = [];
  state.conversationCategoryMap = {};
  state.activeCategoryFilter = 'all';
  state.categoryMenuConversationId = null;
  state.contactAliases = {};
  state.preferencesManager = null;
  state.messageService = null;
  state.conversationPrefs = {};
  state.unreadCounts = new Map();
  state.currentReads = [];
  state.messagePins = [];
  state.replyingToId = null;
  state.avatarPendingDataUrl = '';
  closeAvatarCropSource();
  clearCallUi();
  hide('#settingsModal');
  hide('#appScreen');
  show('#authScreen');
  switchAuthTab('login');
}

function showEmailPasswordRecoveryDialog() {
  const wrapper = document.createElement('div');
  wrapper.className = 'modal-backdrop';
  wrapper.innerHTML = `<section class="modal-card">
    <header><div><h3>Tạo mật khẩu mới</h3><p>Email khôi phục đã được xác nhận.</p></div></header>
    <div class="stack">
      <label>Mật khẩu mới<input data-p1 type="password" minlength="8" /></label>
      <label>Nhập lại<input data-p2 type="password" minlength="8" /></label>
      <div data-error class="error-text"></div>
      <button data-save class="primary-btn" type="button">Lưu mật khẩu mới</button>
    </div>
  </section>`;
  document.body.appendChild(wrapper);
  const p1 = $('[data-p1]', wrapper);
  const p2 = $('[data-p2]', wrapper);
  p1.focus();
  $('[data-save]', wrapper).addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const error = $('[data-error]', wrapper);
    if (p1.value.length < 8 || p1.value !== p2.value) {
      error.textContent = 'Mật khẩu cần từ 8 ký tự và hai ô phải giống nhau.';
      return;
    }
    setBusy(btn, true);
    const { error: updateError } = await supabase.auth.updateUser({ password: p1.value });
    setBusy(btn, false);
    if (updateError) {
      error.textContent = updateError.message;
      return;
    }
    wrapper.remove();
    toast('Đã tạo mật khẩu mới.');
    history.replaceState({}, '', location.pathname);
  });
}

async function initAuth() {
  initRememberLoginPreference();
  $$('.auth-tab').forEach((btn) => btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab)));

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    setBusy(button, true);
    setAuthMessage('');
    try {
      applyRememberLoginPreference();
      const data = await invokeAuth('login', {
        identifier: $('#loginId').value,
        password: $('#loginPassword').value,
      });
      await setSessionFromResponse(data.session);
      const { data: sessionData } = await supabase.auth.getSession();
      await startApp(sessionData.session);
    } catch (e) {
      setAuthMessage(e.message, true);
    } finally {
      setBusy(button, false);
    }
  });

  $('#registerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    const password = $('#registerPassword').value;
    if (password !== $('#registerPassword2').value) {
      setAuthMessage('Hai ô mật khẩu chưa giống nhau.', true);
      return;
    }
    setBusy(button, true);
    setAuthMessage('');
    try {
      applyRememberLoginPreference();
      const data = await invokeAuth('register', {
        username: $('#registerId').value,
        displayName: $('#registerName').value,
        password,
        email: $('#registerEmail').value,
      });
      state.pendingRecoveryCode = data.recoveryCode;
      if (data.session) {
        await setSessionFromResponse(data.session);
        const { data: sessionData } = await supabase.auth.getSession();
        await startApp(sessionData.session);
        await showRecoveryCode(data.recoveryCode);
      } else {
        await showRecoveryCode(data.recoveryCode);
        switchAuthTab('login');
        setAuthMessage('Tạo tài khoản thành công. Hãy đăng nhập.');
      }
    } catch (e) {
      setAuthMessage(e.message, true);
    } finally {
      setBusy(button, false);
    }
  });

  $('#codeResetForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    setBusy(button, true);
    setAuthMessage('');
    try {
      const data = await invokeAuth('reset_with_code', {
        identifier: $('#resetId').value,
        recoveryCode: $('#resetCode').value,
        newPassword: $('#resetPassword').value,
      });
      setAuthMessage(data.message || 'Đã tạo mật khẩu mới.');
      $('#loginId').value = $('#resetId').value;
      switchAuthTab('login');
    } catch (e) {
      setAuthMessage(e.message, true);
    } finally {
      setBusy(button, false);
    }
  });

  $('#emailResetForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    setBusy(button, true);
    setAuthMessage('');
    try {
      const data = await invokeAuth('request_email_reset', {
        identifier: $('#emailResetId').value,
      });
      setAuthMessage(data.message || 'Nếu tài khoản có email, Kalo sẽ gửi hướng dẫn.');
    } catch (e) {
      setAuthMessage(e.message, true);
    } finally {
      setBusy(button, false);
    }
  });

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      setTimeout(showEmailPasswordRecoveryDialog, 50);
      return;
    }
    if (event === 'SIGNED_OUT') return;
    if (session?.user && !state.starting && state.startedUserId !== session.user.id) {
      setTimeout(() => startApp(session), 0);
    }
  });

  const { data } = await supabase.auth.getSession();
  if (data.session) {
    await startApp(data.session);
    if (new URLSearchParams(location.search).get('recovery') === '1') {
      setTimeout(showEmailPasswordRecoveryDialog, 80);
    }
  }
}

function bindAppEvents() {
  $$('.rail-btn[data-view]').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $('#categoryFilterBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleCategoryFilterMenu();
  });
  $('#categoryCreateForm').addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      createConversationCategory($('#categoryCreateName').value, $('#categoryCreateColor').value);
      $('#categoryCreateName').value = '';
      $('#categoryCreateName').focus();
    } catch (e) {
      toast(e.message || 'Không tạo được phân loại.', 'error');
    }
  });
  $('#conversationSearch').addEventListener('input', () => {
    if (state.currentView === 'people') renderPeopleList();
    else if (state.currentView === 'documents') renderDocumentsList();
    else renderConversationList();
  });

  $('#addFriendBtn').addEventListener('click', () => openAddFriendModal('scan'));
  $('#createGroupBtn').addEventListener('click', openGroupModal);
  $('#groupPeopleSearch').addEventListener('input', renderGroupFriendsPicker);
  $('#createGroupSubmitBtn').addEventListener('click', () => {
    createGroupFromPicker().catch((e) => toast(e.message, 'error'));
  });

  $$('.friend-tab').forEach((btn) => btn.addEventListener('click', () => switchFriendTab(btn.dataset.friendTab)));
  $('#startQrBtn').addEventListener('click', async () => {
    const button = $('#startQrBtn');
    setBusy(button, true, 'Đang mở...');
    try {
      await startQrScanner();
    } catch (e) {
      toast(e.message || 'Không mở được camera.', 'error');
    } finally {
      setBusy(button, false);
    }
  });
  $('#qrImageInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
      await handleQrPayload(result.data);
    } catch (e) {
      toast('Không đọc được mã QR trong ảnh này.', 'error');
    }
  });
  $('#addFriendIdForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    setBusy(button, true);
    try {
      await sendFriendRequestByUsername($('#friendIdInput').value);
      hide('#addFriendModal');
      setView('people');
    } catch (e) {
      toast(e.message || 'Không thêm được bạn.', 'error');
    } finally {
      setBusy(button, false);
    }
  });
  $('#shareQrBtn').addEventListener('click', async () => {
    const url = friendLink();
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Kết bạn Kalo', text: `Kết bạn với ${state.profile.display_name} trên Kalo`, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast('Đã sao chép liên kết kết bạn.');
      }
    } catch {}
  });

  $$('[data-close-modal]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.dataset.closeModal;
    if (id === 'addFriendModal') stopQrScanner();
    hide(`#${id}`);
  }));
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#categoryFilterWrap')) hide('#categoryFilterMenu');
    if (!event.target.closest('#conversationCategoryMenu') && !event.target.closest('[data-classify-conv]')) hide('#conversationCategoryMenu');
  });

  $('#sendBtn').addEventListener('click', sendMessage);
  $('#messageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  $('#messageInput').addEventListener('input', (event) => {
    event.currentTarget.style.height = 'auto';
    event.currentTarget.style.height = `${Math.min(120, event.currentTarget.scrollHeight)}px`;
    if (state.currentView === 'chats' && state.currentConversationId) {
      setDraft(state.user?.id, state.currentConversationId, event.currentTarget.value);
      renderConversationList();
    }
  });
  $('#messageInput').addEventListener('paste', async (event) => {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) {
      if (file.type?.startsWith('image/')) await sendImage(file);
      else await sendFile(file);
    }
  });

  let messageSearchTimer = null;
  $('#messageSearchBtn').addEventListener('click', () => {
    if ($('#messageSearchPanel').classList.contains('hidden')) openMessageSearch();
    else closeMessageSearch(false);
  });
  $('#messageSearchClose').addEventListener('click', () => closeMessageSearch(false));
  $('#messageSearchClear').addEventListener('click', () => {
    $('#messageSearchText').value = '';
    $('#messageSearchDate').value = '';
    runMessageSearch().catch(console.error);
  });
  $('#messageSearchText').addEventListener('input', () => {
    clearTimeout(messageSearchTimer);
    messageSearchTimer = setTimeout(() => runMessageSearch().catch(console.error), 260);
  });
  $('#messageSearchDate').addEventListener('change', () => runMessageSearch().catch(console.error));

  const messageList = $('#messageList');
  messageList.addEventListener('scroll', () => {
    updateScrollToLatestButton();
    if (messageList.scrollTop < 90 && state.currentView === 'chats') {
      loadOlderMessages().catch(console.error);
    }
  }, { passive: true });
  $('#scrollToLatestBtn').addEventListener('click', () => scrollMessagesToLatest({ smooth: true }));
  $('#cancelReplyBtn').addEventListener('click', clearReply);
  $('#pinnedMessagesBtn').addEventListener('click', () => {
    renderPinnedMessages();
    show('#pinnedMessagesModal');
  });
  $('#forwardConversationSearch').addEventListener('input', renderForwardConversationList);
  window.addEventListener('resize', updateScrollToLatestButton);

  renderStickerGrid();
  $('#stickerBtn').addEventListener('click', () => {
    $('#stickerPanel').classList.toggle('hidden');
  });
  $('#closeStickerBtn').addEventListener('click', () => hide('#stickerPanel'));

  $('#imageBtn').addEventListener('click', () => $('#imageInput').click());
  $('#imageInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await sendImage(file);
  });

  $('#fileBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await sendFile(file);
  });

  $('#addDocumentBtn').addEventListener('click', () => $('#documentInput').click());
  $('#documentInput').addEventListener('change', async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (!files.length) return;
    try { await addDocuments(files); }
    catch (e) { toast(e.message || 'Không thêm được file.', 'error'); }
  });
  $('#documentsChangeFolderBtn').addEventListener('click', chooseStorageFolder);
  $('#changeStorageBtn').addEventListener('click', chooseStorageFolder);

  $('#audioCallBtn').addEventListener('click', () => startCurrentCall('audio'));
  $('#videoCallBtn').addEventListener('click', () => startCurrentCall('video'));
  $('#acceptCallBtn').addEventListener('click', async () => {
    const incoming = state.incomingCall;
    if (!incoming) return;
    try {
      const session = await state.callManager.accept(incoming.callId);
      state.incomingCall = null;
      hide('#incomingCallModal');
      updateCallUi(session, 'Đang kết nối...');
    } catch (e) {
      toast(e.message || 'Không trả lời được cuộc gọi.', 'error');
    }
  });
  $('#rejectCallBtn').addEventListener('click', async () => {
    const incoming = state.incomingCall;
    if (!incoming) return;
    await state.callManager.reject(incoming.callId);
    clearCallUi();
  });
  $('#hangupCallBtn').addEventListener('click', async () => {
    if (state.activeCall) await state.callManager.hangup(state.activeCall);
    clearCallUi();
  });
  $('#muteCallBtn').addEventListener('click', () => {
    if (state.activeCall) state.callManager.toggleMute(state.activeCall);
  });
  $('#cameraCallBtn').addEventListener('click', () => {
    if (state.activeCall) state.callManager.toggleCamera(state.activeCall);
  });

  $('#returnKanbanBtn').addEventListener('click', returnToKanban);
  $('#quickLogoutBtn').addEventListener('click', logout);

  $('#privacyBtn').addEventListener('click', () => applyPrivacy(!document.body.classList.contains('privacy-mode')));
  $('#privacyToggle').addEventListener('change', (event) => applyPrivacy(event.target.checked));

  $('#selfAvatarBtn').addEventListener('click', (event) => {
    event.preventDefault();
    openAvatarViewer(state.user?.id);
  });

  document.addEventListener('click', (event) => {
    const avatar = event.target.closest('[data-avatar-user].avatar-clickable');
    if (!avatar) return;
    if (avatar.closest('#selfAvatarBtn')) return;
    event.preventDefault();
    event.stopPropagation();
    openAvatarViewer(avatar.dataset.avatarUser);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    const avatar = event.target.closest?.('[data-avatar-user].avatar-clickable');
    if (!avatar || avatar.closest('#selfAvatarBtn')) return;
    event.preventDefault();
    openAvatarViewer(avatar.dataset.avatarUser);
  });

  $('#closeAvatarViewerBtn').addEventListener('click', closeAvatarViewer);
  $('#avatarViewerModal').addEventListener('click', (event) => {
    if (event.target === $('#avatarViewerModal')) closeAvatarViewer();
  });
  $('#avatarViewerModal').addEventListener('wheel', (event) => {
    if ($('#avatarViewerModal').classList.contains('hidden')) return;
    event.preventDefault();
    const step = event.deltaY < 0 ? 0.12 : -0.12;
    applyAvatarViewerZoom(state.avatarViewerZoom + step);
  }, { passive: false });
  $('#avatarViewerImage').addEventListener('dblclick', (event) => {
    event.preventDefault();
    applyAvatarViewerZoom(1);
  });

  $('#settingsBtn').addEventListener('click', () => {
    $('#settingsAccount').textContent = `@${state.profile?.username || ''}`;
    $('#displayNameInput').value = state.profile?.display_name || '';
    updateProfileAvatarPreview();
    $('#privacyToggle').checked = document.body.classList.contains('privacy-mode');
    const turn = loadTurnConfig();
    $('#turnUrlInput').value = turn?.url || '';
    $('#turnUsernameInput').value = turn?.username || '';
    $('#turnCredentialInput').value = turn?.credential || '';
    refreshStorageUi().catch(console.error);
    show('#settingsModal');
  });

  $('#chooseAvatarBtn').addEventListener('click', () => $('#avatarInput').click());
  $('#avatarInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const button = $('#chooseAvatarBtn');
    setBusy(button, true, 'Đang mở...');
    try {
      await openAvatarCrop(file);
    } catch (e) {
      toast(e.message || 'Không mở được ảnh để crop.', 'error');
    } finally {
      setBusy(button, false);
    }
  });
  $('#cropAvatarBtn').addEventListener('click', async () => {
    const button = $('#cropAvatarBtn');
    setBusy(button, true, 'Đang mở...');
    try {
      if (state.avatarCrop?.bitmap) {
        await openAvatarCrop('', { replaceSource: false });
      } else {
        const source = state.avatarPendingDataUrl || safeAvatarUrl(state.profile?.avatar_url);
        if (!source) throw new Error('Hãy chọn ảnh trước.');
        await openAvatarCrop(source);
      }
    } catch (e) {
      toast(e.message || 'Không mở được trình crop.', 'error');
    } finally {
      setBusy(button, false);
    }
  });
  $('#saveAvatarBtn').addEventListener('click', async () => {
    if (!state.avatarPendingDataUrl) return;
    const button = $('#saveAvatarBtn');
    setBusy(button, true, 'Đang lưu...');
    try {
      await saveOwnAvatar(state.avatarPendingDataUrl);
      toast('Đã lưu Avatar.');
    } catch (e) {
      toast(e.message || 'Không lưu được Avatar.', 'error');
    } finally {
      setBusy(button, false);
    }
  });
  $('#removeAvatarBtn').addEventListener('click', async () => {
    if (!state.avatarPendingDataUrl && !safeAvatarUrl(state.profile?.avatar_url)) return;
    const button = $('#removeAvatarBtn');
    setBusy(button, true, '...');
    try {
      state.avatarPendingDataUrl = '';
      await saveOwnAvatar('');
      toast('Đã xóa ảnh đại diện.');
    } catch (e) {
      toast(e.message || 'Không xóa được ảnh đại diện.', 'error');
    } finally {
      setBusy(button, false);
    }
  });

  $('#avatarZoomRange').addEventListener('input', (event) => {
    const crop = state.avatarCrop;
    if (!crop) return;
    crop.scale = crop.minScale * (Number(event.target.value || 100) / 100);
    renderAvatarCrop();
  });
  $('#resetAvatarCropBtn').addEventListener('click', resetAvatarCrop);
  $('#applyAvatarCropBtn').addEventListener('click', applyAvatarCropPreview);
  $('#cancelAvatarCropBtn').addEventListener('click', cancelAvatarCrop);
  $('#closeAvatarCropBtn').addEventListener('click', cancelAvatarCrop);

  const cropCanvas = $('#avatarCropCanvas');
  cropCanvas.addEventListener('pointerdown', (event) => {
    const crop = state.avatarCrop;
    if (!crop) return;
    crop.dragging = true;
    crop.pointerId = event.pointerId;
    crop.lastX = event.clientX;
    crop.lastY = event.clientY;
    cropCanvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  cropCanvas.addEventListener('pointermove', (event) => {
    const crop = state.avatarCrop;
    if (!crop?.dragging || crop.pointerId !== event.pointerId) return;
    const rect = cropCanvas.getBoundingClientRect();
    const factorX = cropCanvas.width / Math.max(1, rect.width);
    const factorY = cropCanvas.height / Math.max(1, rect.height);
    crop.offsetX += (event.clientX - crop.lastX) * factorX;
    crop.offsetY += (event.clientY - crop.lastY) * factorY;
    crop.lastX = event.clientX;
    crop.lastY = event.clientY;
    renderAvatarCrop();
    event.preventDefault();
  });
  const endCropDrag = (event) => {
    const crop = state.avatarCrop;
    if (!crop || crop.pointerId !== event.pointerId) return;
    crop.dragging = false;
    crop.pointerId = null;
    try { cropCanvas.releasePointerCapture?.(event.pointerId); } catch {}
  };
  cropCanvas.addEventListener('pointerup', endCropDrag);
  cropCanvas.addEventListener('pointercancel', endCropDrag);

  $('#renameContactBtn').addEventListener('click', openContactAliasModal);
  $('#contactAliasForm').addEventListener('submit', (event) => {
    event.preventDefault();
    saveCurrentContactAlias($('#contactAliasInput').value);
  });
  $('#resetContactAliasBtn').addEventListener('click', () => saveCurrentContactAlias(''));

  $('#profileForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('#displayNameInput').value.trim();
    if (!name) return;
    const { error } = await supabase
      .from('kalo_profiles')
      .update({ display_name: name, updated_at: new Date().toISOString() })
      .eq('user_id', state.user.id);
    if (error) return toast('Không lưu được tên.', 'error');
    state.profile.display_name = name;
    await loadProfiles();
    state.profile = state.profiles.get(state.user.id) || state.profile;
    updateProfileAvatarPreview();
    updateSelfAvatar();
    renderPeopleList();
    renderConversationList();
    renderChatHeader();
    toast('Đã lưu tên hiển thị.');
  });

  $('#changePasswordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const p1 = $('#newPasswordInput').value;
    const p2 = $('#newPasswordInput2').value;
    if (p1.length < 8 || p1 !== p2) {
      toast('Mật khẩu cần từ 8 ký tự và hai ô phải giống nhau.', 'error');
      return;
    }
    const button = $('button[type="submit"]', event.currentTarget);
    setBusy(button, true);
    const { error } = await supabase.auth.updateUser({ password: p1 });
    setBusy(button, false);
    if (error) return toast('Không đổi được mật khẩu.', 'error');
    $('#newPasswordInput').value = '';
    $('#newPasswordInput2').value = '';
    toast('Đã đổi mật khẩu.');
  });

  $('#saveTurnConfigBtn').addEventListener('click', () => {
    const url = $('#turnUrlInput').value.trim();
    saveTurnConfig(url ? {
      url,
      username: $('#turnUsernameInput').value,
      credential: $('#turnCredentialInput').value,
    } : null);
    toast(url ? 'Đã lưu TURN. Kết nối mới sẽ dùng cấu hình này.' : 'Đã xóa cấu hình TURN.');
  });

  $('#exportBackupBtn').addEventListener('click', async () => {
    try {
      const prefs = await state.preferencesManager?.load().catch(() => null);
      const timeline = await state.documentsManager?.loadTimeline().catch(() => []);
      downloadBackup({
        app: 'Kalo',
        version: 2,
        exportedAt: new Date().toISOString(),
        account: {
          username: state.profile?.username || '',
          displayName: state.profile?.display_name || '',
        },
        preferences: prefs || {
          aliases: state.contactAliases,
          categories: state.conversationCategories,
          conversationPrefs: state.conversationPrefs,
          pins: state.messagePins,
        },
        drafts: exportDrafts(state.user.id),
        local: {
          privacy: document.body.classList.contains('privacy-mode'),
          rememberLogin: rememberLoginEnabled(),
          turn: (() => {
            const turn = loadTurnConfig();
            return turn ? { url: turn.url, username: turn.username || '', credential: '' } : null;
          })(),
        },
        myDocumentsTimeline: timeline || [],
      }, `Kalo_Backup_${state.profile?.username || 'user'}_${new Date().toISOString().slice(0,10)}.json`);
      toast('Đã xuất backup Kalo.');
    } catch (error) {
      toast(error.message || 'Không xuất được backup.', 'error');
    }
  });

  $('#importBackupBtn').addEventListener('click', () => $('#backupImportInput').click());
  $('#backupImportInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const backup = await readBackupFile(file);
      if (backup.preferences?.aliases) {
        state.contactAliases = { ...backup.preferences.aliases };
        await state.preferencesManager?.replaceAliases(state.contactAliases);
      }
      if (Array.isArray(backup.preferences?.categories)) {
        state.conversationCategories = backup.preferences.categories.map((item) => ({
          id: item.id || crypto.randomUUID(),
          name: String(item.name || 'Phân loại').slice(0,30),
          color: safeCategoryColor(item.color),
        }));
        const assignments = Object.fromEntries(
          Object.entries(backup.preferences?.conversationPrefs || {})
            .filter(([, pref]) => pref?.category_id)
            .map(([conversationId, pref]) => [conversationId, pref.category_id])
        );
        state.conversationCategoryMap = assignments;
        await state.preferencesManager?.replaceCategories(state.conversationCategories, assignments);
      }
      if (backup.preferences?.conversationPrefs && state.preferencesManager) {
        state.conversationPrefs = { ...backup.preferences.conversationPrefs };
        await state.preferencesManager.replaceConversationPrefs(state.conversationPrefs);
      }
      if (Array.isArray(backup.preferences?.pins) && state.preferencesManager) {
        state.messagePins = [...backup.preferences.pins];
        await state.preferencesManager.replacePins(state.messagePins);
      }
      importDrafts(state.user.id, backup.drafts || {});
      if (Array.isArray(backup.myDocumentsTimeline) && state.documentsManager) {
        await state.documentsManager.saveTimeline(backup.myDocumentsTimeline);
      }
      if (backup.local?.turn) saveTurnConfig(backup.local.turn);
      if (typeof backup.local?.privacy === 'boolean') applyPrivacy(backup.local.privacy);
      await hydrateSyncedPreferences();
      renderConversationList();
      renderCategoryFilterMenu();
      toast('Đã khôi phục backup Kalo.');
    } catch (error) {
      toast(error.message || 'Không nhập được backup.', 'error');
    }
  });

  $('#logoutBtn').addEventListener('click', logout);
  $('#copyRecoveryCode').addEventListener('click', async () => {
    const text = $('#recoveryCodeValue').textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast('Đã sao chép mã khôi phục.');
    } catch {
      toast('Không thể sao chép tự động.', 'error');
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !$('#activeChat').classList.contains('hidden') && !modalOpen()) {
      event.preventDefault();
      openMessageSearch();
      return;
    }
    if (event.altKey && (event.code === 'Period' || event.key === '.' || event.key === '>')) {
      event.preventDefault();
      const next = !document.body.classList.contains('privacy-mode');
      applyPrivacy(next);
      toast(next ? 'Đã che tin nhắn.' : 'Đã bỏ che tin nhắn.');
      return;
    }
    if (event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (window.parent !== window) window.parent.postMessage({ source: 'kalo', type: 'toggle' }, '*');
      return;
    }
    if (event.key === 'Escape') {
      if (!$('#callModal').classList.contains('hidden')) return;
      if (!$('#avatarViewerModal').classList.contains('hidden')) {
        event.preventDefault();
        closeAvatarViewer();
        return;
      }
      if (!$('#avatarCropModal').classList.contains('hidden')) {
        event.preventDefault();
        cancelAvatarCrop();
        return;
      }
      if (!$('#conversationCategoryMenu').classList.contains('hidden')) {
        event.preventDefault();
        hide('#conversationCategoryMenu');
        return;
      }
      if (!$('#categoryFilterMenu').classList.contains('hidden')) {
        event.preventDefault();
        hide('#categoryFilterMenu');
        return;
      }
      if (!$('#stickerPanel').classList.contains('hidden')) {
        event.preventDefault();
        hide('#stickerPanel');
        $('#messageInput')?.focus();
        return;
      }
      if (!$('#messageSearchPanel').classList.contains('hidden')) {
        event.preventDefault();
        closeMessageSearch(false);
        return;
      }
      if (closeTopModal()) return;
      if ($('#appScreen').classList.contains('chat-open') && window.innerWidth <= 720) {
        $('#appScreen').classList.remove('chat-open');
        return;
      }
      if (window.parent !== window) {
        window.parent.postMessage({ source: 'kalo', type: 'close' }, '*');
      }
    }
  });

  window.addEventListener('beforeunload', () => {
    try { state.fileManager?.stop(); } catch {}
    try { state.callManager?.stop(); } catch {}
    try { state.qrScanner?.stop(); } catch {}
    try { state.avatarCrop?.bitmap?.close?.(); } catch {}
  });
}

async function boot() {
  bindAppEvents();
  await initAuth();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot().catch((error) => {
  console.error(error);
  setAuthMessage('Kalo chưa khởi động được. Vui lòng tải lại trang.', true);
});
