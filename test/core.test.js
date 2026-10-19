import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { processMessage } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { COMMANDS, DutyBot, HELP_DETAIL, newState, parseLeave } from "../src/core.js";
import { parseUpdate } from "../src/zalo.js";

const G = "group-1";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Phòng giả lập: admin Toan + các thành viên đã /toila, bắt đầu T2 19/10/2026 09:00 giờ VN. */
class Room {
  constructor(names = ["Toan", "Nam", "Hung", "Tuan"], cfg = {}) {
    this.bot = new DutyBot(newState(), cfg, seeded(1));
    this.now = Date.UTC(2026, 9, 19, 2, 0);
    this.bot.tick(this.now);
    this.say("Toan", "/khoitao");
    this.say("Toan", "/them " + names.join(", "));
    for (const n of names) this.say(n, `/toila ${n}`);
  }

  say(who, text) {
    return this.bot.handle(`u_${who}`, who, G, "GROUP", text, this.now).map(([, t]) => t).join("\n");
  }

  /** Tua thời gian từng 30 phút, trả về mọi tin bot tự gửi. */
  advance({ days = 0, hours = 0 } = {}) {
    const end = this.now + days * DAY + hours * HOUR;
    const out = [];
    while (this.now < end) {
      this.now = Math.min(this.now + 30 * MIN, end);
      out.push(...this.bot.tick(this.now).map(([, t]) => t));
    }
    return out.join("\n");
  }

  get today() {
    return new Date(this.now + 7 * HOUR).toISOString().slice(0, 10);
  }

  duty() {
    const mid = this.bot.todayDuty(this.today);
    return mid ? this.bot.name(mid) : null;
  }

  schedule(n) {
    return this.bot.plan(this.today, n).map((d) => (d.member ? this.bot.name(d.member) : null));
  }

  water() {
    return this.bot.name(this.bot.waterNext(this.today));
  }

  /** Người trực hôm nay /xong rồi sang ngày mới. */
  doDay() {
    this.say(this.duty(), "/xong");
    return this.advance({ days: 1 });
  }
}

const has = (text, part) => assert.ok(text.includes(part), `không thấy "${part}" trong:\n${text}`);
const hasNot = (text, part) => assert.ok(!text.includes(part), `không được có "${part}" trong:\n${text}`);

describe("Trực phòng", () => {
  test("/xong chuyển sang người kế", () => {
    const r = new Room();
    assert.equal(r.duty(), "Toan");
    const out = r.say("Toan", "/xong");
    has(out, "Toan");
    has(out, "Mai");
    r.advance({ days: 1 });
    assert.equal(r.duty(), "Nam");
  });

  test("chỉ người trực hôm nay mới /xong được", () => {
    const r = new Room();
    has(r.say("Nam", "/xong"), "lượt của Toan");
    assert.equal(r.duty(), "Toan");
  });

  test("lệnh nằm sau @mention và lệnh có dấu", () => {
    const r = new Room();
    has(r.say("Toan", "@Bot Trực Nhật /xong"), "Toan");
    has(r.say("Nam", "/lịch 3"), "Lịch");
  });

  test("xem trước lịch", () => {
    assert.deepEqual(new Room().schedule(6), ["Toan", "Nam", "Hung", "Tuan", "Toan", "Nam"]);
  });

  test("admin sắp lại thứ tự", () => {
    const r = new Room();
    r.say("Toan", "/thutu Tuan Hung");
    assert.deepEqual(r.schedule(4), ["Tuan", "Hung", "Toan", "Nam"]);
    has(r.say("Nam", "/thutu Nam"), "chỉ admin");
  });

  test("xóa người", () => {
    const r = new Room();
    r.say("Toan", "/xoa Toan");
    assert.equal(r.duty(), "Nam");
  });
});

describe("Trốn trực", () => {
  test("không /xong thì trực tiếp, trốn 2 ngày bị bêu tên", () => {
    const r = new Room();
    let out = r.advance({ days: 1 });
    assert.equal(r.duty(), "Toan");
    has(out, "trực tiếp");
    out = r.advance({ days: 1 });
    assert.equal(r.duty(), "Toan");
    has(out, "Toan");
    has(out, "2");
    assert.equal(r.bot.s.missStreak.m1, 2);
    r.say("Toan", "/xong");
    assert.ok(!("m1" in r.bot.s.missStreak));
  });

  test("bot tắt thì không tính trốn", () => {
    const r = new Room();
    r.now += 3 * DAY; // bot tắt 3 ngày (20–22/10)
    r.advance({ hours: 1 });
    // chỉ tính ngày 19 (bot có chạy), 2 ngày bot tắt không tính
    assert.deepEqual(r.bot.s.missStreak, { m1: 1 });
  });

  test("tin buổi sáng: 'Mai' là người kế tiếp", () => {
    const r = new Room();
    const out = r.advance({ days: 1 });
    has(out, "Hôm nay Toan");
    has(out, "Mai (T4 21/10): Nam");
  });

  test("nhắc buổi tối, đã xong thì thôi", () => {
    const r = new Room();
    has(r.advance({ hours: 11 }), "Toan");
    r.say("Toan", "/xong");
    assert.equal(r.advance({ hours: 2 }), "");
  });

  test("/xong sau 0h không tính cho hôm qua (chốt ngày ngay khi nhận tin)", () => {
    const r = new Room();
    r.now = Date.UTC(2026, 9, 19, 17, 30); // 00:30 ngày 20/10 giờ VN, chưa có tick nào
    r.say("Toan", "/xong");
    // ngày 19 vẫn bị tính trốn, /xong này là của ngày 20
    has(r.bot.s.pendingNotes.map((n) => n.text).join(), "Hôm qua Toan chưa xác nhận");
    assert.equal(r.bot.s.lastDone.date, "2026-10-20");
  });
});

describe("/xong homqua (quên bấm)", () => {
  test("tự xác nhận bù trước 7h: xóa lỗi, không báo quên, hôm nay chuyển người kế", () => {
    const r = new Room();
    r.advance({ hours: 21 }); // 06:00 T3 20/10, Toan quên /xong hôm T2
    assert.equal(r.bot.s.missStreak.m1, 1);
    const out = r.say("Toan", "/xong homqua");
    has(out, "Toan xác nhận bù: hôm qua (T2 19/10) đã trực.");
    has(out, "Hôm nay (T3 20/10): Nam trực.");
    assert.equal(r.duty(), "Nam");
    assert.deepEqual(r.bot.s.missStreak, {});
    hasNot(r.advance({ hours: 1 }), "chưa xác nhận"); // tin 7h không còn báo Toan quên
  });

  test("gõ có dấu cũng được, và chỉ xác nhận được một lần", () => {
    const r = new Room();
    r.advance({ hours: 23 });
    has(r.say("Toan", "/xong hôm qua"), "xác nhận bù");
    has(r.say("Toan", "/xong homqua"), "đã xác nhận bù cho hôm qua rồi");
  });

  test("admin xác nhận hộ, người khác thì không được", () => {
    const r = new Room();
    r.say("Toan", "/thutu Nam");
    r.advance({ hours: 21 });
    has(r.say("Hung", "/xong homqua"), "Chỉ Nam hoặc admin");
    has(r.say("Toan", "/xong homqua Hung"), "Hôm qua là lượt của Nam");
    has(r.say("Toan", "/xong homqua Nam"), "admin xác nhận hộ");
    assert.equal(r.duty(), "Toan");
  });

  test("quá 12:00 thì hết hạn", () => {
    const r = new Room();
    r.advance({ hours: 27.5 }); // 12:30 T3
    has(r.say("Toan", "/xong homqua"), "Quá 12:00");
    assert.equal(r.duty(), "Toan");
  });

  test("hôm qua không ai quên thì báo không có", () => {
    const r = new Room();
    r.say("Toan", "/xong");
    r.advance({ hours: 21 });
    has(r.say("Nam", "/xong homqua"), "không có ai bị tính quên");
  });

  test("gỡ được cả tin bêu tên chưa gửi", () => {
    const r = new Room();
    r.advance({ days: 1, hours: 21 }); // 06:00 T4: Toan quên 2 ngày → tin bêu tên đang chờ 7h
    assert.ok(r.bot.s.pendingNotes.some((n) => n.kind === "shame"));
    r.say("Toan", "/xong homqua");
    assert.deepEqual(r.bot.s.pendingNotes, []);
    hasNot(r.advance({ hours: 1 }), "Cả phòng nhắc giùm");
    assert.equal(r.duty(), "Nam");
  });

  test("tính vào vòng vệ sinh như một lượt trực", () => {
    const r = new Room(["Toan", "Nam", "Hung"]);
    r.say("Toan", "/vesinh Nam, Hung"); // Hung dọn vệ sinh, vòng trực phòng: Toan, Nam
    r.advance({ hours: 21 });
    r.say("Toan", "/xong homqua");
    assert.equal(r.bot.s.toilet.progress, 1);
  });
});

describe("Nghỉ", () => {
  test("nghỉ thì người khác dồn vào, về được ưu tiên", () => {
    const r = new Room();
    r.say("Nam", "/nghi 20/10 25/10");
    const days = r.schedule(8);
    assert.deepEqual(days.slice(0, 7), ["Toan", "Hung", "Tuan", "Toan", "Hung", "Tuan", "Toan"]);
    assert.equal(days[7], "Nam");
  });

  test("giới hạn số ngày với người thường", () => {
    const r = new Room();
    has(r.say("Nam", "/nghi 20/10 30/10"), "tối đa");
    has(r.say("Toan", "/nghi Nam 20/10 30/10"), "nghỉ");
    assert.ok("m2" in r.bot.s.leaves);
  });

  test("không xin nghỉ được đúng ngày mình trực", () => {
    const r = new Room();
    r.say("Toan", "/thutu Nam");
    has(r.say("Nam", "/nghi 19/10 20/10"), "lượt của bạn");
    has(r.say("Nam", "/nghi 20/10 21/10"), "nghỉ");
  });

  test("hết hạn nghỉ", () => {
    const r = new Room();
    r.say("Nam", "/nghi 2");
    has(r.advance({ days: 3 }), "hết nghỉ");
    assert.deepEqual(r.bot.s.leaves, {});
  });

  test("đọc ngày nghỉ", () => {
    const today = "2026-10-19";
    assert.deepEqual(parseLeave("20/10 26/10", today), { name: "", start: "2026-10-20", end: "2026-10-26" });
    assert.deepEqual(parseLeave("Nam từ 20/10 đến 22/10", today), { name: "Nam", start: "2026-10-20", end: "2026-10-22" });
    assert.deepEqual(parseLeave("3", today), { name: "", start: "2026-10-20", end: "2026-10-22" });
    assert.equal(parseLeave("5/1", today).start, "2027-01-05");
    assert.throws(() => parseLeave("31/2", today), /không hợp lệ/);
  });

  test("ngày sai báo lỗi thay vì sập", () => {
    has(new Room().say("Nam", "/nghi 31/2"), "Ngày không hợp lệ");
  });
});

describe("Đổi lượt", () => {
  test("đổi và trực bù", () => {
    const r = new Room();
    has(r.say("Toan", "/doi Hung"), "/dongy");
    r.say("Hung", "/dongy");
    assert.deepEqual(r.schedule(4), ["Hung", "Nam", "Toan", "Tuan"]);
    has(r.say("Nam", "/lich 4"), "bù cho Hung");
  });

  test("đang trực bù thì không đổi tiếp", () => {
    const r = new Room();
    r.say("Toan", "/doi Hung");
    r.say("Hung", "/dongy");
    has(r.say("Toan", "/doi Tuan"), "trực bù");
  });

  test("giới hạn số lần đổi", () => {
    const r = new Room(undefined, { swapLimit: 1 });
    r.say("Toan", "/doi Nam");
    r.say("Nam", "/dongy");
    r.say("Nam", "/xong");
    r.advance({ days: 1 });
    r.say("Toan", "/xong");
    has(r.say("Toan", "/doi Tuan"), "tối đa 1");
  });

  test("bị từ chối thì phải đợi", () => {
    const r = new Room();
    r.say("Toan", "/doi Nam");
    has(r.say("Nam", "/tuchoi"), "từ chối");
    has(r.say("Toan", "/doi Hung"), "phút nữa");
    r.advance({ hours: 1 });
    has(r.say("Toan", "/doi Hung"), "/dongy");
  });

  test("lời nhờ hết hạn", () => {
    const r = new Room();
    r.say("Toan", "/doi Nam");
    has(r.advance({ hours: 3 }), "hết hạn");
    has(r.say("Nam", "/dongy"), "Không có ai");
  });

  test("không đẩy lượt cho người trực trước mình", () => {
    has(new Room().say("Hung", "/doi Toan"), "trực trước bạn");
  });

  test("chỉ người được nhờ mới đồng ý được", () => {
    const r = new Room();
    r.say("Toan", "/doi Nam");
    has(r.say("Hung", "/dongy"), "Không có ai");
  });
});

describe("Tạm dừng", () => {
  test("lịch đứng yên khi tạm dừng", () => {
    const r = new Room();
    r.say("Toan", "/xong");
    has(r.say("Toan", "/tamdung 20/10 22/10"), "Trực lại từ T6 23/10: Nam");
    assert.deepEqual(r.schedule(5), ["Toan", null, null, null, "Nam"]);
  });

  test("không phạt, không nhắc khi tạm dừng", () => {
    const r = new Room();
    r.say("Toan", "/tamdung 2");
    const out = r.advance({ days: 2 });
    hasNot(out, "⏰");
    assert.deepEqual(r.bot.s.missStreak, {});
    has(out, "Hết tạm dừng");
    assert.equal(r.duty(), "Toan");
    has(r.say("Toan", "/tamdung 2"), "Tạm dừng trực");
    has(r.say("Toan", "/tieptuc"), "Hủy tạm dừng");
  });

  test("chỉ admin tạm dừng được", () => {
    has(new Room().say("Nam", "/tamdung 26/10"), "chỉ admin");
  });
});

describe("Vệ sinh", () => {
  test("1 người trong nhóm dọn vệ sinh, hết vòng đổi người", () => {
    const r = new Room(["Toan", "Nam", "Hung", "Tuan", "Long"]);
    has(r.say("Toan", "/vesinh Hung, Tuan"), "Vòng này Tuan dọn vệ sinh");
    assert.deepEqual(r.schedule(4), ["Toan", "Nam", "Hung", "Long"]);
    for (let i = 0; i < 3; i++) r.doDay();
    assert.equal(r.duty(), "Long");
    r.say("Tuan", "/xongvs");
    const done = r.say("Long", "/xong");
    has(done, "Hết vòng");
    has(done, "Vòng mới Hung dọn vệ sinh");
    assert.equal(r.bot.s.toilet.current, "m3");
    r.advance({ days: 1 });
    assert.deepEqual(r.schedule(4), ["Tuan", "Toan", "Nam", "Long"]);
  });

  test("/lich cho thấy ngày đổi người vệ sinh", () => {
    const r = new Room(["Toan", "Nam", "Hung"]);
    r.say("Toan", "/vesinh Nam, Hung");
    const out = r.say("Toan", "/lich 4");
    has(out, "Vệ sinh vòng này: Hung");
    has(out, "Nam dọn vệ sinh vòng mới");
  });

  test("không đổi lượt với người đang dọn vệ sinh", () => {
    const r = new Room();
    r.say("Toan", "/vesinh Hung, Tuan");
    has(r.say("Toan", "/doi Tuan"), "dọn vệ sinh");
  });

  test("chỉ người dọn vòng này mới /xongvs", () => {
    const r = new Room();
    r.say("Toan", "/vesinh Hung, Tuan");
    has(r.say("Hung", "/xongvs"), "không phải bạn");
    has(r.say("Tuan", "/xongvs"), "xong vòng này");
  });
});

describe("Lấy nước", () => {
  test("báo hết nước gọi người tới lượt, /lay xoay vòng", () => {
    const r = new Room();
    has(r.say("Nam", "/hetnuoc"), "@Toan");
    has(r.say("Toan", "/lay"), "Lần sau: Nam");
    assert.equal(r.bot.s.water.emptySince, null);
    assert.equal(r.water(), "Nam");
  });

  test("lấy hộ thì người tới lượt vẫn giữ lượt", () => {
    const r = new Room();
    has(r.say("Hung", "/lay"), "Toan vẫn là lượt kế");
    assert.equal(r.water(), "Toan");
  });

  test("đổi lượt nước và lấy bù", () => {
    const r = new Room();
    r.say("Toan", "/hetnuoc");
    has(r.say("Nam", "/doinuoc Hung"), "Chưa tới lượt");
    r.say("Toan", "/doinuoc Hung");
    has(r.say("Hung", "/dongy"), "Hung đi lấy nước thay Toan");
    assert.equal(r.water(), "Hung");
    r.say("Hung", "/lay");
    assert.deepEqual(r.bot.s.water.queue.map((m) => r.bot.name(m)), ["Nam", "Toan", "Tuan", "Hung"]);
    r.say("Nam", "/lay");
    has(r.say("Toan", "/lay"), "lấy bù cho Hung");
  });

  test("nhắc hết nước buổi tối và buổi sáng", () => {
    const r = new Room();
    r.say("Nam", "/hetnuoc");
    has(r.advance({ hours: 11 }), "Vẫn đang hết nước");
    has(r.advance({ hours: 11 }), "Đang hết nước");
  });
});

describe("Help", () => {
  test("các tầng help", () => {
    const r = new Room();
    has(r.say("Nam", "/help"), "/help doi");
    has(r.say("Nam", "/help admin"), "/thutunuoc");
    has(r.say("Nam", "/help luat"), "Trốn 2 ngày");
    has(r.say("Nam", "/help doi"), "Vd: /doi Hùng");
    has(r.say("Nam", "/trogiup /đổi"), "Vd: /doi Hùng");
    has(r.say("Nam", "/help nghỉ"), "Vd: /nghi");
    has(r.say("Nam", "/help abc"), "Không có lệnh");
  });

  test("lệnh nào cũng có help chi tiết", () => {
    const covered = new Set(Object.keys(HELP_DETAIL).map((k) => COMMANDS[k]));
    assert.deepEqual(Object.values(COMMANDS).filter((m) => !covered.has(m)), []);
  });
});

describe("Khởi tạo và liên kết", () => {
  test("phải /khoitao trước", () => {
    const bot = new DutyBot(newState());
    const out = bot.handle("u1", "A", G, "GROUP", "/lich", Date.UTC(2026, 9, 19, 2, 0));
    has(out[0][1], "khoitao");
  });

  test("bỏ qua nhóm khác", () => {
    const r = new Room();
    assert.deepEqual(r.bot.handle("u_Nam", "Nam", "other", "GROUP", "/lich", r.now), []);
  });

  test("liên kết trùng", () => {
    const r = new Room();
    has(r.bot.handle("u_x", "X", G, "GROUP", "/toila Nam", r.now)[0][1], "Zalo khác");
    has(r.say("Nam", "/toila Hung"), "đã liên kết với Nam");
  });
});

describe("Kết nối", () => {
  test("đọc update của Zalo", () => {
    const upd = {
      event_name: "message.text.received",
      message: { from: { id: "u1", display_name: "Toàn", is_bot: false }, chat: { id: "g1", chat_type: "GROUP" }, text: "@Bot /xong", message_id: "x" },
    };
    assert.deepEqual(parseUpdate(upd), {
      messageId: "x", senderId: "u1", senderName: "Toàn", chatId: "g1", chatType: "GROUP", text: "@Bot /xong",
    });
    assert.equal(parseUpdate({ event_name: "message.sticker.received", message: {} }), null);
    assert.equal(parseUpdate(null), null);
  });

  test("chống tin trùng và lỗi không làm hỏng state", () => {
    const r = new Room();
    const msg = { messageId: "a1", senderId: "u_Toan", senderName: "Toan", chatId: G, chatType: "GROUP", text: "/xong" };
    has(processMessage(r.bot, msg, r.now).map(([, t]) => t).join(), "Toan");
    assert.deepEqual(processMessage(r.bot, msg, r.now), []);
    r.bot.cmdLich = () => {
      r.bot.s.queue = [];
      throw new Error("boom");
    };
    const out = processMessage(r.bot, { ...msg, messageId: "a2", text: "/lich" }, r.now);
    has(out[0][1], "gặp lỗi");
    assert.equal(r.bot.s.queue.length, 4);
  });

  test("đọc cấu hình từ biến môi trường", () => {
    const cfg = loadConfig({ SWAP_LIMIT: "3", REMINDER_TIMES: "19:00, 21:30", MORNING_TIME: "06:30" });
    assert.equal(cfg.swapLimit, 3);
    assert.deepEqual(cfg.reminderTimes, ["19:00", "21:30"]);
    assert.equal(cfg.morningTime, "06:30");
    assert.equal(cfg.maxLeaveDays, 7);
  });
});
