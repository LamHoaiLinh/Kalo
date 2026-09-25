import fs from 'node:fs';

const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

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

console.log('Kalo DOM binding smoke test passed.');
