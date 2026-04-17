import { useState, useCallback } from "react";

type Mode = "interval" | "cron" | "once";

const MINUTE_PRESETS = ["*", "0", "15", "30", "45", "*/5", "*/15"];
const HOUR_PRESETS = ["*", "0", "6", "9", "12", "18", "*/2", "*/6"];
const DOM_PRESETS = ["*", "1", "15", "*/2"];
const DOW_LABELS: Record<string, string> = {
  "*": "Every day",
  "0": "Sun",
  "1": "Mon",
  "2": "Tue",
  "3": "Wed",
  "4": "Thu",
  "5": "Fri",
  "6": "Sat",
  "1-5": "Mon-Fri",
  "0,6": "Sat-Sun",
};
const DOW_PRESETS = Object.keys(DOW_LABELS);
const MONTH_PRESETS = [
  "*",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
];

interface ScheduleBuilderProps {
  value: string;
  onChange: (value: string) => void;
  preview?: string;
  error?: string;
}

export function ScheduleBuilder({
  value,
  onChange,
  preview,
  error,
}: ScheduleBuilderProps) {
  const [mode, setMode] = useState<Mode>(() => detectMode(value));
  const [showRaw, setShowRaw] = useState(false);

  // Interval state
  const [intervalNum, setIntervalNum] = useState(() => {
    const m = value.match(/^every\s+(\d+)/i);
    return m ? m[1] : "30";
  });
  const [intervalUnit, setIntervalUnit] = useState<"m" | "h" | "d">(() => {
    if (/\d+h/i.test(value)) return "h";
    if (/\d+d/i.test(value)) return "d";
    return "m";
  });

  // Cron field state
  const [cronFields, setCronFields] = useState<string[]>(() =>
    parseCronFields(value),
  );

  // One-time state
  const [onceDate, setOnceDate] = useState(() => {
    if (value.includes("T")) return value.slice(0, 10);
    return new Date().toISOString().slice(0, 10);
  });
  const [onceTime, setOnceTime] = useState(() => {
    if (value.includes("T")) return value.slice(11, 16);
    return "09:00";
  });

  // Emit on mode/field change
  const emitInterval = useCallback(
    (num: string, unit: string) => {
      const n = parseInt(num, 10);
      if (n > 0) onChange(`every ${n}${unit}`);
    },
    [onChange],
  );

  const emitCron = useCallback(
    (fields: string[]) => {
      onChange(fields.join(" "));
    },
    [onChange],
  );

  const emitOnce = useCallback(
    (date: string, time: string) => {
      if (date && time) onChange(`${date}T${time}`);
    },
    [onChange],
  );

  const handleModeSwitch = (m: Mode) => {
    setMode(m);
    if (m === "interval") emitInterval(intervalNum, intervalUnit);
    else if (m === "cron") emitCron(cronFields);
    else emitOnce(onceDate, onceTime);
  };

  return (
    <div className="space-y-2">
      {/* Mode tabs */}
      <div className="flex items-center gap-3">
        <div className="flex rounded border border-rule">
          {(["interval", "cron", "once"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => handleModeSwitch(m)}
              className={`px-2 py-0.5 font-mono text-[10px] uppercase tracking-marker transition-colors ${
                m !== "interval" ? "border-l border-rule" : ""
              } ${
                mode === m
                  ? "bg-oxide-wash text-oxide"
                  : "text-ink-muted hover:text-ink-faint"
              }`}
            >
              {m === "interval"
                ? "Interval"
                : m === "cron"
                  ? "Cron"
                  : "One-time"}
            </button>
          ))}
        </div>

        {mode === "cron" && (
          <label className="flex items-center gap-1.5 font-mono text-[10px] text-ink-faint">
            <input
              type="checkbox"
              checked={showRaw}
              onChange={(e) => setShowRaw(e.target.checked)}
              className="accent-oxide"
            />
            raw
          </label>
        )}
      </div>

      {/* Interval mode */}
      {mode === "interval" && (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            Every
          </span>
          <input
            type="number"
            min={1}
            value={intervalNum}
            onChange={(e) => {
              setIntervalNum(e.target.value);
              emitInterval(e.target.value, intervalUnit);
            }}
            className="w-20 border border-rule bg-bg px-2 py-1.5 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
          />
          <select
            value={intervalUnit}
            onChange={(e) => {
              const u = e.target.value as "m" | "h" | "d";
              setIntervalUnit(u);
              emitInterval(intervalNum, u);
            }}
            className="border border-rule bg-bg px-2 py-1.5 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
          >
            <option value="m">minutes</option>
            <option value="h">hours</option>
            <option value="d">days</option>
          </select>
        </div>
      )}

      {/* Cron mode — raw text or field selectors */}
      {mode === "cron" && showRaw && (
        <input
          type="text"
          placeholder="0 9 * * *"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            const fields = parseCronFields(e.target.value);
            setCronFields(fields);
          }}
          className="w-full border border-rule bg-bg px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
        />
      )}
      {mode === "cron" && !showRaw && (
        <div className="flex flex-wrap items-start gap-2">
          <CronFieldSelect
            label="MIN"
            value={cronFields[0]}
            presets={MINUTE_PRESETS}
            onChange={(v) => {
              const f = [...cronFields];
              f[0] = v;
              setCronFields(f);
              emitCron(f);
            }}
          />
          <CronFieldSelect
            label="HOUR"
            value={cronFields[1]}
            presets={HOUR_PRESETS}
            onChange={(v) => {
              const f = [...cronFields];
              f[1] = v;
              setCronFields(f);
              emitCron(f);
            }}
          />
          <CronFieldSelect
            label="DOM"
            value={cronFields[2]}
            presets={DOM_PRESETS}
            onChange={(v) => {
              const f = [...cronFields];
              f[2] = v;
              setCronFields(f);
              emitCron(f);
            }}
          />
          <CronFieldSelect
            label="MON"
            value={cronFields[3]}
            presets={MONTH_PRESETS}
            onChange={(v) => {
              const f = [...cronFields];
              f[3] = v;
              setCronFields(f);
              emitCron(f);
            }}
          />
          <CronFieldSelect
            label="DOW"
            value={cronFields[4]}
            presets={DOW_PRESETS}
            labelMap={DOW_LABELS}
            onChange={(v) => {
              const f = [...cronFields];
              f[4] = v;
              setCronFields(f);
              emitCron(f);
            }}
          />
        </div>
      )}

      {/* One-time mode */}
      {mode === "once" && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={onceDate}
            onChange={(e) => {
              setOnceDate(e.target.value);
              emitOnce(e.target.value, onceTime);
            }}
            className="border border-rule bg-bg px-2 py-1.5 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
          />
          <input
            type="time"
            value={onceTime}
            onChange={(e) => {
              setOnceTime(e.target.value);
              emitOnce(onceDate, e.target.value);
            }}
            className="border border-rule bg-bg px-2 py-1.5 font-mono text-[12px] text-ink focus:border-oxide-edge focus:outline-none"
          />
        </div>
      )}

      {/* Preview / error */}
      {preview && (
        <p className="font-mono text-[10px] text-success">{preview}</p>
      )}
      {error && (
        <p className="font-mono text-[10px] text-destructive">{error}</p>
      )}
    </div>
  );
}

/* ── Cron field selector ── */

function CronFieldSelect({
  label,
  value,
  presets,
  labelMap,
  onChange,
}: {
  label: string;
  value: string;
  presets: string[];
  labelMap?: Record<string, string>;
  onChange: (v: string) => void;
}) {
  const isCustom = !presets.includes(value);
  const [custom, setCustom] = useState(isCustom ? value : "");

  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[9px] uppercase tracking-marker text-ink-faint">
        {label}
      </span>
      <select
        value={isCustom ? "__custom__" : value}
        onChange={(e) => {
          if (e.target.value === "__custom__") {
            onChange(custom || "*");
          } else {
            onChange(e.target.value);
          }
        }}
        className="w-[88px] border border-rule bg-bg px-1.5 py-1.5 font-mono text-[11px] text-ink focus:border-oxide-edge focus:outline-none"
      >
        {presets.map((p) => (
          <option key={p} value={p}>
            {labelMap?.[p] ?? p}
          </option>
        ))}
        <option value="__custom__">custom...</option>
      </select>
      {isCustom && (
        <input
          type="text"
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            if (e.target.value.trim()) onChange(e.target.value.trim());
          }}
          placeholder={label}
          className="w-[88px] border border-rule bg-bg px-1.5 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-oxide-edge focus:outline-none"
        />
      )}
    </div>
  );
}

/* ── Helpers ── */

function detectMode(value: string): Mode {
  if (!value) return "interval";
  if (/^every\s/i.test(value) || /^\d+[mhd]$/i.test(value)) return "interval";
  if (value.includes("T") || /^\d{4}-/.test(value)) return "once";
  return "cron";
}

function parseCronFields(value: string): string[] {
  const parts = value.trim().split(/\s+/);
  if (parts.length >= 5) return parts.slice(0, 5);
  return ["0", "9", "*", "*", "*"];
}
