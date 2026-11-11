// ---------- tiny UI bits ----------
export function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={`ic ${className ?? ""}`} viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Mark({ big, small }: { big?: boolean; small?: boolean }) {
  return <span className={`mark ${big ? "big" : ""} ${small ? "small" : ""}`} aria-hidden />;
}
