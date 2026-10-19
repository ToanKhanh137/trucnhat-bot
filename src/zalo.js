// Client tối giản cho Zalo Bot API (https://bot.zapps.me/docs). Chạy được cả trên Cloudflare lẫn Node 18+.
const API_URL = "https://bot-api.zaloplatforms.com/bot";
const MAX_TEXT = 2000;

export class ZaloError extends Error {
  constructor(body) {
    super(JSON.stringify(body));
    this.body = body;
    this.code = body?.error_code;
  }
}

export class ZaloClient {
  constructor(token) {
    this.token = token;
  }

  async call(method, payload = {}, timeoutMs = 20_000) {
    const res = await fetch(`${API_URL}${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      body = { ok: false, error_code: res.status, description: raw.slice(0, 300) };
    }
    if (!body.ok) throw new ZaloError(body);
    return body.result;
  }

  getMe() {
    return this.call("getMe");
  }

  setWebhook(url, secretToken) {
    return this.call("setWebhook", { url, secret_token: secretToken });
  }

  deleteWebhook() {
    return this.call("deleteWebhook");
  }

  /** Long polling, chỉ dùng khi chạy thử trên máy (không dùng được khi đang đặt webhook). */
  async getUpdates(timeout = 30) {
    try {
      const result = await this.call("getUpdates", { timeout: String(timeout) }, (timeout + 15) * 1000);
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    } catch (e) {
      if (e.name === "TimeoutError" || e.code === 408) return []; // hết thời gian chờ mà không có tin mới
      throw e;
    }
  }

  async sendMessage(chatId, text) {
    for (let i = 0; i < text.length; i += MAX_TEXT) {
      await this.call("sendMessage", { chat_id: chatId, text: text.slice(i, i + MAX_TEXT) });
    }
  }
}

/** Lấy các trường cần thiết từ một update {message, event_name}; bỏ qua tin không phải chữ. */
export function parseUpdate(upd) {
  if (!upd || typeof upd !== "object") return null;
  const event = upd.event_name || "";
  if (event && event !== "message.text.received") return null;
  const msg = upd.message || {};
  const sender = msg.from || {};
  const chat = msg.chat || {};
  if (sender.is_bot || !msg.text) return null;
  return {
    messageId: msg.message_id ?? null,
    senderId: String(sender.id ?? ""),
    senderName: sender.display_name || "",
    chatId: String(chat.id ?? ""),
    chatType: chat.chat_type || "",
    text: msg.text,
  };
}

export async function sendAll(client, messages, log = console) {
  for (const [chatId, text] of messages) {
    try {
      await client.sendMessage(chatId, text);
    } catch (e) {
      log.error(`Gửi tin tới ${chatId} lỗi: ${e.message}`);
    }
  }
}
