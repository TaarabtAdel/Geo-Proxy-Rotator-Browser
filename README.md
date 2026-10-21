# Geo Proxy Rotator Browser

Trình duyệt Electron chạy bài viết qua nhiều proxy, mỗi tab một proxy riêng và giả lập vị trí USA. Logic giống extension **Geo Proxy Rotator**: mỗi proxy mở lần lượt hết các bài trong `list-link.txt`, rồi mới đổi sang proxy kế.

## Cài đặt

### 1. Cài Node.js

Tải bản **LTS** tại <https://nodejs.org> (Windows hoặc macOS) và cài như bình thường.

Kiểm tra trong Terminal / Command Prompt:

```bash
node -v
npm -v
```

### 2. Tải mã nguồn

```bash
git clone <địa-chỉ-repo> Geo_Proxy_Rotator_Browser
cd Geo_Proxy_Rotator_Browser
```

### 3. Cài thư viện (chỉ làm một lần)

```bash
npm install
```

Lần đầu sẽ tải Electron (khoảng 100 MB), cần mạng ổn định.

### 4. Chạy ứng dụng

| Hệ điều hành | Cách chạy |
|---|---|
| Windows | Nhấp đúp `start.bat` |
| macOS / Linux | `./start.sh` (lần đầu: `chmod +x start.sh`) |
| Mọi nơi | `npm start` |

Tab đầu tiên tự **Bắt đầu** chạy sau khi mở app.

## Các file cấu hình

Tất cả nằm cùng thư mục với app.

### `list-proxy.txt`: danh sách proxy

Mỗi dòng một proxy. Dòng bắt đầu bằng `#` được bỏ qua.

```text
1.2.3.4:8080
5.6.7.8:3128:user:pass
socks4://9.9.9.9:4145
socks5://10.10.10.10:1080
```

- Không ghi giao thức thì hiểu là HTTP.
- Tài khoản `user:pass` chỉ dùng được với HTTP. SOCKS4/SOCKS5 có mật khẩu sẽ bị bỏ qua.

### `list-link.txt`: danh sách bài viết

Mỗi dòng một URL `http`/`https`. Mỗi proxy sẽ chạy lần lượt từ bài đầu đến bài cuối.

### `geo-config.json`: thời gian và cuộn trang

| Khóa | Mặc định | Ý nghĩa |
|---|---|---|
| `waitMinSec` / `waitMaxSec` | 100 / 120 | Chờ ngẫu nhiên (giây) giữa hai bài |
| `proxyTimeoutSec` | 15 | Thời gian tối đa kiểm tra kết nối proxy và giả lập vị trí |
| `articleLoadTimeoutSec` | 60 | Thời gian tối đa tải một bài |
| `scrollEnabled` | `true` | Tự cuộn trang như người đọc |
| `scrollSpeed` | `normal` | `slow` / `normal` / `fast` |
| `scrollDepthPercent` | 95 | Cuộn tới bao nhiêu % chiều dài trang (50 đến 100) |

Mỗi khóa trong file đều có dòng chú thích `//` giải thích. Có thể sửa hoặc thêm chú thích thoải mái, app vẫn đọc được. Hai khóa `loop` và `parallelTabs` hiện chưa có tác dụng.

Sửa xong thì khởi động lại app.

### `geo-proxy-data.json`: lịch sử chạy

App tự tạo và cập nhật file này, **cùng định dạng với extension**:

- `proxyArticleDone`: cặp proxy–bài đã chạy (thành công hoặc lỗi). Lần sau sẽ bỏ qua.
- `proxyHealth`: tình trạng proxy (`live` / `dead`). Proxy `dead` bị bỏ qua.

File này **không đưa lên git** (đã có trong `.gitignore`) vì thay đổi liên tục.

### `geo-proxy-data.sample.json`: file mẫu trên git

File mẫu rỗng, chỉ có cấu trúc, được commit lên git. Khi chạy app trên máy mới mà chưa có `geo-proxy-data.json`, app tự chép file mẫu này thành `geo-proxy-data.json` rồi ghi lịch sử vào đó.

App **không bao giờ ghi đè** `geo-proxy-data.json` đã có.

Muốn máy mới bỏ qua sẵn proxy chết và các cặp đã chạy thì chép dữ liệu thật vào file mẫu rồi đưa lên git (file có thể nặng vài MB):

```bash
cp geo-proxy-data.json geo-proxy-data.sample.json
git add geo-proxy-data.sample.json
git commit -m "Cập nhật dữ liệu proxy mẫu"
```

## Dùng chung dữ liệu với extension

Chép `geo-proxy-data.json` từ thư mục dữ liệu của extension sang thư mục app, có thể chép cả khi app đang chạy. App tự đọc lại file khi thấy file thay đổi. Chép ngược từ app sang extension cũng được.

Đừng để extension và app **cùng ghi vào một file** một lúc.

## Cách hoạt động

Mỗi tab là một runner riêng:

1. **Đang đặt proxy**: lấy proxy kế trong list. Bỏ qua proxy dead, proxy đã chạy hết bài, và proxy đang bận ở tab khác hoặc ở extension.
2. **Đang kiểm tra kết nối**: kiểm tra IP qua proxy. Hai tab không bao giờ dùng trùng IP.
3. **Đang giả lập vị trí**: chọn ngẫu nhiên một thành phố USA, đặt GPS và múi giờ.
4. **Đang mở bài viết**: tải bài theo thứ tự trong `list-link.txt`.
5. **Đang chờ bài tiếp theo**: cuộn trang, chờ `waitMinSec`–`waitMaxSec` giây.
6. **Đang chuyển proxy**: hết bài, hoặc proxy chết giữa chừng, thì sang proxy kế.

Xử lý lỗi giống extension:

- Lỗi proxy (HTTP 407, `ERR_PROXY_CONNECTION_FAILED`…): đánh dấu proxy dead và đổi proxy.
- HTTP 403 hoặc lỗi chứng chỉ: bỏ qua bài đó.
- Bài tải quá hạn hoặc lỗi: ghi "không được" và sang bài kế.

## Giao diện

- **Thanh tab**: `IP - thành phố` của từng tab. Nút `+` mở thêm tab, mỗi tab tự chạy với proxy khác.
- **Bắt đầu / Dừng / Next bài**: điều khiển tab đang chọn. Next bỏ qua thời gian chờ.
- **Tình trạng proxy**: Tất cả · Chưa thử · Không · Bận · Đang dùng · Live.
- **Cặp proxy–bài đã chạy**: số cặp đã lưu, số chạy được và không được, các lỗi hay gặp.
- **Nhật ký tab này**: diễn biến chi tiết của tab.

## Chạy lại từ đầu

| Muốn | Làm |
|---|---|
| Thử lại proxy đã đánh dấu dead | Xóa mục `proxyHealth` trong `geo-proxy-data.json` |
| Chạy lại mọi bài | Xóa mục `proxyArticleDone` |
| Xóa sạch lịch sử | Tắt app, xóa `geo-proxy-data.json` (app sẽ tạo lại từ file mẫu rỗng) |

## Đóng gói cài đặt Windows

```bash
npm run dist
```

File cài đặt `.exe` nằm trong thư mục `dist/`.

## Kiểm thử

```bash
npm test
```

## Lưu ý

- Proxy miễn phí phần lớn đã chết. Log và terminal hiện nhiều lỗi `ERR_TIMED_OUT`, `handshake failed` là bình thường.
- Proxy tốt thì chạy lâu: 20 bài × khoảng 110 giây chờ ≈ 35–40 phút cho mỗi proxy.
