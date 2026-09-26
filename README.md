# Kalo

Kalo là ứng dụng trò chuyện web/PWA dành cho **gia đình, đồng nghiệp và nhóm nhỏ**, dùng tài khoản riêng của Kalo và được nhúng trực tiếp trong Kanban.

## Trạng thái hiện tại

- Web: `https://lamhoailinh.github.io/Kalo/`
- Frontend: HTML/CSS/JavaScript thuần trong thư mục `web/`.
- Tài khoản, đồng bộ và dữ liệu chat: project Supabase `family-farm-online`, dùng các bảng có tiền tố `kalo_`.
- Không phụ thuộc Matrix/Cinny.
- Không dùng Supabase Storage để truyền file lớn.

## Chức năng

- Đăng ký bằng **ID + mật khẩu + nhập lại mật khẩu**; email khôi phục là tùy chọn.
- Mỗi tài khoản có **mã khôi phục Kalo** để tạo lại mật khẩu và mở khóa lịch sử E2EE trên thiết bị mới.
- Chat 1-1 và nhóm; tin nhắn được mã hóa ở trình duyệt trước khi lưu lên server.
- Lịch sử chat tải theo trang: mở 100 tin gần nhất, cuộn lên đầu để nạp tiếp tin cũ.
- Tin chưa đọc và trạng thái **Đã gửi / Đã xem** đồng bộ qua `kalo_reads`.
- Trả lời, sửa, xóa, chuyển tiếp, thả tim và ghim tin nhắn.
- Draft được lưu riêng theo từng cuộc trò chuyện.
- Biệt danh, phân loại, ghim/tắt thông báo/lưu trữ cuộc trò chuyện được đồng bộ theo tài khoản.
- Avatar lưu trong Supabase Storage thay vì nhúng base64 vào bảng profile.
- File lớn truyền **P2P qua WebRTC**; file/ảnh ≤ 10 MB có thể kèm bản relay **AES-GCM** tạm thời để tải khi máy gửi đã offline.
- Có cấu hình TURN tùy chọn và ICE restart để tăng độ ổn định ở NAT/mạng công ty.
- Backup/restore biệt danh, phân loại, ghim, draft, cài đặt và timeline My Documents; có thể bảo vệ backup bằng mật khẩu AES-GCM.
- My Documents vẫn lưu cục bộ trên thiết bị; backup không nhúng file nhị phân và không xuất khóa mã hóa tin nhắn.
- Chế độ **Che tin nhắn**; `Alt+.` bật/tắt nhanh.
- `Alt+K` mở Kalo trong Kanban; `Esc` quay về Kanban.

## Cấu trúc

- `web/index.html` — giao diện.
- `web/styles.css` — giao diện xanh lá pastel.
- `web/app.js` — điều phối UI và các luồng nghiệp vụ chính.
- `web/message-service.js` — phân trang lịch sử, read/unread.
- `web/preferences.js` — biệt danh, phân loại, pin/mute/archive và draft.
- `web/media-storage.js` — avatar Storage và relay file nhỏ mã hóa.
- `web/backup.js` — backup/restore, mã hóa backup tùy chọn.
- `web/rtc-config.js` — cấu hình STUN/TURN runtime.
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


## Kalo v1.7

V1.7 tập trung vào ổn định dài hạn: sửa giới hạn lịch sử cũ, tách các service khỏi `app.js`, đồng bộ preference nhiều thiết bị, đưa avatar ra Storage, bổ sung relay file nhỏ mã hóa, TURN tùy chọn và backup có mật khẩu.

Migration Supabase tương ứng được lưu tại `supabase/migrations/202609260001_kalo_v17_stability.sql`.
