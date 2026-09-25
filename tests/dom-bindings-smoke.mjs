import fs from 'node:fs';

const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');

const badPatterns = [
  /\n\s*\$\('\.rail-btn\[data-view\]'\)\.forEach/,
  /\n\s*\$\('\.auth-tab'\)\.forEach/,
  /\n\s*\$\('\.friend-tab'\)\.forEach/,
  /\n\s*\$\('\[data-close-modal\]'\)\.forEach/,
  /const open = \$\('\.modal-backdrop:not\(\.hidden\)'\)/,
];

for (const pattern of badPatterns) {
  if (pattern.test(app)) throw new Error(`Single-element selector used as a list: ${pattern}`);
}

for (const line of app.split('\n')) {
  if (/[^$]\$\([^)]*\)\.forEach/.test(` ${line}`)) {
    throw new Error(`Single-element selector used as a list: ${line.trim()}`);
  }
}

const requiredIds = [
  'rememberLogin',
  'addFriendBtn',
  'createGroupBtn',
  'addFriendModal',
  'groupModal',
  'qrVideo',
  'startQrBtn',
  'friendIdInput',
  'myQrCode',
  'groupFriendsPicker',
  'documentsList',
  'documentsHome',
  'addDocumentBtn',
  'documentsStorageLabel',
  'settingsStorageLabel',
  'changeStorageBtn',
  'audioCallBtn',
  'videoCallBtn',
  'incomingCallModal',
  'callModal',
  'remoteCallVideo',
  'localCallVideo',
  'messageSearchBtn',
  'messageSearchPanel',
  'messageSearchText',
  'messageSearchDate',
  'messageSearchResults',
  'categoryFilterWrap',
  'categoryFilterBtn',
  'categoryFilterMenu',
  'conversationCategoryMenu',
  'categoryManagerModal',
  'categoryCreateForm',
  'categoryCreateColor',
  'categoryCreateName',
  'categoryManagerList',
  'logoutBtn',
  'returnKanbanBtn',
  'quickLogoutBtn',
  'profileAvatarPreview',
  'chooseAvatarBtn',
  'removeAvatarBtn',
  'avatarInput',
  'renameContactBtn',
  'contactAliasModal',
  'contactAliasForm',
  'contactAliasInput',
  'resetContactAliasBtn',
  'cropAvatarBtn',
  'saveAvatarBtn',
  'avatarPendingHint',
  'avatarCropModal',
  'avatarCropCanvas',
  'avatarZoomRange',
  'avatarZoomValue',
  'resetAvatarCropBtn',
  'cancelAvatarCropBtn',
  'applyAvatarCropBtn',
  'closeAvatarCropBtn',
  'scrollToLatestBtn',
];

for (const id of requiredIds) {
  if (!html.includes(`id="${id}"`)) throw new Error(`Missing required DOM id: ${id}`);
}

if (!app.includes("storage: authStorage")) throw new Error('Remember-login storage adapter is missing');
if (!app.includes("new QrScanner(")) throw new Error('QR scanner binding is missing');
if (!app.includes("from('kalo_friendships')")) throw new Error('Friendship backend binding is missing');
if (!app.includes("new KaloDocuments(")) throw new Error('My Documents manager is missing');
if (!app.includes("new KaloCallManager(")) throw new Error('Call manager is missing');
if (!app.includes("createReceiveTarget:")) throw new Error('Received files are not routed to My Documents');
if (!app.includes("sendMyDocumentText(")) throw new Error('My Documents self-chat text flow is missing');
if (!app.includes("sendMyDocumentFile(")) throw new Error('My Documents self-chat file flow is missing');
if (!app.includes("fetchConversationMessagesForSearch(")) throw new Error('Message search flow is missing');
if (!app.includes("addEventListener('paste'")) throw new Error('Paste-to-chat binding is missing');
if (!app.includes("loadConversationCategories(")) throw new Error('Conversation category storage is missing');
if (!app.includes("openConversationCategoryMenu(")) throw new Error('Conversation category assignment UI is missing');
if (!app.includes("renderCategoryFilterMenu(")) throw new Error('Conversation category filter UI is missing');
if (!app.includes("createConversationCategory(")) throw new Error('Conversation category manager is missing');
if (!app.includes("notifyParentOfIncomingMessage(")) throw new Error('Kanban incoming-message notification bridge is missing');
if (!app.includes("event.code === 'Period'")) throw new Error('Alt period privacy shortcut is missing');
if (!css.includes("Keep composer visible in long chats")) throw new Error('Long-chat composer layout fix is missing');
if (!app.includes("async function openAvatarCrop(")) throw new Error('Manual avatar crop opener is missing');
if (!app.includes("saveOwnAvatar(")) throw new Error('Avatar profile save flow is missing');
if (!app.includes("applyAvatarCropPreview(")) throw new Error('Avatar crop preview flow is missing');
if (!app.includes("pointermove")) throw new Error('Draggable avatar crop flow is missing');
if (!app.includes("avatarPendingDataUrl")) throw new Error('Explicit avatar save staging is missing');
if (!app.includes("scrollMessagesToLatest(")) throw new Error('Jump-to-latest message flow is missing');
if (!app.includes("updateScrollToLatestButton(")) throw new Error('Jump-to-latest visibility flow is missing');
if (!css.includes("#avatarCropModal")) throw new Error('Avatar crop priority styling is missing');
if (!app.includes("contactAliasStorageKey(")) throw new Error('Private contact nickname storage is missing');
if (!app.includes("openContactAliasModal(")) throw new Error('Contact nickname UI flow is missing');
if (!html.includes('logout-icon-img')) throw new Error('Custom logout icon is missing');
if (!app.includes("function returnToKanban(")) throw new Error('Standalone return-to-Kanban action is missing');
if (!html.includes('id="imageBtn"') || !html.includes('compose-tool-image')) throw new Error('Custom image composer icon is missing');

console.log('Kalo DOM binding smoke test passed.');
