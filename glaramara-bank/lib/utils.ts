import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatMoney(value: number, showSign = false) {
  const amount = Math.abs(value).toLocaleString("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
  });
  if (!showSign) return amount;
  return `${value >= 0 ? "+" : "−"}${amount}`;
}
