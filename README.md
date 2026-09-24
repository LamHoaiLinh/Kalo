# Kalo

Kalo là ứng dụng trò chuyện web/PWA theo phong cách thao tác quen thuộc của ứng dụng nhắn tin Việt Nam, dùng **Matrix** làm giao thức và kế thừa lõi mã nguồn mở **Cinny 4.12.7** để có sẵn E2EE, gửi ảnh/tập tin, reaction, reply, typing, read receipt, multi-device và lưu cache cục bộ.

## Trạng thái

- Frontend Kalo: GitHub Pages tại `https://lamhoailinh.github.io/Kalo/`
- Nền mã nguồn: Cinny commit `8967c13878137841e49ee17184b689a6b4da334a` (v4.12.7)
- Backend mặc định: Matrix homeserver `matrix.org`
- Có thể đổi sang Synapse riêng sau này mà không phải viết lại Kalo.
- Không dùng Supabase cho lõi chat/E2EE.

## Điểm riêng của Kalo

- Tông xanh lá pastel.
- Mở mặc định ở **Tin nhắn**, bố cục ba vùng gần với ứng dụng nhắn tin desktop.
- Tin nhắn dạng bubble; tin của bạn nằm bên phải và có nền xanh pastel.
- Chat 1-1 mặc định bật mã hóa đầu cuối theo cơ chế Matrix/Cinny.
- Gửi hình, file, audio/video, reaction, reply, chỉnh sửa/xóa theo quyền Matrix.
- Cài đặt **Che tin nhắn**: làm mờ nội dung và hình ảnh, rê chuột/focus để xem tạm thời.
- Dữ liệu phiên/sync được lưu cục bộ bằng IndexedDB theo lõi Cinny.
- Khi nhúng trong Kanban: **Alt+K** mở Kalo; **Esc** trở về Kanban.
- Xưng hô trong phần tùy biến Kalo là **bạn**.

## Cách build

Repo này không chép lại gần 1.000 file Cinny. Workflow tải đúng commit Cinny đã khóa, áp các patch Kalo trong thư mục `kalo/`, build bằng Vite rồi deploy GitHub Pages. Cách này giúp repo nhẹ nhưng vẫn có thể tái tạo đúng mã nguồn dẫn xuất.

```bash
# Workflow tự làm các bước này:
# 1) tải Cinny commit đã khóa
# 2) node kalo/patch-build.mjs vendor/cinny kalo
# 3) npm ci
# 4) npm run build
```

## Backend

Kalo hoạt động ngay với Matrix homeserver có sẵn. Nếu muốn dữ liệu nằm trên hạ tầng riêng, xem `backend/README.md` để triển khai Synapse + PostgreSQL trên VPS/server.

## Giấy phép

Kalo là tác phẩm dẫn xuất từ Cinny và tiếp tục sử dụng **AGPL-3.0-only**. Xem `LICENSE` và `NOTICE.md`.
