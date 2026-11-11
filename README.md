# Cả nhà Lên Chùa

Game web 3D. Trên máy chủ này, ai mở link cũng thấy người chơi khác, không cần đăng nhập.

## Đồ hoạ

Game dựng bằng three.js 0.187 (giấy phép MIT) với `WebGPURenderer` và vật liệu viết bằng TSL. Trình duyệt có WebGPU thì chạy WebGPU, chưa có thì tự lùi về WebGL 2. Thêm `?webgl` vào cuối link để ép WebGL 2 khi cần thử. Mọi hình, hoạ tiết và âm thanh đều dựng bằng công thức ngay trong `index.html`, không tải tệp ảnh, mô hình hay nhạc nào.

## Chạy thử trên máy

Cần Node.js 18 trở lên.

```bash
npm install
npm start
```

Mở http://localhost:8080 ở hai cửa sổ để thấy hai nhân vật. Điện thoại cùng Wi-Fi mở `http://<địa-chỉ-IP-của-máy>:8080`; cách này chưa có `https` nên chưa lắc được điện thoại và chưa mở được bảng chia sẻ.

## Đưa lên mạng bằng Render

1. Tạo kho mới trên GitHub, tải lên 5 tệp: `index.html`, `server.js`, `package.json`, `package-lock.json`, `render.yaml`. Không tải thư mục `node_modules`.
2. Trên Render, chọn **New > Blueprint**, chọn kho vừa tạo rồi xác nhận. Render đọc `render.yaml` và tự dựng.
3. Khi dựng xong, Render cho một địa chỉ dạng `https://ten-dich-vu.onrender.com`. Đó là link gửi cho mọi người.

Gói miễn phí tắt máy sau 15 phút không có ai, người mở tiếp theo chờ khoảng một phút. Muốn luôn sẵn sàng thì đổi sang gói trả phí.

## Cấu hình

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 8080 | Cổng chạy, nhà cung cấp hosting thường tự đặt |
| `TRUST_PROXY` | tắt | Đặt `1` khi chạy sau proxy, để đếm kết nối theo IP đúng |
| `MAX_CONNECTIONS` | 500 | Tổng số kết nối của cả máy chủ |
| `MAX_PER_IP` | 20 | Số kết nối từ một địa chỉ IP |
| `ALLOWED_ORIGINS` | trống | Tên miền khác được phép nối vào, cách nhau bằng dấu phẩy |

## Dữ liệu

Máy chủ chỉ giữ trong bộ nhớ tên, vị trí, tư thế và số lần thắp hương, đánh chuông của người đang chơi, rồi xoá khi họ rời đi. Lời cầu, quẻ và điểm không gửi lên máy chủ. Nhà cung cấp hosting có thể có nhật ký truy cập riêng của họ.

Mỗi sân tối đa 25 người, đông hơn thì người mới sang sân khác và không thấy sân trước.
