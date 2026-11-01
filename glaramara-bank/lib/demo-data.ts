export type DemoCustomer = {
  id: string;
  slug: string;
  name: string;
  firstName: string;
  lastName: string;
  initials: string;
};

export type Transaction = {
  id: string;
  name: string;
  date: string;
  bookedAt?: string;
  amount: number;
  icon: string;
  category?: string;
};

export type Beneficiary = {
  id: string;
  name: string;
  sortCode: string;
  accountNumber: string;
  initials: string;
  recent: boolean;
  bookedPaymentCount?: number;
};

export const customers: DemoCustomer[] = [
  {
    id: "cabcc662-0c08-5a82-b350-847e713ca3b7",
    slug: "alex-morgan",
    name: "Alex Morgan",
    firstName: "Alex",
    lastName: "Morgan",
    initials: "AM",
  },
  {
    id: "cf874fb6-1429-5a1a-9538-961c82062156",
    slug: "priya-shah",
    name: "Priya Shah",
    firstName: "Priya",
    lastName: "Shah",
    initials: "PS",
  },
  {
    id: "1a2cbd9a-b406-5b87-9dc0-d1dd9a51ae2c",
    slug: "daniel-evans",
    name: "Daniel Evans",
    firstName: "Daniel",
    lastName: "Evans",
    initials: "DE",
  },
];

export const transactions: Transaction[] = [
  { id: "tx-1", name: "Whole Foods Market", date: "Today · 13:42", amount: -42.85, icon: "W" },
  { id: "tx-2", name: "Pret A Manger", date: "Yesterday · 09:17", amount: -6.95, icon: "P" },
  { id: "tx-3", name: "Salary · Fable Studio", date: "28 Oct · 08:30", amount: 3250, icon: "↙" },
  { id: "tx-4", name: "South Western Railway", date: "27 Oct · 18:14", amount: -29.1, icon: "↗" },
  { id: "tx-5", name: "The Coffee Lab", date: "26 Oct · 11:31", amount: -9.7, icon: "C" },
  { id: "tx-6", name: "Rent · High Street Homes", date: "25 Oct · 10:00", amount: -1200, icon: "⌂" },
  { id: "tx-7", name: "Tesco Express", date: "24 Oct · 16:32", amount: -21.85, icon: "T" },
  { id: "tx-8", name: "British Gas", date: "22 Oct · 08:10", amount: -65.21, icon: "B" },
];

export const beneficiaries: Beneficiary[] = [
  {
    id: "sam-bennett",
    name: "Sam Bennett",
    sortCode: "04-09-41",
    accountNumber: "82645281",
    initials: "SB",
    recent: true,
  },
  {
    id: "chloe-williams",
    name: "Chloe Williams",
    sortCode: "20-16-25",
    accountNumber: "49018272",
    initials: "CW",
    recent: true,
  },
];

export const alexAccount = {
  id: "a4af9cb1-1c67-599b-93b6-a0233710941a",
  name: "Glaramara Current Account",
  sortCode: "04-11-20",
  accountNumber: "00007281",
  accountSuffix: "7281",
  currency: "GBP" as const,
  availableBalance: 24862.8,
  cardLastFour: "7281",
  balanceAsOf: "2026-10-31T13:42:00.000Z",
};
