import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-[11px] text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6b9d73] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-[#204f3b] px-4 py-3 text-white shadow-sm hover:bg-[#163f30]",
        secondary: "border border-[#dce5d8] bg-white px-4 py-[11px] text-[#305a42] hover:bg-[#f5faf3]",
        ghost: "bg-transparent px-3 py-2 text-[#2a6245] hover:bg-[#f0f5ed]",
        outline: "border border-white/30 bg-white/10 px-3 py-2 text-white hover:bg-white/15",
      },
      size: {
        default: "min-h-10",
        sm: "min-h-8 px-3 py-2 text-[11px]",
        icon: "size-10 rounded-full p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
