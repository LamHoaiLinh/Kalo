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

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
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
  starting: false,
  startedUserId: null,
  pendingRecoveryCode: null,
  currentView: 'chats',
};

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
  open[open.length - 1].classList.add('hidden');
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
  const p = state.profiles.get(otherId);
  return p?.display_name || p?.username || 'Cuộc trò chuyện';
}
function conversationAvatar(conv) {
  return initials(conversationLabel(conv));
}
function isOnline(userId) {
  return state.presence.has(userId);
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

async function startRealtime() {
  await stopRealtime();
  await startPresence();

  const dataChannel = supabase
    .channel(`kalo-data-${state.user.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'kalo_messages' }, async (payload) => {
      const row = payload.new;
      if (!state.conversations.some((c) => c.id === row.conversation_id)) {
        await loadConversations();
      }
      if (row.conversation_id === state.currentConversationId) {
        await loadMessages(row.conversation_id);
      } else {
        await refreshPreviews();
        renderConversationList();
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kalo_reactions' }, async () => {
      if (state.currentConversationId) await loadReactions();
    })
    .subscribe();
  state.realtimeChannels.push(dataChannel);

  state.fileManager = new KaloFileTransfer(supabase, state.user.id, { onStatus: onFileStatus });
  await state.fileManager.start();
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
      const decoded = await decryptPayload(row.encrypted_payloads, state.user.id, state.identity);
      state.previews.set(row.conversation_id, {
        text: row.kind === 'file_offer' ? `📎 ${decoded.name || 'File'}` : decoded.text || 'Tin nhắn',
        created_at: row.created_at,
      });
    } catch {
      state.previews.set(row.conversation_id, { text: 'Tin nhắn riêng tư', created_at: row.created_at });
    }
  }
}

async function markRead(conversationId) {
  const last = state.messages[state.messages.length - 1];
  if (!last) return;
  await supabase.from('kalo_reads').upsert({
    conversation_id: conversationId,
    user_id: state.user.id,
    last_message_id: last.id,
    read_at: new Date().toISOString(),
  });
}

async function loadMessages(conversationId) {
  if (!state.identity) return;
  const { data, error } = await supabase
    .from('kalo_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(150);
  if (error) {
    toast('Không tải được tin nhắn.', 'error');
    return;
  }

  const decoded = [];
  for (const row of data || []) {
    let payload;
    try {
      payload = await decryptPayload(row.encrypted_payloads, state.user.id, state.identity);
    } catch {
      payload = { type: 'locked', text: 'Không mở được tin nhắn này trên thiết bị hiện tại.' };
    }
    decoded.push({ ...row, decoded: payload });
  }
  state.messages = decoded;
  await loadReactions();
  renderMessages();
  await markRead(conversationId);
  setTimeout(() => {
    const list = $('#messageList');
    list.scrollTop = list.scrollHeight;
  }, 0);
}

async function loadReactions() {
  const ids = state.messages.map((m) => m.id);
  state.reactions.clear();
  if (!ids.length) {
    renderMessages();
    return;
  }
  const { data } = await supabase.from('kalo_reactions').select('*').in('message_id', ids);
  for (const r of data || []) {
    if (!state.reactions.has(r.message_id)) state.reactions.set(r.message_id, []);
    state.reactions.get(r.message_id).push(r);
  }
  renderMessages();
}

function renderOnlineSummary() {
  const count = [...state.presence].filter((id) => id !== state.user?.id).length;
  $('#onlineSummary').textContent = count > 0 ? `${count} người đang online` : 'Kalo đã sẵn sàng';
}

function renderConversationList() {
  const list = $('#conversationList');
  if (!list) return;
  const query = $('#conversationSearch')?.value.trim().toLowerCase() || '';
  const sorted = [...state.conversations].sort((a, b) => {
    const at = state.previews.get(a.id)?.created_at || a.created_at;
    const bt = state.previews.get(b.id)?.created_at || b.created_at;
    return new Date(bt) - new Date(at);
  });

  list.innerHTML = sorted
    .filter((conv) => conversationLabel(conv).toLowerCase().includes(query))
    .map((conv) => {
      const label = conversationLabel(conv);
      const preview = state.previews.get(conv.id);
      const otherId = conv.kind === 'direct' ? memberIds(conv.id).find((id) => id !== state.user.id) : null;
      const online = otherId && isOnline(otherId);
      return `<button class="conv-item ${conv.id === state.currentConversationId ? 'active' : ''}" data-conv-id="${conv.id}">
        <div class="avatar">${escapeHtml(conversationAvatar(conv))}</div>
        <div class="conv-main">
          <div class="conv-name">${escapeHtml(label)}${online ? ' · 🟢' : ''}</div>
          <div class="conv-preview">${escapeHtml(preview?.text || 'Bắt đầu trò chuyện')}</div>
        </div>
        <div class="conv-meta">${escapeHtml(formatTime(preview?.created_at || conv.created_at))}</div>
      </button>`;
    }).join('') || '<div class="empty-chat" style="padding:32px 10px"><p>Chưa có cuộc trò chuyện.</p></div>';

  $$('[data-conv-id]', list).forEach((btn) => btn.addEventListener('click', () => openConversation(btn.dataset.convId)));
}

function renderPeopleList() {
  const root = $('#peopleList');
  const query = ($('#conversationSearch')?.value || '').trim().toLowerCase();
  const people = [...state.profiles.values()]
    .filter((p) => p.user_id !== state.user.id)
    .filter((p) => !query || p.display_name.toLowerCase().includes(query) || p.username.includes(query));
  root.innerHTML = people.map((p) => `<div class="person-item">
    <div class="avatar">${escapeHtml(initials(p.display_name))}</div>
    <div class="person-info">
      <strong>${escapeHtml(p.display_name)} ${isOnline(p.user_id) ? '🟢' : ''}</strong>
      <small>@${escapeHtml(p.username)}${p.public_key ? '' : ' · chưa mở Kalo lần đầu'}</small>
    </div>
    <button data-message-user="${p.user_id}" type="button">Nhắn tin</button>
  </div>`).join('') || '<div class="empty-chat" style="padding:32px 10px"><p>Không tìm thấy người dùng.</p></div>';
  $$('[data-message-user]', root).forEach((btn) => btn.addEventListener('click', () => createOrOpenDirect(btn.dataset.messageUser)));
}

function renderChatHeader() {
  const conv = currentConversation();
  if (!conv) return;
  const title = conversationLabel(conv);
  $('#chatTitle').textContent = title;
  $('#chatAvatar').textContent = initials(title);
  if (conv.kind === 'group') {
    $('#chatSubtitle').textContent = `${memberIds(conv.id).length} thành viên`;
  } else {
    const other = memberIds(conv.id).find((id) => id !== state.user.id);
    $('#chatSubtitle').textContent = other && isOnline(other) ? 'Đang online' : 'Riêng tư';
  }
}

function renderMessages() {
  const list = $('#messageList');
  if (!list || !state.currentConversationId) return;
  list.innerHTML = state.messages.map((m) => {
    const own = m.sender_id === state.user.id;
    const sender = state.profiles.get(m.sender_id);
    const reactions = state.reactions.get(m.id) || [];
    const hearts = reactions.filter((r) => r.emoji === '❤️');
    const mine = hearts.some((r) => r.user_id === state.user.id);
    let body = '';

    if (m.decoded.type === 'locked') {
      body = `<div class="bubble-text">${escapeHtml(m.decoded.text)}</div>`;
    } else if (m.kind === 'file_offer' || m.decoded.type === 'file') {
      const canReceive = !own;
      body = `<div class="file-card">
        <div class="file-card-head">
          <div class="file-icon">📎</div>
          <div style="min-width:0">
            <div class="file-name">${escapeHtml(m.decoded.name || 'File')}</div>
            <div class="file-size">${escapeHtml(formatBytes(m.decoded.size))} · truyền trực tiếp</div>
          </div>
        </div>
        ${canReceive ? `<button class="secondary-btn" data-receive-file="${m.id}" type="button">Nhận file</button>` : '<div class="file-size" style="margin-top:8px">Giữ Kalo mở để người nhận tải file.</div>'}
      </div>`;
    } else {
      body = `<div class="bubble-text">${escapeHtml(m.decoded.text || '')}</div>`;
    }

    return `<div class="msg-row ${own ? 'own' : 'other'}" data-message-id="${m.id}">
      ${own ? '' : `<div class="msg-avatar">${escapeHtml(initials(sender?.display_name || sender?.username))}</div>`}
      <div class="msg-content">
        ${own ? '' : `<div class="msg-sender">${escapeHtml(sender?.display_name || sender?.username || 'Người dùng')}</div>`}
        <div class="bubble">
          ${body}
          <div class="bubble-time">${escapeHtml(formatTime(m.created_at))}</div>
        </div>
        <div class="msg-actions">
          <button class="mini-action" data-heart="${m.id}" type="button">${mine ? '❤️' : '♡'} ${hearts.length || ''}</button>
        </div>
      </div>
    </div>`;
  }).join('');

  $$('[data-heart]', list).forEach((btn) => btn.addEventListener('click', () => toggleHeart(btn.dataset.heart)));
  $$('[data-receive-file]', list).forEach((btn) => btn.addEventListener('click', () => receiveFile(btn.dataset.receiveFile)));
}

async function openConversation(id) {
  state.currentConversationId = id;
  renderConversationList();
  renderChatHeader();
  hide('#emptyChat');
  show('#activeChat');
  $('#appScreen').classList.add('chat-open');
  await loadMessages(id);
}

async function createOrOpenDirect(userId) {
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

async function createConversationFromPicker() {
  const selected = $$('[data-pick-user]:checked', $('#newChatPeople')).map((x) => x.value);
  if (!selected.length) {
    toast('Hãy chọn ít nhất một người.', 'error');
    return;
  }
  const missingKey = selected.map((id) => state.profiles.get(id)).find((p) => !p?.public_key);
  if (missingKey) {
    toast(`${missingKey.display_name} cần mở Kalo ít nhất một lần trước khi nhận tin riêng tư.`, 'error');
    return;
  }
  if (selected.length === 1) {
    hide('#newChatModal');
    await createOrOpenDirect(selected[0]);
    return;
  }

  const title = $('#groupNameInput').value.trim();
  if (!title) {
    toast('Vui lòng đặt tên nhóm.', 'error');
    return;
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
  hide('#newChatModal');
  await loadConversations();
  await openConversation(id);
}

function renderPeoplePicker() {
  const q = ($('#peopleSearch').value || '').trim().toLowerCase();
  const root = $('#newChatPeople');
  const people = [...state.profiles.values()]
    .filter((p) => p.user_id !== state.user.id)
    .filter((p) => !q || p.display_name.toLowerCase().includes(q) || p.username.includes(q));
  root.innerHTML = people.map((p) => `<div class="picker-row">
    <label>
      <input type="checkbox" data-pick-user value="${p.user_id}" ${p.public_key ? '' : 'disabled'} />
      <div class="avatar">${escapeHtml(initials(p.display_name))}</div>
      <span><strong>${escapeHtml(p.display_name)}</strong><br><small>@${escapeHtml(p.username)}${p.public_key ? '' : ' · chưa sẵn sàng'}</small></span>
    </label>
  </div>`).join('');
}

async function sendMessage() {
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text || !state.currentConversationId) return;
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
    });
    if (error) throw error;
    input.value = '';
    input.style.height = '';
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
  if (!file || !state.currentConversationId) return;
  const profiles = memberProfiles(state.currentConversationId);
  try {
    const transferId = crypto.randomUUID();
    const envelope = await encryptPayload({
      type: 'file',
      transferId,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      createdAt: Date.now(),
    }, profiles);

    state.fileManager.registerOutgoing(transferId, file);
    const { error } = await supabase.from('kalo_messages').insert({
      id: crypto.randomUUID(),
      conversation_id: state.currentConversationId,
      sender_id: state.user.id,
      kind: 'file_offer',
      encrypted_payloads: envelope,
    });
    if (error) throw error;
    toast('Đã gửi lời mời nhận file. Hãy giữ Kalo mở cho tới khi truyền xong.');
    await loadMessages(state.currentConversationId);
  } catch (e) {
    toast(e.message || 'Không thể gửi file.', 'error');
  }
}

async function receiveFile(messageId) {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg?.decoded?.transferId) return;
  try {
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
  if (view === 'people') {
    $('#leftPaneTitle').textContent = 'Danh bạ';
    hide('#conversationList');
    show('#peopleList');
    renderPeopleList();
  } else {
    $('#leftPaneTitle').textContent = 'Tin nhắn';
    show('#conversationList');
    hide('#peopleList');
    renderConversationList();
  }
}

function applyPrivacy(value) {
  const enabled = Boolean(value);
  document.body.classList.toggle('privacy-mode', enabled);
  localStorage.setItem('kalo-privacy', enabled ? '1' : '0');
  $('#privacyToggle').checked = enabled;
  $('#privacyBtn').classList.toggle('active', enabled);
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
    state.identity = await ensureUserIdentity(state.pendingRecoveryCode);
    state.pendingRecoveryCode = null;

    await Promise.all([loadProfiles(), loadConversations()]);
    await startRealtime();

    hide('#authScreen');
    show('#appScreen');
    $('#settingsAccount').textContent = `@${state.profile.username}`;
    $('#displayNameInput').value = state.profile.display_name;
    applyPrivacy(localStorage.getItem('kalo-privacy') === '1');
    setView('chats');
    renderOnlineSummary();
    state.startedUserId = session.user.id;
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

async function logout() {
  await stopRealtime();
  await supabase.auth.signOut();
  state.session = null;
  state.user = null;
  state.profile = null;
  state.identity = null;
  state.startedUserId = null;
  state.profiles.clear();
  state.conversations = [];
  state.members.clear();
  state.messages = [];
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
  $$('.auth-tab').forEach((btn) => btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab)));

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    setBusy(button, true);
    setAuthMessage('');
    try {
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
  }
}

function bindAppEvents() {
  $$('.rail-btn[data-view]').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $('#conversationSearch').addEventListener('input', () => {
    if (state.currentView === 'people') renderPeopleList();
    else renderConversationList();
  });

  $('#newChatBtn').addEventListener('click', () => {
    $('#groupNameInput').value = '';
    $('#peopleSearch').value = '';
    renderPeoplePicker();
    show('#newChatModal');
  });
  $('#peopleSearch').addEventListener('input', renderPeoplePicker);
  $('#createChatBtn').addEventListener('click', () => createConversationFromPicker().catch((e) => toast(e.message, 'error')));

  $$('[data-close-modal]').forEach((btn) => btn.addEventListener('click', () => hide(`#${btn.dataset.closeModal}`)));

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
  });

  $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await sendFile(file);
  });

  $('#privacyBtn').addEventListener('click', () => applyPrivacy(!document.body.classList.contains('privacy-mode')));
  $('#privacyToggle').addEventListener('change', (event) => applyPrivacy(event.target.checked));

  $('#settingsBtn').addEventListener('click', () => {
    $('#settingsAccount').textContent = `@${state.profile?.username || ''}`;
    $('#displayNameInput').value = state.profile?.display_name || '';
    $('#privacyToggle').checked = document.body.classList.contains('privacy-mode');
    show('#settingsModal');
  });

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
    if (event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (window.parent !== window) window.parent.postMessage({ source: 'kalo', type: 'toggle' }, '*');
      return;
    }
    if (event.key === 'Escape') {
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
