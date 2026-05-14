import { useEffect, useState } from 'react'
import HomePage from './pages/HomePage'
import HandTrackingPage from './pages/HandTrackingPage'
import EyeTrackingPage from './pages/EyeTrackingPage'
import EyeTrackingUIPage from './pages/EyeTrackingUIPage'
import NavBar from './components/NavBar'

type Route = '/' | '/hand-tracking' | '/eye-tracking' | '/eye-tracking-ui'

function getRoute(): Route {
  const path = window.location.pathname
  if (path === '/hand-tracking') return '/hand-tracking'
  if (path === '/eye-tracking') return '/eye-tracking'
  if (path === '/eye-tracking-ui') return '/eye-tracking-ui'
  return '/'
}

export function navigate(to: Route) {
  window.history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function App() {
  const [route, setRoute] = useState<Route>(getRoute)

  useEffect(() => {
    const onPopState = () => setRoute(getRoute())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <NavBar current={route} />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {route === '/' && <HomePage />}
        {route === '/hand-tracking' && <HandTrackingPage />}
        {route === '/eye-tracking' && <EyeTrackingPage />}
        {route === '/eye-tracking-ui' && <EyeTrackingUIPage />}
      </div>
    </div>
  )
}
