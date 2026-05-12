import { useEffect, useState } from 'react'
import HomePage from './pages/HomePage'
import Page1 from './pages/Page1'
import Page2 from './pages/Page2'
import HandTrackingPage from './pages/HandTrackingPage'
import NavBar from './components/NavBar'

type Route = '/' | '/page-1' | '/page-2' | '/hand-tracking'

function getRoute(): Route {
  const path = window.location.pathname
  if (path === '/page-1') return '/page-1'
  if (path === '/page-2') return '/page-2'
  if (path === '/hand-tracking') return '/hand-tracking'
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
        {route === '/page-1' && <Page1 />}
        {route === '/page-2' && <Page2 />}
        {route === '/hand-tracking' && <HandTrackingPage />}
      </div>
    </div>
  )
}
