export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="kificut-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8d97ff" />
          <stop offset="1" stopColor="#5a4fd6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#kificut-bg)" />
      <rect x="12" y="20" width="24" height="9" rx="3" fill="#fff" opacity="0.95" />
      <rect x="22" y="35" width="30" height="9" rx="3" fill="#fff" opacity="0.6" />
      <rect x="39" y="12" width="3.5" height="40" rx="1.75" fill="#ffd56a" />
    </svg>
  )
}
