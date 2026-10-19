export const DEFAULT_CONFIG = {
  morningTime: "07:00",              // giờ báo ai trực hôm nay
  reminderTimes: ["20:00", "22:00"], // nhắc nếu chưa /xong
  shameStreak: 2,                    // trốn bao nhiêu ngày liền thì bị bêu tên
  lateConfirmUntil: "12:00",         // quên /xong thì được /xong homqua đến giờ này hôm sau
  maxLeaveDays: 7,                   // số ngày nghỉ tối đa tự xin (admin không giới hạn)
  swapLimit: 2,                      // số lần đổi tối đa ...
  swapWindowDays: 7,                 // ... trong bấy nhiêu ngày
  swapTimeoutMinutes: 120,           // lời nhờ đổi tự hết hạn
  swapCooldownMinutes: 30,           // bị từ chối/hủy thì phải đợi mới nhờ tiếp
};

const ENV_KEYS = {
  MORNING_TIME: "morningTime",
  REMINDER_TIMES: "reminderTimes",
  SHAME_STREAK: "shameStreak",
  LATE_CONFIRM_UNTIL: "lateConfirmUntil",
  MAX_LEAVE_DAYS: "maxLeaveDays",
  SWAP_LIMIT: "swapLimit",
  SWAP_WINDOW_DAYS: "swapWindowDays",
  SWAP_TIMEOUT_MINUTES: "swapTimeoutMinutes",
  SWAP_COOLDOWN_MINUTES: "swapCooldownMinutes",
};

/** Đọc cấu hình từ biến môi trường (wrangler.toml [vars] hoặc file .env). */
export function loadConfig(env = {}) {
  const cfg = { ...DEFAULT_CONFIG };
  for (const [envKey, key] of Object.entries(ENV_KEYS)) {
    const raw = env[envKey];
    if (raw === undefined || raw === "") continue;
    if (Array.isArray(cfg[key])) cfg[key] = String(raw).split(",").map((x) => x.trim()).filter(Boolean);
    else if (typeof cfg[key] === "number") cfg[key] = Number(raw);
    else cfg[key] = String(raw);
  }
  return cfg;
}
