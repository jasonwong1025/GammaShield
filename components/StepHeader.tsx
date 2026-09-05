"use client";

// Shared heading for account and policy details.

export function StepHeader({
  title,
  children,
  aside,
}: {
  title: string;
  /** One line on what this step does, in the second person. */
  children?: React.ReactNode;
  /** Status chip or control, right-aligned on the same line as the title. */
  aside?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold tracking-[-0.01em] text-fg">{title}</h3>
        {aside}
      </div>
      {children && <p className="mt-1 max-w-[68ch] text-[12px] leading-relaxed text-muted">{children}</p>}
    </div>
  );
}
