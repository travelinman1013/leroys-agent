import { useState } from "react";

export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex cursor-help"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span className="inline-flex size-3.5 items-center justify-center rounded-full border border-rule text-[8px] leading-none text-ink-faint transition-colors hover:border-oxide hover:text-oxide">
        ?
      </span>
      {open && (
        <span className="absolute bottom-full left-1/2 z-50 mb-2 w-72 -translate-x-1/2 whitespace-normal break-words border border-rule bg-bg-alt px-3 py-2 font-mono text-[10px] normal-case leading-relaxed tracking-normal text-ink shadow-sm">
          {text}
        </span>
      )}
    </span>
  );
}
