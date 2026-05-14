/**
 * 文件日志：把启动 / 错误 / 诊断信息持久化到 ~/.wand/logs/wand-YYYY-MM-DD.log。
 *
 * 设计要点：
 * - 按天分文件，跨日自动 rotate（写入时检测日期变化 + 一个零点定时器双保险）。
 * - 默认保留 7 天，老文件每次 rotate / init 时清掉。
 * - 写失败一律静默 — 日志系统不能因为磁盘问题反过来把进程拉挂。
 * - 不劫持 stdout/stderr。调用方按需调用 logToFile()，避免和 TUI 的 log-bus
 *   抢占 stderr。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

export type LogLevel = "info" | "warn" | "error";

interface FileLoggerState {
  logsDir: string;
  currentDate: string;
  retentionDays: number;
  rotationTimer: NodeJS.Timeout | null;
}

let state: FileLoggerState | null = null;

const DEFAULT_RETENTION_DAYS = 7;

function todayString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function logFilePath(logsDir: string, date: string): string {
  return path.join(logsDir, `wand-${date}.log`);
}

function pruneOldLogs(logsDir: string, retentionDays: number): void {
  try {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(logsDir)) {
      if (!name.startsWith("wand-") || !name.endsWith(".log")) continue;
      const full = path.join(logsDir, name);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) unlinkSync(full);
      } catch {
        /* ignore individual file errors */
      }
    }
  } catch {
    /* ignore — pruning failure must not block logging */
  }
}

function scheduleMidnightRotation(): void {
  if (!state) return;
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 5, 0);
  const delay = Math.max(60_000, next.getTime() - now.getTime());
  state.rotationTimer = setTimeout(() => {
    if (!state) return;
    state.currentDate = todayString();
    pruneOldLogs(state.logsDir, state.retentionDays);
    scheduleMidnightRotation();
  }, delay);
  state.rotationTimer.unref?.();
}

export function initFileLogger(configDir: string, retentionDays = DEFAULT_RETENTION_DAYS): void {
  if (state) return;
  const logsDir = path.join(configDir, "logs");
  try {
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  } catch {
    return;
  }
  state = {
    logsDir,
    currentDate: todayString(),
    retentionDays,
    rotationTimer: null,
  };
  pruneOldLogs(logsDir, retentionDays);
  scheduleMidnightRotation();
}

export function logToFile(level: LogLevel, line: string): void {
  if (!state) return;
  const today = todayString();
  if (today !== state.currentDate) {
    state.currentDate = today;
    pruneOldLogs(state.logsDir, state.retentionDays);
  }
  const cleaned = line.replace(/\s+$/, "");
  if (cleaned.length === 0) return;
  const ts = new Date().toISOString();
  try {
    appendFileSync(logFilePath(state.logsDir, state.currentDate), `${ts} [${level}] ${cleaned}\n`);
  } catch {
    /* swallow — log failures must not crash the server */
  }
}

export function getLogsDir(): string | null {
  return state?.logsDir ?? null;
}

export function getCurrentLogPath(): string | null {
  if (!state) return null;
  return logFilePath(state.logsDir, state.currentDate);
}

export function closeFileLogger(): void {
  if (!state) return;
  if (state.rotationTimer) clearTimeout(state.rotationTimer);
  state = null;
}
