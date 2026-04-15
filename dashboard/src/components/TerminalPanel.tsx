/**
 * TerminalPanel — global shell drawer.
 *
 * Invokes the agent's `terminal` tool via the dashboard API.
 * Mirrors ToolInvokeDrawer's Sheet structure. Dangerous commands
 * return 202 needs_approval and display a warning instead of executing.
 *
 * Toggle: Ctrl+` (backtick) or the >_ button in StatusHeader.
 */

import { useCallback, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from "@/components/ui/sheet";

interface HistoryEntry {
  command: string;
  output: string;
  needsApproval?: boolean;
  error?: boolean;
  ts: number;
}

const MAX_HISTORY = 200;

interface TerminalPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TerminalPanel({ open, onOpenChange }: TerminalPanelProps) {
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const historyRef = useRef<HistoryEntry[]>([]);
  const cmdHistoryRef = useRef<string[]>([]);
  const cmdIndexRef = useRef(-1);
  const [, forceRender] = useState(0);
  const outputRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
    });
  }, []);

  const execute = useCallback(async () => {
    const cmd = command.trim();
    if (!cmd || running) return;

    setCommand("");
    setRunning(true);
    cmdHistoryRef.current.push(cmd);
    cmdIndexRef.current = -1;

    try {
      const res = await api.invokeTool("terminal", { command: cmd });
      const entry: HistoryEntry = {
        command: cmd,
        output: "",
        ts: Date.now(),
      };

      if (res.needs_approval) {
        entry.needsApproval = true;
        entry.output = `[APPROVAL REQUIRED] ${res.description ?? res.pattern_key ?? "Dangerous command detected"}\n\nCommand: ${res.command ?? cmd}`;
      } else if (res.result !== undefined) {
        entry.output = typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2);
      } else {
        entry.output = JSON.stringify(res, null, 2);
      }

      historyRef.current.push(entry);
      if (historyRef.current.length > MAX_HISTORY) {
        historyRef.current = historyRef.current.slice(-MAX_HISTORY);
      }
    } catch (err: unknown) {
      historyRef.current.push({
        command: cmd,
        output: err instanceof Error ? err.message : String(err),
        error: true,
        ts: Date.now(),
      });
    }

    setRunning(false);
    forceRender((n) => n + 1);
    scrollToBottom();
  }, [command, running, scrollToBottom]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      execute();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const cmds = cmdHistoryRef.current;
      if (cmds.length === 0) return;
      const idx = cmdIndexRef.current === -1 ? cmds.length - 1 : Math.max(0, cmdIndexRef.current - 1);
      cmdIndexRef.current = idx;
      setCommand(cmds[idx]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const cmds = cmdHistoryRef.current;
      if (cmdIndexRef.current === -1) return;
      const idx = cmdIndexRef.current + 1;
      if (idx >= cmds.length) {
        cmdIndexRef.current = -1;
        setCommand("");
      } else {
        cmdIndexRef.current = idx;
        setCommand(cmds[idx]);
      }
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width="w-full sm:w-[480px] md:w-[560px] lg:w-[640px]">
        <SheetHeader>
          <SheetTitle>TERMINAL</SheetTitle>
          <SheetDescription>
            Runs commands via the agent's terminal tool. Dangerous commands
            require approval.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <div
            ref={outputRef}
            className="flex-1 overflow-y-auto font-mono text-[11px]"
          >
            {historyRef.current.map((entry, i) => (
              <div key={i} className="mb-3">
                <div className="text-oxide">$ {entry.command}</div>
                {entry.needsApproval ? (
                  <div className="mt-1 border border-warning/40 bg-warning/5 px-3 py-2 text-warning">
                    <div>{entry.output}</div>
                    <Link
                      to="/approvals"
                      className="mt-1 inline-block text-oxide underline"
                      onClick={() => onOpenChange(false)}
                    >
                      Go to Approvals
                    </Link>
                  </div>
                ) : (
                  <pre
                    className={`mt-1 whitespace-pre-wrap ${entry.error ? "text-danger" : "text-ink"}`}
                  >
                    {entry.output || "(no output)"}
                  </pre>
                )}
              </div>
            ))}
            {running && (
              <div className="text-ink-muted">
                running<span className="loading-cursor ml-1" />
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-rule pt-3">
            <span className="font-mono text-[11px] text-oxide">$</span>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="type a command..."
              disabled={running}
              autoFocus
              className="flex-1 bg-transparent font-mono text-[12px] text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
