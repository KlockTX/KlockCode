/**
 * run_code 的结果序列化：宿主进程与沙箱子进程共用一份，
 * 避免两边对"什么算可序列化"判断不一致（例如 undefined / 循环引用）。
 */
export function serializeResultValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "(no return value)";
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
