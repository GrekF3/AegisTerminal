"use client";

import { memo } from "react";

/** Stable place-value keys keep each wheel mounted when the balance ticks. */
export const RollingNumber = memo(function RollingNumber({ value }: { value: number | null | undefined }) {
  if (value == null || !Number.isFinite(value)) return <span>—</span>;
  const label = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return <span className="rolling-number" aria-label={label}>
    {[...label].map((char, index) => /\d/.test(char)
      ? <span className="number-wheel" key={`place-${label.length - index}`} aria-hidden="true"><span className="number-wheel-track" style={{ transform: `translateY(-${Number(char)}em)` }}>{Array.from({ length: 10 }, (_, digit) => <span key={digit}>{digit}</span>)}</span></span>
      : <span className="number-punctuation" key={`punct-${label.length - index}`} aria-hidden="true">{char}</span>)}
  </span>;
});
