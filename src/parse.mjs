const POLL_PATTERN = /(?:^|\n)[ \t]*\[POLL\][ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\[\/POLL\][ \t]*(?:\r?\n[ \t]*)*$/;

function ensureText(value, label, maxLength) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || [...normalized].length > maxLength) {
    throw new Error(`${label} length must be between 1 and ${maxLength}`);
  }
  return normalized;
}

export function parsePollText(content) {
  if (typeof content !== "string" || !content.includes("[POLL]")) return null;
  const match = POLL_PATTERN.exec(content);
  if (!match) return null;

  // Never interpret a marker located in a markdown fenced code block.
  const prefix = content.slice(0, match.index);
  const fenceCount = (prefix.match(/^\s*```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) return null;

  let raw;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    throw new Error("[POLL] body must contain valid JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("[POLL] body must be a JSON object");
  }
  const question = ensureText(raw.question, "question", 300);
  if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 12) {
    throw new Error("options must contain 2-12 choices");
  }
  const options = raw.options.map((s, i) => ensureText(s, `options[${i}]`, 100));
  if (new Set(options).size !== options.length) throw new Error("options must be unique");

  const anonymous = raw.anonymous === undefined ? false : raw.anonymous;
  const multi = raw.multi === undefined ? false : raw.multi;
  const silent = raw.silent === undefined ? false : raw.silent;
  if (typeof anonymous !== "boolean" || typeof multi !== "boolean" || typeof silent !== "boolean") {
    throw new Error("anonymous, multi and silent must be boolean");
  }
  const durationSeconds = raw.durationSeconds === undefined ? 300 : raw.durationSeconds;
  if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 604800) {
    throw new Error("durationSeconds must be an integer between 5 and 604800");
  }
  const intro = prefix.trim();
  return { intro, poll: { question, options, anonymous, multi, silent, durationSeconds } };
}

export function fallbackText({ intro, poll }) {
  const readable = [poll.question, ...poll.options.map((option, i) => `${i + 1}. ${option}`)].join("\n");
  return intro ? `${intro}\n\n${readable}` : readable;
}
