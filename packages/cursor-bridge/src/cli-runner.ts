/**
 * Cursor CLI Runner — spawns `agent` CLI in print mode and parses stream-json output.
 * Maps Cursor's stream events to BotsChat protocol messages.
 */

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";

export type StreamEvent =
  | { type: "agent.stream.start"; runId: string; model?: string }
  | { type: "agent.stream.chunk"; runId: string; text: string }
  | { type: "agent.stream.end"; runId: string; result?: string }
  | { type: "agent.trace"; verboseLevel: 2 | 3; traceType: string; content: string; metadata?: Record<string, unknown> }
  | { type: "error"; message: string };

export type RunOptions = {
  chatId: string;
  prompt: string;
  workspace?: string;
  model?: string;
  onEvent: (event: StreamEvent) => void;
};

const AGENT_BIN = process.env.CURSOR_AGENT_BIN ?? "agent";
const RG_PATH = process.env.RG_PATH ?? "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin";

export async function createChat(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(AGENT_BIN, ["create-chat"], {
      env: { ...process.env, PATH: `${RG_PATH}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    proc.stdout.on("data", (d) => { output += d.toString(); });
    proc.stderr.on("data", (d) => { console.error("[cli] create-chat stderr:", d.toString()); });
    proc.on("close", (code) => {
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        reject(new Error(`create-chat failed with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

export function runAgent(opts: RunOptions): { proc: ChildProcess; abort: () => void } {
  const runId = randomUUID().slice(0, 8);
  const args = [
    "-p", "--force", "--trust",
    "--output-format", "stream-json",
    "--resume", opts.chatId,
  ];
  if (opts.model) args.push("--model", opts.model);
  args.push(opts.prompt);

  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${RG_PATH}:${process.env.PATH}`,
  };
  // Ensure we're not running inside Cursor's extension host
  delete env.CURSOR_AGENT;
  delete env.VSCODE_IPC_HOOK;
  delete env.CURSOR_EXTENSION_HOST_ROLE;

  console.log(`[cli] Spawning: ${AGENT_BIN} ${args.join(" ")}`);
  console.log(`[cli] CWD: ${opts.workspace ?? process.cwd()}`);
  console.log(`[cli] CURSOR_AGENT=${env.CURSOR_AGENT ?? "unset"}, VSCODE_IPC_HOOK=${env.VSCODE_IPC_HOOK ? "SET" : "unset"}`);

  const proc = spawn(AGENT_BIN, args, {
    env,
    cwd: opts.workspace ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  console.log(`[cli] Spawned PID: ${proc.pid}`);

  let streamStarted = false;
  let accumulatedText = "";
  let lineBuffer = "";

  proc.stdout.on("data", (data) => {
    lineBuffer += data.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        processStreamEvent(event, runId, opts.onEvent, { streamStarted, accumulatedText });
        if (!streamStarted && event.type === "system") {
          streamStarted = true;
          opts.onEvent({ type: "agent.stream.start", runId, model: event.model });
        }
        if (event.type === "assistant") {
          const text = event.message?.content?.[0]?.text ?? "";
          if (text) {
            accumulatedText += text;
            opts.onEvent({ type: "agent.stream.chunk", runId, text: accumulatedText });
          }
        }
      } catch {
        // Non-JSON line, ignore
      }
    }
  });

  proc.stdout.on("end", () => { console.log("[cli] stdout ended"); });
  proc.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.error("[cli] stderr:", text);
  });
  proc.stderr.on("end", () => { console.log("[cli] stderr ended"); });

  proc.on("close", (code) => {
    // Process any remaining buffered line
    if (lineBuffer.trim()) {
      try {
        const event = JSON.parse(lineBuffer);
        processStreamEvent(event, runId, opts.onEvent, { streamStarted, accumulatedText });
      } catch { /* ignore */ }
    }

    if (code !== 0) {
      opts.onEvent({ type: "error", message: `Agent CLI exited with code ${code}` });
    }
    opts.onEvent({ type: "agent.stream.end", runId, result: accumulatedText });
  });

  proc.on("error", (err) => {
    opts.onEvent({ type: "error", message: `Failed to spawn agent: ${err.message}` });
  });

  return {
    proc,
    abort: () => { try { proc.kill("SIGTERM"); } catch { /* ignore */ } },
  };
}

function processStreamEvent(
  event: Record<string, unknown>,
  runId: string,
  onEvent: (event: StreamEvent) => void,
  _ctx: { streamStarted: boolean; accumulatedText: string },
) {
  // Map tool_call events to lv3 traces
  if (event.type === "tool_call") {
    const subtype = event.subtype as string;
    const toolCall = event.tool_call as Record<string, unknown> | undefined;
    if (!toolCall) return;

    if (toolCall.readToolCall) {
      const read = toolCall.readToolCall as Record<string, unknown>;
      const args = read.args as Record<string, unknown> | undefined;
      if (subtype === "started") {
        onEvent({
          type: "agent.trace", verboseLevel: 3, traceType: "file_read",
          content: `Reading: ${args?.path ?? "unknown"}`,
          metadata: { path: args?.path, lines: args?.limit },
        });
      } else if (subtype === "completed") {
        const result = read.result as Record<string, unknown> | undefined;
        const success = result?.success as Record<string, unknown> | undefined;
        onEvent({
          type: "agent.trace", verboseLevel: 3, traceType: "file_read",
          content: `Read ${success?.totalLines ?? "?"} lines from ${args?.path ?? "unknown"}`,
          metadata: { path: args?.path, totalLines: success?.totalLines },
        });
      }
    }

    if (toolCall.writeToolCall) {
      const write = toolCall.writeToolCall as Record<string, unknown>;
      const args = write.args as Record<string, unknown> | undefined;
      if (subtype === "completed") {
        const result = write.result as Record<string, unknown> | undefined;
        const success = result?.success as Record<string, unknown> | undefined;
        onEvent({
          type: "agent.trace", verboseLevel: 3, traceType: "file_write",
          content: `Wrote ${success?.linesCreated ?? "?"} lines (${success?.fileSize ?? "?"} bytes) to ${args?.path ?? "unknown"}`,
          metadata: { path: args?.path, linesCreated: success?.linesCreated, fileSize: success?.fileSize },
        });
      }
    }

    if (toolCall.bashToolCall || toolCall.shellToolCall) {
      const bash = (toolCall.bashToolCall ?? toolCall.shellToolCall) as Record<string, unknown>;
      const args = bash.args as Record<string, unknown> | undefined;
      if (subtype === "started") {
        onEvent({
          type: "agent.trace", verboseLevel: 3, traceType: "command_exec",
          content: `Running: ${args?.command ?? "unknown"}`,
          metadata: { command: args?.command },
        });
      } else if (subtype === "completed") {
        const result = bash.result as Record<string, unknown> | undefined;
        onEvent({
          type: "agent.trace", verboseLevel: 3, traceType: "command_exec",
          content: `${result?.output ?? "(no output)"}`,
          metadata: { command: args?.command, exitCode: result?.exitCode },
        });
      }
    }
  }
}
