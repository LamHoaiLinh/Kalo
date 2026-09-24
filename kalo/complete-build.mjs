import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'vendor/cinny');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const write = (rel, content) => fs.writeFileSync(path.join(root, rel), content, 'utf8');
const replace = (rel, from, to) => {
  const src = read(rel);
  if (src.includes(from)) {
    write(rel, src.replace(from, to));
    return;
  }
  if (src.includes(to)) return;
  throw new Error('Kalo completion patch failed in ' + rel + ': ' + from.slice(0, 100));
};
const replaceAll = (rel, pairs) => {
  let src = read(rel);
  for (const [from, to] of pairs) {
    if (src.includes(from)) {
      src = src.split(from).join(to);
      continue;
    }
    if (src.includes(to)) continue;
    throw new Error('Kalo completion patch failed in ' + rel + ': ' + from.slice(0, 100));
  }
  write(rel, src);
};

// Cinny sets publicDir=false, therefore Kalo's injected CSS/JS/logo must be copied explicitly.
replace(
  'vite.config.js',
  "    {\n      src: 'config.json',\n      dest: '',\n    },",
  "    {\n      src: 'config.json',\n      dest: '',\n    },\n    {\n      src: 'public/kalo/*',\n      dest: 'kalo',\n    },"
);

// Build metadata identifies the derived application as Kalo.
replaceAll('package.json', [
  ['"name": "cinny"', '"name": "kalo"'],
  ['"description": "Yet another matrix client"', '"description": "Kalo - secure Matrix messenger"'],
]);

// GitHub Pages and PWA metadata must use the /Kalo/ sub-path rather than the domain root.
let index = read('index.html');
index = index
  .replace('<html lang="en">', '<html lang="vi">')
  .replace(
    'A Matrix client where you can enjoy the conversation using simple, elegant and secure interface protected by e2ee with the power of open source.',
    'Kalo - trò chuyện riêng tư, gửi ảnh và tập tin với mã hóa đầu cuối trên nền Matrix.'
  )
  .replace(
    'content="cinny, cinnyapp, cinnychat, matrix, matrix client, matrix.org, element"',
    'content="kalo, chat, matrix, e2ee, nhắn tin, mã hóa đầu cuối"'
  )
  .replace('content="https://cinny.in"', 'content="https://lamhoailinh.github.io/Kalo/"')
  .replace(
    'content="https://cinny.in/assets/favicon-48x48.png"',
    'content="https://lamhoailinh.github.io/Kalo/kalo/kalo.svg"'
  )
  .replace('content="#000000"', 'content="#7fc9a5"')
  .replace(
    '<link id="favicon" rel="shortcut icon" href="./public/favicon.ico" />',
    '<link id="favicon" rel="shortcut icon" href="./kalo/kalo.svg" />'
  )
  .replace('<link rel="manifest" href="/manifest.json" />', '<link rel="manifest" href="./manifest.json" />');
write('index.html', index);

// Use the Kalo logo for browser/desktop notifications too.
replaceAll('src/app/pages/client/ClientNonUIFeatures.tsx', [
  ['../../../../public/res/svg/cinny.svg', '../../../../public/kalo/kalo.svg'],
  ['../../../../public/res/svg/cinny-unread.svg', '../../../../public/kalo/kalo.svg'],
  ['../../../../public/res/svg/cinny-highlight.svg', '../../../../public/kalo/kalo.svg'],
  ["new window.Notification('Invitation'", "new window.Notification('Lời mời'"],
  ['You have ${count} new invitation request.', 'Bạn có ${count} lời mời mới.'],
]);

// Attach stable data attributes for local privacy blur and detect messages sent by the current user.
replace(
  'src/app/features/room/message/Message.tsx',
  "    const senderId = mEvent.getSender() ?? '';",
  "    const senderId = mEvent.getSender() ?? '';\n    const isOwnMessage = senderId === mx.getUserId();"
);
replace(
  'src/app/features/room/message/Message.tsx',
  '        tabIndex={0}\n        space={messageSpacing}',
  '        data-kalo-message="1"\n        data-kalo-own={isOwnMessage ? \'1\' : \'0\'}\n        tabIndex={0}\n        space={messageSpacing}'
);

// Bubble layout: incoming messages stay left with avatar/name; your messages move right like familiar desktop messengers.
replace(
  'src/app/features/room/message/Message.tsx',
  '        {messageLayout === MessageLayout.Bubble && (\n          <BubbleLayout before={avatarJSX} header={headerJSX} onContextMenu={handleContextMenu}>\n            {msgContentJSX}\n          </BubbleLayout>\n        )}',
  '        {messageLayout === MessageLayout.Bubble && (\n          <BubbleLayout\n            own={isOwnMessage}\n            before={isOwnMessage ? undefined : avatarJSX}\n            header={isOwnMessage ? undefined : headerJSX}\n            onContextMenu={handleContextMenu}\n          >\n            {msgContentJSX}\n          </BubbleLayout>\n        )}'
);
replace(
  'src/app/components/message/layout/Bubble.tsx',
  'type BubbleLayoutProps = {\n  hideBubble?: boolean;\n  before?: ReactNode;\n  header?: ReactNode;\n};',
  'type BubbleLayoutProps = {\n  hideBubble?: boolean;\n  before?: ReactNode;\n  header?: ReactNode;\n  own?: boolean;\n};'
);
replace(
  'src/app/components/message/layout/Bubble.tsx',
  'export const BubbleLayout = as<\'div\', BubbleLayoutProps>(\n  ({ hideBubble, before, header, children, ...props }, ref) => (\n    <Box gap="300" {...props} ref={ref}>\n      <Box className={css.BubbleBefore} shrink="No">\n        {before}\n      </Box>\n      <Box grow="Yes" direction="Column">',
  'export const BubbleLayout = as<\'div\', BubbleLayoutProps>(\n  ({ hideBubble, before, header, own, children, ...props }, ref) => (\n    <Box gap="300" justifyContent={own ? \'End\' : undefined} {...props} ref={ref}>\n      {!own && (\n        <Box className={css.BubbleBefore} shrink="No">\n          {before}\n        </Box>\n      )}\n      <Box\n        grow={own ? undefined : \'Yes\'}\n        direction="Column"\n        alignItems={own ? \'End\' : undefined}\n        style={own ? { maxWidth: \'82%\' } : undefined}\n      >'
);
replace(
  'src/app/components/message/layout/Bubble.tsx',
  '              direction="Column"\n            >',
  '              direction="Column"\n              style={\n                own\n                  ? {\n                      backgroundColor: \'#DDF4E8\',\n                      color: \'#173B2D\',\n                      borderTopRightRadius: 0,\n                    }\n                  : undefined\n              }\n            >'
);

// Translate the highest-frequency message actions without touching React identifiers.
replaceAll('src/app/features/room/message/Message.tsx', [
  ['Add Reaction', 'Thả cảm xúc'],
  ['Reply in Thread', 'Trả lời trong luồng'],
  ['Edit Message', 'Sửa tin nhắn'],
]);
replace(
  'src/app/features/room/message/Message.tsx',
  '                            >\n                              Reply\n                            </Text>',
  '                            >\n                              Trả lời\n                            </Text>'
);

console.log('Kalo completion patches applied successfully.');
