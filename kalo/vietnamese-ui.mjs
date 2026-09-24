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
  throw new Error(`Vietnamese patch failed: ${rel} missing ${from.slice(0, 100)}`);
};
const replaceAll = (rel, pairs) => {
  let src = read(rel);
  for (const [from, to] of pairs) {
    if (src.includes(from)) {
      src = src.split(from).join(to);
      continue;
    }
    if (src.includes(to)) continue;
    throw new Error(`Vietnamese patch failed: ${rel} missing ${from.slice(0, 100)}`);
  }
  write(rel, src);
};

// Đăng nhập: người dùng chỉ thấy Kalo, không cần biết hạ tầng phía sau.
replace(
  'src/app/pages/auth/AuthLayout.tsx',
  `            <Box direction="Column" gap="100">
              <Text as="label" size="L400" priority="300">
                Homeserver
              </Text>
              <ServerPicker
                server={server}
                serverList={clientConfig.homeserverList ?? []}
                allowCustomServer={clientConfig.allowCustomHomeservers}
                onServerChange={selectServer}
              />
            </Box>`,
  `            <Box direction="Column" gap="100">
              <Text size="T300" priority="300">
                Đăng nhập để tiếp tục sử dụng Kalo.
              </Text>
            </Box>`
);
replaceAll('src/app/pages/auth/AuthLayout.tsx', [
  ['Looking for homeserver...', 'Đang kết nối...'],
  ['Failed to find homeserver.', 'Không thể kết nối. Vui lòng thử lại.'],
  ['Failed to connect. Homeserver configuration base_url appears invalid.', 'Không thể kết nối. Vui lòng thử lại.'],
  ['Failed to connect. Either homeserver is unavailable at this moment or does not exist.', 'Dịch vụ hiện chưa sẵn sàng. Vui lòng thử lại sau.'],
  ['Loading authentication flow...', 'Đang chuẩn bị đăng nhập...'],
  ['Failed to get authentication flow information.', 'Không thể tải thông tin đăng nhập. Vui lòng thử lại.'],
]);

replaceAll('src/app/pages/auth/login/Login.tsx', [
  ['        Login\n', '        Đăng nhập\n'],
  ['          {parsedFlows.sso && <OrDivider />}\n', ''],
  [`      {parsedFlows.sso && (
        <>
          <SSOLogin
            providers={parsedFlows.sso.identity_providers}
            redirectUrl={ssoRedirectUrl}
            action={SSOAction.LOGIN}
            saveScreenSpace={parsedFlows.password !== undefined}
          />
          <span data-spacing-node />
        </>
      )}
`, ''],
  [`            {`This client does not support login on "${server}" homeserver. Password and SSO based login method not found.`}
`, '            Hiện chưa thể đăng nhập. Vui lòng thử lại sau.\n'],
  [`      <Text align="Center">
        Do not have an account? <Link to={getRegisterPath(server)}>Register</Link>
      </Text>`,
   `      <Text align="Center">
        Bạn chưa có tài khoản?{' '}
        <a href="https://account.matrix.org/register/password" target="_blank" rel="noreferrer">
          Tạo tài khoản
        </a>
      </Text>`],
]);

replaceAll('src/app/pages/auth/login/PasswordLoginForm.tsx', [
  ['          Username\n', '          Tên tài khoản hoặc email\n'],
  ['          Password\n', '          Mật khẩu\n'],
  ['          after={<UsernameHint server={server} />}\n', '          after={undefined}\n'],
  ['<FieldError message="Login with custom server not allowed by your client instance." />', '<FieldError message="Tài khoản này chưa được hỗ trợ trên Kalo." />'],
  ['<FieldError message="Failed to find your Matrix ID server." />', '<FieldError message="Không tìm thấy tài khoản. Vui lòng kiểm tra lại." />'],
  ['<FieldError message="Invalid Username or Password." />', '<FieldError message="Tên tài khoản hoặc mật khẩu không đúng." />'],
  ['<FieldError message="This account has been deactivated." />', '<FieldError message="Tài khoản này đã bị vô hiệu hóa." />'],
  ['<FieldError message="Failed to login. Part of your request data is invalid." />', '<FieldError message="Không thể đăng nhập. Vui lòng kiểm tra lại thông tin." />'],
  ['<FieldError message="Failed to login. Your login request has been rate-limited by server, Please try after some time." />', '<FieldError message="Bạn đã thử quá nhiều lần. Vui lòng chờ một lúc rồi thử lại." />'],
  ['<FieldError message="Failed to login. Unknown reason." />', '<FieldError message="Không thể đăng nhập. Vui lòng thử lại sau." />'],
  ['<Link to={getResetPasswordPath(server)}>Forget Password?</Link>', '<a href="https://account.matrix.org/recover" target="_blank" rel="noreferrer">Quên mật khẩu?</a>'],
  ['          Login\n', '          Đăng nhập\n'],
]);

// Nếu người dùng truy cập thẳng trang đăng ký trong Kalo, chỉ hiện trải nghiệm đơn giản và mở trang tạo tài khoản ở tab mới.
write('src/app/pages/auth/register/Register.tsx', `import React from 'react';
import { Box, Button, Text } from 'folds';
import { Link } from 'react-router-dom';
import { useAuthServer } from '../../../hooks/useAuthServer';
import { getLoginPath } from '../../pathUtils';

export function Register() {
  const server = useAuthServer();
  return (
    <Box direction="Column" gap="500">
      <Text size="H2" priority="400">Tạo tài khoản</Text>
      <Text size="T300" priority="300">
        Bạn sẽ được mở trang đăng ký trong một tab mới. Sau khi tạo xong, quay lại Kalo để đăng nhập.
      </Text>
      <Button
        as="a"
        href="https://account.matrix.org/register/password"
        target="_blank"
        rel="noreferrer"
        variant="Primary"
        size="500"
      >
        <Text as="span" size="B500">Mở trang tạo tài khoản</Text>
      </Button>
      <Text align="Center">
        Bạn đã có tài khoản? <Link to={getLoginPath(server)}>Đăng nhập</Link>
      </Text>
    </Box>
  );
}
`);

// Quên mật khẩu cũng mở ngoài Kalo để không bị chặn khi Kalo đang nằm trong Kanban.
write('src/app/pages/auth/reset-password/ResetPassword.tsx', `import React from 'react';
import { Box, Button, Text } from 'folds';
import { Link } from 'react-router-dom';
import { useAuthServer } from '../../../hooks/useAuthServer';
import { getLoginPath } from '../../pathUtils';

export function ResetPassword() {
  const server = useAuthServer();
  return (
    <Box direction="Column" gap="500">
      <Text size="H2" priority="400">Khôi phục mật khẩu</Text>
      <Text size="T300" priority="300">
        Mở trang khôi phục mật khẩu, sau đó quay lại Kalo để đăng nhập.
      </Text>
      <Button
        as="a"
        href="https://account.matrix.org/recover"
        target="_blank"
        rel="noreferrer"
        variant="Primary"
        size="500"
      >
        <Text as="span" size="B500">Khôi phục mật khẩu</Text>
      </Button>
      <Text align="Center">
        Quay lại <Link to={getLoginPath(server)}>Đăng nhập</Link>
      </Text>
    </Box>
  );
}
`);

write('src/app/pages/auth/AuthFooter.tsx', `import React from 'react';
import { Box, Text } from 'folds';
import * as css from './styles.css';

export function AuthFooter() {
  return (
    <Box className={css.AuthFooter} justifyContent="Center">
      <Text size="T300" priority="300">Kalo · Trò chuyện riêng tư</Text>
    </Box>
  );
}
`);

replace('src/app/pages/auth/OrDivider.tsx', '<Text>OR</Text>', '<Text>HOẶC</Text>');

// Điều hướng chính.
replaceAll('src/app/pages/client/sidebar/DirectTab.tsx', [
  ['Mark as Read', 'Đánh dấu đã đọc'],
  ['tooltip="Direct Messages"', 'tooltip="Tin nhắn"'],
]);
replaceAll('src/app/pages/client/sidebar/HomeTab.tsx', [
  ['Mark as Read', 'Đánh dấu đã đọc'],
  ['tooltip="Home"', 'tooltip="Trang chủ"'],
]);
replace('src/app/pages/client/sidebar/InboxTab.tsx', 'tooltip="Inbox"', 'tooltip="Hộp thư"');
replace('src/app/pages/client/sidebar/SettingsTab.tsx', 'tooltip="User Settings"', 'tooltip="Cài đặt"');

replaceAll('src/app/features/settings/Settings.tsx', [
  ["name: 'General'", "name: 'Chung'"],
  ["name: 'Account'", "name: 'Tài khoản'"],
  ["name: 'Notifications'", "name: 'Thông báo'"],
  ["name: 'Devices'", "name: 'Thiết bị'"],
  ["name: 'Emojis & Stickers'", "name: 'Biểu tượng & nhãn dán'"],
  ["name: 'Developer Tools'", "name: 'Công cụ nâng cao'"],
  ["name: 'About'", "name: 'Giới thiệu'"],
  ['                  Settings\n', '                  Cài đặt\n'],
  ['<Text size="B400">Logout</Text>', '<Text size="B400">Đăng xuất</Text>'],
]);

replaceAll('src/app/components/LogoutDialog.tsx', [
  ['<Text size="H4">Logout</Text>', '<Text size="H4">Đăng xuất</Text>'],
  ['title="Unverified Device"', 'title="Thiết bị chưa được xác minh"'],
  ['description="Verify your device before logging out to save your encrypted messages."', 'description="Hãy xác minh thiết bị trước khi đăng xuất để tránh mất quyền truy cập vào các tin nhắn riêng tư."'],
  ['title="Alert"', 'title="Lưu ý"'],
  ['description="Enable device verification or export your encrypted data from settings to avoid losing access to your messages."', 'description="Hãy xác minh thiết bị hoặc sao lưu dữ liệu bảo mật trước khi đăng xuất."'],
  ['<Text priority="400">You’re about to log out. Are you sure?</Text>', '<Text priority="400">Bạn có chắc muốn đăng xuất?</Text>'],
  ['Failed to logout!', 'Không thể đăng xuất!'],
  ['<Text size="B400">Logout</Text>', '<Text size="B400">Đăng xuất</Text>'],
  ['<Text size="B400">Cancel</Text>', '<Text size="B400">Hủy</Text>'],
]);

// Bỏ câu mô tả kỹ thuật khỏi trang giới thiệu/chào mừng.
replaceAll('src/app/features/settings/about/About.tsx', [
  ['Kalo - trò chuyện riêng tư trên nền Matrix.', 'Kalo - ứng dụng trò chuyện riêng tư.'],
]);
replaceAll('src/app/pages/client/WelcomePage.tsx', [
  ['Trò chuyện riêng tư, gửi ảnh và tập tin với mã hóa đầu cuối.', 'Trò chuyện, gửi ảnh và tập tin riêng tư, thuận tiện.'],
]);

console.log('Kalo Vietnamese UI patches applied successfully.');
