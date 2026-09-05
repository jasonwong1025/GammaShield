"use client";

// A detail the panel does not open with.
//
// This console has a lot to be honest about — rejected actions, reason codes,
// persistence, execution mode, the exact signed terms — and showing all of it
// at once buried the one thing a visit is usually about: what the agent is
// doing and whether it needs anything. Honesty is about the detail being
// available and truthful, not about it being unavoidable, so the workings sit
// one click behind the answer.

import { useState } from "react";

export function Disclosure({
  label,
  children,
  align = "left",
}: {
  /** Reads as a question the summary above just raised. */
  label: string;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={align === "right" ? "flex justify-end" : ""}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="text-[12px] font-semibold text-blue hover:underline"
        >
          {open ? "Hide" : label}
        </button>
      </div>
      {open && children}
    </>
  );
}
