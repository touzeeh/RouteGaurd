import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowRight, Bell, BrainCircuit, Bookmark, CalendarClock, Check, ChevronDown, Clock3,
  Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Compass, Crosshair, Eye, Gauge, LoaderCircle,
  Moon, Navigation, RefreshCw, Route, Settings, Share2, ShieldCheck, Sparkles,
  Sun, Thermometer, TriangleAlert, Wind, Zap,
} from 'lucide-react'
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { formatArrivalDateTime } from './utils/dateUtils'
import { buildGemmaPayload, generateGemmaBriefing } from './services/gemmaService'
import { RouteIcon, routeMarkerIcon } from './components/RouteIcons'
import './index.css'
import './App.css'

const API = {
  geocode: 'https://nominatim.openstreetmap.org/search',
  route: 'https://router.project-osrm.org/route/v1/driving',
  weather: 'https://api.open-meteo.com/v1/forecast',
}
const ROUTE_API = import.meta.env.VITE_ROUTE_API_BASE_URL || 'http://localhost:8000/api'
const SAMPLE_COUNT = 7
const PAGE_IDS = ['planner', 'saved-routes', 'alerts', 'fleet', 'risk', 'departure-optimizer', 'briefing']
const EMPTY_SEGMENTS = []

function pageFromHash() {
  const page = window.location.hash.replace(/^#\/?/, '')
  return PAGE_IDS.includes(page) ? page : 'planner'
}

function localDateTime(offsetHours = 1) {
  const date = new Date(Date.now() + offsetHours * 3600000)
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
function formatTime(date) {
  return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).format(date)
}
function formatBriefingDateTime(date) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
function formatDuration(seconds) {
  const total = Math.round(seconds / 60)
  const hours = Math.floor(total / 60)
  return hours ? `${hours}h ${total % 60}m` : `${total} min`
}
function weatherLabel(code) {
  if (code == null) return 'Unknown conditions'
  if (code === 0) return 'Clear sky'
  if ([1, 2].includes(code)) return 'Partly cloudy'
  if (code === 3) return 'Overcast'
  if ([45, 48].includes(code)) return 'Fog'
  if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle'
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain'
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow'
  if ([95, 96, 99].includes(code)) return 'Thunderstorm'
  return 'Variable conditions'
}
function weatherIcon(code) {
  if (code == null) return CloudSun
  if (code === 0) return Sun
  if ([1, 2].includes(code)) return CloudSun
  if (code === 3) return Cloud
  if ([45, 48].includes(code)) return CloudFog
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return CloudRain
  if ([71, 73, 75, 77, 85, 86].includes(code)) return CloudSnow
  if ([95, 96, 99].includes(code)) return CloudLightning
  return Sun
}
function riskFor(weather) {
  let score = 0
  const reasons = []
  const code = weather.code
  const rain = Number(weather.precipitation ?? 0)
  const probability = Number(weather.precipitationProbability ?? 0)
  const temperature = weather.temperature == null ? NaN : Number(weather.temperature)
  const wind = weather.wind == null ? NaN : Number(weather.wind)
  const visibility = weather.visibility == null ? NaN : Number(weather.visibility)
  if ([95, 96, 99].includes(code)) { score += 48; reasons.push('Thunderstorm risk') }
  else if ([65, 67, 82, 86].includes(code)) { score += 34; reasons.push('Heavy precipitation conditions') }
  else if ([63, 81, 75].includes(code)) { score += 26; reasons.push('Rain or snow') }
  else if ([61, 80, 73].includes(code)) { score += 15; reasons.push('Light precipitation') }
  if (probability >= 70) { score += 15; if (!reasons.some((reason) => reason.includes('precipitation'))) reasons.push('High chance of precipitation') }
  else if (probability >= 40) score += 8
  if (rain >= 7.5) { score += 15; reasons.push('High forecast precipitation') }
  else if (rain >= 2.5) score += 8
  if ([45, 48].includes(code)) { score += 28; reasons.push('Fog reported in weather code') }
  if (Number.isFinite(visibility) && visibility < 1000) { score += 35; reasons.push('Very low forecast visibility') }
  else if (Number.isFinite(visibility) && visibility < 3000) { score += 20; reasons.push('Reduced forecast visibility') }
  if (Number.isFinite(temperature) && temperature >= 42) { score += 20; reasons.push('Extreme heat') }
  else if (Number.isFinite(temperature) && temperature >= 38) { score += 12; reasons.push('High heat') }
  else if (Number.isFinite(temperature) && temperature >= 35) { score += 5; reasons.push('Warm conditions') }
  if (Number.isFinite(wind) && wind >= 60) { score += 24; reasons.push('Very strong forecast winds') }
  else if (Number.isFinite(wind) && wind >= 40) { score += 12; reasons.push('Strong forecast winds') }
  if (!reasons.length) reasons.push('No major threshold crossed in the available forecast')
  score = Math.min(100, score)
  return { score, level: score >= 55 ? 'High' : score >= 28 ? 'Moderate' : 'Low', reasons }
}
function sampleCoordinates(routeCoordinates, count) {
  if (!routeCoordinates?.length) return []
  const toRadians = (degrees) => degrees * Math.PI / 180
  const distance = (a, b) => {
    const [lon1, lat1] = a
    const [lon2, lat2] = b
    const dLat = toRadians(lat2 - lat1)
    const dLon = toRadians(lon2 - lon1)
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
  }
  const cumulative = [0]
  for (let index = 1; index < routeCoordinates.length; index++) cumulative.push(cumulative[index - 1] + distance(routeCoordinates[index - 1], routeCoordinates[index]))
  const total = cumulative.at(-1)
  if (!total) return [{ point: [routeCoordinates[0][1], routeCoordinates[0][0]], fraction: 0 }]
  const samples = []
  let segmentIndex = 1
  for (let index = 0; index < count; index++) {
    const fraction = index / (count - 1)
    const target = total * fraction
    while (segmentIndex < cumulative.length - 1 && cumulative[segmentIndex] < target) segmentIndex++
    const span = cumulative[segmentIndex] - cumulative[segmentIndex - 1]
    const within = span ? (target - cumulative[segmentIndex - 1]) / span : 0
    const left = routeCoordinates[segmentIndex - 1]
    const right = routeCoordinates[segmentIndex]
    const point = [left[1] + (right[1] - left[1]) * within, left[0] + (right[0] - left[0]) * within]
    if (!samples.length || samples.at(-1).point[0] !== point[0] || samples.at(-1).point[1] !== point[1]) samples.push({ point, fraction })
  }
  return samples
}
function coordinateLabel([latitude, longitude]) {
  return `${Math.abs(latitude).toFixed(4)}° ${latitude < 0 ? 'S' : 'N'}, ${Math.abs(longitude).toFixed(4)}° ${longitude < 0 ? 'W' : 'E'}`
}
function routeElapsedAtFraction(route, fraction) {
  const steps = route.legs?.[0]?.steps
  if (!Array.isArray(steps) || !steps.length || !(route.distance > 0)) return route.duration * fraction
  const targetDistance = route.distance * fraction
  let elapsedDistance = 0
  let elapsedSeconds = 0
  for (const step of steps) {
    const stepDistance = Number(step.distance) || 0
    const stepDuration = Number(step.duration) || 0
    if (targetDistance <= elapsedDistance + stepDistance && stepDistance > 0) {
      return elapsedSeconds + stepDuration * Math.max(0, (targetDistance - elapsedDistance) / stepDistance)
    }
    elapsedDistance += stepDistance
    elapsedSeconds += stepDuration
  }
  return Math.min(route.duration, elapsedSeconds)
}
async function reverseGeocodePoints(points) {
  if (!points.length) return []
  const response = await fetchWithTimeout(`${ROUTE_API}/geo/reverse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points }) }, 25000)
  if (!response.ok) throw new Error('Place names are temporarily unavailable.')
  const result = await response.json()
  return Array.isArray(result.points) ? result.points : []
}
function chooseForecast(response, arrival) {
  const hourly = response.hourly
  if (!hourly?.time?.length) throw new Error('No hourly forecast was returned.')
  const target = arrival.getTime()
  let bestIndex = -1
  let bestDifference = Infinity
  hourly.time.forEach((time, index) => {
    const difference = Math.abs(new Date(time).getTime() - target)
    if (Number.isFinite(difference) && difference < bestDifference) { bestDifference = difference; bestIndex = index }
  })
  if (bestIndex < 0 || bestDifference > 2 * 3600000) {
    const targetText = `${arrival.getFullYear()}-${String(arrival.getMonth() + 1).padStart(2, '0')}-${String(arrival.getDate()).padStart(2, '0')}T${String(arrival.getHours()).padStart(2, '0')}:00`
    const fallback = hourly.time.indexOf(targetText)
    if (fallback >= 0) bestIndex = fallback
  }
  if (bestIndex < 0) throw new Error('Forecast does not cover the expected arrival time.')
  const get = (key) => hourly[key]?.[bestIndex] == null ? null : Number(hourly[key][bestIndex])
  return { time: hourly.time[bestIndex], temperature: get('temperature_2m'), precipitation: get('precipitation'), precipitationProbability: get('precipitation_probability'), visibility: get('visibility'), wind: get('wind_speed_10m'), code: get('weather_code') }
}
async function fetchWithTimeout(input, options = {}, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(input, { ...options, signal: controller.signal })
    return response
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('The request timed out. Please check your connection and try again.')
    throw error
  } finally { clearTimeout(timer) }
}
async function geocode(place) {
  const url = new URL(API.geocode)
  url.searchParams.set('q', place); url.searchParams.set('format', 'jsonv2'); url.searchParams.set('limit', '1')
  const response = await fetchWithTimeout(url)
  if (!response.ok) throw new Error(`Place search failed (${response.status}).`)
  const results = await response.json()
  if (!results.length) throw new Error(`Couldn't find "${place}". Try adding the city or state.`)
  return { name: results[0].display_name.split(',').slice(0, 2).join(','), lat: Number(results[0].lat), lon: Number(results[0].lon) }
}
function photonPlace(feature) {
  const properties = feature.properties ?? {}
  const name = properties.name || properties.city || properties.locality || properties.county || properties.state || 'Mapped place'
  const context = [...new Set([properties.city, properties.state, properties.country].filter((part) => part && part !== name))]
  return { name, label: [name, ...context].join(', '), lat: Number(feature.geometry.coordinates[1]), lon: Number(feature.geometry.coordinates[0]) }
}
async function fetchRoutes(start, destination, stops = []) {
  const coordinates = [start, ...stops, destination].map(({ lon, lat }) => `${lon},${lat}`).join(';')
  const url = `${API.route}/${coordinates}`
  const response = await fetchWithTimeout(`${url}?overview=full&geometries=geojson&steps=true&alternatives=2`, {}, 20000)
  if (!response.ok) throw new Error(`Routing service failed (${response.status}).`)
  const result = await response.json()
  if (result.code !== 'Ok' || !result.routes?.length) throw new Error('No driving route was found for those places.')
  return result.routes
}
async function fetchForecast(point) {
  const url = new URL(API.weather)
  url.searchParams.set('latitude', String(point[0])); url.searchParams.set('longitude', String(point[1]))
  url.searchParams.set('hourly', ['temperature_2m', 'precipitation', 'precipitation_probability', 'visibility', 'weather_code', 'wind_speed_10m'].join(','))
  url.searchParams.set('current', ['temperature_2m', 'precipitation', 'visibility', 'weather_code', 'wind_speed_10m'].join(','))
  url.searchParams.set('forecast_days', '7'); url.searchParams.set('timezone', 'auto')
  const response = await fetchWithTimeout(url)
  if (!response.ok) throw new Error(`Weather service failed (${response.status}).`)
  return response.json()
}
function readCurrentWeather(response) {
  const current = response.current
  if (!current) return null
  const value = (key) => current[key] == null ? null : Number(current[key])
  return { time: current.time ? new Date(current.time) : null, temperature: value('temperature_2m'), precipitation: value('precipitation'), visibility: value('visibility'), wind: value('wind_speed_10m'), code: value('weather_code') }
}
async function analyzeRouteVariant(route, start, destination, leaveAt, id, onStage) {
  const coordinates = route.geometry.coordinates
  const routeSamples = sampleCoordinates(coordinates, SAMPLE_COUNT)
  const points = routeSamples.map((sample) => sample.point)
  onStage?.(`Looking up mapped places for route ${id}…`)
  let placeResults = []
  try { placeResults = await reverseGeocodePoints(points.slice(1, -1).map(([lat, lon]) => ({ lat, lon }))) } catch { /* Coordinates remain visible when place labels are unavailable. */ }
  onStage?.(`Fetching weather for route ${id}…`)
  const forecasts = await Promise.all(points.map(async (point) => { try { return await fetchForecast(point) } catch (error) { return { forecastError: error.message } } }))
  const segments = points.map((point, index) => {
    const fraction = routeSamples[index]?.fraction ?? 0
    const arrival = new Date(leaveAt.getTime() + routeElapsedAtFraction(route, fraction) * 1000)
    const forecast = forecasts[index]
    const mappedPlace = index > 0 && index < points.length - 1 ? placeResults[index - 1]?.name : null
    const currentWeather = forecast.forecastError ? null : readCurrentWeather(forecast)
    let weather = null
    let risk = { score: 0, level: 'Unknown', reasons: ['Forecast unavailable'] }
    if (!forecast.forecastError) {
      try {
        weather = chooseForecast(forecast, arrival)
        risk = weather.code == null ? { score: 0, level: 'Unknown', reasons: ['Weather condition data is incomplete; risk could not be classified'] } : riskFor(weather)
      } catch (error) { risk = { score: 0, level: 'Unknown', reasons: [error.message] } }
    }
    const name = index === 0 ? start.name : index === points.length - 1 ? destination.name : mappedPlace || `Waypoint near ${coordinateLabel(point)}`
    return { id: index + 1, point, fraction, arrival, weather, currentWeather, risk, forecastError: forecast.forecastError ?? null, name, placeNameSource: index === 0 || index === points.length - 1 ? 'search' : mappedPlace ? 'OpenStreetMap' : 'route coordinates' }
  })
  const candidates = Array.from({ length: 7 }, (_, offsetHours) => {
    const candidateStart = new Date(leaveAt.getTime() + offsetHours * 3600000)
    const sampledRisks = segments.map((segment, index) => {
      if (forecasts[index].forecastError) return null
      try {
        const candidateWeather = chooseForecast(forecasts[index], new Date(candidateStart.getTime() + routeElapsedAtFraction(route, segment.fraction) * 1000))
        return candidateWeather.code == null ? null : riskFor(candidateWeather)
      } catch { return null }
    }).filter(Boolean)
    return { offsetHours, departure: candidateStart, averageRisk: sampledRisks.length ? Math.round(sampledRisks.reduce((sum, risk) => sum + risk.score, 0) / sampledRisks.length) : null, highRiskSegments: sampledRisks.filter((risk) => risk.level === 'High').length, sampled: sampledRisks.length }
  })
  const bestCandidate = [...candidates].filter((candidate) => candidate.averageRisk != null && candidate.sampled > 0).sort((a, b) => a.averageRisk - b.averageRisk)[0] ?? null
  const roadNames = [...new Set((route.legs ?? []).flatMap((leg) => (leg.steps ?? []).map((step) => step.ref || step.name).filter(Boolean)))].filter((name) => name !== 'unknown').slice(0, 2)
  const routeName = roadNames.length ? `via ${roadNames.join(' · ')}` : `Route ${id}`
  return { id, routeName, start, destination, routeCoordinates: coordinates, routeDuration: route.duration, distanceKm: route.distance / 1000, segments, candidates, bestCandidate, baselineRisk: candidates[0]?.averageRisk ?? null, generatedAt: new Date() }
}
function riskColor(level) { return level === 'High' ? '#ff5d62' : level === 'Moderate' ? '#f4b942' : level === 'Low' ? '#42d9b1' : '#8994a4' }
function FitRoute({ positions }) {
  const map = useMap()
  useEffect(() => { if (positions.length > 1) map.fitBounds(positions, { padding: [42, 42] }) }, [map, positions])
  return null
}
function StatCard({ icon: Icon, label, value, detail, accent }) {
  return <div className="stat-card"><div className="stat-top"><span className="stat-icon"><Icon size={17} /></span><span className="stat-label">{label}</span><span className="stat-accent" style={{ color: accent }}>{accent ? '●' : '•'}</span></div><div className="stat-value">{value}</div><div className="stat-detail">{detail}</div></div>
}
const TRAVEL_MODES = [
  { value: 'driving', label: 'Driving', detail: 'Road route' },
  { value: 'cycling', label: 'Cycling estimate', detail: 'Estimated mode' },
  { value: 'walking', label: 'Walking estimate', detail: 'Estimated mode' },
]
function LocationAutocomplete({ value, onChange, onSelect, type, label, placeholder }) {
  const [suggestions, setSuggestions] = useState([])
  const [searching, setSearching] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const skipNextSearch = useRef(false)
  const inputRef = useRef(null)
  const listId = `places-${type}`
  useEffect(() => {
    if (skipNextSearch.current) { skipNextSearch.current = false; return undefined }
    const query = value.trim()
    if (query.length < 3) return undefined
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const url = new URL('https://photon.komoot.io/api/')
        url.searchParams.set('q', query); url.searchParams.set('limit', '5'); url.searchParams.set('lang', 'en')
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error('Location search unavailable')
        const data = await response.json()
        const places = (data.features ?? []).map(photonPlace).filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lon))
        setSuggestions(places); setActiveIndex(0); setOpen(Boolean(places.length))
      } catch (error) {
        if (error.name !== 'AbortError') { setSuggestions([]); setOpen(false) }
      } finally { if (!controller.signal.aborted) setSearching(false) }
    }, 420)
    return () => { clearTimeout(timer); controller.abort() }
  }, [value])
  function choose(place) {
    skipNextSearch.current = true
    onChange(place.label)
    onSelect(place)
    setSuggestions([]); setOpen(false); setSearching(false)
  }
  function handleKeyDown(event) {
    if (event.key === 'ArrowDown' && suggestions.length) { event.preventDefault(); setOpen(true); setActiveIndex((index) => (index + 1) % suggestions.length) }
    else if (event.key === 'ArrowUp' && suggestions.length) { event.preventDefault(); setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length) }
    else if (event.key === 'Enter' && open && suggestions[activeIndex]) { event.preventDefault(); choose(suggestions[activeIndex]) }
    else if (event.key === 'Escape') setOpen(false)
  }
  return <div className={`input-wrap location-autocomplete ${open ? 'suggestions-open' : ''}`}>
    <span className="field-label"><RouteIcon type={type} size={15} decorative /> {label}</span>
    <RouteIcon type={type} size={18} className="input-icon" label={type === 'origin' ? 'Starting point' : 'Destination'} />
    <input ref={inputRef} value={value} onChange={(event) => { const nextValue = event.target.value; onChange(nextValue); onSelect(null); if (nextValue.trim().length < 3) { setSuggestions([]); setSearching(false); setOpen(false) } else setOpen(true) }} onKeyDown={handleKeyDown} onFocus={() => suggestions.length && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 140)} placeholder={placeholder} role="combobox" aria-label={type === 'origin' ? 'Starting point' : 'Destination'} aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={open && suggestions[activeIndex] ? `${listId}-${activeIndex}` : undefined} autoComplete="off" />
    {searching && <LoaderCircle className="location-search-spinner spin" size={15} aria-label="Searching locations" />}
    {open && suggestions.length > 0 && <div className="location-suggestions" role="listbox" id={listId} aria-label={`${label.toLowerCase()} suggestions`}>{suggestions.map((place, index) => <button type="button" role="option" aria-selected={index === activeIndex} id={`${listId}-${index}`} key={`${place.lat}-${place.lon}-${place.label}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(place)}><span className="suggestion-pin"><Navigation size={15} /></span><span><b>{place.name}</b><small>{place.label}</small></span></button>)}</div>}
  </div>
}
function TravelModeDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(Math.max(0, TRAVEL_MODES.findIndex((mode) => mode.value === value)))
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const optionRefs = useRef([])
  const selectedIndex = Math.max(0, TRAVEL_MODES.findIndex((mode) => mode.value === value))

  useEffect(() => {
    if (!open) return undefined
    const closeOutside = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', closeOutside)
    optionRefs.current[activeIndex]?.focus()
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open, activeIndex])

  function closeDropdown(returnFocus = true) {
    setOpen(false)
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  function openAt(index = selectedIndex) {
    setActiveIndex(index)
    setOpen(true)
  }
  function handleTriggerKeyDown(event) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      openAt(event.key === 'ArrowDown' ? selectedIndex : event.key === 'ArrowUp' ? (selectedIndex - 1 + TRAVEL_MODES.length) % TRAVEL_MODES.length : selectedIndex)
    }
  }
  function handleOptionKeyDown(event, index) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? TRAVEL_MODES.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + TRAVEL_MODES.length) % TRAVEL_MODES.length
      setActiveIndex(next)
      optionRefs.current[next]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeDropdown()
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  const selectedMode = TRAVEL_MODES[selectedIndex]
  return <div className={`mode-dropdown ${open ? 'is-open' : ''}`} ref={rootRef}>
    <button ref={triggerRef} type="button" className="mode-select-trigger" role="combobox" aria-label="Travel mode" aria-haspopup="listbox" aria-expanded={open} aria-controls="travel-mode-options" onClick={() => open ? closeDropdown(false) : openAt()} onKeyDown={handleTriggerKeyDown}>
      <Navigation size={15} aria-hidden="true" />
      <span>{selectedMode.label}</span>
      <ChevronDown size={15} className="mode-chevron" aria-hidden="true" />
    </button>
    {open && <div className="mode-option-list" id="travel-mode-options" role="listbox" aria-label="Travel mode options">{TRAVEL_MODES.map((mode, index) => <button ref={(element) => { optionRefs.current[index] = element }} type="button" role="option" aria-selected={mode.value === value} tabIndex={activeIndex === index ? 0 : -1} className={`mode-option ${mode.value === value ? 'selected' : ''}`} key={mode.value} onFocus={() => setActiveIndex(index)} onClick={() => { onChange(mode.value); closeDropdown() }} onKeyDown={(event) => handleOptionKeyDown(event, index)}><span className="mode-option-icon"><Navigation size={15} aria-hidden="true" /></span><span className="mode-option-copy"><b>{mode.label}</b><small>{mode.detail}</small></span>{mode.value === value && <Check size={16} className="mode-option-check" aria-hidden="true" />}</button>)}</div>}
  </div>
}
function InlineBriefingText({ text }) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    return part
  })
}
function BriefingRenderer({ content }) {
  const lines = content.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean)
  const blocks = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    const heading = line.match(/^#{1,3}\s+(.+)$/) || line.match(/^\*\*([^*]+)\*\*$/)
    if (heading) {
      const title = heading[1].replace(/^\d+[.)]?\s*/, '').replace(/\*\*/g, '').trim()
      blocks.push({ type: 'heading', text: title })
      index++
    } else if (/^(?:[-*•]|\d+[.)])\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^(?:[-*•]|\d+[.)])\s+/.test(lines[index])) items.push(lines[index++].replace(/^(?:[-*•]|\d+[.)])\s+/, ''))
      blocks.push({ type: 'list', items })
    } else {
      const paragraph = []
      while (index < lines.length && !/^#{1,3}\s+/.test(lines[index]) && !/^(?:[-*•]|\d+[.)])\s+/.test(lines[index])) paragraph.push(lines[index++])
      blocks.push({ type: 'paragraph', text: paragraph.join(' ').replace(/\*\*/g, '') })
    }
  }
  return <div className="briefing-content">{blocks.map((block, index) => {
    const animationStyle = { '--briefing-index': Math.min(index, 8) }
    if (block.type === 'heading') return <h3 className="briefing-section-title" style={animationStyle} key={`${block.text}-${index}`}>{block.text}</h3>
    if (block.type === 'list') return <ul className="briefing-list" style={animationStyle} key={`list-${index}`}>{block.items.map((item, itemIndex) => <li key={itemIndex}><InlineBriefingText text={item} /></li>)}</ul>
    const previousHeading = blocks.slice(0, index).reverse().find((item) => item.type === 'heading')
    const recommendation = previousHeading?.text.toLowerCase().includes('recommendation')
    return <p className={`briefing-paragraph ${recommendation ? 'briefing-recommendation' : ''}`} style={animationStyle} key={`paragraph-${index}`}><InlineBriefingText text={block.text} /></p>
  })}</div>
}

export default function App() {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('routeguard-theme') === 'dark' ? 'dark' : 'light' } catch { return 'light' } })
  const [toast, setToast] = useState(null)
  const [startText, setStartText] = useState(() => new URLSearchParams(window.location.search).get('from') || 'Bhopal, Madhya Pradesh')
  const [destinationText, setDestinationText] = useState(() => new URLSearchParams(window.location.search).get('to') || 'Indore, Madhya Pradesh')
  const [startPlace, setStartPlace] = useState(null)
  const [destinationPlace, setDestinationPlace] = useState(null)
  const [departure, setDeparture] = useState(() => new URLSearchParams(window.location.search).get('depart') || localDateTime())
  const [analysis, setAnalysis] = useState(null)
  const [routeOptions, setRouteOptions] = useState([])
  const [savedRoutes, setSavedRoutes] = useState(() => { try { return JSON.parse(localStorage.getItem('routeguard-saved-routes') || '[]') } catch { return [] } })
  const [loading, setLoading] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(0)
  const [aiBrief, setAiBrief] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiStatus, setAiStatus] = useState('not-connected')
  const [aiError, setAiError] = useState('')
  const [routeMode, setRouteMode] = useState('driving')
  const [openPanel, setOpenPanel] = useState('')
  const [activeSection, setActiveSection] = useState(pageFromHash)
  const [mapVisible, setMapVisible] = useState(true)
  const [timelineVisible, setTimelineVisible] = useState(true)
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => { try { return localStorage.getItem('routeguard-notifications') === 'on' } catch { return false } })
  const analysisRequestRef = useRef(0)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('routeguard-theme', theme) } catch { /* Session theme remains active. */ }
  }, [theme])
  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(null), 4500)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    try { localStorage.setItem('routeguard-notifications', notificationsEnabled ? 'on' : 'off') } catch { /* Setting remains active for this session. */ }
  }, [notificationsEnabled])
  useEffect(() => { try { localStorage.setItem('routeguard-saved-routes', JSON.stringify(savedRoutes)) } catch { /* Saved routes remain in memory for this session. */ } }, [savedRoutes])
  useEffect(() => {
    const syncPage = () => setActiveSection(pageFromHash())
    window.addEventListener('hashchange', syncPage)
    window.addEventListener('popstate', syncPage)
    return () => { window.removeEventListener('hashchange', syncPage); window.removeEventListener('popstate', syncPage) }
  }, [])
  function notify(message, type = 'error') { setToast({ message, type, id: Date.now() }) }
  function invalidateRouteAnalysis() {
    analysisRequestRef.current += 1
    setAnalysis(null); setRouteOptions([]); setAiBrief(''); setAiError('')
    setLoading(false); setStage(''); setError('')
  }
  function goToSection(section) {
    const page = PAGE_IDS.includes(section) ? section : 'planner'
    setActiveSection(page); setOpenPanel('')
    if (window.location.hash !== `#${page}`) window.history.pushState(null, '', `#${page}`)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function saveCurrentRoute() {
    const route = { id: `${Date.now()}`, start: startText.trim(), destination: destinationText.trim(), departure, routeMode, savedAt: new Date().toISOString() }
    setSavedRoutes((items) => [route, ...items.filter((item) => !(item.start === route.start && item.destination === route.destination))])
    notify('Route saved on this device.', 'success')
  }
  async function shareCurrentRoute() {
    const url = new URL(window.location.href)
    url.searchParams.set('from', startText.trim()); url.searchParams.set('to', destinationText.trim()); url.searchParams.set('depart', departure)
    try { if (navigator.share) await navigator.share({ title: 'RouteGuard trip plan', url: url.toString() }); else { await navigator.clipboard.writeText(url.toString()); notify('Trip link copied to clipboard.', 'success') } }
    catch (shareError) { if (shareError?.name !== 'AbortError') notify('Could not share the trip link. Check browser clipboard permissions.') }
  }
  function openSavedRoute(route) { invalidateRouteAnalysis(); setStartText(route.start); setDestinationText(route.destination); setStartPlace(null); setDestinationPlace(null); setDeparture(route.departure); setRouteMode(route.routeMode || 'driving'); goToSection('planner'); notify('Saved trip loaded. Analyze it to refresh its route and forecast.', 'success') }
  async function toggleNotifications(enabled) {
    if (!enabled) { setNotificationsEnabled(false); return }
    if (!('Notification' in window)) { notify('This browser does not support desktop notifications. Route alerts remain available in the Weather alerts page.'); return }
    if (Notification.permission === 'denied') { notify('Browser notifications are blocked for this site. Allow them in the browser site settings.'); return }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    if (permission === 'granted') { setNotificationsEnabled(true); notify('Browser alerts enabled for future route analyses.', 'success') }
    else notify('Browser notification permission was not granted.')
  }
  const routePositions = analysis?.routeCoordinates?.map(([lon, lat]) => [lat, lon]) ?? []
  const segments = analysis?.segments ?? EMPTY_SEGMENTS
  const highestRisk = useMemo(() => segments.length ? [...segments].sort((a, b) => b.risk.score - a.risk.score)[0] : null, [segments])

  async function runAnalysis(departureOverride = null) {
    if (!startText.trim() || !destinationText.trim() || (!departure && !departureOverride)) { setError('Enter both places and a departure time.'); notify('Enter both a starting point and a destination, then choose a departure time.'); return }
    const leaveAt = departureOverride ? new Date(departureOverride) : new Date(departure)
    if (Number.isNaN(leaveAt.getTime())) { setError('Please choose a valid departure time.'); notify('Please choose a valid departure date and time.'); return }
    if (leaveAt.getTime() < Date.now() - 3600000) { setError('Choose a future departure time for a forward-looking forecast.'); notify('Choose a future departure time for a forward-looking forecast.'); return }
    if (startText.trim().toLowerCase() === destinationText.trim().toLowerCase()) { setError('Choose two different locations.'); notify('Starting point and destination must be different.'); return }
    const requestId = ++analysisRequestRef.current
    setLoading(true); setError(''); setToast(null); setAnalysis(null); setRouteOptions([]); setAiBrief(''); setAiError(''); setAiStatus('not-connected')
    try {
      setStage('Finding your start and destination…')
      const [start, destination] = await Promise.all([startPlace?.label === startText ? Promise.resolve(startPlace) : geocode(startText), destinationPlace?.label === destinationText ? Promise.resolve(destinationPlace) : geocode(destinationText)])
      if (requestId !== analysisRequestRef.current) return
      setStage('Calculating the driving route…')
      const routes = await fetchRoutes(start, destination)
      if (requestId !== analysisRequestRef.current) return
      const variants = []
      for (const [index, route] of routes.slice(0, 2).entries()) {
        if (requestId !== analysisRequestRef.current) return
        setStage(index === 0 ? 'Sampling route weather and mapped places…' : 'Checking the available alternate route…')
        try { variants.push(await analyzeRouteVariant(route, start, destination, leaveAt, index === 0 ? 'A' : 'B', setStage)) } catch (variantError) { if (index === 0) throw variantError }
      }
      if (requestId !== analysisRequestRef.current) return
      if (!variants.length) throw new Error('No route had enough data to calculate conditions.')
      setRouteOptions(variants)
      setAnalysis({ ...variants[0], routeMode })
      const firstHighRisk = variants[0].segments.find((segment) => segment.risk.level === 'High')
      if (notificationsEnabled && firstHighRisk && 'Notification' in window && Notification.permission === 'granted') new Notification('RouteGuard: high forecast risk', { body: `${firstHighRisk.name}: ${firstHighRisk.risk.reasons.join(', ')}` })
      setSelected(0); setStage(''); goToSection('planner')
    } catch (err) {
      if (requestId !== analysisRequestRef.current) return
      const message = err.message || 'Something went wrong while analyzing the route.'
      setError(message); notify(message); setStage('')
    } finally { if (requestId === analysisRequestRef.current) setLoading(false) }
  }

  async function generateGemmaBrief() {
    if (!analysis) { notify('Analyze a route before generating an AI briefing.'); return }
    if ((analysis.candidates ?? []).length < 2) { notify('At least two departure comparison windows are required.'); return }
    setAiLoading(true); setAiBrief(''); setAiError(''); setAiStatus('connecting')
    try {
      const payload = buildGemmaPayload({
        origin: analysis.start.name, destination: analysis.destination.name,
        departureDateTime: formatBriefingDateTime(new Date(departure)), totalDistance: `${analysis.distanceKm.toFixed(1)} km`, duration: Math.round(analysis.routeDuration / 60),
        segmentForecasts: analysis.segments.map((segment) => ({ location: segment.name, expected_arrival: formatBriefingDateTime(segment.arrival), temperature_c: segment.weather?.temperature ?? null, rain_probability: segment.weather?.precipitationProbability ?? null, precipitation_mm: segment.weather?.precipitation ?? null, visibility_km: segment.weather?.visibility == null ? null : segment.weather.visibility / 1000, wind_speed_kmh: segment.weather?.wind ?? null, weather: segment.weather ? weatherLabel(segment.weather.code) : 'Unavailable', risk_score: segment.risk.score, risk_level: segment.risk.level, risk_reasons: segment.risk.reasons })),
        departureOptimizerWindows: analysis.candidates.map((candidate, index) => ({ departure_time: formatBriefingDateTime(candidate.departure), risk_score: candidate.averageRisk, high_risk_samples: candidate.highRiskSegments, recommendation: analysis.bestCandidate && candidate.averageRisk === analysis.bestCandidate.averageRisk ? 'Lowest sampled risk among the compared windows' : index === 0 ? 'Current departure' : `Alternative departure +${candidate.offsetHours} hours` })),
      })
      let receivedText = ''
      const result = await generateGemmaBriefing(payload, { timeoutMs: 30000, onToken: (chunk, fullText) => { receivedText = fullText ?? `${receivedText}${chunk}`; setAiBrief(receivedText) } })
      setAiBrief(result || receivedText); setAiStatus('connected')
    } catch (err) { setAiStatus('not-connected'); setAiError(err.message || 'The AI briefing could not be generated.'); setAiBrief(''); notify(err.message || 'The AI briefing could not be generated.') }
    finally { setAiLoading(false) }
  }

  const totals = useMemo(() => segments.reduce((result, segment) => {
    if (segment.risk.level === 'High') result.high++
    else if (segment.risk.level === 'Moderate') result.moderate++
    else if (segment.risk.level === 'Low') result.low++
    else result.unknown++
    return result
  }, { high: 0, moderate: 0, low: 0, unknown: 0 }), [segments])
  const selectedSegment = segments[selected]
  const riskOverall = analysis?.baselineRisk == null ? '—' : analysis.baselineRisk >= 55 ? 'Elevated' : analysis.baselineRisk >= 28 ? 'Moderate' : 'Low'

  return <div className="dashboard-layout">
    <aside className="dashboard-sidebar">
      <a href="#planner" className="sidebar-brand" aria-label="RouteGuard home" onClick={() => goToSection('planner')}><span className="brand-mark"><RouteIcon type="origin" size={21} decorative /></span><span className="brand-word">route<span className="brand-light">guard</span></span></a>
      <div className="sidebar-caption">WORKSPACE</div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        <a className={`sidebar-link ${activeSection === 'planner' ? 'active' : ''}`} href="#planner" aria-current={activeSection === 'planner' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); goToSection('planner') }}><Compass size={17} /><span>Route planner</span></a>
        <a className={`sidebar-link ${activeSection === 'risk' ? 'active' : ''}`} href="#risk" aria-current={activeSection === 'risk' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); goToSection('risk') }}><Activity size={17} /><span>Risk analysis</span></a>
        <a className={`sidebar-link ${activeSection === 'departure-optimizer' ? 'active' : ''}`} href="#departure-optimizer" aria-current={activeSection === 'departure-optimizer' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); goToSection('departure-optimizer') }}><CalendarClock size={17} /><span>Departure optimizer</span></a>
        <a className={`sidebar-link ${activeSection === 'briefing' ? 'active' : ''}`} href="#briefing" aria-current={activeSection === 'briefing' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); goToSection('briefing') }}><BrainCircuit size={17} /><span>AI briefing</span></a>
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-status"><span className="live-dot" /><div><b>Forecast data</b><small>Open data sources</small></div></div><div className="sidebar-safety"><ShieldCheck size={17} /><span>Built for safer decisions, not certainty.</span></div></div>
    </aside>
    <main className="app-shell">
      <header className="topbar">
        <a href="#planner" className="topbar-brand" aria-label="RouteGuard home" onClick={(event) => { event.preventDefault(); goToSection('planner') }}><span className="brand-mark"><RouteIcon type="origin" size={18} decorative /></span><b>RouteGuard</b></a>
        <nav className="main-nav" aria-label="Dashboard sections"><a className={activeSection === 'planner' ? 'nav-active' : ''} href="#planner" aria-current={activeSection === 'planner' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); goToSection('planner') }}><Compass size={15} /> Plan trip</a><a className={activeSection === 'saved-routes' ? 'nav-active' : ''} href="#saved-routes" aria-current={activeSection === 'saved-routes' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); goToSection('saved-routes') }}><Bookmark size={15} /> Saved routes</a><a className={activeSection === 'alerts' ? 'nav-active' : ''} href="#alerts" aria-current={activeSection === 'alerts' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); goToSection('alerts') }}><Bell size={15} /> Weather alerts</a><a className={activeSection === 'fleet' ? 'nav-active' : ''} href="#fleet" aria-current={activeSection === 'fleet' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); goToSection('fleet') }}><Navigation size={15} /> Fleet</a><a className={activeSection === 'risk' ? 'nav-active' : ''} href="#risk" aria-current={activeSection === 'risk' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); goToSection('risk') }}><Activity size={15} /> Risk</a><a className={activeSection === 'departure-optimizer' ? 'nav-active' : ''} href="#departure-optimizer" aria-current={activeSection === 'departure-optimizer' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); goToSection('departure-optimizer') }}><CalendarClock size={15} /> Departure</a><a className={activeSection === 'briefing' ? 'nav-active' : ''} href="#briefing" aria-current={activeSection === 'briefing' ? 'page' : undefined} onClick={(event) => { event.preventDefault(); goToSection('briefing') }}><BrainCircuit size={15} /> AI briefing</a></nav>
        <div className="topbar-right">
          <button className="icon-button utility-button" type="button" title="Notifications" aria-label="Notifications" aria-expanded={openPanel === 'notifications'} onClick={() => setOpenPanel(openPanel === 'notifications' ? '' : 'notifications')}><Bell size={16} /></button>
          <button className="icon-button utility-button" type="button" title="Settings" aria-label="Settings" aria-expanded={openPanel === 'settings'} onClick={() => setOpenPanel(openPanel === 'settings' ? '' : 'settings')}><Settings size={16} /></button>
          <div className="theme-switch" role="group" aria-label="Color theme"><button type="button" className={theme === 'light' ? 'theme-choice active' : 'theme-choice'} onClick={() => setTheme('light')} aria-pressed={theme === 'light'}><Sun size={14} /> <span>Light</span></button><button type="button" className={theme === 'dark' ? 'theme-choice active' : 'theme-choice'} onClick={() => setTheme('dark')} aria-pressed={theme === 'dark'}><Moon size={14} /> <span>Dark</span></button></div>
        </div>
        {openPanel === 'notifications' && <div className="utility-panel" role="dialog" aria-label="Notifications"><div className="utility-panel-heading"><b>Notifications</b><button type="button" className="panel-close" onClick={() => setOpenPanel('')} aria-label="Close notifications">×</button></div>{analysis ? <p>{totals.high ? `${totals.high} high-risk forecast sample${totals.high === 1 ? '' : 's'} on your current route.` : 'No high-risk samples on the current route.'}</p> : <p>Analyze a route to see forecast alerts here.</p>}<button type="button" className="panel-action" onClick={() => goToSection('risk')}>View risk analysis <ArrowRight size={14} /></button></div>}
        {openPanel === 'settings' && <div className="utility-panel settings-panel" role="dialog" aria-label="Dashboard settings"><div className="utility-panel-heading"><b>Dashboard settings</b><button type="button" className="panel-close" onClick={() => setOpenPanel('')} aria-label="Close settings">×</button></div><label><input type="checkbox" checked={mapVisible} onChange={(event) => setMapVisible(event.target.checked)} /> Show route map</label><label><input type="checkbox" checked={timelineVisible} onChange={(event) => setTimelineVisible(event.target.checked)} /> Show conditions timeline</label><label><input type="checkbox" checked={notificationsEnabled} onChange={(event) => toggleNotifications(event.target.checked)} /> Enable browser alerts for high forecast risk</label><p className="settings-note">The connected routing service provides driving routes only.</p></div>}
      </header>
      <div key={activeSection} className="page-content" aria-live="polite">
      {activeSection === 'planner' && <><section className="welcome-row"><div><div className="eyebrow"><span className="eyebrow-line" /> WEATHER-AWARE ROUTING</div><h1>See the weather you'll actually drive through.</h1><p className="welcome-description">We forecast each route point at its expected arrival time, then surface conditions and risk to help you plan.</p></div><div className="welcome-actions"><button type="button" className="secondary-action" onClick={saveCurrentRoute}><Bookmark size={15} /> Save route</button><button type="button" className="secondary-action" onClick={shareCurrentRoute}><Share2 size={15} /> Share</button></div></section>
      <div className="planner-overview"><div className="planner-left-stack">
      <section className="planner-card" id="planner">
        <div className="section-heading"><div className="heading-icon"><Route size={18} /></div><div><h2>Plan your journey</h2><p>Get a segment-by-segment view of your route conditions.</p></div></div>
        <form className="route-form" onSubmit={(event) => { event.preventDefault(); runAnalysis() }}>
          <div className="location-fields">
            <LocationAutocomplete type="origin" label="FROM" value={startText} onChange={(value) => { setStartText(value); invalidateRouteAnalysis() }} onSelect={setStartPlace} placeholder="Starting point or city" />
            <button type="button" className="swap-button" title="Swap start and destination" aria-label="Swap start and destination" onClick={() => { invalidateRouteAnalysis(); setStartText(destinationText); setDestinationText(startText); setStartPlace(destinationPlace); setDestinationPlace(startPlace) }}><RefreshCw size={17} /></button>
            <LocationAutocomplete type="destination" label="DESTINATION" value={destinationText} onChange={(value) => { setDestinationText(value); invalidateRouteAnalysis() }} onSelect={setDestinationPlace} placeholder="Destination city" />
          </div>
          <div className="departure-row">
            <label className="departure-field"><span className="field-label"><CalendarClock size={13} /> DEPARTURE DATE & TIME</span><input type="datetime-local" value={departure} onChange={(event) => { setDeparture(event.target.value); invalidateRouteAnalysis() }} /></label>
            <div className="mode-field"><span className="field-label"><Navigation size={13} /> TRAVEL MODE</span><TravelModeDropdown value={routeMode} onChange={(value) => { setRouteMode(value); invalidateRouteAnalysis() }} />{routeMode !== 'driving' && <small className="mode-note">Other route services are not connected yet; route and duration remain based on driving directions.</small>}</div>
            <button type="submit" className="analyze-button" disabled={loading}>{loading ? <LoaderCircle className="spin" size={18} /> : <Zap size={17} />}{loading ? 'Analyzing route…' : 'Analyze my route'}{!loading && <ArrowRight size={17} />}</button>
          </div>
        </form>
        {analysis && <RouteArrivalSummary analysis={analysis} />}
        {loading && <div className="progress-line" role="status" aria-live="polite" aria-label="Route analysis progress"><LoaderCircle className="spin" size={16} /><span>{stage}</span></div>}
        {error && <div className="error-banner"><TriangleAlert size={17} /> {error}</div>}
        <div className="planner-footnote"><ShieldCheck size={15} /><span>Road route: OSRM · Place labels: OpenStreetMap · Weather: Open-Meteo current model + arrival forecast. Forecasts are estimates, not official alerts.</span><span className="secure-note"><span className="live-dot" /> Data refreshed on analysis</span></div>
      </section>{analysis && routeOptions.length > 1 && <section className="route-options-section"><div className="route-options-heading"><div><div className="eyebrow">LIVE ROUTE OPTIONS</div><h2>Route options</h2></div><span>Departing {formatTime(new Date(departure))}</span></div><div className="route-option-grid">{routeOptions.map((option) => <button type="button" key={option.id} className={`route-option-card ${analysis.id === option.id ? 'route-option-selected' : ''}`} onClick={() => { setAnalysis({ ...option, routeMode }); setSelected(0); setAiBrief('') }} aria-pressed={analysis.id === option.id}><span className="route-option-top"><b>Route {option.id}</b><span>{analysis.id === option.id ? 'Selected' : 'Select route'}</span></span><strong>{option.routeName}</strong><span>{formatDuration(option.routeDuration)} · {option.distanceKm.toFixed(1)} km</span><span className="route-option-risk">{option.baselineRisk == null ? 'Risk unavailable' : `Risk ${option.baselineRisk}`} <small>FORECAST</small></span><span className="route-risk-strip" aria-label={`Forecast risk score ${option.baselineRisk ?? 'unavailable'}`}>{option.segments.map((segment) => <i key={segment.id} className={`risk-strip-${segment.risk.level.toLowerCase()}`} />)}</span></button>)}</div></section>}</div>{analysis && mapVisible && <RouteMapCard analysis={analysis} segments={segments} routePositions={routePositions} selected={selected} setSelected={setSelected} />}{!analysis && mapVisible && (loading ? <RouteLoadingCard stage={stage} /> : <JourneyEmptyCard routeReady={Boolean(startText.trim() && destinationText.trim() && departure)} />)}</div>{analysis && analysis.bestCandidate && analysis.baselineRisk != null && <RecommendationBanner analysis={analysis} onApply={(chosen) => { setDeparture(new Date(chosen.getTime() - chosen.getTimezoneOffset() * 60000).toISOString().slice(0, 16)); runAnalysis(chosen) }} />}{analysis && timelineVisible && <JourneyForecast segments={segments} selected={selected} setSelected={setSelected} />}</>}


      {activeSection === 'saved-routes' && <section className="utility-page"><div className="eyebrow">YOUR TRIPS</div><h1>Saved routes</h1><p className="welcome-description">Trips are stored in this browser on this device. Forecasts refresh when you load and analyze a route.</p>{savedRoutes.length ? <div className="saved-route-list">{savedRoutes.map((route) => <article className="saved-route-card" key={route.id}><div className="saved-route-icon"><Route size={18} /></div><div className="saved-route-copy"><b>{route.start} <ArrowRight size={14} /> {route.destination}</b><span>{route.departure ? new Date(route.departure).toLocaleString() : 'Departure not set'} · {route.routeMode || 'Driving'}</span></div><button type="button" className="secondary-action" onClick={() => openSavedRoute(route)}>Load trip</button><button type="button" className="icon-button" aria-label={`Delete saved route ${route.start} to ${route.destination}`} onClick={() => setSavedRoutes((items) => items.filter((item) => item.id !== route.id))}>×</button></article>)}</div> : <div className="empty-panel"><Bookmark size={24} /><b>No saved routes yet</b><span>Plan a journey and choose “Save route” to keep it here.</span><button type="button" className="analyze-button" onClick={() => goToSection('planner')}>Plan a trip <ArrowRight size={16} /></button></div>}</section>}
      {activeSection === 'alerts' && <section className="utility-page"><div className="eyebrow">FORECAST MONITOR</div><h1>Weather alerts</h1><p className="welcome-description">Alerts below come from your most recently analyzed route forecast. Forecast estimates are not official warnings.</p>{analysis ? <div className="alert-list">{segments.filter((segment) => ['High', 'Moderate'].includes(segment.risk.level)).sort((a, b) => b.risk.score - a.risk.score).map((segment) => <article className={`alert-card alert-${segment.risk.level.toLowerCase()}`} key={segment.id}><RouteIcon type="weather" size={21} decorative /><div><b>{segment.name} · {segment.risk.level} forecast risk</b><span>Expected around {formatTime(segment.arrival)} · {segment.risk.reasons.join(' · ')}</span>{segment.weather && <small>{weatherLabel(segment.weather.code)}{segment.weather.temperature == null ? '' : ` · ${Math.round(segment.weather.temperature)}°C`}{segment.weather.precipitationProbability == null ? '' : ` · ${segment.weather.precipitationProbability}% precipitation chance`}</small>}</div><b className="alert-score">{segment.risk.score}</b></article>)}{!segments.some((segment) => ['High', 'Moderate'].includes(segment.risk.level)) && <div className="empty-panel"><ShieldCheck size={24} /><b>No elevated samples in this route forecast</b><span>Unknown forecast points are not counted as safe.</span></div>}</div> : <div className="empty-panel"><Bell size={24} /><b>No route forecast to monitor</b><span>Analyze a trip to see forecast alerts based on its sampled route.</span><button type="button" className="analyze-button" onClick={() => goToSection('planner')}>Plan a trip <ArrowRight size={16} /></button></div>}</section>}
      {activeSection === 'fleet' && <FleetPage notify={notify} />}

      {['risk', 'departure-optimizer', 'briefing'].includes(activeSection) && !analysis && <section className="page-empty"><div className="empty-graphic"><div className="empty-orbit orbit-one" /><div className="empty-orbit orbit-two" /><div className="empty-center">{activeSection === 'briefing' ? <BrainCircuit size={30} /> : activeSection === 'departure-optimizer' ? <CalendarClock size={30} /> : <Activity size={30} />}</div></div><div className="empty-eyebrow">{activeSection === 'briefing' ? 'GEMMA 4 BRIEFING' : activeSection === 'departure-optimizer' ? 'DEPARTURE OPTIMIZER' : 'ROUTE RISK ANALYSIS'}</div><h2>Analyze a route to get started.</h2><p>RouteGuard needs a route and its forecast samples before it can show {activeSection === 'briefing' ? 'an AI travel briefing' : activeSection === 'departure-optimizer' ? 'departure comparisons' : 'risk and weather details'}.</p><button type="button" className="analyze-button page-empty-action" onClick={() => goToSection('planner')}><Compass size={16} /> Open route planner <ArrowRight size={16} /></button></section>}

      {analysis && ['risk', 'planner'].includes(activeSection) && <>
        <section className="metrics-grid" id="risk"><StatCard icon={Route} label="ROAD DISTANCE" value={`${analysis.distanceKm.toFixed(1)} km`} detail={`OSRM driving route · ${formatDuration(analysis.routeDuration)}`} /><StatCard icon={Clock3} label="ESTIMATED ARRIVAL" value={formatArrivalDateTime(departure, Math.round(analysis.routeDuration / 60)).time} detail={`${formatArrivalDateTime(departure, Math.round(analysis.routeDuration / 60)).date} · Depart ${formatTime(new Date(departure))}`} /><StatCard icon={Gauge} label="AVERAGE ROUTE RISK" value={riskOverall} detail={analysis.baselineRisk == null ? 'Insufficient forecast coverage' : `Risk score ${analysis.baselineRisk}/100`} accent={analysis.baselineRisk == null ? '#8a96aa' : riskColor(analysis.baselineRisk >= 55 ? 'High' : analysis.baselineRisk >= 28 ? 'Moderate' : 'Low')} /><StatCard icon={TriangleAlert} label="HIGH-RISK SAMPLES" value={`${totals.high}`} detail={`${totals.moderate} moderate · ${totals.low} low · ${totals.unknown} unknown`} accent={totals.high ? '#ff5d62' : '#42d9b1'} /></section>
        <section className="analysis-grid">
          {activeSection !== 'planner' && mapVisible && <RouteMapCard analysis={analysis} segments={segments} routePositions={routePositions} selected={selected} setSelected={setSelected} />}
          {timelineVisible && <div className="conditions-card"><div className="card-header"><div><div className="card-kicker">SAMPLED ROUTE FORECAST</div><h2>Conditions timeline</h2></div><button type="button" className="icon-button" onClick={runAnalysis} title="Refresh analysis" aria-label="Refresh analysis" disabled={loading}><RefreshCw size={16} /></button></div><div className="segment-list">{segments.map((segment, index) => { const WeatherIcon = weatherIcon(segment.weather?.code); const iconType = segment.risk.level === 'High' ? 'high' : segment.risk.level === 'Low' ? 'safe' : segment.weather && [45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(segment.weather.code) ? 'weather' : index === 0 ? 'origin' : index === segments.length - 1 ? 'destination' : 'waypoint'; return <button type="button" key={segment.id} className={`segment-row ${selected === index ? 'segment-selected' : ''}`} onClick={() => setSelected(index)}><span className="segment-line"><RouteIcon type={iconType} size={22} decorative />{index !== segments.length - 1 && <span className="segment-line-stem" />}</span><span className="segment-main"><span className="segment-location">{segment.name}</span><span className="segment-sub">{formatTime(segment.arrival)} arrival</span></span><span className="segment-weather"><WeatherIcon size={21} /><span>{segment.weather?.temperature == null ? '—' : `${Math.round(segment.weather.temperature)}°`}</span></span><span className={`risk-chip risk-${segment.risk.level.toLowerCase()}`}>{segment.risk.level}</span></button> })}</div><div className="selected-detail"><div className="detail-title"><span className="detail-dot" style={{ background: riskColor(selectedSegment?.risk.level) }} /><b>{selectedSegment?.name ?? 'Select a segment'}</b><span className={`risk-chip risk-${(selectedSegment?.risk.level ?? 'unknown').toLowerCase()}`}>{selectedSegment?.risk.level}</span></div>{selectedSegment && <div className="location-source-note">Forecast point: {coordinateLabel(selectedSegment.point)} · {selectedSegment.placeNameSource === "OpenStreetMap" ? "nearest mapped place label" : selectedSegment.placeNameSource === "search" ? "geocoded route endpoint" : "coordinate shown because no mapped name was found"}</div>}{selectedSegment?.currentWeather && <div className="current-weather-summary"><span className="current-weather-label">CURRENT MODEL CONDITIONS · UPDATED {selectedSegment.currentWeather.time ? formatTime(selectedSegment.currentWeather.time) : "recently"}</span><b>{weatherLabel(selectedSegment.currentWeather.code)}{selectedSegment.currentWeather.temperature == null ? "" : ` · ${Math.round(selectedSegment.currentWeather.temperature)}°C`}{selectedSegment.currentWeather.wind == null ? "" : ` · Wind ${Math.round(selectedSegment.currentWeather.wind)} km/h`}</b></div>}<div className="forecast-detail-heading"><span>Forecast at expected arrival</span><time>{selectedSegment ? formatTime(selectedSegment.arrival) : "—"}</time></div>{selectedSegment?.weather && <div className="weather-detail-grid"><span><Thermometer size={14} /> {selectedSegment.weather.temperature ?? '—'}°C</span><span><CloudRain size={14} /> {selectedSegment.weather.precipitationProbability ?? '—'}% rain chance</span><span><Wind size={14} /> {selectedSegment.weather.wind ?? '—'} km/h</span><span><Eye size={14} /> {selectedSegment.weather.visibility == null ? 'N/A' : `${(selectedSegment.weather.visibility / 1000).toFixed(1)} km`}</span></div>}{selectedSegment?.forecastError && <p className="detail-muted">Forecast unavailable: {selectedSegment.forecastError}</p>}<ul className="risk-reasons">{selectedSegment?.risk.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div></div>}
        </section>
        {highestRisk && <section className="insight-strip"><div className="insight-icon"><Activity size={18} /></div><div><b>What matters most</b><p>Highest sampled risk: {highestRisk.name}, around {formatTime(highestRisk.arrival)}. {highestRisk.risk.reasons.join('; ')}.</p></div></section>}
      </>}

      {analysis && (activeSection === 'departure-optimizer' || activeSection === 'planner') && <DepartureDashboard analysis={analysis} routeOptions={routeOptions} onChooseDeparture={(candidate) => { const chosen = candidate.departure; setDeparture(new Date(chosen.getTime() - chosen.getTimezoneOffset() * 60000).toISOString().slice(0, 16)); runAnalysis(chosen) }} onChooseRoute={(option) => { setAnalysis({ ...option, routeMode }); setSelected(0); setAiBrief(''); goToSection('planner') }} />}

      {analysis && activeSection === 'briefing' && <section className="ai-card" id="briefing"><div className="ai-emblem"><BrainCircuit size={23} /></div><div className="ai-content"><div className="ai-topline"><span className="ai-label">GEMMA 4 INTELLIGENCE</span><span className={`ai-connection ${aiStatus === 'connected' ? 'connected' : ''}`}><span className="live-dot" /> {aiStatus === 'connected' ? 'Connected' : 'Backend setup required'}</span></div><h2>Your route briefing</h2><p>Forecast-based guidance using the conditions and risk scores calculated for this route.</p>{aiLoading && !aiBrief && <div className="ai-brief-result ai-thinking" role="status" aria-live="polite"><LoaderCircle className="spin" size={16} /> Preparing your route briefing…</div>}{aiBrief && <div className="ai-brief-result" aria-live="polite" aria-busy={aiLoading}><BriefingRenderer content={aiBrief} />{aiLoading && <span className="typing-cursor" aria-hidden="true">▋</span>}</div>}{aiError && <div className="error-banner ai-error-message" role="alert"><TriangleAlert size={16} /> {aiError}</div>}{!aiBrief && !aiLoading && aiStatus === 'not-connected' && <p className="ai-note">Configure the Gemma provider in the local backend environment to enable AI-generated briefings. Route forecasts work without AI.</p>}<button type="button" className="ai-button" onClick={generateGemmaBrief} disabled={aiLoading || loading}>{aiLoading ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{aiLoading ? 'Requesting Gemma 4…' : aiBrief ? 'Refresh travel briefing' : 'Generate AI travel briefing'}{!aiLoading && <ArrowRight size={16} />}</button></div><div className="ai-decoration"><div /><div /><div /><div /><div /></div></section>}
      </div>
      {activeSection !== 'departure-optimizer' && <footer className="footer"><a href="#planner" className="footer-brand" onClick={(event) => { event.preventDefault(); goToSection('planner') }}><span className="brand-mark"><RouteIcon type="origin" size={15} decorative /></span> routeguard</a><span>Built for safer decisions, not certainty.</span><span className="footer-links">Open data · AI-assisted · Forecast dependent</span></footer>}
    </main>
    {toast && <div className={`rg-toast ${toast.type === 'success' ? 'rg-toast-success' : ''}`} role={toast.type === 'error' ? 'alert' : 'status'} aria-live={toast.type === 'error' ? 'assertive' : 'polite'}><span>{toast.message}</span><button type="button" onClick={() => setToast(null)} aria-label="Dismiss notification">×</button></div>}
  </div>
}

function RiskSampleMarker({ position, selected, level, onSelect, children }) {
  return <CircleMarker center={position} radius={selected ? 8 : 5} pathOptions={{ color: '#34465d', weight: 2, fillColor: riskColor(level), fillOpacity: 1 }} eventHandlers={{ click: onSelect }}>{children}</CircleMarker>
}

function FleetPage({ notify }) {
  const [vehicles, setVehicles] = useState(() => { try { return JSON.parse(localStorage.getItem('routeguard-fleet') || '[]') } catch { return [] } })
  const [vehicleName, setVehicleName] = useState('')
  const [vehicleType, setVehicleType] = useState('Car')
  useEffect(() => { try { localStorage.setItem('routeguard-fleet', JSON.stringify(vehicles)) } catch { /* Fleet entries remain for this session. */ } }, [vehicles])
  function addVehicle(event) {
    event.preventDefault()
    if (!vehicleName.trim()) return
    setVehicles((items) => [...items, { id: `${Date.now()}`, name: vehicleName.trim(), type: vehicleType }])
    setVehicleName(''); notify('Vehicle added to this device’s fleet list.', 'success')
  }
  return <section className="utility-page"><div className="eyebrow">LOCAL VEHICLE DIRECTORY</div><h1>Fleet</h1><p className="welcome-description">Keep a simple vehicle list for planning. Vehicle entries are stored in this browser and do not change route calculations.</p><form className="fleet-form" onSubmit={addVehicle}><label><span>Vehicle name</span><input value={vehicleName} onChange={(event) => setVehicleName(event.target.value)} placeholder="e.g. Family car" maxLength={48} required /></label><label><span>Type</span><select value={vehicleType} onChange={(event) => setVehicleType(event.target.value)}><option>Car</option><option>Van</option><option>Truck</option><option>Motorcycle</option><option>Other</option></select></label><button type="submit" className="analyze-button">Add vehicle <ArrowRight size={16} /></button></form><div className="fleet-list">{vehicles.map((vehicle) => <article key={vehicle.id} className="fleet-item"><span className="fleet-symbol"><Navigation size={18} /></span><div><b>{vehicle.name}</b><span>{vehicle.type} · Local profile</span></div><button type="button" className="icon-button" aria-label={`Remove ${vehicle.name}`} onClick={() => setVehicles((items) => items.filter((item) => item.id !== vehicle.id))}>×</button></article>)}{!vehicles.length && <div className="empty-panel"><Navigation size={24} /><b>Your fleet list is empty</b><span>Add vehicles to keep your planning details organized on this device.</span></div>}</div><p className="settings-note fleet-limitation">The connected router currently provides standard driving directions only. Vehicle dimensions, fuel use, toll preferences, and restrictions are not applied to route selection.</p></section>
}

function JourneyEmptyCard({ routeReady = false }) {
  return <section className="journey-empty-state"><div className="empty-route-art"><span><Route size={30} /></span><i className="empty-weather empty-weather-one"><CloudRain size={16} /></i><i className="empty-weather empty-weather-two"><Wind size={16} /></i></div><div className="eyebrow">YOUR JOURNEY, WITH CONTEXT</div><h2>{routeReady ? 'Inputs changed. Refresh your forecast.' : 'Every mile has a forecast.'}</h2><p>{routeReady ? 'The previous results are cleared so they cannot be mistaken for this route. Analyze your route to fetch updated directions, arrival-time weather and risk.' : 'Enter a route to see weather and risk estimates at sampled points along your journey.'}</p><div className="empty-benefits"><span><Check size={14} /> Arrival-time forecasts</span><span><Check size={14} /> Route risk samples</span><span><Check size={14} /> Departure comparisons</span></div></section>
}

function RouteArrivalSummary({ analysis }) {
  const plannedDeparture = analysis.candidates?.[0]?.departure ?? analysis.segments?.[0]?.arrival
  if (!plannedDeparture || !Number.isFinite(analysis.routeDuration)) return null
  const arrival = formatArrivalDateTime(plannedDeparture, Math.round(analysis.routeDuration / 60))
  return <section className="route-arrival-summary" aria-live="polite" aria-label="Estimated route arrival">
    <span className="route-arrival-icon"><Clock3 size={18} /></span>
    <div className="route-arrival-main"><span>ESTIMATED ARRIVAL · LOCAL TIME</span><strong>{arrival.time}</strong><small>{arrival.date} · {analysis.destination.name}</small></div>
    <div className="route-arrival-duration"><span>ESTIMATED DRIVE</span><b>{formatDuration(analysis.routeDuration)}</b><small>Router duration estimate</small></div>
  </section>
}

function RouteLoadingCard({ stage }) {
  return <div className="route-loading-card" role="status" aria-live="polite"><div className="route-loading-orbit"><Route size={25} /><span><LoaderCircle size={17} className="spin" /></span></div><b>Building your route forecast</b><p>{stage || 'Connecting route and forecast data…'}</p><div className="route-loading-track"><i /></div></div>
}

function RecommendationBanner({ analysis, onApply }) {
  const improved = analysis.bestCandidate.averageRisk < analysis.baselineRisk
  const score = analysis.bestCandidate.averageRisk
  const difference = Math.max(0, analysis.baselineRisk - score)
  return <section className={`recommendation-banner ${improved ? 'recommendation-improved' : 'recommendation-steady'}`}><div className="recommendation-icon"><ShieldCheck size={22} /></div><div><span>{improved ? 'SAFER SAMPLED DEPARTURE' : 'DEPARTURE WINDOW CHECK'}</span><b>{improved ? `Consider leaving at ${formatTime(analysis.bestCandidate.departure)} · risk score ${analysis.baselineRisk} → ${score}` : `No lower sampled risk than your current departure · risk score ${score}`}</b><p>Forecast comparison across the available hourly windows at sampled route points. Conditions may change.</p></div>{improved && <div className="recommendation-delta"><b>−{difference}</b><small>risk points</small></div>}<button type="button" onClick={() => onApply(analysis.bestCandidate.departure)}>{improved ? 'Apply time' : 'Refresh route'} <ArrowRight size={15} /></button></section>
}

function RouteMapCard({ analysis, segments, routePositions, selected, setSelected }) {
  return <div className="map-card"><div className="card-header"><div><div className="card-kicker">OSRM DRIVING ROUTE</div><h2>Weather along the way</h2></div><span className="map-badge"><span className="live-dot" /> {segments.length} sampled points</span></div><div className="map-wrap"><MapContainer center={routePositions[0] ?? [23.25, 77.4]} zoom={7} scrollWheelZoom className="route-map"><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />{routePositions.length > 1 && <FitRoute positions={routePositions} />}{routePositions.length > 1 && <Polyline positions={routePositions} pathOptions={{ color: '#21c99a', weight: 5, opacity: .92 }} />}{segments.map((segment, index) => { const markerType = segment.risk.level === 'High' ? 'high' : segment.risk.level === 'Low' ? 'safe' : null; const position = [segment.point[0], segment.point[1]]; const popup = <Popup className="route-map-popup"><b>{segment.name}</b><br />{segment.weather ? weatherLabel(segment.weather.code) : 'Forecast unavailable'}<br />Risk: {segment.risk.level}</Popup>; return markerType ? <Marker key={segment.id} position={position} icon={routeMarkerIcon(markerType)} title={`${segment.risk.level} risk sample`} eventHandlers={{ click: () => setSelected(index) }}>{popup}</Marker> : <RiskSampleMarker key={segment.id} position={position} selected={selected === index} level={segment.risk.level} onSelect={() => setSelected(index)}>{popup}</RiskSampleMarker> })}<Marker position={[analysis.start.lat, analysis.start.lon]} icon={routeMarkerIcon('origin')} title={`Start: ${analysis.start.name}`}><Popup className="route-map-popup">Start: {analysis.start.name}</Popup></Marker><Marker position={[analysis.destination.lat, analysis.destination.lon]} icon={routeMarkerIcon('destination')} title={`Destination: ${analysis.destination.name}`}><Popup className="route-map-popup">Destination: {analysis.destination.name}</Popup></Marker></MapContainer><div className="map-legend"><span><i className="legend-dot low" /> Low</span><span><i className="legend-dot moderate" /> Moderate</span><span><i className="legend-dot high" /> High</span></div><div className="map-controls"><span><Crosshair size={14} /> Sampled route points</span><span><Check size={14} /> Forecast risk markers</span></div></div><div className="route-endpoints"><div className="endpoint"><RouteIcon type="origin" size={19} decorative /><div><span>STARTING POINT</span><b>{analysis.start.name}</b></div></div><ArrowRight size={17} className="endpoint-arrow" /><div className="endpoint"><RouteIcon type="destination" size={19} decorative /><div><span>DESTINATION</span><b>{analysis.destination.name}</b></div></div></div></div>
}

function JourneyForecast({ segments, selected, setSelected }) {
  return <section className="journey-forecast-card"><header className="journey-forecast-header"><div><span className="card-kicker">FORECAST AT EXPECTED ARRIVAL</span><h2>Weather along your journey</h2><p>Conditions from the hourly model at sampled points along this route.</p></div><span className="forecast-coverage">{segments.filter((segment) => segment.weather).length} of {segments.length} forecast points available</span></header><div className="forecast-card-grid">{segments.map((segment, index) => { const Icon = weatherIcon(segment.weather?.code); const level = segment.risk.level.toLowerCase(); return <button type="button" key={segment.id} className={`forecast-segment-card forecast-${level} ${selected === index ? 'forecast-card-selected' : ''}`} style={{ '--forecast-index': index }} onClick={() => setSelected(index)} aria-pressed={selected === index}><div className="forecast-segment-top"><span className={`forecast-level-pill ${level}`}>{segment.risk.level}</span><time>{formatTime(segment.arrival)}</time></div><Icon className="forecast-condition-icon" size={27} aria-hidden="true" /><b className="forecast-location">{segment.name}</b><span className="forecast-condition">{segment.weather ? weatherLabel(segment.weather.code) : 'Forecast unavailable'}</span><div className="forecast-readings"><span><small>Temp</small><b>{segment.weather?.temperature == null ? '—' : `${Math.round(segment.weather.temperature)}°C`}</b></span><span><small>Visibility</small><b>{segment.weather?.visibility == null ? '—' : `${(segment.weather.visibility / 1000).toFixed(1)} km`}</b></span><span><small>Rain chance</small><b>{segment.weather?.precipitationProbability == null ? '—' : `${segment.weather.precipitationProbability}%`}</b></span><span><small>Wind</small><b>{segment.weather?.wind == null ? '—' : `${Math.round(segment.weather.wind)} km/h`}</b></span></div></button> })}</div></section>
}

function classifyWeatherSegment(segment, type) {
  const weather = segment.weather
  if (!weather) return false
  if (type === 'rain') return [51,53,55,56,57,61,63,65,66,67,80,81,82,85,86,95,96,99].includes(weather.code) || Number(weather.precipitationProbability) >= 40 || Number(weather.precipitation) > 0
  if (type === 'visibility') return [45,48].includes(weather.code) || (weather.visibility != null && weather.visibility < 3000)
  if (type === 'heat') return weather.temperature != null && weather.temperature >= 35
  if (type === 'wind') return weather.wind != null && weather.wind >= 40
  return false
}

function weatherHazardSeverity(segment, type) {
  const weather = segment.weather
  if (!weather) return 'Unknown'
  if (type === 'rain') {
    if ([65,67,82,86,95,96,99].includes(weather.code) || (weather.precipitation != null && weather.precipitation >= 7.5)) return 'High'
    if ([51,53,55,56,57,61,63,66,71,73,75,77,80,81,85].includes(weather.code) || Number(weather.precipitationProbability) >= 70 || (weather.precipitation != null && weather.precipitation >= 2.5)) return 'Moderate'
    return 'Low'
  }
  if (type === 'visibility') {
    if (weather.visibility != null && weather.visibility < 1000) return 'High'
    if ([45,48].includes(weather.code) || (weather.visibility != null && weather.visibility < 3000)) return 'Moderate'
    return 'Low'
  }
  if (type === 'heat') return weather.temperature >= 42 ? 'High' : weather.temperature >= 38 ? 'Moderate' : 'Low'
  if (type === 'wind') return weather.wind >= 60 ? 'High' : weather.wind >= 40 ? 'Moderate' : 'Low'
  return 'Unknown'
}

function RiskBreakdown({ segments }) {
  const availableSamples = segments.filter((segment) => segment.weather).length
  const categories = [
    { id: 'rain', label: 'Rain & storms', Icon: CloudRain },
    { id: 'visibility', label: 'Fog & visibility', Icon: Eye },
    { id: 'heat', label: 'Heat', Icon: Thermometer },
    { id: 'wind', label: 'Strong wind', Icon: Wind },
  ].map((category) => {
    const samples = segments.filter((segment) => classifyWeatherSegment(segment, category.id))
    const severity = samples.map((segment) => weatherHazardSeverity(segment, category.id))
    const level = severity.includes('High') ? 'High' : severity.includes('Moderate') ? 'Moderate' : severity.includes('Low') ? 'Low' : samples.length ? 'Unknown' : 'None'
    return { ...category, samples, level }
  })
  const tips = [
    { id: 'rain', text: 'Check official weather and road advisories before departure.' },
    { id: 'visibility', text: 'Allow extra following distance where visibility is reduced.' },
    { id: 'heat', text: 'Plan breaks and monitor vehicle temperature in hotter sections.' },
    { id: 'wind', text: 'Use extra care on exposed sections in strong winds.' },
  ].filter((tip) => categories.find((category) => category.id === tip.id)?.samples.length)
  return <aside className="risk-breakdown-card"><div className="risk-breakdown-heading"><span className="card-kicker">SAMPLED WEATHER SIGNALS</span><h2>Risk breakdown</h2><p>Forecast hazards on this route at the selected departure.</p><span className="risk-sample-coverage" aria-live="polite">{availableSamples} of {segments.length} weather samples available</span></div><div className="hazard-list">{categories.map(({ id, label, Icon, samples, level }) => <div className={`hazard-row hazard-${level.toLowerCase()}`} key={id}><span className="hazard-icon"><Icon size={15} /></span><div className="hazard-content"><div className="hazard-label-row"><b>{label}</b><span>{availableSamples === 0 ? `Forecast unavailable · 0/${segments.length}` : samples.length ? `${samples.length}/${availableSamples} samples · ${level}` : `0/${availableSamples} samples · No threshold crossed`}</span></div><div className="hazard-track"><span style={{ width: `${availableSamples ? samples.length / availableSamples * 100 : 0}%` }} /></div></div></div>)}</div><div className="before-you-go"><b>Before you go</b>{tips.length ? <ul>{tips.map((tip) => <li key={tip.id}><Check size={13} /> {tip.text}</li>)}</ul> : <p>{availableSamples ? 'No threshold-based weather actions were triggered in the available samples. Check local advisories before travel.' : 'Weather data is unavailable for these route points. Refresh the analysis when forecast data is reachable; do not interpret missing data as safe conditions.'}</p>}</div><p className="risk-breakdown-note">These are model-based weather indicators, not official alerts or a guarantee of road safety.</p></aside>
}

function DepartureDashboard({ analysis, routeOptions, onChooseDeparture, onChooseRoute }) {
  const current = analysis.candidates[0]
  const baseline = current?.averageRisk
  const maxRisk = 100
  return <section className="departure-dashboard" id="departure-optimizer"><div className="departure-card"><div className="card-header"><div><div className="card-kicker">DEPARTURE OPTIMIZER</div><h2>Departure window</h2><p className="card-description">Sampled route risk at hourly departure choices. Unknown forecast windows stay unscored.</p></div><div className="chart-legend"><span><i className="legend-dot low" /> Low &lt;28</span><span><i className="legend-dot moderate" /> Moderate</span><span><i className="legend-dot high" /> High ≥55</span></div></div><div className="departure-chart"><div className="chart-y-axis"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span><small>Risk</small></div><div className="chart-plot"><div className="chart-grid-lines"><i /><i /><i /><i /><i /></div><div className="departure-bars">{analysis.candidates.map((candidate, index) => { const score = candidate.averageRisk; const tone = score == null ? 'unknown' : score >= 55 ? 'high' : score >= 28 ? 'moderate' : 'low'; const recommended = analysis.bestCandidate?.offsetHours === candidate.offsetHours; const selected = candidate.offsetHours === 0; return <button type="button" key={candidate.offsetHours} className={`departure-bar-column bar-${tone} ${recommended ? 'bar-recommended' : ''} ${selected ? 'bar-current' : ''}`} style={{ '--bar-index': index, '--bar-height': `${score ?? 0}%` }} onClick={() => score != null && onChooseDeparture(candidate)} disabled={score == null} aria-label={`${formatTime(candidate.departure)} departure, ${score == null ? 'forecast unavailable' : `risk score ${score}`}${recommended ? ', lowest sampled score' : ''}`} title={score == null ? `${formatTime(candidate.departure)} · forecast unavailable` : `${formatTime(candidate.departure)} · risk ${score}/100 · ${candidate.sampled} sampled points`}><span className="chart-bar-value">{score == null ? '—' : score}</span><span className="chart-bar-track"><i style={{ height: `${score == null ? 0 : Math.max(2, score / maxRisk * 100)}%` }} /></span><span className="chart-bar-time">{formatTime(candidate.departure)}</span>{recommended && <span className="chart-recommend-label">Best sample</span>}{selected && <span className="chart-current-label">Current</span>}</button> })}</div></div></div><div className="departure-summary-cards"><article className="summary-best"><span><Sparkles size={13} /> Lowest sampled risk</span><b>{analysis.bestCandidate ? formatTime(analysis.bestCandidate.departure) : 'Unavailable'}</b><small>{analysis.bestCandidate?.averageRisk == null ? 'Forecast coverage is insufficient' : `Risk ${analysis.bestCandidate.averageRisk}/100 · ${analysis.bestCandidate.sampled}/${analysis.segments.length} points`}</small></article><article><span><Clock3 size={13} /> Current selection</span><b>{current ? formatTime(current.departure) : '—'}</b><small>{baseline == null ? 'Risk score unavailable' : `Risk ${baseline}/100 · ${current.highRiskSegments} high-risk samples`}</small></article><article><span><Route size={13} /> Alternate road</span>{routeOptions.find((route) => route.id !== analysis.id) ? <><b>{routeOptions.find((route) => route.id !== analysis.id).routeName}</b><small>{routeOptions.find((route) => route.id !== analysis.id).baselineRisk == null ? 'Risk unavailable' : `Risk ${routeOptions.find((route) => route.id !== analysis.id).baselineRisk}/100 · ${formatDuration(routeOptions.find((route) => route.id !== analysis.id).routeDuration)}`}</small><button type="button" onClick={() => onChooseRoute(routeOptions.find((route) => route.id !== analysis.id))}>Select alternate route <ArrowRight size={13} /></button></> : <small>No alternate route was returned by the router.</small>}</article></div><p className="comparison-note"><TriangleAlert size={14} /> Each score uses forecast data at sampled points near expected arrival times. Choose a bar to re-run the route at that departure.</p></div><RiskBreakdown segments={analysis.segments} /></section>
}
