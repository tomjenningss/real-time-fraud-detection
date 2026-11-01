import * as React from "react";

import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-11 w-full rounded-[10px] border border-[#dfe7dd] bg-white px-3 text-xs text-[#244431] outline-none placeholder:text-[#99a49d] focus:border-[#6b9d73] focus:ring-4 focus:ring-[#468147]/[.07]",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
