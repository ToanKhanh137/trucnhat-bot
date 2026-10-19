/**
 * Logic lịch trực nhật. Không phụ thuộc Zalo hay Cloudflare nên test được độc lập.
 *
 * Trực phòng: một hàng đợi cố định thứ tự. Người trực hôm nay là người đầu hàng
 * không đang nghỉ (và không phải người dọn vệ sinh vòng này). /xong thì xuống
 * cuối hàng. Không /xong thì vẫn đứng đầu → hôm sau trực tiếp. Người nghỉ giữ
 * nguyên chỗ nên khi về đứng đầu hàng → được ưu tiên trực trước.
 * Đổi lượt = hoán đổi vị trí 2 người trong hàng, người nhờ ghi nợ.
 *
 * Vệ sinh: trong nhóm n người, mỗi vòng 1 người dọn vệ sinh (lúc nào cũng được),
 * n-1 người còn lại vào vòng trực phòng. Một vòng = (số người trực phòng) lượt /xong.
 *
 * Lấy nước: hàng đợi riêng, không theo ngày. Ai /lay thì xuống cuối hàng.
 *
 * Ngày lưu dạng "YYYY-MM-DD" theo giờ Việt Nam, thời điểm lưu dạng mili-giây.
 */
import { DEFAULT_CONFIG } from "./config.js";
import { MISSED, PRAISE, REMINDER, SHAME } from "./jokes.js";

const DAY_MS = 86_400_000;
const VN_OFFSET_MS = 7 * 3_600_000;
const THU = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const CMD_RE = /(?:^|\s)\/([\p{L}\p{M}\p{N}_]+)([\s\S]*)$/u;
const DATE_RE = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g;
const LEAVE_FILLER = new Set(["tu", "den", "toi", "ngay", "-"]);
const YESTERDAY_RE = /(^|\s)hom ?qua(\s|$)/; // "homqua", "hôm qua" (sau khi norm)

export class UserError extends Error {}

// ---------- ngày giờ ----------
const isoOf = (d) => d.toISOString().slice(0, 10);
export const vnDate = (ms) => isoOf(new Date(ms + VN_OFFSET_MS));
export const vnMinutes = (ms) => {
  const d = new Date(ms + VN_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
export const addDays = (day, n) => isoOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
export const fmtDay = (day) => `${THU[new Date(`${day}T00:00:00Z`).getUTCDay()]} ${day.slice(8, 10)}/${day.slice(5, 7)}`;
const hm = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
const humanMinutes = (n) => (n % 60 === 0 ? `${n / 60} giờ` : `${n} phút`);

function makeDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new UserError("Ngày không hợp lệ.");
  }
  return isoOf(dt);
}

function toDate(dd, mm, yy, today) {
  if (yy) return makeDate(Number(yy) + (yy.length === 2 ? 2000 : 0), Number(mm), Number(dd));
  const year = Number(today.slice(0, 4));
  let d = makeDate(year, Number(mm), Number(dd));
  if (d < addDays(today, -60)) d = makeDate(year + 1, Number(mm), Number(dd));
  return d;
}

// ---------- chữ ----------
export function norm(s) {
  return (s || "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/^@+/, "")
    .trim()
    .replace(/\s+/g, " ");
}

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));

export function splitNames(args) {
  const parts = args.includes(",") ? args.split(",") : args.split(/\s+/);
  return parts.map((p) => p.trim().replace(/^@+/, "").trim()).filter(Boolean);
}

function parseDates(args, today) {
  const dates = [...args.matchAll(DATE_RE)].map((m) => toDate(m[1], m[2], m[3], today));
  const tokens = args
    .replace(DATE_RE, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter((t) => t && !LEAVE_FILLER.has(norm(t)));
  return { dates, tokens };
}

/** '20/10 26/10', '20/10', '3' (3 ngày từ mai), có thể kèm tên phía trước. */
export function parseLeave(args, today) {
  const { dates, tokens } = parseDates(args, today);
  let start, end;
  if (dates.length) {
    [start, end] = [dates[0], dates.at(-1)];
  } else if (tokens.length && /^\d+$/.test(tokens.at(-1))) {
    const n = Number(tokens.pop());
    if (n < 1) throw new UserError("Số ngày phải ≥ 1.");
    start = addDays(today, 1);
    end = addDays(start, n - 1);
  } else {
    throw new UserError("Cú pháp: /nghi 20/10 26/10  hoặc  /nghi 3 (nghỉ 3 ngày từ mai)");
  }
  return { name: tokens.join(" "), start, end };
}

/** '26/10' (từ hôm nay đến hết 26/10), '20/10 26/10', '3' (3 ngày tính cả hôm nay). */
export function parseFreeze(args, today) {
  const { dates, tokens } = parseDates(args, today);
  if (dates.length >= 2) return { start: dates[0], end: dates.at(-1) };
  if (dates.length === 1) return { start: today, end: dates[0] };
  if (tokens.length && /^\d+$/.test(tokens.at(-1)) && Number(tokens.at(-1)) >= 1) {
    return { start: today, end: addDays(today, Number(tokens.at(-1)) - 1) };
  }
  throw new UserError("Cú pháp: /tamdung 26/10 (từ hôm nay đến hết 26/10)  hoặc  /tamdung 20/10 26/10");
}

// ---------- trạng thái ----------
const newToilet = () => ({ group: [], current: null, progress: 0, doneCycle: false });

export function newState() {
  return {
    version: 3,
    groupChatId: null,
    adminIds: [],
    members: {}, // id -> {name, zaloId, displayName}
    nextId: 1,
    queue: [], // thứ tự vòng trực phòng, đầu hàng = trực kế tiếp
    leaves: {}, // id -> {start, end}
    freeze: null, // {start, end}: cả phòng tạm dừng trực
    debts: {}, // người nhờ -> người được nhờ (đang trực bù)
    missStreak: {},
    swapLog: {},
    swapCooldown: {},
    pendingSwaps: {}, // người nhờ -> {to, created, date}
    toilet: newToilet(),
    water: { queue: [], debts: {}, pending: {}, emptySince: null, last: null },
    lastDone: null, // {date, member}
    lastMiss: null, // {date, member, fixed}: người bị tính quên trực gần nhất
    history: [],
    lastClosedDate: null,
    lastAliveDate: null,
    lastMorningDate: null,
    lastReminderSlot: null,
    pendingNotes: [], // [{kind: note|shame, text}] gửi kèm tin buổi sáng
    seenIds: [], // message_id đã xử lý, chống Zalo gửi trùng
  };
}

export class DutyBot {
  constructor(state, cfg = {}, rng = Math.random) {
    this.s = state;
    for (const [k, v] of Object.entries(newState())) if (!(k in state)) state[k] = v;
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.rng = rng;
    this.out = [];
    this.src = null;
  }

  choice(list) {
    return list[Math.floor(this.rng() * list.length)];
  }

  // ---------- tra cứu ----------
  name(mid) {
    return this.s.members[mid]?.name ?? "(đã xóa)";
  }

  memberOf(zaloId) {
    for (const [mid, m] of Object.entries(this.s.members)) if (m.zaloId === zaloId) return mid;
    return null;
  }

  isAdmin(zaloId) {
    return this.s.adminIds.includes(zaloId);
  }

  onLeave(mid, day) {
    const lv = this.s.leaves[mid];
    return Boolean(lv) && lv.start <= day && day <= lv.end;
  }

  frozen(day) {
    const f = this.s.freeze;
    return Boolean(f) && f.start <= day && day <= f.end;
  }

  doneOn(day) {
    return this.s.lastDone?.date === day;
  }

  roomFree(mid, day, toilet) {
    return mid !== toilet && !this.onLeave(mid, day);
  }

  static cycleSize(q, toilet) {
    return Math.max(1, q.length - (q.includes(toilet) ? 1 : 0));
  }

  nextToilet(cur) {
    const group = this.s.toilet.group.filter((m) => m in this.s.members);
    if (!group.length) return null;
    if (!group.includes(cur)) return group[0];
    return group[(group.indexOf(cur) + 1) % group.length];
  }

  todayDuty(today) {
    if (this.doneOn(today) || this.frozen(today)) return null;
    const toilet = this.s.toilet.current;
    return this.s.queue.find((m) => this.roomFree(m, today, toilet)) ?? null;
  }

  /** Mô phỏng lịch trực phòng, tính cả nghỉ, tạm dừng, trực bù và đổi người vệ sinh. */
  plan(start, days) {
    const q = [...this.s.queue];
    const owed = { ...this.s.debts };
    let { current: toilet, progress } = this.s.toilet;
    const out = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(start, i);
      if (i === 0 && this.doneOn(date)) {
        out.push({ date, member: this.s.lastDone.member, kind: "done", owed: null, toilet });
        continue;
      }
      if (this.frozen(date)) {
        out.push({ date, member: null, kind: "frozen", owed: null, toilet });
        continue;
      }
      const mid = q.find((m) => this.roomFree(m, date, toilet)) ?? null;
      out.push({ date, member: mid, kind: "plan", owed: mid ? owed[mid] ?? null : null, toilet });
      if (!mid) continue;
      delete owed[mid];
      q.splice(q.indexOf(mid), 1);
      q.push(mid);
      if (toilet) {
        progress += 1;
        if (progress >= DutyBot.cycleSize(q, toilet)) {
          toilet = this.nextToilet(toilet);
          progress = 0;
        }
      }
    }
    return out;
  }

  nextTurn(mid, today) {
    const horizon = 2 * this.s.queue.length + 60;
    return this.plan(today, horizon).find((d) => d.member === mid && d.kind === "plan")?.date ?? null;
  }

  /** Người trực ngày mai, giả định hôm nay trực xong. */
  tomorrow(today) {
    return this.plan(today, 2)[1];
  }

  waterNext(today) {
    return this.s.water.queue.find((m) => !this.onLeave(m, today)) ?? null;
  }

  find(query) {
    const q = norm(query);
    const queue = this.s.queue;
    if (!q) return [null, "Thiếu tên."];
    if (/^\d+$/.test(q)) {
      const i = Number(q) - 1;
      if (i >= 0 && i < queue.length) return [queue[i], null];
      return [null, `Không có số thứ tự ${q}. Xem /ds.`];
    }
    const names = (m) => [norm(m.name), ...(m.displayName ? [norm(m.displayName)] : [])];
    const entries = Object.entries(this.s.members);
    const exact = entries.filter(([, m]) => names(m).includes(q)).map(([id]) => id);
    if (exact.length === 1) return [exact[0], null];
    const partial = exact.length
      ? exact
      : entries.filter(([, m]) => names(m).some((n) => n.includes(q))).map(([id]) => id);
    if (partial.length === 1) return [partial[0], null];
    if (partial.length) {
      return [null, `'${query}' khớp nhiều người: ${partial.map((m) => this.name(m)).join(", ")}. Gõ rõ hơn.`];
    }
    return [null, `Không tìm thấy '${query}'. Xem /ds.`];
  }

  /** Tìm tên, báo lỗi nếu không thấy. */
  findOrSay(query) {
    const [mid, err] = this.find(query);
    if (err) this.say(err);
    return mid;
  }

  // ---------- gửi tin ----------
  say(text) {
    this.out.push([this.src, text]);
  }

  announce(text) {
    const group = this.s.groupChatId;
    if (group) this.out.push([group, text]);
    if (this.src && this.src !== group) this.out.push([this.src, text]);
  }

  requireAdmin(ctx) {
    if (this.isAdmin(ctx.senderId)) return true;
    this.say("Lệnh này chỉ admin dùng được.");
    return false;
  }

  requireMember(ctx) {
    const mid = this.memberOf(ctx.senderId);
    if (!mid) this.say("Bạn chưa liên kết Zalo với tên nào. Gõ /toila <tên> (xem tên ở /ds).");
    return mid;
  }

  // ---------- nhận lệnh ----------
  /** Xử lý một tin nhắn. Trả về [[chatId, text], ...]. */
  handle(senderId, senderName, chatId, chatType, text, now) {
    this.out = [];
    this.src = chatId;
    const m = CMD_RE.exec(text || "");
    if (!m) return [];
    const cmd = norm(m[1]); // /nghỉ, /đổi cũng được
    const args = m[2].trim();
    const isGroup = String(chatType || "").toUpperCase() === "GROUP";
    const group = this.s.groupChatId;
    if (group && isGroup && chatId !== group && cmd !== "khoitao") return [];
    const method = COMMANDS[cmd];
    if (!method) {
      this.say(`Không có lệnh /${cmd}. Gõ /help để xem danh sách lệnh.`);
      return this.out;
    }
    if (group === null && !SETUP_FREE.has(cmd)) {
      this.say("Bot chưa được khởi tạo. Admin hãy gõ /khoitao trong nhóm phòng.");
      return this.out;
    }
    const ctx = { senderId: String(senderId), senderName: senderName || "", chatId, isGroup, args, now, today: vnDate(now) };
    this.rollDays(ctx.today);
    const me = this.memberOf(ctx.senderId);
    if (me && senderName) this.s.members[me].displayName = senderName;
    for (const t of this.expireSwaps(now)) this.announce(t);
    try {
      this[method](ctx);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      this.say(e.message);
    }
    return this.out;
  }

  // ---------- lệnh chung ----------
  cmdHelp(ctx) {
    const c = this.cfg;
    const values = {
      max: c.maxLeaveDays, shame: c.shameStreak, lim: c.swapLimit, win: c.swapWindowDays,
      timeout: humanMinutes(c.swapTimeoutMinutes), cooldown: c.swapCooldownMinutes, late: c.lateConfirmUntil,
    };
    const topic = ctx.args ? norm(ctx.args).replace(/^\/+/, "").split(" ")[0] : "";
    let text;
    if (!topic) text = HELP;
    else if (topic === "admin") text = HELP_ADMIN;
    else if (["luat", "rule", "rules"].includes(topic)) text = HELP_RULES;
    else {
      const method = COMMANDS[topic];
      const key = method && Object.keys(HELP_DETAIL).find((k) => COMMANDS[k] === method);
      text = key ? HELP_DETAIL[key] : `Không có lệnh /${topic}. Gõ /help để xem danh sách.`;
    }
    this.say(fill(text, values));
  }

  cmdId(ctx) {
    this.say(`Zalo ID của bạn: ${ctx.senderId}\nChat ID: ${ctx.chatId} (${ctx.isGroup ? "nhóm" : "chat riêng"})`);
  }

  cmdKhoitao(ctx) {
    const s = this.s;
    if (s.groupChatId === null) {
      if (!ctx.isGroup) {
        this.say("Hãy thêm bot vào nhóm phòng rồi gõ /khoitao trong nhóm.");
        return;
      }
      s.groupChatId = ctx.chatId;
      s.adminIds = [ctx.senderId];
      this.say(
        `🧹 Đã khởi tạo bot trực nhật cho nhóm này. ${ctx.senderName || "Bạn"} là admin 👑\n` +
          "Bước tiếp:\n" +
          "1. Admin: /them Tên1, Tên2, Tên3 (theo thứ tự trực)\n" +
          "2. Mỗi người: /toila <Tên của mình>\n" +
          "3. Nếu có nhóm dọn vệ sinh: /vesinh Tên1, Tên2\n" +
          "4. Xem lịch: /lich",
      );
    } else if (ctx.chatId === s.groupChatId) {
      const admins = s.adminIds.map((a) => (this.memberOf(a) ? this.name(this.memberOf(a)) : a));
      this.say(`Nhóm này đã khởi tạo rồi. Admin: ${admins.join(", ")}`);
    } else if (ctx.isGroup && this.isAdmin(ctx.senderId)) {
      s.groupChatId = ctx.chatId;
      this.say("Đã chuyển bot sang nhóm này (dữ liệu lịch giữ nguyên).");
    } else {
      this.say("Bot đang phục vụ nhóm khác.");
    }
  }

  cmdToila(ctx) {
    if (!ctx.args) {
      this.say("Cú pháp: /toila <tên của bạn trong /ds>");
      return;
    }
    const mid = this.findOrSay(ctx.args);
    if (!mid) return;
    const current = this.memberOf(ctx.senderId);
    const m = this.s.members[mid];
    if (current && current !== mid) {
      this.say(`Zalo của bạn đã liên kết với ${this.name(current)} rồi.`);
      return;
    }
    if (m.zaloId && m.zaloId !== ctx.senderId) {
      this.say(`${m.name} đã liên kết với Zalo khác. Nhờ admin /huylk ${m.name} nếu nhầm.`);
      return;
    }
    m.zaloId = ctx.senderId;
    m.displayName = ctx.senderName || null;
    this.say(`🔗 Đã liên kết: ${ctx.senderName || "bạn"} = ${m.name}`);
  }

  cmdHomnay(ctx) {
    const today = ctx.today;
    const lines = [];
    if (this.frozen(today)) {
      lines.push(`🧊 Đang tạm dừng trực đến hết ${fmtDay(this.s.freeze.end)}.`);
    } else if (this.doneOn(today)) {
      lines.push(`Hôm nay (${fmtDay(today)}) ${this.name(this.s.lastDone.member)} đã trực rồi ✅`);
    } else {
      const td = this.todayDuty(today);
      if (!td) {
        lines.push(this.s.queue.length ? "Hôm nay không ai phải trực." : "Chưa có ai. Admin gõ /them A, B, C");
      } else {
        const owed = this.s.debts[td];
        const extra = owed ? ` (trực bù cho ${this.name(owed)})` : "";
        lines.push(`🧹 Hôm nay (${fmtDay(today)}): ${this.name(td)} trực${extra}. Xong gõ /xong nhé.`);
      }
    }
    lines.push(...this.toiletLines(), ...this.waterLines(today));
    this.say(lines.join("\n"));
  }

  cmdLich(ctx) {
    if (!this.s.queue.length) {
      this.say("Chưa có ai trong danh sách. Admin gõ /them A, B, C");
      return;
    }
    const first = ctx.args.split(/\s+/)[0];
    const n = /^\d+$/.test(first) ? Math.max(1, Math.min(30, Number(first))) : 7;
    const lines = [`📅 Lịch ${n} ngày tới:`];
    const days = this.plan(ctx.today, n);
    if (days[0]?.toilet) lines.push(`🚽 Vệ sinh vòng này: ${this.name(days[0].toilet)}`);
    let prevToilet = days[0]?.toilet ?? null;
    for (const day of days) {
      if (day.toilet !== prevToilet) {
        lines.push(`🔁 Hết vòng, 🚽 ${this.name(day.toilet)} dọn vệ sinh vòng mới`);
        prevToilet = day.toilet;
      }
      const label = fmtDay(day.date) + (day.date === ctx.today ? " (hôm nay)" : "");
      if (day.kind === "frozen") lines.push(`${label}: 🧊 tạm dừng`);
      else if (!day.member) lines.push(`${label}: (cả phòng nghỉ)`);
      else if (day.kind === "done") lines.push(`${label}: ${this.name(day.member)} ✅`);
      else lines.push(`${label}: ${this.name(day.member)}` + (day.owed ? ` (bù cho ${this.name(day.owed)})` : ""));
    }
    lines.push(...this.leaveLines(ctx.today));
    this.say(lines.join("\n"));
  }

  leaveLines(today) {
    return Object.entries(this.s.leaves)
      .filter(([, lv]) => lv.end >= today)
      .map(([mid, lv]) => `🏖 ${this.name(mid)} nghỉ ${fmtDay(lv.start)} → ${fmtDay(lv.end)}`);
  }

  toiletLines() {
    const t = this.s.toilet;
    if (!t.current) return [];
    const left = DutyBot.cycleSize(this.s.queue, t.current) - t.progress;
    const status = t.doneCycle ? "✅ đã xong" : `chưa xong, còn ${left} lượt trực phòng là hết vòng`;
    return [`🚽 Vệ sinh vòng này: ${this.name(t.current)} (${status})`];
  }

  waterLines(today) {
    const nxt = this.waterNext(today);
    if (!nxt) return [];
    if (this.s.water.emptySince) return [`🚱 Đang hết nước! @${this.name(nxt)} đi lấy nhé (xong gõ /lay).`];
    return [`💧 Lượt lấy nước kế tiếp: ${this.name(nxt)}`];
  }

  cmdDs(ctx) {
    const s = this.s;
    if (!s.queue.length) {
      this.say("Chưa có ai. Admin gõ /them A, B, C");
      return;
    }
    const td = this.todayDuty(ctx.today);
    const lines = ["👥 Thứ tự vòng trực (trên cùng = trực sớm nhất):"];
    s.queue.forEach((mid, i) => {
      const m = s.members[mid];
      const flags = [];
      if (mid === td) flags.push("👉 hôm nay");
      if (mid === s.toilet.current) flags.push("🚽 dọn vệ sinh vòng này");
      const lv = s.leaves[mid];
      if (lv && lv.end >= ctx.today) flags.push(`🏖 nghỉ ${fmtDay(lv.start)}→${fmtDay(lv.end)}`);
      if (s.debts[mid]) flags.push(`trực bù cho ${this.name(s.debts[mid])}`);
      if (s.missStreak[mid]) flags.push(`⚠️ trốn ${s.missStreak[mid]} ngày`);
      if (!m.zaloId) flags.push("chưa /toila");
      else if (this.isAdmin(m.zaloId)) flags.push("👑");
      lines.push(`${i + 1}. ${m.name}` + (flags.length ? ` — ${flags.join(", ")}` : ""));
    });
    if (s.freeze) lines.push(`🧊 Tạm dừng ${fmtDay(s.freeze.start)} → ${fmtDay(s.freeze.end)}`);
    this.say(lines.join("\n"));
  }

  // ---------- trực phòng ----------
  cmdXong(ctx) {
    const today = ctx.today;
    if (YESTERDAY_RE.test(norm(ctx.args))) {
      this.xongHomqua(ctx);
      return;
    }
    if (this.frozen(today)) {
      this.say("Đang tạm dừng trực, không cần /xong đâu 🧊");
      return;
    }
    if (this.doneOn(today)) {
      this.say(`Hôm nay ${this.name(this.s.lastDone.member)} trực rồi. Nghỉ ngơi đi 😎`);
      return;
    }
    const td = this.todayDuty(today);
    if (!td) {
      this.say("Hôm nay không ai phải trực.");
      return;
    }
    let target;
    if (ctx.args) {
      if (!this.requireAdmin(ctx)) return;
      target = this.findOrSay(ctx.args);
    } else {
      target = this.requireMember(ctx);
    }
    if (!target) return;
    if (target !== td) {
      this.say(`Hôm nay là lượt của ${this.name(td)}, không phải ${this.name(target)}.`);
      return;
    }
    this.complete(td, today);
  }

  complete(mid, today) {
    let text = fill(this.choice(PRAISE), { name: this.name(mid) }) + this.markDone(mid, today);
    const nxt = this.tomorrow(today);
    if (nxt.member) text += `\nMai (${fmtDay(nxt.date)}): ${this.name(nxt.member)}`;
    this.announce(text);
  }

  /** Ghi nhận mid đã trực ngày `day`: xuống cuối vòng, hết nợ, tính vòng vệ sinh. Trả về phần chữ báo thêm. */
  markDone(mid, day) {
    const s = this.s;
    s.queue.splice(s.queue.indexOf(mid), 1);
    s.queue.push(mid);
    s.lastDone = { date: day, member: mid };
    delete s.missStreak[mid];
    const owed = s.debts[mid];
    delete s.debts[mid];
    delete s.pendingSwaps[mid];
    s.history = [...s.history, { date: day, member: mid }].slice(-60);
    let text = owed ? `\n(Đã trực bù cho ${this.name(owed)}, hết nợ!)` : "";
    const t = s.toilet;
    if (t.current) {
      t.progress += 1;
      if (t.progress >= DutyBot.cycleSize(s.queue, t.current)) text += "\n" + this.rotateToilet();
    }
    return text;
  }

  /** /xong homqua: quên bấm /xong hôm qua thì xác nhận bù (người đó hoặc admin), trước giờ hạn. */
  xongHomqua(ctx) {
    const s = this.s;
    const today = ctx.today;
    const yesterday = addDays(today, -1);
    const miss = s.lastMiss;
    if (!miss || miss.date !== yesterday || !s.members[miss.member]) {
      this.say("Hôm qua không có ai bị tính quên trực.");
      return;
    }
    const target = miss.member;
    const name = this.name(target);
    if (miss.fixed) {
      this.say(`${name} đã xác nhận bù cho hôm qua rồi.`);
      return;
    }
    if (vnMinutes(ctx.now) >= hm(this.cfg.lateConfirmUntil)) {
      this.say(`Quá ${this.cfg.lateConfirmUntil} rồi, không xác nhận bù cho hôm qua được nữa.`);
      return;
    }
    const nameArg = norm(ctx.args).replace(YESTERDAY_RE, " ").trim();
    const admin = this.isAdmin(ctx.senderId);
    if (nameArg) {
      const mid = this.findOrSay(nameArg);
      if (!mid) return;
      if (mid !== target) {
        this.say(`Hôm qua là lượt của ${name}, không phải ${this.name(mid)}.`);
        return;
      }
    }
    if (this.memberOf(ctx.senderId) !== target && !admin) {
      this.say(`Chỉ ${name} hoặc admin mới xác nhận bù cho hôm qua được.`);
      return;
    }
    // gỡ lỗi quên hôm qua (tin bêu tên chưa gửi thì bỏ luôn)
    const streak = (s.missStreak[target] || 1) - 1;
    if (streak > 0) s.missStreak[target] = streak;
    else delete s.missStreak[target];
    s.pendingNotes = s.pendingNotes.filter((n) => !(n.member === target && n.date === yesterday));
    miss.fixed = true;
    let text = `✅ ${name} xác nhận bù: hôm qua (${fmtDay(yesterday)}) đã trực` +
      (this.memberOf(ctx.senderId) === target ? "." : ` (admin xác nhận hộ).`);
    // nếu người đó vẫn đang đứng đầu hàng (bị giữ lại vì quên) thì cho xuống cuối như đã trực
    if (this.todayDuty(today) === target) {
      text += this.markDone(target, yesterday);
      const td = this.todayDuty(today);
      if (td) text += `\nHôm nay (${fmtDay(today)}): ${this.name(td)} trực.`;
    }
    this.announce(text);
  }

  // ---------- vệ sinh ----------
  rotateToilet() {
    const t = this.s.toilet;
    const old = t.current;
    const next = this.nextToilet(old);
    const lines = [];
    if (old && !t.doneCycle) lines.push(`😒 ${this.name(old)} chưa /xongvs vòng vừa rồi đâu nhé.`);
    Object.assign(t, { current: next, progress: 0, doneCycle: false });
    if (next === old) {
      lines.push(`🔁 Hết vòng! 🚽 ${this.name(next)} tiếp tục dọn vệ sinh vòng mới (xong gõ /xongvs).`);
    } else {
      lines.push(
        `🔁 Hết vòng! 🚽 Vòng mới ${this.name(next)} dọn vệ sinh (lúc nào cũng được, ` +
          `xong gõ /xongvs). ${this.name(old)} quay lại trực phòng.`,
      );
    }
    return lines.join("\n");
  }

  cmdVesinh(ctx) {
    const t = this.s.toilet;
    if (!ctx.args) {
      if (!t.group.length) {
        this.say("Chưa có nhóm vệ sinh. Admin gõ /vesinh Tên1, Tên2");
        return;
      }
      const group = t.group.map((m) => this.name(m)).join(", ");
      this.say([`🚽 Nhóm vệ sinh: ${group}`, ...this.toiletLines()].join("\n"));
      return;
    }
    if (!this.requireAdmin(ctx)) return;
    if (["tat", "xoa", "off", "huy"].includes(norm(ctx.args))) {
      this.s.toilet = newToilet();
      this.announce("🚽 Đã tắt nhóm vệ sinh, mọi người đều vào vòng trực phòng.");
      return;
    }
    const picked = [];
    for (const n of splitNames(ctx.args)) {
      const mid = this.findOrSay(n);
      if (!mid) return;
      if (!picked.includes(mid)) picked.push(mid);
    }
    if (!picked.length) {
      this.say("Cú pháp: /vesinh Tên1, Tên2");
      return;
    }
    // người đứng cuối hàng trực phòng (vừa trực xong gần nhất) dọn vệ sinh trước
    const q = this.s.queue;
    const current = picked.reduce((a, b) => (q.indexOf(b) > q.indexOf(a) ? b : a));
    this.s.toilet = { group: picked, current, progress: 0, doneCycle: false };
    const others = picked.filter((m) => m !== current).map((m) => this.name(m));
    this.announce(
      `🚽 Nhóm vệ sinh: ${picked.map((m) => this.name(m)).join(", ")}.\n` +
        `Vòng này ${this.name(current)} dọn vệ sinh (lúc nào cũng được, xong gõ /xongvs)` +
        (others.length ? `, ${others.join(", ")} trực phòng như thường.` : ".") +
        "\nHết mỗi vòng trực phòng sẽ tự đổi người.",
    );
  }

  cmdXongvs(ctx) {
    const t = this.s.toilet;
    if (!t.current) {
      this.say("Chưa có nhóm vệ sinh.");
      return;
    }
    const me = this.requireMember(ctx);
    if (!me) return;
    if (me !== t.current) {
      this.say(`Vòng này ${this.name(t.current)} dọn vệ sinh, không phải bạn.`);
      return;
    }
    if (t.doneCycle) {
      this.say("Vòng này bạn dọn rồi, nghỉ đi 😎");
      return;
    }
    t.doneCycle = true;
    this.announce(`🚽✨ ${this.name(me)} đã dọn vệ sinh xong vòng này! Thơm phức.`);
  }

  // ---------- tạm dừng ----------
  cmdTamdung(ctx) {
    if (!ctx.args) {
      const f = this.s.freeze;
      if (f) this.say(`🧊 Đang đặt tạm dừng ${fmtDay(f.start)} → ${fmtDay(f.end)}. Admin gõ /tieptuc để hủy.`);
      else this.say("Cú pháp: /tamdung 26/10 (từ hôm nay đến hết 26/10)  hoặc  /tamdung 20/10 26/10");
      return;
    }
    if (!this.requireAdmin(ctx)) return;
    const { start, end } = parseFreeze(ctx.args, ctx.today);
    if (start < ctx.today || end < start) {
      this.say("Khoảng ngày không hợp lệ (không được ở quá khứ, ngày kết thúc phải sau ngày bắt đầu).");
      return;
    }
    this.s.freeze = { start, end };
    const resume = this.plan(ctx.today, daysBetween(ctx.today, end) + 2).at(-1);
    this.announce(
      `🧊 Tạm dừng trực từ ${fmtDay(start)} đến hết ${fmtDay(end)}. Về quê vui vẻ!\n` +
        `Trực lại từ ${fmtDay(resume.date)}` + (resume.member ? `: ${this.name(resume.member)}.` : "."),
    );
  }

  cmdTieptuc(ctx) {
    if (!this.requireAdmin(ctx)) return;
    if (!this.s.freeze) {
      this.say("Đang không tạm dừng.");
      return;
    }
    this.s.freeze = null;
    const td = this.todayDuty(ctx.today);
    this.announce("🔥 Hủy tạm dừng, trực lại bình thường!" + (td ? ` Hôm nay: ${this.name(td)}.` : ""));
  }

  // ---------- đổi lượt ----------
  cmdDoi(ctx) {
    const s = this.s;
    const c = this.cfg;
    const me = this.requireMember(ctx);
    if (!me) return;
    if (!ctx.args) {
      this.say("Cú pháp: /doi <tên người trực thay>");
      return;
    }
    if (s.debts[me]) {
      this.say(`Bạn đang trực bù cho ${this.name(s.debts[me])}. Trả nợ xong mới được đổi tiếp 😤`);
      return;
    }
    if (s.pendingSwaps[me]) {
      this.say(`Bạn đang nhờ ${this.name(s.pendingSwaps[me].to)}, chờ trả lời. Gõ /huydoi để hủy.`);
      return;
    }
    const cd = s.swapCooldown[me];
    if (cd && ctx.now < cd) {
      this.say(`Từ từ đã, ${Math.floor((cd - ctx.now) / 60_000) + 1} phút nữa mới được nhờ đổi tiếp.`);
      return;
    }
    const since = addDays(ctx.today, -(c.swapWindowDays - 1));
    const used = (s.swapLog[me] || []).filter((d) => d >= since);
    if (used.length >= c.swapLimit) {
      this.say(
        `Bạn đã đổi ${used.length} lần trong ${c.swapWindowDays} ngày qua (tối đa ${c.swapLimit}). ` +
          "Lần này tự trực đi nha 💪",
      );
      return;
    }
    const target = this.findOrSay(ctx.args);
    if (!target) return;
    if (target === me) {
      this.say("Tự đổi với chính mình à? 🤨");
      return;
    }
    const tname = this.name(target);
    if (!s.members[target].zaloId) {
      this.say(`${tname} chưa /toila nên không trả lời được.`);
      return;
    }
    const toilet = s.toilet.current;
    if (toilet && (toilet === me || toilet === target)) {
      this.say(`${this.name(toilet)} đang dọn vệ sinh vòng này nên không đổi lượt trực phòng được.`);
      return;
    }
    const dMe = this.nextTurn(me, ctx.today);
    const dT = this.nextTurn(target, ctx.today);
    if (!dMe) {
      this.say("Bạn chưa có lượt nào sắp tới.");
      return;
    }
    if (!dT) {
      this.say(`${tname} chưa có lượt nào sắp tới nên không đổi được.`);
      return;
    }
    if (dT <= dMe) {
      this.say(`${tname} trực trước bạn (${fmtDay(dT)}) rồi, không đổi được.`);
      return;
    }
    if (this.onLeave(target, dMe)) {
      this.say(`${tname} nghỉ vào ${fmtDay(dMe)}, nhờ người khác nhé.`);
      return;
    }
    s.pendingSwaps[me] = { to: target, created: ctx.now, date: dMe };
    this.announce(
      `🔄 ${this.name(me)} nhờ ${tname} trực thay ngày ${fmtDay(dMe)}.\n` +
        `Đổi lại ${this.name(me)} sẽ trực bù lượt của ${tname} (${fmtDay(dT)}).\n` +
        `${tname} gõ /dongy hoặc /tuchoi (hết hạn sau ${humanMinutes(c.swapTimeoutMinutes)}).`,
    );
  }

  /** Các lời nhờ (trực phòng hoặc lấy nước) đang gửi tới me → {kind, from}. */
  incoming(ctx, me) {
    let list = [
      ...Object.entries(this.s.pendingSwaps).filter(([, p]) => p.to === me).map(([r]) => ({ kind: "room", from: r })),
      ...Object.entries(this.s.water.pending).filter(([, p]) => p.to === me).map(([r]) => ({ kind: "water", from: r })),
    ];
    if (ctx.args) {
      const r = this.findOrSay(ctx.args);
      if (!r) return null;
      list = list.filter((x) => x.from === r);
    }
    if (!list.length) {
      this.say("Không có ai đang nhờ bạn đổi lượt.");
      return null;
    }
    if (list.length > 1) {
      const names = list
        .map((x) => `${this.name(x.from)} (${x.kind === "water" ? "lấy nước" : "trực phòng"})`)
        .join(", ");
      this.say(`Có nhiều lời nhờ: ${names}. Gõ kèm tên, vd /dongy ${this.name(list[0].from)}`);
      return null;
    }
    return list[0];
  }

  cmdDongy(ctx) {
    const me = this.requireMember(ctx);
    if (!me) return;
    const found = this.incoming(ctx, me);
    if (!found) return;
    const r = found.from;
    if (found.kind === "water") {
      this.acceptWater(r, me);
      return;
    }
    const s = this.s;
    delete s.pendingSwaps[r];
    const dR = this.nextTurn(r, ctx.today);
    const dT = this.nextTurn(me, ctx.today);
    if (!dR || !dT || dT <= dR || this.onLeave(me, dR)) {
      this.announce("Lịch đã thay đổi nên lời nhờ đổi không còn hợp lệ.");
      return;
    }
    const q = s.queue;
    const i = q.indexOf(r);
    const j = q.indexOf(me);
    [q[i], q[j]] = [q[j], q[i]];
    s.debts[r] = me;
    s.swapLog[r] = [...(s.swapLog[r] || []), ctx.today].slice(-20);
    const newT = this.nextTurn(me, ctx.today);
    const newR = this.nextTurn(r, ctx.today);
    this.announce(
      `🤝 Chốt đơn! ${this.name(me)} trực ${fmtDay(newT)} thay ${this.name(r)}.\n` +
        `${this.name(r)} trực bù vào ${newR ? fmtDay(newR) : "lượt tới"}. Không được quỵt nha 👀`,
    );
  }

  cmdTuchoi(ctx) {
    const me = this.requireMember(ctx);
    if (!me) return;
    const found = this.incoming(ctx, me);
    if (!found) return;
    const r = found.from;
    if (found.kind === "water") {
      delete this.s.water.pending[r];
      this.announce(`🙅 ${this.name(me)} không đi lấy nước thay được. ${this.name(r)} tự đi nhé.`);
      return;
    }
    delete this.s.pendingSwaps[r];
    this.setCooldown(r, ctx.now);
    this.announce(`🙅 ${this.name(me)} từ chối đổi với ${this.name(r)}. ${this.name(r)} tự trực nhé.`);
  }

  cmdHuydoi(ctx) {
    const me = this.requireMember(ctx);
    if (!me) return;
    const room = this.s.pendingSwaps[me];
    const water = this.s.water.pending[me];
    if (!room && !water) {
      this.say("Bạn không có lời nhờ đổi nào.");
      return;
    }
    delete this.s.pendingSwaps[me];
    delete this.s.water.pending[me];
    if (room) this.setCooldown(me, ctx.now);
    const names = [room, water].filter(Boolean).map((p) => this.name(p.to)).join(", ");
    this.announce(`${this.name(me)} đã hủy lời nhờ ${names}.`);
  }

  setCooldown(mid, now) {
    this.s.swapCooldown[mid] = now + this.cfg.swapCooldownMinutes * 60_000;
  }

  expireSwaps(now) {
    const out = [];
    const limit = this.cfg.swapTimeoutMinutes * 60_000;
    const today = vnDate(now);
    for (const [r, p] of Object.entries(this.s.pendingSwaps)) {
      if (now - p.created > limit || p.date < today) {
        delete this.s.pendingSwaps[r];
        out.push(`⌛ Lời nhờ ${this.name(p.to)} trực thay của ${this.name(r)} đã hết hạn.`);
      }
    }
    for (const [r, p] of Object.entries(this.s.water.pending)) {
      if (now - p.created > limit) {
        delete this.s.water.pending[r];
        out.push(`⌛ Lời nhờ ${this.name(p.to)} lấy nước thay ${this.name(r)} đã hết hạn.`);
      }
    }
    return out;
  }

  // ---------- lấy nước ----------
  cmdNuoc(ctx) {
    const w = this.s.water;
    if (!w.queue.length) {
      this.say("Chưa có ai trong danh sách lấy nước.");
      return;
    }
    const nxt = this.waterNext(ctx.today);
    const lines = [w.emptySince ? "🚱 ĐANG HẾT NƯỚC" : "💧 Còn nước", "Thứ tự lấy nước:"];
    w.queue.forEach((mid, i) => {
      const flags = [];
      if (mid === nxt) flags.push("👉 lượt kế");
      if (this.onLeave(mid, ctx.today)) flags.push("🏖 đang nghỉ");
      if (w.debts[mid]) flags.push(`lấy bù cho ${this.name(w.debts[mid])}`);
      lines.push(`${i + 1}. ${this.name(mid)}` + (flags.length ? ` — ${flags.join(", ")}` : ""));
    });
    if (w.last) lines.push(`Lần trước: ${this.name(w.last.member)} (${fmtDay(w.last.date)})`);
    this.say(lines.join("\n"));
  }

  cmdHetnuoc(ctx) {
    const w = this.s.water;
    const nxt = this.waterNext(ctx.today);
    if (!nxt) {
      this.say("Chưa có ai trong danh sách lấy nước.");
      return;
    }
    if (w.emptySince) {
      this.say(`Đã báo hết nước rồi, đang chờ @${this.name(nxt)} đi lấy 🚶`);
      return;
    }
    w.emptySince = ctx.now;
    this.announce(
      `🚱 HẾT NƯỚC RỒI! @${this.name(nxt)} đến lượt đi lấy nước.\n` +
        "Lấy xong gõ /lay. Không đi được thì /doinuoc <tên> nhờ người khác (sau lấy bù).",
    );
  }

  cmdLay(ctx) {
    const w = this.s.water;
    const me = this.requireMember(ctx);
    if (!me) return;
    const nxt = this.waterNext(ctx.today);
    if (w.queue.includes(me)) w.queue.splice(w.queue.indexOf(me), 1);
    w.queue.push(me);
    w.emptySince = null;
    w.last = { date: ctx.today, member: me };
    delete w.pending[me];
    const owed = w.debts[me];
    delete w.debts[me];
    let text = `💧 Cảm ơn ${this.name(me)} đã lấy nước!`;
    if (owed) text += ` (đã lấy bù cho ${this.name(owed)}, hết nợ)`;
    else if (nxt && me !== nxt) text += ` Lấy sớm hơn lượt nên ${this.name(nxt)} vẫn là lượt kế.`;
    const after = this.waterNext(ctx.today);
    if (after) text += `\nLần sau: ${this.name(after)}`;
    this.announce(text);
  }

  cmdDoinuoc(ctx) {
    const w = this.s.water;
    const me = this.requireMember(ctx);
    if (!me) return;
    const nxt = this.waterNext(ctx.today);
    if (nxt !== me) {
      this.say(`Chưa tới lượt bạn lấy nước (lượt kế: ${this.name(nxt)}).`);
      return;
    }
    if (w.debts[me]) {
      this.say(`Bạn đang lấy bù cho ${this.name(w.debts[me])}, không đổi tiếp được 😤`);
      return;
    }
    if (w.pending[me]) {
      this.say(`Bạn đang nhờ ${this.name(w.pending[me].to)} rồi, chờ trả lời hoặc /huydoi.`);
      return;
    }
    if (!ctx.args) {
      this.say("Cú pháp: /doinuoc <tên>");
      return;
    }
    const target = this.findOrSay(ctx.args);
    if (!target) return;
    if (target === me) {
      this.say("Tự nhờ chính mình à? 🤨");
      return;
    }
    if (!this.s.members[target].zaloId) {
      this.say(`${this.name(target)} chưa /toila nên không trả lời được.`);
      return;
    }
    if (this.onLeave(target, ctx.today)) {
      this.say(`${this.name(target)} đang nghỉ, nhờ người khác nhé.`);
      return;
    }
    w.pending[me] = { to: target, created: ctx.now };
    this.announce(
      `🔄 ${this.name(me)} nhờ @${this.name(target)} đi lấy nước thay, sau sẽ lấy bù lượt của ` +
        `${this.name(target)}.\n${this.name(target)} gõ /dongy hoặc /tuchoi.`,
    );
  }

  acceptWater(r, me) {
    const w = this.s.water;
    delete w.pending[r];
    const q = w.queue;
    const i = q.indexOf(r);
    const j = q.indexOf(me);
    [q[i], q[j]] = [q[j], q[i]];
    w.debts[r] = me;
    this.announce(
      `🤝 ${this.name(me)} đi lấy nước thay ${this.name(r)} (xong gõ /lay).\n` +
        `${this.name(r)} lấy bù vào lượt của ${this.name(me)}.`,
    );
  }

  cmdThutunuoc(ctx) {
    if (!this.requireAdmin(ctx)) return;
    const picked = [];
    for (const n of splitNames(ctx.args)) {
      const mid = this.findOrSay(n);
      if (!mid) return;
      if (!picked.includes(mid)) picked.push(mid);
    }
    if (!picked.length) {
      this.say("Cú pháp: /thutunuoc Nam Hùng Tuấn");
      return;
    }
    const w = this.s.water;
    w.queue = [...picked, ...w.queue.filter((m) => !picked.includes(m))];
    this.cmdNuoc(ctx);
  }

  // ---------- nghỉ ----------
  cmdNghi(ctx) {
    const s = this.s;
    const today = ctx.today;
    const admin = this.isAdmin(ctx.senderId);
    const { name: nameText, start, end } = parseLeave(ctx.args, today);
    const target = nameText ? this.findOrSay(nameText) : this.requireMember(ctx);
    if (!target) return;
    if (target !== this.memberOf(ctx.senderId) && !admin) {
      this.say("Chỉ admin mới xin nghỉ hộ người khác được.");
      return;
    }
    if (start < today) {
      this.say("Không xin nghỉ cho ngày đã qua được.");
      return;
    }
    if (end < start) {
      this.say("Ngày kết thúc phải sau ngày bắt đầu.");
      return;
    }
    const days = daysBetween(start, end) + 1;
    if (days > this.cfg.maxLeaveDays && !admin) {
      this.say(`Tự xin nghỉ tối đa ${this.cfg.maxLeaveDays} ngày. Nghỉ lâu hơn thì nhờ admin.`);
      return;
    }
    if (start === today && this.todayDuty(today) === target && !admin) {
      this.say("Hôm nay đang là lượt của bạn. Xin nghỉ từ mai, hoặc /doi với ai đó, hoặc nhờ admin.");
      return;
    }
    s.leaves[target] = { start, end };
    const name = this.name(target);
    this.announce(
      `🏖 ${name} nghỉ từ ${fmtDay(start)} đến ${fmtDay(end)} (${days} ngày).\n` +
        `Lịch tự dồn cho người khác. Về là ${name} được ưu tiên trực trước 😏`,
    );
  }

  cmdHuynghi(ctx) {
    let target;
    if (ctx.args) {
      target = this.findOrSay(ctx.args);
      if (!target) return;
      if (target !== this.memberOf(ctx.senderId) && !this.requireAdmin(ctx)) return;
    } else {
      target = this.requireMember(ctx);
      if (!target) return;
    }
    if (!this.s.leaves[target]) {
      this.say(`${this.name(target)} không có lịch nghỉ nào.`);
      return;
    }
    delete this.s.leaves[target];
    this.announce(`${this.name(target)} đã hủy nghỉ, quay lại vòng trực.`);
  }

  // ---------- admin ----------
  cmdThem(ctx) {
    if (!this.requireAdmin(ctx)) return;
    const names = splitNames(ctx.args);
    if (!names.length) {
      this.say("Cú pháp: /them Nam, Hùng, Tuấn");
      return;
    }
    const s = this.s;
    const existing = new Set(Object.values(s.members).map((m) => norm(m.name)));
    const added = [];
    const skipped = [];
    for (const n of names) {
      if (existing.has(norm(n))) {
        skipped.push(n);
        continue;
      }
      const mid = `m${s.nextId++}`;
      s.members[mid] = { name: n, zaloId: null, displayName: null };
      s.queue.push(mid);
      s.water.queue.push(mid);
      existing.add(norm(n));
      added.push(n);
    }
    const lines = [];
    if (added.length) lines.push(`➕ Đã thêm: ${added.join(", ")}. Mỗi người gõ /toila <tên> để liên kết.`);
    if (skipped.length) lines.push(`Đã có sẵn: ${skipped.join(", ")}`);
    this.say(lines.join("\n"));
  }

  cmdXoa(ctx) {
    if (!this.requireAdmin(ctx)) return;
    const mid = this.findOrSay(ctx.args);
    if (!mid) return;
    const s = this.s;
    const name = this.name(mid);
    const t = s.toilet;
    if (t.current === mid) Object.assign(t, { current: this.nextToilet(mid), progress: 0, doneCycle: false });
    if (t.group.includes(mid)) {
      t.group = t.group.filter((m) => m !== mid);
      if (!t.group.length) s.toilet = newToilet();
    }
    s.queue = s.queue.filter((m) => m !== mid);
    delete s.members[mid];
    for (const key of ["leaves", "missStreak", "swapLog", "swapCooldown", "pendingSwaps", "debts"]) delete s[key][mid];
    s.debts = Object.fromEntries(Object.entries(s.debts).filter(([, v]) => v !== mid));
    s.pendingSwaps = Object.fromEntries(Object.entries(s.pendingSwaps).filter(([, v]) => v.to !== mid));
    const w = s.water;
    w.queue = w.queue.filter((m) => m !== mid);
    w.debts = Object.fromEntries(Object.entries(w.debts).filter(([k, v]) => k !== mid && v !== mid));
    w.pending = Object.fromEntries(Object.entries(w.pending).filter(([k, v]) => k !== mid && v.to !== mid));
    this.announce(`➖ Đã xóa ${name} khỏi danh sách trực.`);
  }

  cmdThutu(ctx) {
    if (!this.requireAdmin(ctx)) return;
    const names = splitNames(ctx.args);
    if (!names.length) {
      this.say("Cú pháp: /thutu Nam Hùng Tuấn (người không ghi tên giữ thứ tự cũ, xếp phía sau)");
      return;
    }
    const picked = [];
    for (const n of names) {
      const mid = this.findOrSay(n);
      if (!mid) return;
      if (picked.includes(mid)) {
        this.say(`${this.name(mid)} bị ghi trùng.`);
        return;
      }
      picked.push(mid);
    }
    this.s.queue = [...picked, ...this.s.queue.filter((m) => !picked.includes(m))];
    this.cmdDs(ctx);
  }

  cmdDatlai(ctx) {
    if (!this.requireAdmin(ctx)) return;
    const mid = this.findOrSay(ctx.args);
    if (!mid) return;
    this.s.queue = [mid, ...this.s.queue.filter((m) => m !== mid)];
    const d = this.nextTurn(mid, ctx.today);
    this.announce(`📌 ${this.name(mid)} được đưa lên trực kế tiếp` + (d ? ` (${fmtDay(d)}).` : "."));
  }

  cmdHuylk(ctx) {
    if (!this.requireAdmin(ctx)) return;
    const mid = this.findOrSay(ctx.args);
    if (!mid) return;
    Object.assign(this.s.members[mid], { zaloId: null, displayName: null });
    this.say(`Đã gỡ liên kết Zalo của ${this.name(mid)}.`);
  }

  cmdAdmin(ctx) {
    if (!this.requireAdmin(ctx)) return;
    const mid = this.findOrSay(ctx.args);
    if (!mid) return;
    const zid = this.s.members[mid].zaloId;
    if (!zid) {
      this.say(`${this.name(mid)} cần /toila trước.`);
      return;
    }
    if (!this.s.adminIds.includes(zid)) this.s.adminIds.push(zid);
    this.say(`👑 ${this.name(mid)} giờ là admin.`);
  }

  // ---------- hẹn giờ ----------
  /** Chốt các ngày đã qua: tính trốn trực, hết hạn nghỉ/tạm dừng. Chạy cả khi nhận tin lẫn khi cron. */
  rollDays(today) {
    const s = this.s;
    const yesterday = addDays(today, -1);
    if (!s.lastClosedDate) s.lastClosedDate = yesterday;
    const alive = s.lastAliveDate;
    for (let d = addDays(s.lastClosedDate, 1); d <= yesterday; d = addDays(d, 1)) {
      // chỉ phạt những ngày bot có chạy (bot sập thì không tính trốn)
      this.closeDay(d, alive !== null && alive >= d);
      s.lastClosedDate = d;
    }
    s.lastAliveDate = today;
  }

  /** Gọi theo lịch (cron). Trả về [[chatId, text], ...]. */
  tick(now) {
    const s = this.s;
    const today = vnDate(now);
    const minutes = vnMinutes(now);
    this.rollDays(today);
    const group = s.groupChatId;
    const expired = this.expireSwaps(now);
    if (!group) return [];
    const out = expired.map((t) => [group, t]);
    if (!s.queue.length) return out;

    let sentMorning = false;
    if (s.lastMorningDate !== today && minutes >= hm(this.cfg.morningTime)) {
      s.lastMorningDate = today;
      out.push(...this.morning(today).map((t) => [group, t]));
      sentMorning = true;
    }

    const passed = [...this.cfg.reminderTimes].sort((a, b) => hm(a) - hm(b)).filter((t) => minutes >= hm(t));
    if (passed.length) {
      const key = `${today} ${passed.at(-1)}`;
      if (s.lastReminderSlot !== key) {
        s.lastReminderSlot = key;
        if (!sentMorning && !this.frozen(today)) {
          const lines = [];
          const td = this.todayDuty(today);
          if (td) lines.push(fill(this.choice(REMINDER), { name: this.name(td) }));
          const wn = this.waterNext(today);
          if (s.water.emptySince && wn) lines.push(`🚱 Vẫn đang hết nước, @${this.name(wn)} ơi đi lấy đi (xong gõ /lay).`);
          if (lines.length) out.push([group, lines.join("\n")]);
        }
      }
    }
    return out;
  }

  closeDay(d, penalize) {
    const s = this.s;
    if (penalize && !this.frozen(d) && !this.doneOn(d)) {
      const toilet = s.toilet.current;
      const td = s.queue.find((m) => this.roomFree(m, d, toilet));
      if (td) {
        const streak = (s.missStreak[td] || 0) + 1;
        s.missStreak[td] = streak;
        s.lastMiss = { date: d, member: td, fixed: false };
        const name = this.name(td);
        const tag = { member: td, date: d }; // để /xong homqua gỡ được tin này nếu chưa gửi
        if (streak >= this.cfg.shameStreak) {
          s.pendingNotes.push({
            kind: "shame",
            text: fill(this.choice(SHAME), { name, days: streak }) +
              `\n👉 Hôm nay ${name} vẫn trực. Cả phòng nhắc giùm nha!\n(Quên bấm thôi thì gõ /xong homqua trước ${this.cfg.lateConfirmUntil})`,
            ...tag,
          });
        } else {
          s.pendingNotes.push({ kind: "note", text: fill(MISSED, { name, until: this.cfg.lateConfirmUntil }), ...tag });
        }
      }
    }
    if (s.freeze && s.freeze.end <= d) {
      s.freeze = null;
      s.pendingNotes.push({ kind: "note", text: "🔥 Hết tạm dừng! Hôm nay trực lại bình thường." });
    }
    for (const [mid, lv] of Object.entries(s.leaves)) {
      if (lv.end <= d) {
        delete s.leaves[mid];
        if (s.members[mid]) {
          s.pendingNotes.push({ kind: "note", text: `👋 ${this.name(mid)} hết nghỉ, chào mừng trở lại vòng trực!` });
        }
      }
    }
  }

  morning(today) {
    const s = this.s;
    const notes = s.pendingNotes;
    s.pendingNotes = [];
    const out = notes.filter((n) => n.kind === "shame").map((n) => n.text);
    const noteLines = notes.filter((n) => n.kind === "note").map((n) => n.text);
    const lines = [`☀️ Chào buổi sáng! ${fmtDay(today)}`];
    if (this.frozen(today)) {
      // chỉ báo vào ngày đầu tạm dừng (hoặc khi có tin cần báo), còn lại im lặng
      if (s.freeze.start !== today && !noteLines.length) return out;
      lines.push(`🧊 Phòng đang tạm dừng trực đến hết ${fmtDay(s.freeze.end)}.`, ...noteLines);
      out.push(lines.join("\n"));
      return out;
    }
    const td = this.todayDuty(today);
    if (td) {
      const owed = s.debts[td];
      lines.push(`🧹 Hôm nay ${this.name(td)} trực` + (owed ? ` (bù cho ${this.name(owed)})` : "") + ". Xong nhớ gõ /xong nhé.");
    } else if (!this.doneOn(today)) {
      lines.push("Hôm nay không ai phải trực 🎉");
    }
    lines.push(...noteLines, ...this.toiletLines(), ...this.waterLines(today));
    const nxt = this.tomorrow(today);
    if (nxt.member) lines.push(`Mai (${fmtDay(nxt.date)}): ${this.name(nxt.member)}`);
    out.push(lines.join("\n"));
    return out;
  }
}

export const HELP = `🧹 BOT TRỰC NHẬT
Trong nhóm phải @bot trước lệnh, vd: @Bot Trực Nhật /xong
<...> là chỗ điền, [...] là có thể bỏ trống.

📌 Trực phòng
/homnay: hôm nay ai trực, ai vệ sinh, ai lấy nước
/xong: báo đã trực xong
/xong homqua: quên bấm hôm qua thì xác nhận bù
/lich [số ngày]: xem lịch sắp tới
/ds: thứ tự vòng trực

🔄 Đổi lượt
/doi <tên>: nhờ người trực thay, sau trực bù
/dongy · /tuchoi: trả lời lời nhờ
/huydoi: rút lại lời nhờ

🚽 /vesinh: ai dọn vệ sinh vòng này · /xongvs: báo đã dọn
💧 /hetnuoc: báo hết nước · /lay: báo đã lấy
   /doinuoc <tên>: nhờ đi lấy thay · /nuoc: thứ tự lấy nước
🏖 /nghi <từ> <đến>: xin nghỉ · /huynghi: hủy nghỉ
👤 /toila <tên>: liên kết Zalo · /id: xem ID

Xem thêm: /help <lệnh> (vd /help doi) · /help luat · /help admin`;

export const HELP_ADMIN = `👑 LỆNH ADMIN
/khoitao: gắn bot vào nhóm này
/them A, B, C: thêm người vào cuối vòng
/xoa <tên>: xóa người
/thutu A B C: sắp lại thứ tự trực phòng
/thutunuoc A B C: sắp lại thứ tự lấy nước
/datlai <tên>: cho người này trực kế tiếp
/xong <tên>: xác nhận trực hộ
/nghi <tên> <từ> <đến>: cho nghỉ, không giới hạn ngày
/vesinh A, B: đặt nhóm vệ sinh · /vesinh tat: bỏ nhóm
/tamdung <đến ngày>: cả phòng tạm dừng trực · /tieptuc: hủy
/huylk <tên>: gỡ liên kết Zalo
/admin <tên>: thêm admin

Chi tiết từng lệnh: /help <lệnh>`;

export const HELP_RULES = `📜 LUẬT PHÒNG
• Mỗi ngày 1 người trực, theo thứ tự vòng (/ds)
• Không /xong trước 0h → hôm sau trực tiếp
• Trực rồi mà quên bấm → /xong homqua trước {late} hôm sau
• Trốn {shame} ngày liền → bị bêu tên trước cả phòng 😈
• Đổi lượt: người được nhờ phải /dongy, người nhờ trực bù lượt của họ
• Tối đa {lim} lần đổi / {win} ngày. Đang trực bù thì không được đổi tiếp
• Nghỉ tối đa {max} ngày, không phải bù, về là được xếp trực trước
• Không được xin nghỉ đúng ngày mình đang tới lượt
• Nhóm vệ sinh n người: mỗi vòng 1 người dọn vệ sinh, n-1 người trực phòng. Hết vòng đổi người
• Nước: ai /lay thì xuống cuối hàng. Lấy hộ thì người tới lượt vẫn giữ lượt`;

export const HELP_DETAIL = {
  homnay: "/homnay\nXem hôm nay ai trực phòng, ai dọn vệ sinh vòng này, ai tới lượt lấy nước.",
  xong:
    "/xong\nNgười trực hôm nay báo đã trực xong. Mình xuống cuối vòng, mai đến người kế.\n" +
    "Phải gõ trước 0h, không thì hôm sau trực tiếp.\n" +
    "Quên bấm: /xong homqua trước {late} hôm sau. Bot xóa lỗi quên, hôm nay chuyển cho người kế tiếp.\n" +
    "Admin: /xong <tên> để xác nhận hộ, /xong homqua <tên> để xác nhận bù hộ.",
  lich:
    "/lich [số ngày]\nXem ai trực những ngày tới (mặc định 7, tối đa 30). Có tính cả người nghỉ, " +
    "trực bù, tạm dừng và ngày đổi người vệ sinh.\nVd: /lich 14",
  ds: "/ds\nThứ tự vòng trực (trên cùng trực sớm nhất) kèm trạng thái: đang nghỉ, đang trực bù, " +
    "số ngày trốn, chưa liên kết Zalo.",
  doi:
    "/doi <tên>\nNhờ người đó trực thay lượt sắp tới của bạn. Đổi lại bạn trực bù vào lượt của họ.\n" +
    "• Người kia phải /dongy trong {timeout}\n" +
    "• Chỉ nhờ được người trực sau mình\n" +
    "• Tối đa {lim} lần / {win} ngày, đang trực bù thì không được đổi tiếp\n" +
    "• Bị từ chối hoặc tự hủy thì đợi {cooldown} phút mới nhờ lại\nVd: /doi Hùng",
  dongy: "/dongy [tên]\nĐồng ý lời nhờ trực phòng hoặc lấy nước. Nếu nhiều người cùng nhờ thì ghi tên.\nVd: /dongy Nam",
  tuchoi: "/tuchoi [tên]\nTừ chối lời nhờ. Nhiều người nhờ thì ghi tên.",
  huydoi: "/huydoi\nRút lại lời nhờ đổi mình vừa gửi (đợi {cooldown} phút mới nhờ lại được).",
  vesinh:
    "/vesinh\nXem nhóm vệ sinh và ai dọn vòng này.\n" +
    "Admin: /vesinh A, B để đặt nhóm (mỗi vòng 1 người dọn vệ sinh, những người còn lại trực phòng). /vesinh tat để bỏ.",
  xongvs: "/xongvs\nNgười dọn vệ sinh vòng này báo đã dọn xong. Lúc nào trong vòng cũng được.",
  hetnuoc: "/hetnuoc\nBáo hết nước. Bot gọi người tới lượt và nhắc mãi đến khi có người /lay.",
  lay: "/lay\nBáo đã lấy nước. Mình xuống cuối hàng.\nLấy hộ khi chưa tới lượt thì người tới lượt vẫn giữ lượt.",
  doinuoc:
    "/doinuoc <tên>\nĐang tới lượt mà không đi được thì nhờ người khác đi thay. Người kia /dongy, " +
    "bạn lấy bù vào lượt của họ.\nVd: /doinuoc Long",
  nuoc: "/nuoc\nXem còn hay hết nước, thứ tự lấy nước, ai lấy lần trước.",
  nghi:
    "/nghi <từ> <đến>\nXin nghỉ, tối đa {max} ngày. Không phải bù, lịch tự dồn cho người khác, " +
    "về là được xếp trực trước.\nVd: /nghi 20/10 26/10 · /nghi 25/10 (1 ngày) · /nghi 3 (3 ngày từ mai)\n" +
    "Admin: /nghi <tên> <từ> <đến>, không giới hạn ngày.",
  huynghi: "/huynghi\nHủy lịch nghỉ của mình. Admin: /huynghi <tên>.",
  toila: "/toila <tên>\nLiên kết Zalo của bạn với tên trong /ds. Mỗi người gõ một lần.\nVd: /toila Nam",
  id: "/id\nXem Zalo ID của bạn và ID cuộc trò chuyện.",
  help: "/help [lệnh | luat | admin]\nXem hướng dẫn.",
  khoitao: "/khoitao (admin)\nGõ trong nhóm phòng để gắn bot vào nhóm. Người gõ đầu tiên là admin.",
  them:
    "/them A, B, C (admin)\nThêm người vào cuối vòng trực và hàng lấy nước. Tên có dấu cách thì ngăn bằng " +
    "dấu phẩy.\nVd: /them Nam, Hùng, Văn Tuấn",
  xoa: "/xoa <tên> (admin)\nXóa người khỏi mọi lịch.",
  thutu: "/thutu A B C (admin)\nSắp lại thứ tự trực phòng. Người không ghi tên giữ thứ tự cũ, xếp phía sau.",
  thutunuoc: "/thutunuoc A B C (admin)\nSắp lại thứ tự lấy nước.",
  datlai: "/datlai <tên> (admin)\nĐưa người này lên đầu vòng, trực lượt kế tiếp.",
  tamdung:
    "/tamdung <đến ngày> (admin)\nCả phòng tạm dừng trực (lễ, Tết): lịch đứng yên, không nhắc, không tính trốn.\n" +
    "Vd: /tamdung 26/10 (từ hôm nay đến hết 26/10) · /tamdung 20/10 26/10 (đặt trước)",
  tieptuc: "/tieptuc (admin)\nHủy tạm dừng, trực lại ngay.",
  huylk: "/huylk <tên> (admin)\nGỡ liên kết Zalo khi ai đó /toila nhầm.",
  admin: "/admin <tên> (admin)\nCho thêm người làm admin (người đó phải /toila trước).",
};

export const COMMANDS = {
  help: "cmdHelp", trogiup: "cmdHelp", start: "cmdHelp",
  id: "cmdId",
  khoitao: "cmdKhoitao",
  toila: "cmdToila",
  homnay: "cmdHomnay",
  lich: "cmdLich",
  ds: "cmdDs", list: "cmdDs",
  xong: "cmdXong", done: "cmdXong",
  doi: "cmdDoi",
  dongy: "cmdDongy",
  tuchoi: "cmdTuchoi",
  huydoi: "cmdHuydoi",
  vesinh: "cmdVesinh", wc: "cmdVesinh",
  xongvs: "cmdXongvs", xongwc: "cmdXongvs",
  tamdung: "cmdTamdung", freeze: "cmdTamdung",
  tieptuc: "cmdTieptuc", unfreeze: "cmdTieptuc",
  nuoc: "cmdNuoc",
  hetnuoc: "cmdHetnuoc",
  lay: "cmdLay", laynuoc: "cmdLay",
  doinuoc: "cmdDoinuoc",
  thutunuoc: "cmdThutunuoc",
  nghi: "cmdNghi",
  huynghi: "cmdHuynghi",
  them: "cmdThem",
  xoa: "cmdXoa",
  thutu: "cmdThutu",
  datlai: "cmdDatlai",
  huylk: "cmdHuylk",
  admin: "cmdAdmin",
};
const SETUP_FREE = new Set(["khoitao", "id", "help", "trogiup", "start"]);
