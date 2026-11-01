import type { Metadata, Viewport } from "next";

import { BankingShell } from "@/components/banking-shell";

import "./globals.css";

export const metadata: Metadata = {
  title: "Glaramara Bank · Fictional banking demo",
  description: "A fictional UK banking experience for the Glaramara fraud-platform demonstration.",
};

export const viewport: Viewport = {
  themeColor: "#173F33",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <BankingShell>{children}</BankingShell>
      </body>
    </html>
  );
}
