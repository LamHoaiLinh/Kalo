# Backend Kalo

Kalo dùng **Matrix** làm giao thức chat và **Cinny/Matrix SDK** ở phía trình duyệt. Bản hiện tại hoạt động ngay với homeserver mặc định `matrix.org`, nên không cần Supabase để chạy chat.

## Khi nào cần Synapse riêng?

Khi muốn toàn quyền quản lý tài khoản, thời gian lưu media, giới hạn file, tên miền và chính sách vận hành, triển khai một Matrix homeserver riêng bằng **Synapse + PostgreSQL** trên VPS/server 24/7 rồi đổi homeserver mặc định trong `kalo/patch-build.mjs`.

Luồng dữ liệu:

```text
Kalo (trình duyệt/PWA)
  -> Matrix HTTPS
  -> Synapse
  -> PostgreSQL (room/event/device metadata)
  -> Media store (attachment ciphertext khi phòng bật E2EE)
```

Nội dung tin nhắn trong phòng E2EE được mã hóa/giải mã ở thiết bị. Synapse chuyển và lưu event mã hóa; không nên tự viết lại giao thức crypto.

## Supabase

Không dùng project `family-farm-online` cho lõi Kalo. Việc tách chat khỏi database game tránh phụ thuộc, tránh migration Synapse làm rối schema game và tránh hai hệ tài khoản Matrix/Supabase Auth.

Supabase chỉ nên được bổ sung sau này cho các tính năng ngoài Matrix nếu thật sự cần, ví dụ dashboard nội bộ hoặc liên kết nghiệp vụ Kanban.

## Checklist production Synapse riêng

- VPS có HTTPS và domain riêng.
- Synapse bản được hỗ trợ.
- PostgreSQL riêng cho Synapse.
- Reverse proxy (Caddy/Nginx).
- Backup database + media.
- Giới hạn upload/retention phù hợp.
- Chỉ mở đăng ký theo chính sách mong muốn.
- Theo dõi cập nhật bảo mật Matrix/Synapse.
