import 'dotenv/config'
import express from 'express'
import cors from 'cors'

const app = express()
const port = Number(process.env.PORT || 8000)
const allowedOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5175'
const providerKey = process.env.GEMMA_API_KEY
const providerModel = process.env.GEMMA_MODEL || 'gemma-4-26b-a4b-it'
const providerUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(providerModel)}:generateContent`
const reverseCache = new Map()
let reverseQueue = Promise.resolve()
let lastReverseLookupAt = 0

app.disable('x-powered-by')
app.use(cors({ origin: allowedOrigin }))
app.use(express.json({ limit: '256kb' }))

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', providerConfigured: Boolean(providerKey), model: providerModel })
})

app.post('/api/geo/reverse', async (request, response) => {
  const points = request.body?.points
  if (!Array.isArray(points) || points.length > 7 || points.some((point) => !Number.isFinite(Number(point?.lat)) || !Number.isFinite(Number(point?.lon)) || Math.abs(Number(point.lat)) > 90 || Math.abs(Number(point.lon)) > 180)) {
    return response.status(400).json({ error: 'Provide up to seven valid route coordinates.' })
  }

  const resolvePoint = (point) => {
    const lat = Number(point.lat)
    const lon = Number(point.lon)
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`
    const cached = reverseCache.get(key)
    if (cached && Date.now() - cached.createdAt < 7 * 24 * 60 * 60 * 1000) return Promise.resolve(cached.value)

    const lookup = reverseQueue.then(async () => {
      const wait = Math.max(0, 1100 - (Date.now() - lastReverseLookupAt))
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
      lastReverseLookupAt = Date.now()

      const url = new URL('https://nominatim.openstreetmap.org/reverse')
      url.searchParams.set('lat', String(lat))
      url.searchParams.set('lon', String(lon))
      url.searchParams.set('format', 'jsonv2')
      url.searchParams.set('zoom', '17')
      url.searchParams.set('addressdetails', '1')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 9000)
      try {
        const result = await fetch(url, { headers: { 'User-Agent': 'RouteGuard/1.0 (route waypoint reverse geocoding)' }, signal: controller.signal })
        if (!result.ok) throw new Error(`Place lookup failed (${result.status}).`)
        const data = await result.json()
        const address = data.address ?? {}
        const settlement = address.city ?? address.town ?? address.village ?? address.municipality ?? address.suburb ?? address.hamlet ?? address.locality ?? address.county ?? address.state_district
        const road = address.road ?? address.pedestrian ?? address.highway
        const name = road && settlement ? `${road}, ${settlement}` : settlement ?? road ?? data.name ?? null
        const value = { name, type: data.type ?? data.addresstype ?? null, displayName: data.display_name ?? null }
        reverseCache.set(key, { value, createdAt: Date.now() })
        if (reverseCache.size > 4000) reverseCache.delete(reverseCache.keys().next().value)
        return value
      } finally { clearTimeout(timeout) }
    })
    reverseQueue = lookup.then(() => undefined, () => undefined)
    return lookup.catch(() => ({ name: null, type: null, displayName: null }))
  }

  const results = await Promise.all(points.map(resolvePoint))
  return response.json({ points: results })
})

app.post('/api/gemma/briefing', async (request, response) => {
  if (!providerKey) {
    return response.status(503).json({ error: 'Gemma is not configured. Add GEMMA_API_KEY to the server environment.' })
  }

  const { system_prompt: systemPrompt, ...routeData } = request.body ?? {}
  if (!routeData.origin || !routeData.destination || !Array.isArray(routeData.segment_forecasts) || !Array.isArray(routeData.departure_optimizer_windows)) {
    return response.status(400).json({ error: 'The route briefing payload is incomplete.' })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 55_000)
  response.setTimeout(60_000)
  try {
    const upstream = await fetch(providerUrl, {
      method: 'POST',
      headers: { 'x-goog-api-key': providerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt || 'Use only supplied route and weather facts. Do not invent hazards or data. Describe all risk as forecast estimates, not official safety advice.' }] },
        contents: [{ role: 'user', parts: [{ text: `Create a concise travel briefing from this JSON. Explain whether the forecast supports Go, Delay, or Adjust, list the key hazards by segment, and identify the lowest-risk departure window. Make clear that this is an estimate, not an official safety advisory. If data is missing, say so.\n\n${JSON.stringify(routeData)}` }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1100, thinkingConfig: { thinkingLevel: 'minimal' } },
      }),
      signal: controller.signal,
    })

    const raw = await upstream.text()
    if (!upstream.ok) {
      return response.status(502).json({ error: `Gemma provider returned HTTP ${upstream.status}.`, detail: raw.slice(0, 300) })
    }

    let data
    try { data = JSON.parse(raw) } catch { return response.status(502).json({ error: 'Gemma provider returned invalid JSON.' }) }
    const parts = data.candidates?.[0]?.content?.parts ?? []
    const text = parts.filter((part) => !part.thought).map((part) => part.text ?? '').join('') || data.output_text || data.text
    if (!text) return response.status(502).json({ error: 'Gemma provider response contained no briefing text.' })
    return response.json({ text })
  } catch (error) {
    const timeoutError = error?.name === 'AbortError'
    return response.status(timeoutError ? 504 : 502).json({ error: timeoutError ? 'Gemma provider request timed out.' : 'Could not reach the Gemma provider.' })
  } finally {
    clearTimeout(timeout)
  }
})

app.listen(port, () => console.log(`RouteGuard API listening on http://localhost:${port}`))
