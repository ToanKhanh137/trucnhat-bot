/**
 * Cloudflare Worker: cron chạy mỗi phút, mỗi lần long-poll Zalo (getUpdates) khoảng 70 giây (gối lên lần sau)
 * để nhận tin, đồng thời chạy nhắc lịch. Trạng thái lưu trong D1 (một dòng JSON, khóa lạc quan).
 *
 * Không dùng webhook vì Cloudflare chặn User-Agent "Java/1.8" của máy chủ Zalo trên tên miền
 * workers.dev (lỗi 1010) và không tắt được. Có tên miền riêng thì có thể dùng lại /webhook.
 *
 * Đường dẫn:
 *   GET  /setup?key=SECRET     gỡ webhook (để polling chạy được) và kiểm tra token
 *   GET  /check?key=SECRET     kiểm tra token (getMe)
 *   GET  /backup?key=SECRET    tải dữ liệu JSON về
 *   POST /webhook              dự phòng cho trường hợp dùng tên miền riêng
 */
import { processMessage } from "./app.js";
import { loadConfig } from "./config.js";
import { DutyBot, newState } from "./core.js";
import { ZaloClient, parseUpdate, sendAll } from "./zalo.js";

const SCHEMA = "CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)";
let schemaReady = false;

async function loadState(db) {
  if (!schemaReady) {
    await db.prepare(SCHEMA).run();
    schemaReady = true;
  }
  const row = await db.prepare("SELECT version, data FROM state WHERE id = 1").first();
  return row ? { version: row.version, state: JSON.parse(row.data) } : { version: 0, state: newState() };
}

async function saveState(db, version, state) {
  const data = JSON.stringify(state);
  const res = version === 0
    ? await db.prepare("INSERT OR IGNORE INTO state (id, version, data) VALUES (1, 1, ?)").bind(data).run()
    : await db.prepare("UPDATE state SET version = version + 1, data = ? WHERE id = 1 AND version = ?").bind(data, version).run();
  return res.meta.changes === 1;
}

/** Đọc state → chạy fn(bot) → lưu. Có request khác ghi chen vào thì đọc lại và chạy lại. */
async function withBot(env, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { version, state } = await loadState(env.DB);
    const before = JSON.stringify(state);
    const out = fn(new DutyBot(state, loadConfig(env)));
    if (JSON.stringify(state) === before || (await saveState(env.DB, version, state))) return out;
  }
  throw new Error("Không lưu được trạng thái (xung đột ghi liên tục)");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a || "");
  const y = enc.encode(b || "");
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const client = new ZaloClient(env.BOT_TOKEN);

    if (request.method === "POST" && url.pathname === "/webhook") {
      if (!safeEqual(request.headers.get("X-Bot-Api-Secret-Token"), env.WEBHOOK_SECRET)) {
        return json({ message: "Unauthorized" }, 403);
      }
      const body = await request.json().catch(() => null);
      console.log("UPDATE THÔ:", JSON.stringify(body));
      const msg = parseUpdate(body?.result ?? body);
      if (msg) ctx.waitUntil(handleMessage(env, client, msg));
      return json({ message: "Success" });
    }

    if (request.method === "GET" && ["/setup", "/check", "/backup"].includes(url.pathname)) {
      if (!safeEqual(url.searchParams.get("key"), env.WEBHOOK_SECRET)) return json({ error: "Sai key" }, 403);
      try {
        if (url.pathname === "/check") return json(await client.getMe());
        if (url.pathname === "/backup") return json((await loadState(env.DB)).state);
        await client.deleteWebhook().catch(() => null);
        return json({ message: "Đã gỡ webhook, bot nhận tin bằng polling mỗi phút", bot: await client.getMe() });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return new Response("🧹 Bot trực nhật đang chạy.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },

  async scheduled(controller, env) {
    const client = new ZaloClient(env.BOT_TOKEN);
    await sendAll(client, await withBot(env, (bot) => bot.tick(Date.now())));
    // Zalo không giữ tin gửi lúc không ai đang nghe, nên mỗi lần cron nghe quá 1 phút một chút
    // để gối lên lần sau, không để hở khoảng nào. Tin trùng đã có lọc theo message_id.
    const deadline = controller.scheduledTime + POLL_SECONDS * 1000;
    while (deadline - Date.now() > 2_000) {
      let updates;
      try {
        updates = await client.getUpdates(Math.min(25, Math.floor((deadline - Date.now()) / 1000)));
      } catch (e) {
        // có thể do 2 lần cron cùng nghe một lúc: chờ chút rồi nghe tiếp chứ không bỏ cuộc
        console.error("getUpdates lỗi:", e.message);
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      for (const upd of updates) {
        console.log("UPDATE THÔ:", JSON.stringify(upd));
        const msg = parseUpdate(upd);
        if (msg) await handleMessage(env, client, msg);
      }
    }
  },
};

const POLL_SECONDS = 70;

async function handleMessage(env, client, msg) {
  console.log(`[${msg.chatType} ${msg.chatId}] ${msg.senderName}: ${msg.text}`);
  await sendAll(client, await withBot(env, (bot) => processMessage(bot, msg, Date.now())));
}
