import { spawn } from "node:child_process";

export class UncertainDeliveryError extends Error {
  constructor(message) { super(message); this.name = "UncertainDeliveryError"; }
}
export class DefiniteDeliveryError extends Error {
  constructor(message) { super(message); this.name = "DefiniteDeliveryError"; }
}

function baseArgs({ to, accountId, threadId }) {
  if (typeof to !== "string" || !to.trim()) throw new DefiniteDeliveryError("missing Telegram recipient");
  const args = ["--channel", "telegram", "--target", to];
  if (accountId) args.push("--account", String(accountId));
  if (threadId !== undefined && threadId !== null && threadId !== "") args.push("--thread-id", String(threadId));
  return args;
}

export function pollArguments({ to, threadId, accountId, poll }) {
  const args = ["message", "poll", ...baseArgs({ to, accountId, threadId }), "--poll-question", poll.question];
  for (const option of poll.options) args.push("--poll-option", option);
  args.push("--poll-duration-seconds", String(poll.durationSeconds));
  args.push(poll.anonymous ? "--poll-anonymous" : "--poll-public");
  if (poll.multi) args.push("--poll-multi");
  if (poll.silent) args.push("--silent");
  args.push("--json");
  return args;
}

export function messageArguments({ to, threadId, accountId, message }) {
  return ["message", "send", ...baseArgs({ to, accountId, threadId }), "--message", message];
}

// A non-zero exit or timeout is UNKNOWN, not definitely unsent: the provider
// may have accepted the poll before the CLI process failed. Never auto-retry.
export function runCli(cliPath, args, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cliPath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      reject(new DefiniteDeliveryError(`cannot start CLI: ${e.message}`));
      return;
    }
    let settled = false;
    let timedOut = false;
    let timer;
    let killTimer;
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      // Keep draining output but bound diagnostic memory use.
      if (output.length < 65536) output += chunk.slice(0, 65536 - output.length);
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        let result;
        try { result = JSON.parse(output); } catch { /* older CLI output has no routing diagnostics */ }
        resolve(result);
      }
    };
    child.stderr?.resume();
    child.once("error", e => finish(new DefiniteDeliveryError(`cannot start CLI: ${e.message}`)));
    child.once("close", (code, signal) => {
      clearTimeout(killTimer);
      if (settled) return;
      if (timedOut) finish(new UncertainDeliveryError("poll CLI timed out; delivery unknown"));
      else if (code === 0) finish();
      else finish(new UncertainDeliveryError(`poll CLI exited with ${code ?? signal}; delivery unknown`));
    });
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* process may already be gone */ }
      // Escalate after a grace period without keeping the Gateway event loop alive.
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 1000);
      killTimer.unref?.();
      // Do not hang the plugin if the child ignores termination.
      finish(new UncertainDeliveryError("poll CLI timed out; delivery unknown"));
    }, timeoutMs);
  });
}

export function sendPollViaCli({ cliPath, timeoutMs, ...details }) {
  return runCli(cliPath, pollArguments(details), timeoutMs);
}

export function sendTextViaCli({ cliPath, timeoutMs, ...details }) {
  return runCli(cliPath, messageArguments(details), timeoutMs);
}
