import { transactions as defaultTransactions, type Transaction } from "@/lib/demo-data";
import { cn, formatMoney } from "@/lib/utils";

export function TransactionList({
  transactions = defaultTransactions,
  limit,
  loading = false,
}: {
  transactions?: Transaction[];
  limit?: number;
  loading?: boolean;
}) {
  const items = typeof limit === "number" ? transactions.slice(0, limit) : transactions;

  if (loading) {
    return <div className="px-3 py-10 text-center text-xs text-[#8b998c]">Loading activity…</div>;
  }

  if (!items.length) {
    return <div className="px-3 py-10 text-center text-xs text-[#8b998c]">No matching transactions.</div>;
  }

  return (
    <div>
      {items.map((transaction) => (
        <div
          key={transaction.id}
          className="flex items-center gap-3 border-b border-[#f0f2ed] py-4 last:border-b-0"
        >
          <div
            className={cn(
              "grid size-[41px] shrink-0 place-items-center rounded-[14px] bg-[#f1f3ed] text-[17px] font-extrabold text-[#315647]",
              transaction.amount > 0 && "bg-[#e7f5e5] text-[#2a7851]",
            )}
            aria-hidden="true"
          >
            {transaction.icon}
          </div>
          <div className="min-w-0 flex-1">
            <strong className="block truncate text-xs font-bold">{transaction.name}</strong>
            <small className="mt-1 block text-[11px] text-[#64746a]">{transaction.date}</small>
          </div>
          <div
            className={cn(
              "whitespace-nowrap text-xs font-extrabold",
              transaction.amount > 0 && "text-[#2e845a]",
            )}
          >
            {formatMoney(transaction.amount, true)}
          </div>
        </div>
      ))}
    </div>
  );
}
