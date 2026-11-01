import * as React from "react";

import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-[17px] border border-[#e7ebe5] bg-white shadow-soft", className)}
      {...props}
    />
  );
}
