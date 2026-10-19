/**
 * Chạy bot trên máy bằng long polling (không cần Cloudflare) để test với Zalo thật.
 *   node local/poll.js --check            kiểm tra token
 *   node local/poll.js --debug            chạy bot, in nguyên văn mọi update
 *   node local/poll.js --send ID "text"   gửi thử một tin
 * Token đọc từ file .dev.vars (dùng chung với wrangler). Dữ liệu lưu ở data/state.json.
 * Lưu ý: polling không chạy khi đang đặt webhook, nên script tự gỡ webhook. Test xong
 * muốn quay lại Cloudflare thì mở lại link /setup.
 */
import fs from "node:fs";
import path from "node:path";
import { processMessage } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DutyBot, newState } from "../src/core.js";
import { ZaloClient, ZaloError, parseUpdate, sendAll } from "../src/zalo.js";

const STATE_FILE = "data/state.json";

function readVars(file) {
  if (!fs.existsSync(file)) return {};
  const vars = {};
  for (const line of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}

function loadState() {
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : newState();
}

let lastSaved = null;
function saveState(state) {
  const data = JSON.stringify(state, null, 2);
  if (data === lastSaved) return;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(`${STATE_FILE}.tmp`, data);
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  lastSaved = data;
}

const log = (...a) => console.log(new Date().toLocaleTimeString("vi-VN"), ...a);

async function run(client, env, debug) {
  const me = await client.getMe();
  log("Đã kết nối bot:", JSON.stringify(me));
  try {
    await client.deleteWebhook();
  } catch (e) {
    if (!(e instanceof ZaloError)) throw e;
  }
  const state = loadState();
  const bot = new DutyBot(state, loadConfig(env));
  let backoff = 1;
  for (;;) {
    let updates = [];
    try {
      updates = await client.getUpdates(30);
      backoff = 1;
    } catch (e) {
      log(`getUpdates lỗi: ${e.message} (thử lại sau ${backoff}s)`);
      await new Promise((r) => setTimeout(r, backoff * 1000));
      backoff = Math.min(backoff * 2, 60);
    }
    for (const upd of updates) {
      if (debug) log("UPDATE THÔ:", JSON.stringify(upd));
      const msg = parseUpdate(upd);
      if (!msg) continue;
      log(`[${msg.chatType} ${msg.chatId}] ${msg.senderName}: ${msg.text}`);
      await sendAll(client, processMessage(bot, msg, Date.now()));
      saveState(state);
    }
    await sendAll(client, bot.tick(Date.now()));
    saveState(state);
  }
}

const env = { ...readVars(".dev.vars"), ...process.env };
if (!env.BOT_TOKEN) {
  console.error("Thiếu BOT_TOKEN. Copy .dev.vars.example thành .dev.vars rồi dán token vào.");
  process.exit(1);
}
const client = new ZaloClient(env.BOT_TOKEN);
const args = process.argv.slice(2);
if (args.includes("--check")) {
  console.log(JSON.stringify(await client.getMe(), null, 2));
} else if (args.includes("--send")) {
  const i = args.indexOf("--send");
  await client.sendMessage(args[i + 1], args[i + 2]);
  console.log("Đã gửi.");
} else {
  await run(client, env, args.includes("--debug"));
}
