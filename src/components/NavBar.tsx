import { navigate } from '../App'

type Route = '/' | '/page-1' | '/page-2'

interface NavBarProps {
  current: Route
}

const LINKS: { label: string; to: Route }[] = [
  { label: 'Home', to: '/' },
  { label: 'Page 1', to: '/page-1' },
  { label: 'Page 2', to: '/page-2' },
]

export default function NavBar({ current }: NavBarProps) {
  return (
    <nav
      style={{
        display: 'flex',
        gap: 8,
        padding: '8px 16px',
        background: '#1a1a2e',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      {LINKS.map(({ label, to }) => (
        <button
          key={to}
          onClick={() => navigate(to)}
          style={{
            padding: '4px 12px',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            fontWeight: current === to ? 700 : 400,
            background: current === to ? '#e94560' : '#16213e',
            color: '#fff',
            fontSize: 14,
          }}
        >
          {label}
        </button>
      ))}
    </nav>
  )
}
