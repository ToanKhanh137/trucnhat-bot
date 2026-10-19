# 🧹 Bot Trực Nhật cho nhóm Zalo

Bot nhắc lịch trực phòng KTX: trực phòng, dọn vệ sinh, lấy nước, đổi lượt có trực bù, xin nghỉ, tạm dừng ngày lễ, bêu tên người lười.
Chạy 24/7 **miễn phí** trên Cloudflare Workers, không cần thẻ, không cần máy bật.

```
src/core.js      toàn bộ luật (trực, đổi, nghỉ, vệ sinh, nước, nhắc giờ)
src/jokes.js     các câu joke, thêm câu mới vào đây
src/worker.js    chạy trên Cloudflare: cron mỗi phút nghe tin Zalo + nhắc giờ, lưu D1
src/zalo.js      gọi Zalo Bot API
local/           chạy thử trên máy (simulate.js không cần Zalo, poll.js với Zalo thật)
test/            test
wrangler.toml    cấu hình Cloudflare (giờ nhắc, giới hạn đổi, ...)
```

## Chạy thử trên máy

Cần Node.js 18+ (`node --version`).
```
npm install
npm run simulate        ← đóng vai từng người: "Toan: /khoitao", tua giờ: "!+1d", "!at 20:00"
npm test
```

## Bước 1: Tạo bot Zalo

1. Mở app Zalo, tìm Official Account **Zalo Bot Manager**, bấm menu **Tạo bot**.
2. Đặt tên **bắt đầu bằng "Bot"**, ví dụ `Bot Trực Nhật P302`, rồi bấm **Tạo Bot**.
3. Zalo nhắn **Bot Token** cho bạn. Giữ bí mật token này.

## Bước 2: Đưa lên Cloudflare (làm 1 lần)

1. Tạo tài khoản miễn phí tại https://dash.cloudflare.com/sign-up (chỉ cần email).
2. Mở PowerShell trong thư mục dự án, chạy lần lượt:
```
npm install
npx wrangler login                     ← mở trình duyệt, bấm Allow
npx wrangler d1 create trucnhat        ← tạo cơ sở dữ liệu
```
3. Lệnh cuối in ra `database_id = "xxxx-..."`. Mở `wrangler.toml`, thay `DIEN_ID_SAU_KHI_CHAY_wrangler_d1_create` bằng id đó.
4. Deploy rồi đặt 2 mã bí mật:
```
npx wrangler deploy                    ← lần đầu sẽ hỏi đặt tên miền con workers.dev, gõ tên bất kỳ
npx wrangler secret put BOT_TOKEN      ← dán token Zalo
npx wrangler secret put WEBHOOK_SECRET ← tự nghĩ một chuỗi bí mật ≥ 8 ký tự, không dấu cách
```
   Lệnh deploy in ra địa chỉ dạng `https://trucnhat-bot.<tên>.workers.dev`.
5. Mở `https://trucnhat-bot.<tên>.workers.dev/setup?key=<WEBHOOK_SECRET>` (thay `<...>` bằng của bạn).
   Thấy thông tin bot là xong. Từ giờ cứ mỗi phút bot tự hỏi Zalo có tin mới không (mỗi lần nghe ~70 giây, gối lên nhau để không sót tin).

> Vì sao không dùng webhook: Cloudflare chặn User-Agent `Java/1.8` mà máy chủ Zalo dùng khi gọi vào tên miền
> `workers.dev` (lỗi 1010), và mình không tắt được luật này. Polling từ cron thì không bị chặn, lại vẫn miễn phí.

## Bước 3: Test trên Zalo

Mở log trực tiếp trong một cửa sổ PowerShell: `npx wrangler tail`

1. **Chat riêng:** tìm bot trên Zalo, nhắn `/id`. Log phải hiện `UPDATE THÔ: ...` và bot trả lời.
2. **Trong nhóm:** thêm bot vào nhóm phòng, gõ `@Bot Trực Nhật P302 /id` (trong nhóm phải @ bot).
   - Bot trả lời là chạy được ✅
   - Log không hiện gì: Zalo chưa gửi tin nhóm cho bot (tính năng nhóm đang Beta). Chụp lại để xử lý tiếp.
3. **Khởi tạo:**
```
@Bot /khoitao                      ← người gõ đầu tiên là admin
@Bot /them Toan, Nam, Hung, Tuan   ← theo thứ tự trực
@Bot /toila Nam                    ← mỗi người tự gõ
@Bot /vesinh Hung, Tuan            ← nhóm dọn vệ sinh (nếu có)
@Bot /help
```

## Vận hành

| Việc | Lệnh |
|---|---|
| Xem log | `npx wrangler tail` |
| Sửa code / cấu hình xong cập nhật | `npx wrangler deploy` (dữ liệu giữ nguyên) |
| Sao lưu dữ liệu | mở `https://.../backup?key=<WEBHOOK_SECRET>` rồi lưu trang |
| Đổi giờ nhắc | sửa `MORNING_TIME` / `REMINDER_TIMES` (giờ Việt Nam) trong `wrangler.toml`, rồi deploy |

**Test trên laptop:** copy `.dev.vars.example` thành `.dev.vars`, điền token, rồi chạy `npm run poll -- --debug`.
Lúc đó cả laptop lẫn Cloudflare cùng hỏi Zalo nên tin có thể rơi vào bên nào cũng được. Test xong nhớ tắt bên laptop đi.

**Gói miễn phí:** cron mỗi phút là 1.440 lần chạy mỗi ngày, mỗi lần chỉ tốn vài ms CPU.
Workers cho 100.000 request/ngày. D1 cho 5 triệu lượt đọc và 100.000 lượt ghi mỗi ngày.
Một phòng KTX dùng chưa tới 5% hạn mức.

## Luật

| Tình huống | Bot xử lý |
|---|---|
| `/xong` | Người trực hôm nay xuống cuối vòng, mai đến người kế tiếp |
| Không `/xong` trước 0h | Hôm sau vẫn người đó. Trốn 2 ngày liền thì bị bêu tên trước cả nhóm kèm joke |
| `/doi Hùng` → Hùng `/dongy` | Hùng trực thay lượt tới của bạn, bạn trực bù vào lượt của Hùng |
| Chống spam đổi | Tối đa 2 lần / 7 ngày · đang trực bù thì không đổi tiếp · bị từ chối/hủy phải đợi 30 phút · lời nhờ hết hạn sau 2 giờ · chỉ nhờ được người trực *sau* mình |
| `/nghi 20/10 26/10` | Tối đa 7 ngày (admin không giới hạn). Không phải bù, lịch tự dồn cho người khác. Về là được trực trước. Không được xin nghỉ đúng ngày mình tới lượt |
| `/tamdung 26/10` (admin) | Cả phòng nghỉ (lễ, Tết) đến hết 26/10: lịch đứng yên, không nhắc, không tính trốn. `/tieptuc` để hủy |
| `/vesinh A, B` (admin) | Nhóm n người: mỗi vòng 1 người dọn vệ sinh (`/xongvs`), n-1 người trực phòng. Hết vòng tự đổi người |
| `/hetnuoc` → `/lay` | Bot gọi người tới lượt, nhắc đến khi có người lấy. Ai lấy thì xuống cuối hàng. Lấy hộ thì người tới lượt vẫn giữ lượt |
| `/doinuoc Long` → Long `/dongy` | Long đi thay, người nhờ lấy bù lượt của Long |

Mọi con số chỉnh được trong `wrangler.toml`. Gõ `/help` để xem lệnh, `/help <lệnh>` để xem chi tiết.
