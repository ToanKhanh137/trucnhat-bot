/**
 * Chạy thử bot ngay trên máy, không cần Zalo.
 *
 * Cú pháp mỗi dòng:
 *   Toan: /khoitao          → người tên "Toan" gõ lệnh trong nhóm
 *   !+1d  !+3h  !+30m       → tua thời gian (bot tự chạy nhắc lịch)
 *   !at 20:00               → tua tới giờ đó (hôm nay hoặc mai)
 *   !now                    → xem giờ hiện tại
 *   !quit                   → thoát
 */
import readline from "node:readline";
import { DutyBot, fmtDay, newState, norm, vnDate, vnMinutes } from "../src/core.js";

const GROUP = "group-demo";
const MIN = 60_000;
const bot = new DutyBot(newState());
let now = Math.floor(Date.now() / MIN) * MIN;
bot.tick(now);

const show = (msgs) => {
  for (const [, text] of msgs) console.log("🤖 " + text.replace(/\n/g, "\n   ") + "\n");
};
const clock = () => {
  const m = vnMinutes(now);
  return `${fmtDay(vnDate(now))} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
// tua từng 30 phút để không bỏ lỡ lần nhắc nào
const advanceTo = (target) => {
  while (now < target) {
    now = Math.min(now + 30 * MIN, target);
    show(bot.tick(now));
  }
};

console.log("Gõ  Tên: /lệnh  (vd  Toan: /khoitao). Tua giờ: !+1d  !+3h  !at 20:00. Thoát: !quit\n");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
process.stdout.write(`[${clock()}] > `);
for await (const raw of rl) {
  const line = raw.replace(/﻿/g, "").trim();
  if (line.startsWith("!")) {
    const cmd = line.slice(1).trim();
    const step = cmd.match(/^\+(\d+)([dhm])$/);
    const at = cmd.match(/^at (\d{1,2}):(\d{2})$/);
    if (step) {
      advanceTo(now + Number(step[1]) * { d: 1440, h: 60, m: 1 }[step[2]] * MIN);
    } else if (at) {
      let delta = Number(at[1]) * 60 + Number(at[2]) - vnMinutes(now);
      if (delta <= 0) delta += 1440;
      advanceTo(now + delta * MIN);
    } else if (cmd === "now") {
      console.log(clock());
    } else if (["quit", "exit", "q"].includes(cmd)) {
      break;
    }
  } else if (line.includes(":")) {
    const i = line.indexOf(":");
    const who = line.slice(0, i).trim();
    show(bot.handle(`u_${norm(who).replace(/ /g, "_")}`, who, GROUP, "GROUP", line.slice(i + 1).trim(), now));
  } else if (line) {
    console.log("Gõ dạng  Tên: /lệnh   (vd  Toan: /khoitao)");
  }
  process.stdout.write(`[${clock()}] > `);
}
rl.close();
