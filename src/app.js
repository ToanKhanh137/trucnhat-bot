// Phần dùng chung cho Worker (Cloudflare) và bản chạy thử trên máy.

/** Xử lý một tin nhắn đã parse: chống trùng, bắt lỗi (lỗi thì trả state về như cũ). */
export function processMessage(bot, msg, now) {
  const s = bot.s;
  if (msg.messageId) {
    if (s.seenIds.includes(msg.messageId)) return [];
    s.seenIds = [...s.seenIds, msg.messageId].slice(-200);
  }
  const snapshot = JSON.stringify(s);
  try {
    return bot.handle(msg.senderId, msg.senderName, msg.chatId, msg.chatType, msg.text, now);
  } catch (e) {
    console.error("Lỗi xử lý lệnh:", e);
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, JSON.parse(snapshot));
    return [[msg.chatId, "😵 Bot gặp lỗi khi xử lý lệnh này."]];
  }
}
