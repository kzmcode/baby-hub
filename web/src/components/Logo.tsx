/** 鳥の巣のロゴ（手描き風の線画。currentColor 指定） */
export function Logo({ size = 48 }: { size?: number }) {
  return (
    <svg className="ch-logo" width={size} height={size} viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {/* 小鳥 */}
      <path d="M14 27c0-7 5-12 11-12 2.6 0 4.7 1 6 2.7l5.5.8-4.6 3c-.6 6-5 10-11.4 10-3.2 0-6.5-1.6-6.5-4.5z" />
      <circle cx="30" cy="20.5" r="0.9" fill="currentColor" stroke="none" />
      <path d="M17.5 24.5c2 2.2 5.5 2.4 8.2.6" />
      {/* 巣 */}
      <path d="M5 30c1 8 8 13 19 13s18-5 19-13" />
      <path d="M8 33c6 3 26 3 32 0M10 38c5 2.4 23 2.4 28 0M6.5 29.5c6 2.5 29 2.5 35 0" />
    </svg>
  );
}
