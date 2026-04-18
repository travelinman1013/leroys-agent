import { useRef, useState } from "react";
import { createPortal } from "react-dom";

export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const show = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // Position tooltip above the trigger, clamped to viewport
      const tooltipWidth = 288; // w-72 = 18rem = 288px
      let left = rect.left + rect.width / 2 - tooltipWidth / 2;
      // Clamp to viewport edges with 8px padding
      left = Math.max(8, Math.min(left, window.innerWidth - tooltipWidth - 8));
      setPos({ top: rect.top - 8, left });
    }
    setOpen(true);
  };

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex cursor-help"
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
    >
      <span className="inline-flex size-3.5 items-center justify-center rounded-full border border-rule text-[8px] leading-none text-ink-faint transition-colors hover:border-oxide hover:text-oxide">
        ?
      </span>
      {open &&
        createPortal(
          <span
            style={{ top: pos.top, left: pos.left }}
            className="pointer-events-none fixed z-[9999] w-72 -translate-y-full whitespace-normal break-words border border-rule bg-bg-alt px-3 py-2 font-mono text-[10px] normal-case leading-relaxed tracking-normal text-ink shadow-sm"
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
