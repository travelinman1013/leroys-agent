/**
 * F4 — Tool invoke drawer.
 *
 * Auto-generates a form from the tool's JSON Schema (fetched from
 * `GET /api/dashboard/tools/{name}/schema`). Falls back to a raw
 * JSON textarea when no schema is available or the schema can't
 * be rendered as a structured form.
 *
 * The dashboard route is security-critical (see the F4 Phase 4
 * notes in dashboard_routes.py::handle_tool_invoke) — every
 * invocation still funnels through `handle_function_call`, still
 * applies the R3 path jail, still scrubs `force` / `skip_approval`
 * / `unsafe` / `bypass` recursively, and still pre-checks
 * dangerous command patterns before dispatch. The auto-form is
 * purely UX — it does NOT open new attack surface because the
 * body shape it submits (`{ args: {...} }`) is identical to the
 * existing JSON-textarea form.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useApiMutation } from "@/lib/mutations";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type JsonSchemaProperty = {
  type?: string | string[];
  description?: string;
  enum?: Array<string | number>;
  default?: unknown;
  items?: unknown;
  properties?: Record<string, JsonSchemaProperty>;
};

type ToolParameters = {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

function extractParameters(spec: unknown): ToolParameters | null {
  if (!spec || typeof spec !== "object") return null;
  const wrapper = spec as Record<string, unknown>;
  const fn = wrapper.function as Record<string, unknown> | undefined;
  const params = (fn?.parameters ?? wrapper.parameters) as
    | ToolParameters
    | undefined;
  if (!params || typeof params !== "object") return null;
  if (!params.properties || typeof params.properties !== "object") return null;
  return params;
}

function primaryType(prop: JsonSchemaProperty): string {
  if (Array.isArray(prop.type)) {
    // Pick the first non-null type — OpenAI specs commonly emit
    // ["string", "null"] for optional string fields.
    return prop.type.find((t) => t !== "null") ?? prop.type[0] ?? "string";
  }
  return prop.type ?? "string";
}

function defaultValueFor(prop: JsonSchemaProperty): unknown {
  if (prop.default !== undefined) return prop.default;
  if (prop.enum && prop.enum.length > 0) return "";
  const t = primaryType(prop);
  if (t === "boolean") return false;
  if (t === "number" || t === "integer") return "";
  if (t === "array") return "[]";
  if (t === "object") return "{}";
  return "";
}

export function ToolInvokeDrawer({
  open,
  onOpenChange,
  toolName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toolName: string;
}) {
  // Raw JSON textarea state — used as the fallback when no schema
  // is available or the schema can't be rendered structurally.
  const [argsJson, setArgsJson] = useState("{}");
  // Structured auto-form field state — keyed by property name.
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [response, setResponse] = useState<unknown>(null);

  // Fetch the tool schema on open. Enabled gate keeps us from
  // hammering the endpoint when the drawer is closed.
  const schemaQuery = useQuery({
    queryKey: ["dashboard", "tool-schema", toolName],
    queryFn: () => api.toolSchema(toolName),
    enabled: open && Boolean(toolName),
    retry: false,
    staleTime: 60_000,
  });

  const parameters = useMemo(
    () => (schemaQuery.data ? extractParameters(schemaQuery.data.spec) : null),
    [schemaQuery.data],
  );

  // Seed the auto-form with defaults when the schema arrives.
  useEffect(() => {
    if (!parameters?.properties) return;
    const seed: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(parameters.properties)) {
      seed[key] = defaultValueFor(prop);
    }
    setFields(seed);
  }, [parameters]);

  // Reset drawer state on close — avoids stale response/args bleeding
  // into the next invocation.
  useEffect(() => {
    if (!open) {
      setResponse(null);
      setArgsJson("{}");
      setFields({});
    }
  }, [open]);

  const invoke = useApiMutation({
    mutationFn: (args: Record<string, unknown>) =>
      api.invokeTool(toolName, args),
    successMessage: (r) =>
      r?.needs_approval ? "Approval required" : "Tool invoked",
    onSuccess: (r) => setResponse(r),
  });

  // JSON-textarea fallback: parse + validate the raw text.
  let jsonParsed: Record<string, unknown> | null = null;
  let jsonParseError: string | null = null;
  try {
    const value = JSON.parse(argsJson);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      jsonParseError = "args must be a JSON object";
    } else {
      jsonParsed = value as Record<string, unknown>;
    }
  } catch (err) {
    jsonParseError = (err as Error).message;
  }

  // Auto-form: coerce field state into typed args, track any
  // missing required fields and parse errors on object/array
  // sub-fields.
  const { autoArgs, autoErrors, autoMissing } = useMemo(() => {
    const errors: Record<string, string> = {};
    const missing: string[] = [];
    const out: Record<string, unknown> = {};
    if (!parameters?.properties) {
      return { autoArgs: out, autoErrors: errors, autoMissing: missing };
    }
    const required = new Set(parameters.required ?? []);
    for (const [key, prop] of Object.entries(parameters.properties)) {
      const raw = fields[key];
      const t = primaryType(prop);
      if (t === "boolean") {
        out[key] = Boolean(raw);
        continue;
      }
      if (t === "number" || t === "integer") {
        if (raw === "" || raw === undefined || raw === null) {
          if (required.has(key)) missing.push(key);
          continue;
        }
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          errors[key] = "not a number";
          continue;
        }
        out[key] = t === "integer" ? Math.trunc(n) : n;
        continue;
      }
      if (t === "array" || t === "object") {
        if (raw === "" || raw === undefined || raw === null) {
          if (required.has(key)) missing.push(key);
          continue;
        }
        try {
          const parsed = JSON.parse(String(raw));
          const expectArray = t === "array";
          if (expectArray && !Array.isArray(parsed)) {
            errors[key] = "expected JSON array";
          } else if (!expectArray && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
            errors[key] = "expected JSON object";
          } else {
            out[key] = parsed;
          }
        } catch (e) {
          errors[key] = (e as Error).message;
        }
        continue;
      }
      // string (default)
      const s = raw === undefined || raw === null ? "" : String(raw);
      if (s === "") {
        if (required.has(key)) missing.push(key);
        continue;
      }
      out[key] = s;
    }
    return { autoArgs: out, autoErrors: errors, autoMissing: missing };
  }, [fields, parameters]);

  const autoFormUsable = Boolean(parameters?.properties);
  const autoReady =
    autoFormUsable &&
    autoMissing.length === 0 &&
    Object.keys(autoErrors).length === 0;

  const handleInvoke = () => {
    if (autoFormUsable) {
      if (autoReady) invoke.mutate(autoArgs);
      return;
    }
    if (jsonParsed) invoke.mutate(jsonParsed);
  };

  const canSubmit = autoFormUsable
    ? autoReady && !invoke.isPending
    : Boolean(jsonParsed) && !invoke.isPending;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width="w-[560px]">
        <SheetHeader>
          <SheetTitle>INVOKE · {toolName}</SheetTitle>
          <SheetDescription>
            Calls run through the same approval + path-jail gates as the
            agent loop. Dangerous shell commands return 202 needs_approval
            instead of executing.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {schemaQuery.isLoading && (
            <p className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
              loading schema<span className="loading-cursor ml-2" />
            </p>
          )}

          {autoFormUsable ? (
            <div className="space-y-4">
              {Object.entries(parameters!.properties!).map(([key, prop]) => {
                const isRequired = (parameters!.required ?? []).includes(key);
                const err = autoErrors[key];
                return (
                  <SchemaField
                    key={key}
                    name={key}
                    prop={prop}
                    required={isRequired}
                    value={fields[key]}
                    onChange={(v) =>
                      setFields((p) => ({ ...p, [key]: v }))
                    }
                    error={err}
                  />
                );
              })}
            </div>
          ) : (
            !schemaQuery.isLoading && (
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                  args (JSON object)
                  {schemaQuery.isError && (
                    <span className="ml-2 text-ink-faint">
                      · no schema available, using raw JSON
                    </span>
                  )}
                </span>
                <Textarea
                  rows={10}
                  value={argsJson}
                  onChange={(e) => setArgsJson(e.target.value)}
                  className={jsonParseError ? "mt-1 border-danger" : "mt-1"}
                />
                {jsonParseError && (
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-marker text-danger">
                    {jsonParseError}
                  </p>
                )}
              </label>
            )
          )}

          {response != null && (
            <div className="mt-4">
              <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                response
              </span>
              <pre className="mt-1 max-h-64 overflow-auto border border-rule bg-bg p-3 font-mono text-[11px] text-ink">
                {JSON.stringify(response, null, 2)}
              </pre>
            </div>
          )}
        </SheetBody>
        <SheetFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            CLOSE
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSubmit}
            onClick={handleInvoke}
          >
            {invoke.isPending ? "INVOKING…" : "INVOKE"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Render one property from a tool's JSON Schema. */
function SchemaField({
  name,
  prop,
  required,
  value,
  onChange,
  error,
}: {
  name: string;
  prop: JsonSchemaProperty;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
}) {
  const t = primaryType(prop);

  const label = (
    <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
      {name}
      {required && (
        <span
          className="inline-block size-1 rounded-full bg-oxide"
          aria-label="required"
          title="required"
        />
      )}
    </span>
  );

  const hint = prop.description ? (
    <p
      className={cn(
        "mt-1 font-mono text-[10px] tracking-marker",
        error ? "text-danger" : "text-ink-faint",
      )}
    >
      {error ?? prop.description}
    </p>
  ) : error ? (
    <p className="mt-1 font-mono text-[10px] tracking-marker text-danger">
      {error}
    </p>
  ) : null;

  // Enum → Select
  if (prop.enum && prop.enum.length > 0) {
    return (
      <label className="block">
        {label}
        <Select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1"
        >
          <option value="">—</option>
          {prop.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </Select>
        {hint}
      </label>
    );
  }

  if (t === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1">
          {label}
          {prop.description && (
            <p className="mt-1 font-mono text-[10px] tracking-marker text-ink-faint">
              {prop.description}
            </p>
          )}
        </div>
        <Switch
          checked={Boolean(value)}
          onCheckedChange={(v) => onChange(v)}
          aria-label={name}
        />
      </div>
    );
  }

  if (t === "number" || t === "integer") {
    return (
      <label className="block">
        {label}
        <Input
          type="number"
          step={t === "integer" ? 1 : "any"}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          className={cn("mt-1", error && "border-danger")}
        />
        {hint}
      </label>
    );
  }

  if (t === "array" || t === "object") {
    return (
      <label className="block">
        {label}
        <Textarea
          rows={4}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t === "array" ? "[]" : "{}"}
          className={cn("mt-1 font-mono text-[11px]", error && "border-danger")}
        />
        {hint}
      </label>
    );
  }

  // string (default)
  return (
    <label className="block">
      {label}
      <Input
        type="text"
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
        className={cn("mt-1", error && "border-danger")}
      />
      {hint}
    </label>
  );
}
