import React, { useState } from "react";
import { cn } from "@/lib/utils";

export default function PlayerPhoto({ src, registrationNumber, alt, size = "md" }) {
  const reg = String(registrationNumber || "").trim();
  const officialSrc = /^\d{4}$/.test(reg) ? `https://www.boatrace.jp/racerphoto/${reg}.jpg` : "";
  const candidates = [src, officialSrc].filter(Boolean);
  const [index, setIndex] = useState(0);
  const currentSrc = candidates[index] || "";
  const sz = size === "xs" ? "w-6 h-6" : size === "sm" ? "w-8 h-8" : "w-10 h-10";
  if (!currentSrc) {
    return (
      <div className={cn("rounded-full bg-slate-700/60 border border-slate-600 flex items-center justify-center shrink-0", sz)}>
        <svg viewBox="0 0 24 24" className="w-1/2 h-1/2 text-slate-500" fill="currentColor">
          <path d="M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z" />
        </svg>
      </div>
    );
  }
  return (
    <img
      src={currentSrc}
      alt={alt || ""}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setIndex((i) => i + 1)}
      className={cn("rounded-full object-cover border border-slate-600 shrink-0 bg-slate-800", sz)}
    />
  );
}