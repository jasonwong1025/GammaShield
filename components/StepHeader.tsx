"use client";

// The header for one step of the policy setup sequence.
//
// Setting an agent up is genuinely ordered — deploy the account, sign the
// limits, fund it, then watch it — and each step is unavailable until the one
// before it is done. Before this, only step 2 said so, and each step opened
// with a tracked-out uppercase label in accent blue that carried no
// information: the network and the standard were already stated elsewhere on
// the page, and blue elsewhere means "you can act on this".
//
// So the numeral carries the sequence, its fill carries the state, and the
// heading is left to be a heading.

export function StepHeader({
  step,
  state,
  title,
  children,
  aside,
}: {
  step: number;
  /** done — already satisfied. current — what to do next. waiting — blocked. */
  state: "done" | "current" | "waiting";
  title: string;
  /** One line on what this step does, in the second person. */
  children?: React.ReactNode;
  /** Status chip or control, right-aligned on the same line as the title. */
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="step-mark mt-0.5 shrink-0" data-state={state} aria-hidden>
        {state === "done" ? "✓" : step}
      </span>
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-bold tracking-[-0.01em] text-fg">{title}</h3>
          {aside}
        </div>
        {children && <p className="mt-1 max-w-[68ch] text-[12px] leading-relaxed text-muted">{children}</p>}
      </div>
    </div>
  );
}
