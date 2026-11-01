export function DataStateNotice({ loading, error }: { loading: boolean; error: string | null }) {
  if (!loading && !error) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 rounded-xl border border-[#e1e8de] bg-white px-4 py-3 text-[11px] leading-relaxed text-[#64746a]"
    >
      {loading ? "Loading persistent fictional banking records…" : error}
    </div>
  );
}
