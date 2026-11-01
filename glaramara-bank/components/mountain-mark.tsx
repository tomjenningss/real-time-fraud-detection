import { cn } from "@/lib/utils";

type MountainProps = { className?: string };

export function MountainMark({ className }: MountainProps) {
  return (
    <span
      className={cn("grid size-[43px] shrink-0 place-items-center rounded-[14px] bg-[#173F33]", className)}
      aria-hidden="true"
    >
      <svg width="31" height="31" viewBox="0 0 40 40" fill="none">
        <circle cx="29" cy="12" r="3.5" fill="#CCE3BA" />
        <path
          d="M4 30 15 12l8 12 5-7 9 13"
          stroke="#E4F2D7"
          strokeWidth="2.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d="m11 19 4 4 3-4M23 24l5 4 4-5"
          stroke="#A2C99C"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path d="M5 34h30" stroke="#B7DAB4" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function AccountMountain({ className }: MountainProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 130 110"
      fill="none"
      role="img"
      aria-label="Glaramara mountain mark"
    >
      <circle cx="95" cy="18" r="11" fill="#D3E9BD" opacity=".88" />
      <path
        d="M3 86 38 23 64 66 80 44 128 96"
        stroke="#D6ECC9"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="m24 48 13 13 12-15M67 63l13 13 14-17"
        stroke="#8DB69A"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="M3 96c28-13 46-13 71 0 18-12 35-11 54 1"
        stroke="#B9D7AE"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M2 106c38-10 70-5 126-1"
        stroke="#81AB8C"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CardMountain({ className }: MountainProps) {
  return (
    <svg className={className} viewBox="0 0 100 70" fill="none" aria-hidden="true">
      <circle cx="77" cy="12" r="7" fill="#DCEEC4" />
      <path
        d="M1 58 32 11l20 32 15-17 32 39"
        stroke="#DCEEC4"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <path d="m23 25 10 11 6-9" stroke="#A0C3AB" strokeWidth="2" />
    </svg>
  );
}

export function Brand() {
  return (
    <div className="flex items-center gap-[11px]">
      <MountainMark />
      <div>
        <div className="text-xl font-extrabold leading-none tracking-[-1px] text-[#172c25]">
          glaramara<span className="text-[#8db179]">.</span>
        </div>
        <div className="mt-1 text-[10px] font-semibold tracking-[.22em] text-[#596a60]">B A N K</div>
      </div>
    </div>
  );
}
