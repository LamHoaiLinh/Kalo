import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'vendor/cinny');
const kaloDir = path.resolve(process.argv[3] || 'kalo');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const write = (rel, content) => {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};
const replace = (rel, from, to) => {
  const src = read(rel);
  if (!src.includes(from)) throw new Error(`Patch failed: ${rel} does not contain expected text: ${from.slice(0, 120)}`);
  write(rel, src.replace(from, to));
};
const replaceAll = (rel, pairs) => {
  let src = read(rel);
  for (const [from, to] of pairs) {
    if (!src.includes(from)) throw new Error(`Patch failed: ${rel} does not contain expected text: ${from.slice(0, 120)}`);
    src = src.split(from).join(to);
  }
  write(rel, src);
};
const append = (rel, content) => write(rel, `${read(rel).trimEnd()}\n\n${content.trim()}\n`);

// GitHub Pages / Kalo base path.
write('build.config.ts', `export default {\n  base: '/Kalo/',\n};\n`);

// Keep Matrix as the chat backend. matrix.org works immediately; custom homeservers remain available.
write(
  'config.json',
  `${JSON.stringify(
    {
      defaultHomeserver: 0,
      homeserverList: ['matrix.org'],
      allowCustomHomeservers: true,
      featuredCommunities: { openAsDefault: false, spaces: [], rooms: [], servers: [] },
      hashRouter: { enabled: true, basename: '/' },
    },
    null,
    2
  )}\n`
);

write(
  'public/manifest.json',
  `${JSON.stringify(
    {
      name: 'Kalo',
      short_name: 'Kalo',
      description: 'Kalo - trò chuyện riêng tư, mã hóa đầu cuối trên nền Matrix.',
      dir: 'auto',
      lang: 'vi-VN',
      display: 'standalone',
      orientation: 'portrait',
      start_url: './#/direct',
      background_color: '#f4fbf7',
      theme_color: '#7fc9a5',
      icons: [{ src: './kalo/kalo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
    },
    null,
    2
  )}\n`
);

// Kalo assets.
fs.mkdirSync(path.join(root, 'public/kalo'), { recursive: true });
for (const name of ['kalo.svg', 'kalo-theme.css', 'kalo-overlay.js']) {
  fs.copyFileSync(path.join(kaloDir, name), path.join(root, 'public/kalo', name));
}

// Page metadata and injected Kalo overlay.
let index = read('index.html');
index = index
  .replaceAll('Cinny', 'Kalo')
  .replace('Yet another matrix client', 'Kalo - trò chuyện riêng tư với mã hóa đầu cuối')
  .replace(
    '</head>',
    '    <link rel="stylesheet" href="./kalo/kalo-theme.css" />\n  </head>'
  )
  .replace(
    '</body>',
    '    <script src="./kalo/kalo-overlay.js"></script>\n  </body>'
  );
write('index.html', index);

// Branding: keep protocol/account-data identifiers intact, only replace user-facing Cinny branding.
const brandingFiles = [
  'src/app/features/settings/about/About.tsx',
  'src/app/components/splash-screen/SplashScreen.tsx',
  'src/app/pages/auth/AuthLayout.tsx',
  'src/app/pages/client/WelcomePage.tsx',
  'src/app/features/settings/notifications/SystemNotification.tsx',
  'src/app/pages/auth/login/PasswordLoginForm.tsx',
  'src/app/pages/auth/login/TokenLogin.tsx',
  'src/app/pages/auth/register/PasswordRegisterForm.tsx',
];
for (const rel of brandingFiles) {
  let src = read(rel);
  src = src.replaceAll('Cinny Web', 'Kalo Web').replaceAll('Cinny', 'Kalo');
  src = src.replaceAll('public/res/svg/cinny.svg', 'public/kalo/kalo.svg');
  write(rel, src);
}

// About page copy.
replaceAll('src/app/features/settings/about/About.tsx', [
  ['Yet another matrix client.', 'Kalo - trò chuyện riêng tư trên nền Matrix.'],
  ['Source Code', 'Mã nguồn'],
