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
  ['Support', 'Ủng hộ'],
]);

replaceAll('src/app/features/settings/about/About.tsx', [
  ['https://github.com/cinnyapp/cinny', 'https://github.com/LamHoaiLinh/Kalo'],
  ['https://cinny.in/#sponsor', 'https://github.com/LamHoaiLinh/Kalo'],
]);

// Welcome page copy.
replaceAll('src/app/pages/client/WelcomePage.tsx', [
  ['Welcome to Kalo', 'Chào mừng bạn đến Kalo'],
  ['Yet another matrix client.', 'Trò chuyện riêng tư, gửi ảnh và tập tin với mã hóa đầu cuối.'],
  ['https://github.com/cinnyapp/cinny/releases', 'https://github.com/LamHoaiLinh/Kalo'],
  ['https://github.com/cinnyapp/cinny', 'https://github.com/LamHoaiLinh/Kalo'],
  ['Source Code', 'Mã nguồn Kalo'],
  ['Support', 'Thông tin dự án'],
]);

// Default UI: Zalo-like conversation list first, bubble messages, less clutter.
replace('src/app/state/settings.ts', '  hideActivity: boolean;\n', '  hideActivity: boolean;\n  privacyBlur: boolean;\n');
replace('src/app/state/settings.ts', '  hideActivity: false,\n', '  hideActivity: false,\n  privacyBlur: false,\n');
replace('src/app/state/settings.ts', '  useSystemTheme: true,', '  useSystemTheme: false,');
replace('src/app/state/settings.ts', '  themeId: undefined,', "  themeId: 'silver-theme',");
replace('src/app/state/settings.ts', '  isPeopleDrawer: true,', '  isPeopleDrawer: false,');
replace('src/app/state/settings.ts', '  messageLayout: 0,', '  messageLayout: 2,');

// Use Kalo pastel theme on login/registration screens as well.
replace(
  'src/app/pages/ThemeManager.tsx',
  '  DarkTheme,\n  LightTheme,\n  ThemeContextProvider,',
  '  DarkTheme,\n  LightTheme,\n  SilverTheme,\n  ThemeContextProvider,'
);

replace(
  'src/app/pages/ThemeManager.tsx',
  `export function UnAuthRouteThemeManager() {
  const systemThemeKind = useSystemThemeKind();

  useEffect(() => {
    document.body.className = '';
    document.body.classList.add(configClass, varsClass);
    if (systemThemeKind === ThemeKind.Dark) {
      document.body.classList.add(...DarkTheme.classNames);
    }
    if (systemThemeKind === ThemeKind.Light) {
      document.body.classList.add(...LightTheme.classNames);
    }
  }, [systemThemeKind]);

  return null;
}`,
  `export function UnAuthRouteThemeManager() {
  useEffect(() => {
    document.body.className = '';
    document.body.classList.add(configClass, varsClass);
    document.body.classList.add(...SilverTheme.classNames);
  }, []);

  return null;
}`
);

// Apply privacy class to the whole app when the user enables message concealment.
replace(
  'src/app/pages/ThemeManager.tsx',
  "  const [monochromeMode] = useSetting(settingsAtom, 'monochromeMode');",
  "  const [monochromeMode] = useSetting(settingsAtom, 'monochromeMode');\n  const [privacyBlur] = useSetting(settingsAtom, 'privacyBlur');"
);
replace(
  'src/app/pages/ThemeManager.tsx',
  "    if (monochromeMode) {\n      document.body.style.filter = 'grayscale(1)';\n    } else {\n      document.body.style.filter = '';\n    }\n  }, [activeTheme, monochromeMode]);",
  "    if (monochromeMode) {\n      document.body.style.filter = 'grayscale(1)';\n    } else {\n      document.body.style.filter = '';\n    }\n\n    document.body.classList.toggle('kalo-privacy', privacyBlur);\n  }, [activeTheme, monochromeMode, privacyBlur]);"
);

// Put the conceal-message switch in Settings > General > Editor.
replace(
  'src/app/features/settings/general/General.tsx',
  "  const [hideActivity, setHideActivity] = useSetting(settingsAtom, 'hideActivity');",
  "  const [hideActivity, setHideActivity] = useSetting(settingsAtom, 'hideActivity');\n  const [privacyBlur, setPrivacyBlur] = useSetting(settingsAtom, 'privacyBlur');"
);
replace(
  'src/app/features/settings/general/General.tsx',
  `      <SequenceCard className={SequenceCardStyle} variant="SurfaceVariant" direction="Column">\n        <SettingTile\n          title="Hide Typing & Read Receipts"\n          description="Turn off both typing status and read receipts to keep your activity private."\n          after={<Switch variant="Primary" value={hideActivity} onChange={setHideActivity} />}\n        />\n      </SequenceCard>`,
  `      <SequenceCard className={SequenceCardStyle} variant="SurfaceVariant" direction="Column">\n        <SettingTile\n          title="Che tin nhắn"\n          description="Làm mờ nội dung tin nhắn và hình ảnh. Di chuột lên tin nhắn để xem tạm thời."\n          after={<Switch variant="Primary" value={privacyBlur} onChange={setPrivacyBlur} />}\n        />\n      </SequenceCard>\n      <SequenceCard className={SequenceCardStyle} variant="SurfaceVariant" direction="Column">\n        <SettingTile\n          title="Ẩn trạng thái đang nhập và đã xem"\n          description="Tắt trạng thái đang nhập và biên nhận đã đọc để tăng riêng tư."\n          after={<Switch variant="Primary" value={hideActivity} onChange={setHideActivity} />}\n        />\n      </SequenceCard>`
);

// Green pastel theme based on Cinny's light theme tokens.
replaceAll('src/colors.css.ts', [
  ["Container: '#DEDEDE',", "Container: '#EAF7F0',"],
  ["ContainerHover: '#D3D3D3',", "ContainerHover: '#DDF1E6',"],
  ["ContainerActive: '#C7C7C7',", "ContainerActive: '#CFE9DC',"],
  ["ContainerLine: '#BBBBBB',", "ContainerLine: '#B8DDCA',"],
  ["Container: '#EAEAEA',", "Container: '#FFFFFF',"],
  ["Main: '#1245A8',", "Main: '#4EA97C',"],
  ["MainHover: '#103E97',", "MainHover: '#438F6B',"],
  ["MainActive: '#0F3B8F',", "MainActive: '#397E5D',"],
  ["MainLine: '#0E3786',", "MainLine: '#347454',"],
  ["Container: '#C4D0E9',", "Container: '#DDF4E8',"],
  ["ContainerHover: '#B8C7E5',", "ContainerHover: '#CFEEDA',"],
  ["ContainerActive: '#ACBEE1',", "ContainerActive: '#C2E7D2',"],
  ["ContainerLine: '#A0B5DC',", "ContainerLine: '#AFE0C5',"],
  ["OnContainer: '#0D3076',", "OnContainer: '#245E45',"],
]);

replace('src/app/hooks/useTheme.ts', "[SilverTheme.id]: 'Silver',", "[SilverTheme.id]: 'Kalo Pastel',");

// Conversation navigation width and left rail proportions similar to desktop Zalo.
replace('src/app/components/page/style.css.ts', "width: toRem(256),", "width: toRem(320),");
replace('src/app/components/page/style.css.ts', "width: toRem(222),", "width: toRem(288),");
replace('src/app/components/sidebar/Sidebar.css.ts', "width: toRem(66),", "width: toRem(70),");
