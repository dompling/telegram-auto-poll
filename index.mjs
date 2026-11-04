import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parsePollText, fallbackText } from "./src/parse.mjs";
import { detectChoicePoll } from "./src/detect.mjs";
import { pollGuidance } from "./src/guidance.mjs";
import { PollJournal } from "./src/state.mjs";
import { DefiniteDeliveryError, sendPollViaCli, sendTextViaCli } from "./src/send.mjs";

const TAG = "投票编号";
const TOKEN_RE = /\[投票编号:([a-f0-9]{16})\]/;
function makeAnchor(intro, token) {
  return intro ? `${intro}\n\n[${TAG}:${token}]` : `📊 请查看接下来的投票。\n[${TAG}:${token}]`;
}

function stringOrEmpty(x) { return typeof x === "string" ? x.trim() : ""; }
function getChannel(event, ctx) { return ctx?.channelId ?? event?.channelId ?? event?.metadata?.channel; }
function getAccount(event, ctx) { return stringOrEmpty(ctx?.accountId ?? event?.accountId ?? event?.metadata?.accountId); }
function stableOrigin(event, ctx, poll) {
  // Only dedupe when the host provides a genuine stable run/message identity.
  const id = ctx?.messageId ?? event?.messageId ?? ctx?.runId;
  if (!id) return undefined;
  const raw = JSON.stringify([ctx?.sessionKey ?? "", String(id), event.to, poll]);
  return createHash("sha256").update(raw).digest("hex");
}

export function createPlugin({
  sendPoll = sendPollViaCli,
  sendText = sendTextViaCli,
  makeJournal = path => new PollJournal(path),
} = {}) {
  return {
    id: "telegram-auto-poll",
    name: "Telegram Auto Poll",
    description: "Turn Telegram decisions into native polls with per-turn guidance and choice detection",
    register(api) {
      const config = api.pluginConfig ?? {};
      if (config.enabled === false) return;
      const logger = api.logger ?? { info() {}, warn() {} };
      const cliPath = stringOrEmpty(config.cliPath) || "openclaw";
      const timeoutMs = Number.isInteger(config.timeoutMs)
        ? Math.max(1000, Math.min(12000, config.timeoutMs)) : 9000;
      const statePath = stringOrEmpty(config.statePath) || join(homedir(), ".openclaw", "telegram-auto-poll-state.json");
      const allowedChatIds = Array.isArray(config.allowedChatIds) ? config.allowedChatIds.map(String) : [];
      const perChatHourlyLimit = Number.isInteger(config.maxPerChatPerHour)
        ? Math.max(1, Math.min(100, config.maxPerChatPerHour)) : 10;
      let journal;
      try { journal = makeJournal(statePath); }
      catch (e) {
        logger.warn(`telegram-auto-poll: cannot initialize journal; plugin disabled: ${e.message}`);
        return;
      }
      const command = { cliPath, timeoutMs };
      const durationSeconds = Number.isInteger(config.defaultDurationSeconds)
        ? Math.max(5, Math.min(604800, config.defaultDurationSeconds)) : 300;

      if (config.promptGuidance !== false) api.on("before_prompt_build", (_event, ctx) => {
        // Agent contexts use channel/messageProvider; channelId can be a chat ID.
        if ((ctx?.channel ?? ctx?.messageProvider ?? ctx?.channelId) !== "telegram") return;
        const chatId = stringOrEmpty(ctx?.chatId ?? ctx?.channelId);
        if (allowedChatIds.length && (!chatId || !allowedChatIds.includes(chatId))) return;
        return { appendSystemContext: pollGuidance(durationSeconds) };
      });

      // No network side effects here. Later hooks can still rewrite or cancel
      // delivery. Only a matching, successful message_sent sends the poll.
      api.on("message_sending", (event, ctx) => {
        if (getChannel(event, ctx) !== "telegram") return;
        if (typeof event?.content !== "string") return;
        let parsed;
        try {
          parsed = parsePollText(event.content);
          if (!parsed && config.autoDetect !== false) parsed = detectChoicePoll(event.content, { durationSeconds });
        }
        catch (e) { logger.warn(`telegram-auto-poll: invalid poll: ${e.message}`); return; }
        if (!parsed) return;
        const to = stringOrEmpty(event.to);
        if (!to) return { content: fallbackText(parsed) };
        if (allowedChatIds.length && !allowedChatIds.includes(to)) return { content: fallbackText(parsed) };
        const accountId = getAccount(event, ctx);
        const originKey = stableOrigin(event, ctx, parsed.poll);
        const earlier = journal.getByOrigin(originKey);
        if (earlier) {
          logger.info("telegram-auto-poll: duplicate origin suppressed");
          return { cancel: true, cancelReason: "telegram-auto-poll duplicate" };
        }
        if (journal.countRecent(to, accountId, Date.now() - 3600000) >= perChatHourlyLimit) {
          logger.warn("telegram-auto-poll: hourly limit reached; falling back to choices");
          return { content: fallbackText(parsed) };
        }
        const threadId = event.threadId ?? ctx?.threadId ?? event.metadata?.threadId;
        try {
          const record = journal.create({ to, accountId, threadId, intro: parsed.intro, poll: parsed.poll, originKey });
          return { content: makeAnchor(record.intro, record.token) };
        } catch (e) {
          logger.warn(`telegram-auto-poll: journal write failed; text fallback: ${e.message}`);
          return { content: fallbackText(parsed) };
        }
      });

      api.on("message_sent", async (event, ctx) => {
        if (getChannel(event, ctx) !== "telegram" || typeof event?.content !== "string") return;
        const token = TOKEN_RE.exec(event.content)?.[1];
        if (!token) return;
        const record = journal.getByToken(token);
        if (!record || record.status !== "pending") return;
        // Do not act on a stale/rewritten message that happens to contain a token.
        if (event.content !== makeAnchor(record.intro, record.token)) return;
        if (stringOrEmpty(event.to) !== record.to) return;
        const accountId = getAccount(event, ctx);
        if (accountId && record.accountId && accountId !== record.accountId) return;
        if (event.success !== true) {
          // Even an unsuccessful logical send may be partially visible.
          try { journal.setStatus(token, "anchor_failed"); }
          catch (e) { logger.warn(`telegram-auto-poll: journal failure: ${e.message}`); }
          return;
        }
        try { journal.setStatus(token, "sending"); }
        catch (e) { logger.warn(`telegram-auto-poll: cannot safely record send attempt: ${e.message}`); return; }
        try {
          const result = await sendPoll({ ...command, to: record.to, threadId: record.threadId,
            accountId: record.accountId, poll: record.poll });
          journal.setStatus(token, "sent");
          const delivery = result?.payload ?? result;
          if (delivery?.warning) logger.warn(`telegram-auto-poll: ${delivery.warning}`);
          logger.info("telegram-auto-poll: poll sent after anchor delivery");
        } catch (e) {
          const definite = e instanceof DefiniteDeliveryError;
          try { journal.setStatus(token, definite ? "failed" : "uncertain"); }
          catch (saveError) { logger.warn(`telegram-auto-poll: journal failure: ${saveError.message}`); }
          if (!definite) {
            logger.warn(`telegram-auto-poll: delivery unknown, refusing automatic retry: ${e.message}`);
            return;
          }
          logger.warn(`telegram-auto-poll: no CLI execution; sending readable fallback: ${e.message}`);
          // A definite local spawn failure means the poll command did not run.
          try { await sendText({ ...command, to: record.to, threadId: record.threadId,
              accountId: record.accountId, message: fallbackText({ intro: "", poll: record.poll }) }); }
          catch (fallbackError) { logger.warn(`telegram-auto-poll: fallback failed: ${fallbackError.message}`); }
        }
      });
    },
  };
}

export default createPlugin();
