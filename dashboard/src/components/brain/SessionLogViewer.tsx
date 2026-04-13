/**
 * SessionLogViewer — structured rendering of session log JSON files in /brain.
 *
 * Matches the editorial transcript layout from sessions/$id (DESIGN.md §6):
 * margin gutter for role labels, prose body, oxide-edged tool callouts.
 *
 * Detects session logs by JSON structure (messages array with role + content).
 */

import { useMemo, useState } from "react";

interface SessionMessage {
  role: string;
  content: string | null;
  tool_calls?: unknown;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: number;
  token_count?: number;
}

interface SessionLog {
  id?: string;
  model?: string;
  source?: string;
  started_at?: number;
  ended_at?: number;
  message_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  system_prompt?: string;
  messages: SessionMessage[];
}

interface Props {
  raw: string;
}

/** Check if a JSON string looks like a session log. */
export function looksLikeSessionLog(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    // Direct session object with messages array
    if (parsed?.messages && Array.isArray(parsed.messages)) {
      const first = parsed.messages[0];
      return first && typeof first.role === "string";
    }
    // JSONL: check first line
    if (typeof parsed === "object" && parsed.role && "content" in parsed) {
      return true;
    }
    return false;
  } catch {
    // Try JSONL (one JSON object per line)
    const firstLine = raw.trim().split("\n")[0];
    try {
      const obj = JSON.parse(firstLine);
      return typeof obj.role === "string" && "content" in obj;
    } catch {
      return false;
    }
  }
}

function parseSessionLog(raw: string): SessionLog | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.messages && Array.isArray(parsed.messages)) {
      return parsed as SessionLog;
    }
    // Single message object — wrap it
    if (parsed?.role) {
      return { messages: [parsed] };
    }
    return null;
  } catch {
    // Try JSONL
    const lines = raw.trim().split("\n");
    const messages: SessionMessage[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.role) messages.push(obj);
      } catch {
        // skip malformed lines
      }
    }
    return messages.length > 0 ? { messages } : null;
  }
}

function formatTimestamp(unix: number | undefined): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SessionLogViewer({ raw }: Props) {
  const [promptOpen, setPromptOpen] = useState(false);
  const log = useMemo(() => parseSessionLog(raw), [raw]);

  if (!log) return null;

  const systemMessages = log.messages.filter((m) => m.role === "system");
  const conversationMessages = log.messages.filter((m) => m.role !== "system");
  const systemPrompt = systemMessages.map((m) => m.content).join("\n\n");

  return (
    <div role="log" className="h-full overflow-y-auto">
      {/* Metadata header */}
      {(log.id || log.model || log.started_at) && (
        <div className="border-b border-rule px-10 py-4">
          <div className="grid grid-cols-[120px_1fr] gap-2 font-mono text-[11px] tabular-nums">
            {log.id && (
              <>
                <span className="uppercase tracking-marker text-ink-muted">SESSION</span>
                <span className="text-ink">{log.id.slice(0, 12)}</span>
              </>
            )}
            {log.model && (
              <>
                <span className="uppercase tracking-marker text-ink-muted">MODEL</span>
                <span className="text-ink">{String(log.model).split("/").pop()}</span>
              </>
            )}
            {log.source && (
              <>
                <span className="uppercase tracking-marker text-ink-muted">SOURCE</span>
                <span className="text-ink">{log.source}</span>
              </>
            )}
            {log.started_at && (
              <>
                <span className="uppercase tracking-marker text-ink-muted">STARTED</span>
                <span className="text-ink">{formatTimestamp(log.started_at)}</span>
              </>
            )}
            {(log.input_tokens != null || log.output_tokens != null) && (
              <>
                <span className="uppercase tracking-marker text-ink-muted">TOKENS</span>
                <span className="text-ink">
                  {log.input_tokens ?? 0} in / {log.output_tokens ?? 0} out
                </span>
              </>
            )}
            <span className="uppercase tracking-marker text-ink-muted">MESSAGES</span>
            <span className="text-ink">{log.messages.length}</span>
          </div>
        </div>
      )}

      {/* System prompt (collapsible, default closed) */}
      {systemPrompt && (
        <div className="border-b border-rule">
          <button
            type="button"
            onClick={() => setPromptOpen(!promptOpen)}
            className="w-full px-10 py-3 text-left font-mono text-[10px] uppercase tracking-marker text-ink-muted hover:text-ink"
          >
            {promptOpen ? "▾" : "▸"} SYSTEM PROMPT ({systemPrompt.length} chars)
          </button>
          {promptOpen && (
            <div className="bg-surface px-10 py-4">
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-2">
                {systemPrompt}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Conversation turns */}
      <div className="px-10 py-6">
        {conversationMessages.map((msg, i) => (
          <MessageTurn key={i} message={msg} />
        ))}
        {conversationMessages.length === 0 && (
          <p className="font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            no conversation messages
          </p>
        )}
      </div>
    </div>
  );
}

function MessageTurn({ message: msg }: { message: SessionMessage }) {
  const isTool = msg.role === "tool";
  const isAssistant = msg.role === "assistant";

  // Tool call result
  if (isTool) {
    return (
      <div className="mb-4 ml-[100px] border-l border-rule bg-surface px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          TOOL: {msg.tool_name || "unknown"}
        </span>
        {msg.content && (
          <pre className="mt-1 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-snug text-ink-2">
            {msg.content.length > 2000 ? msg.content.slice(0, 2000) + "\n... (truncated)" : msg.content}
          </pre>
        )}
      </div>
    );
  }

  // Tool call from assistant
  const hasToolCalls = isAssistant && !!msg.tool_calls;

  return (
    <div role="group" className="mb-6 grid grid-cols-[100px_1fr] gap-0">
      {/* Role gutter */}
      <div className="pt-1">
        <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          {msg.role}
        </span>
        {msg.timestamp && (
          <div className="mt-1 font-mono text-[9px] tabular-nums text-ink-faint">
            {formatTimestamp(msg.timestamp)}
          </div>
        )}
      </div>

      {/* Content */}
      <div className={isAssistant ? "border-l-2 border-oxide pl-4" : ""}>
        {msg.content && (
          <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">
            {msg.content}
          </div>
        )}
        {hasToolCalls && (
          <div className="mt-3 border-l border-oxide-edge bg-oxide-wash px-4 py-2.5">
            <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
              TOOL CALLS
            </span>
            <pre className="mt-1 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-snug text-ink-2">
              {String(typeof msg.tool_calls === "string"
                ? msg.tool_calls
                : JSON.stringify(msg.tool_calls, null, 2))}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
