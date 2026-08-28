"use client";

import { useState } from "react";

// Number that flashes green/red when it changes between renders.
export function LivePrice({
  value,
  format,
  className = "",
}: {
  value: number;
  format: (v: number) => string;
  className?: string;
}) {
  const [prev, setPrev] = useState(value);
  const [dir, setDir] = useState<"up" | "down" | null>(null);

  if (value !== prev) {
    setDir(value > prev ? "up" : "down");
    setPrev(value);
  }

  return (
    <span
      key={value}
      className={`num ${dir === "up" ? "flash-up" : dir === "down" ? "flash-down" : ""} ${className}`}
    >
      {format(value)}
    </span>
  );
}
