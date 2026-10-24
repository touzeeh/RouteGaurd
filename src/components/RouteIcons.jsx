import {
  AlertTriangle, Check, Flag, GitBranch, LocateFixed, MapPin,
  Navigation, Shield, Waypoints
} from 'lucide-react'
import L from 'leaflet'

const icons = {
  origin: Shield,
  destination: Flag,
  waypoint: Waypoints,
  weather: AlertTriangle,
  high: MapPin,
  safe: MapPin,
  alternate: GitBranch,
  current: LocateFixed,
}

/** Compact icon primitive shared by the planner, forecast list, and Leaflet markers. */
export function RouteIcon({ type, size = 17, className = '', label, decorative = false }) {
  const Icon = icons[type] ?? Navigation
  const ariaProps = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label ?? type }

  return (
    <span className={`route-icon route-icon-${type} ${className}`.trim()} {...ariaProps}>
      {type === 'origin' ? <svg className="route-icon-base" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2.8 20 6v6.1c0 5.1-3.4 8.2-8 10-4.6-1.8-8-4.9-8-10V6l8-3.2Z"/><path d="m12 16 1.3-5.4 3.3-2.8-1.2 4.8L12 16Z"/></svg> : type === 'destination' ? <svg className="route-icon-base" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-7-5.9-7-12a7 7 0 1 1 14 0c0 6.1-7 12-7 12Z"/><path d="M10 6v8m0-7h7l-2 2 2 2h-7"/></svg> : <Icon className="route-icon-base" size={size} strokeWidth={1.9} />}
      {type === 'origin' && <Navigation className="route-icon-overlay" size={Math.max(9, size * 0.42)} strokeWidth={2.7} />}
      {type === 'safe' && <Check className="route-icon-overlay" size={Math.max(9, size * 0.46)} strokeWidth={3} />}
    </span>
  )
}

export function routeMarkerIcon(type) {
  const html = `<span class="route-marker route-marker-${type}" aria-hidden="true">${markerSvg(type)}</span>`
  return L.divIcon({ className: 'route-marker-shell', html, iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -21] })
}

function markerSvg(type) {
  const paths = {
    origin: '<path d="M19 3.5 31 8v10c0 8-5.2 13.4-12 17-6.8-3.6-12-9-12-17V8l12-4.5Z"/><path d="m19 26 1.8-9.2 5.7-5.1-1.9 8.1L19 26Z"/>',
    destination: '<path d="M19 34s-11-9.5-11-18a11 11 0 1 1 22 0c0 8.5-11 18-11 18Z"/><circle cx="19" cy="16" r="13" opacity=".24"/><path d="M16 10v13m0-12h10l-3 3 3 3H16"/>',
    high: '<path d="M19 34s-11-9.5-11-18a11 11 0 1 1 22 0c0 8.5-11 18-11 18Z"/><path d="M19 11v7m0 4h.01"/>',
    safe: '<path d="M19 34s-11-9.5-11-18a11 11 0 1 1 22 0c0 8.5-11 18-11 18Z"/><path d="m14 17 3.2 3.2L24 13"/>',
    waypoint: '<circle cx="19" cy="18" r="12"/><circle cx="19" cy="18" r="6"/><path d="m19 18 8-7m-4 0h4v4"/>',
    weather: '<path d="m19 5 15 27H4L19 5Z"/><path d="M19 14v8m0 4h.01"/>',
    alternate: '<path d="M7 9h17a5 5 0 0 1 0 10H14a5 5 0 0 0 0 10h17"/><path d="m27 5 5 4-5 4M27 25l5 4-5 4"/>',
    current: '<circle cx="19" cy="19" r="4"/><path d="M19 3v4m0 24v4M3 19h4m24 0h4M7.7 7.7l2.8 2.8m17 17 2.8 2.8m0-22.6-2.8 2.8m-17 17-2.8 2.8"/>',
  }
  return `<svg viewBox="0 0 38 38" width="27" height="27" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[type] ?? paths.waypoint}</svg>`
}
