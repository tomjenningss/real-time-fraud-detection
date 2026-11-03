"use client";

import {
  BarChart3,
  Bell,
  Clock3,
  CreditCard,
  Home,
  Landmark,
  SendHorizontal,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Brand } from "@/components/mountain-mark";
import { CustomerProvider, useCustomer } from "@/components/customer-provider";
import { cn } from "@/lib/utils";

const navigation = [
  { href: "/", label: "Overview", mobileLabel: "Home", icon: Home },
  { href: "/payments", label: "Payments", mobileLabel: "Pay", icon: SendHorizontal },
  { href: "/activity", label: "Activity", mobileLabel: "Activity", icon: Clock3 },
  { href: "/beneficiaries", label: "Beneficiaries", mobileLabel: "People", icon: UsersRound },
  { href: "/cards", label: "Cards", mobileLabel: "Cards", icon: CreditCard },
];

const pageCopy: Record<string, { eyebrow: string; title: (firstName: string) => string }> = {
  "/": { eyebrow: "SATURDAY, 31 OCTOBER 2026", title: (name) => `Good evening, ${name}` },
  "/payments": { eyebrow: "GLARAMARA BANK · PERSONAL", title: () => "Send money" },
  "/activity": { eyebrow: "GLARAMARA BANK · PERSONAL", title: () => "Your activity" },
  "/beneficiaries": { eyebrow: "GLARAMARA BANK · PERSONAL", title: () => "Your beneficiaries" },
  "/cards": { eyebrow: "GLARAMARA BANK · PERSONAL", title: () => "Your cards" },
  "/payments/status": { eyebrow: "SIMULATED BANKING · NO MONEY MOVES", title: () => "Payment status" },
};

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function ShellContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { customer, customers, sessionError, setCustomerId, switching } = useCustomer();
  const copy = pageCopy[pathname] ?? pageCopy["/"];

  if (pathname.startsWith("/fraud-operations")) {
    return (
      <div className="min-h-screen bg-[#f5f7f3] text-[#172c25]">
        <header className="border-b border-[#dfe7dc] bg-[#173f33] text-white">
          <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-5 py-5 md:flex-row md:items-center md:justify-between md:px-10">
            <div className="flex items-center gap-4"><div className="rounded-xl bg-white p-2"><Brand /></div><div><p className="text-[10px] font-extrabold tracking-[.17em] text-[#bad7c3]">INTERNAL DEMONSTRATION</p><h1 className="mt-1 text-xl font-extrabold">Fraud Operations</h1></div></div>
            <div className="flex items-center gap-3">
              <BarChart3 className="hidden size-5 text-[#bcd8c4] sm:block" />
              <label htmlFor="analyst-persona" className="sr-only">Switch fictional persona</label>
              <select id="analyst-persona" value={customer.id} onChange={(event) => void setCustomerId(event.target.value)} disabled={switching} className="max-w-[240px] rounded-lg border border-[#ffffff33] bg-[#275a47] px-3 py-2 text-xs font-bold text-white outline-none">
                {customers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
              </select>
            </div>
          </div>
        </header>
        <main id="main-content" className="mx-auto max-w-[1440px] px-4 py-6 md:px-10 md:py-8">{children}<footer className="mt-7 text-[10px] text-[#5f6f64]">Glaramara Fraud Operations · Fictional people, synthetic transactions and simulated controls.</footer></main>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-[1440px] bg-[#F5F7F3] text-[#172c25]">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg bg-[#173f33] px-4 py-2 text-xs font-bold text-white transition focus:translate-y-0"
      >
        Skip to banking content
      </a>
      <aside className="hidden min-h-screen w-[236px] shrink-0 flex-col border-r border-[#e7ebe5] bg-white px-5 pb-[22px] pt-[31px] md:flex">
        <div className="mx-[7px] mb-[47px]">
          <Brand />
        </div>
        <p className="mx-[15px] mb-[14px] text-[10px] font-extrabold tracking-[.15em] text-[#5b6b61]">
          YOUR BANKING
        </p>
        <nav aria-label="Primary navigation" className="flex flex-col gap-1">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-[13px] rounded-[11px] px-[15px] py-[13px] text-[13px] font-semibold text-[#69786f] transition hover:bg-[#f0f5ed]",
                isActive(pathname, href) && "bg-[#e9f1e6] text-[#1a513c]",
              )}
            >
              <Icon className="size-[18px] stroke-[1.8]" aria-hidden="true" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto">
          <div className="mb-[19px] rounded-[15px] border border-[#e9eee5] bg-[#f7faf4] px-[15px] py-4">
            <Landmark className="size-5 text-[#3f7858]" aria-hidden="true" />
            <strong className="mb-1 mt-2 block text-xs">Banking with a view</strong>
            <p className="m-0 text-[11px] leading-relaxed text-[#58695f]">
              Thoughtfully designed around the places that matter.
            </p>
          </div>
          <div className="border-t border-[#e7ebe5] px-[7px] pt-3">
            <label htmlFor="desktop-customer" className="sr-only">
              Switch fictional customer
            </label>
            <div className="flex items-center gap-2.5">
              <div className="grid size-[37px] shrink-0 place-items-center rounded-full bg-[#d8e8d1] text-xs font-extrabold text-[#285340]">
                {customer.initials}
              </div>
              <select
                id="desktop-customer"
                value={customer.id}
                onChange={(event) => void setCustomerId(event.target.value)}
                disabled={switching}
                className="min-w-0 flex-1 appearance-none bg-transparent text-xs font-bold outline-none"
                aria-describedby="desktop-customer-caption"
              >
                {customers.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <small id="desktop-customer-caption" className="ml-[47px] mt-1 block text-[10px] text-[#5b6b61]">
              Fictional demo account
            </small>
          </div>
        </div>
      </aside>

      <main id="main-content" className="min-w-0 flex-1 px-[18px] pb-24 pt-[23px] md:px-[clamp(24px,4.5vw,70px)] md:pb-[46px] md:pt-[31px]">
        <header className="mb-6 flex items-center justify-between gap-4 md:mb-[29px]">
          <div>
            <p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-[#5d6e63]">{copy.eyebrow}</p>
            <h1 className="mt-[7px] whitespace-nowrap text-[25px] font-extrabold leading-tight tracking-[-1.2px] md:text-[30px]">
              {copy.title(customer.firstName)} <span className="font-normal">✳</span>
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <div
              aria-label="INTERACTIVE DEMO"
              className="flex items-center gap-[7px] rounded-full border border-[#d6e5c9] bg-[#e7f1df] px-[11px] py-[9px] text-[10px] font-bold tracking-[.03em] text-[#356645] md:text-[11px]"
            >
              <span className="size-[7px] rounded-full bg-[#62ab63]" />
              <span><span className="hidden sm:inline">INTERACTIVE </span>DEMO</span>
            </div>
            <button
              type="button"
              className="hidden size-[38px] place-items-center rounded-full border border-[#e6ebe4] bg-white text-[#456254] md:grid"
              aria-label="Notifications — none available in this demo"
              title="No new demo notifications"
            >
              <Bell className="size-[17px]" />
            </button>
            <div className="hidden size-[37px] place-items-center rounded-full bg-[#d8e8d1] text-xs font-extrabold text-[#285340] sm:grid">
              {customer.initials}
            </div>
          </div>
        </header>

        <div className="mb-4 flex items-center gap-3 rounded-xl border border-[#e1e8de] bg-white px-3 py-2.5 md:hidden">
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-[#d8e8d1] text-[11px] font-extrabold text-[#285340]">
            {customer.initials}
          </div>
          <div className="min-w-0 flex-1">
            <label htmlFor="mobile-customer" className="block text-[9px] font-extrabold tracking-[.12em] text-[#5d6e63]">
              FICTIONAL CUSTOMER
            </label>
            <select
              id="mobile-customer"
              value={customer.id}
              onChange={(event) => void setCustomerId(event.target.value)}
              disabled={switching}
              className="mt-0.5 w-full appearance-none bg-transparent text-xs font-bold outline-none"
            >
              {customers.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <span className="text-xs text-[#58695f]" aria-hidden="true">⌄</span>
        </div>

        {sessionError && (
          <div
            role="status"
            className="mb-4 rounded-xl border border-[#ead9bd] bg-[#fff9eb] px-4 py-3 text-[11px] leading-relaxed text-[#785f31]"
          >
            {sessionError} The screen remains a non-transactional preview; no banking action was taken.
          </div>
        )}

        <div className="animate-fade-in">{children}</div>
        <footer className="mt-7 flex items-center gap-2 text-[10px] leading-relaxed text-[#5f6f64]">
          <span className="size-1.5 rounded-full bg-[#96ba8b]" />
          Glaramara Bank · All accounts, transactions and decisions are fictional.
        </footer>
      </main>

      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-50 flex h-[75px] items-center justify-around border-t border-[#e2e9e0] bg-white/[.97] shadow-[0_-8px_25px_#172e2109] backdrop-blur-2xl md:hidden"
      >
        {navigation.map(({ href, mobileLabel, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center gap-1 px-0.5 py-2 text-[10px] font-bold text-[#5d6d63]",
              isActive(pathname, href) && "text-[#276144]",
            )}
          >
            <Icon className="size-[21px]" aria-hidden="true" />
            <span className="max-w-full truncate">{mobileLabel}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function BankingShell({ children }: { children: React.ReactNode }) {
  return (
    <CustomerProvider>
      <ShellContent>{children}</ShellContent>
    </CustomerProvider>
  );
}
