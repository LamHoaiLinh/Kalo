# Kalo

Kalo là ứng dụng trò chuyện web/PWA dành cho **gia đình, đồng nghiệp và nhóm nhỏ**, dùng tài khoản riêng của Kalo và được nhúng trực tiếp trong Kanban.

## Trạng thái hiện tại

- Web: `https://lamhoailinh.github.io/Kalo/`
- Frontend: HTML/CSS/JavaScript thuần trong thư mục `web/`.
- Tài khoản, đồng bộ và dữ liệu chat: project Supabase `family-farm-online`, dùng các bảng có tiền tố `kalo_`.
- Không phụ thuộc Matrix/Cinny.
- Không dùng Supabase Storage để truyền file lớn.

## Chức năng

- Đăng ký bằng **ID + mật khẩu + nhập lại mật khẩu**.
- Email khôi phục là tùy chọn, không bắt buộc.
- Không gửi email thông báo chat.
- Email khôi phục chỉ được gửi khi người dùng chủ động yêu cầu và được giới hạn tối đa 1 yêu cầu / 10 phút.
- Mỗi tài khoản có **mã khôi phục Kalo** để tạo lại mật khẩu mà không cần email.
- Chat 1-1 và nhóm.
- Tin nhắn được mã hóa ở trình duyệt trước khi lưu lên server.
- Thả tim tin nhắn.
- Trạng thái online.
- Chế độ **Che tin nhắn**.
- File lớn truyền **trực tiếp máy gửi → máy nhận bằng WebRTC**; nội dung file không lưu trong Supabase.
- Người gửi và người nhận phải cùng online để truyền file.
- Với Chrome/Edge trên máy tính, file nhận có thể được ghi thẳng xuống ổ đĩa thay vì giữ toàn bộ trong RAM.
- `Alt+K` mở Kalo trong Kanban; `Esc` quay về Kanban.

## Cấu trúc

- `web/index.html` — giao diện.
- `web/styles.css` — giao diện xanh lá pastel.
- `web/app.js` — tài khoản, chat, nhóm, reaction, realtime.
- `web/crypto.js` — mã hóa/giải mã phía người dùng và khóa bảo mật.
- `web/webrtc.js` — truyền file P2P.
- `web/config.js` — cấu hình frontend.
- `.github/workflows/build-deploy.yml` — kiểm tra cú pháp/smoke test và deploy GitHub Pages.

## Backend Kalo trong Supabase

Các bảng Kalo được tách bằng tiền tố `kalo_` để không đụng dữ liệu game Family Farm:

- `kalo_profiles`
- `kalo_private_accounts`
- `kalo_key_backups`
- `kalo_conversations`
- `kalo_conversation_members`
- `kalo_messages`
- `kalo_reactions`
- `kalo_reads`
- `kalo_webrtc_signals`

Edge Function `kalo-auth` xử lý đăng ký, đăng nhập và khôi phục mật khẩu.

## Lưu ý file lớn

Kalo không upload file chat vào Supabase Storage. Supabase chỉ chuyển tín hiệu kết nối rất nhỏ. Nếu mạng công ty/NAT chặn WebRTC trực tiếp, Kalo sẽ báo không kết nối được thay vì tự upload file lên server.

## Giấy phép

Kalo hiện được phát hành theo giấy phép AGPL-3.0 trong file `LICENSE`.
