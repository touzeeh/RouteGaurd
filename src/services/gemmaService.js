
const SYSTEM_PROMPT = `You are RouteGuard's weather-forecast explainer. Produce a concise briefing in clean Markdown with these sections: Recommendation, Route highlights, Departure comparison, and Limitations.
Rules:
- Use only values and facts present in the supplied route data. Never invent places, segment names, hazards, values, or road conditions.
- For locations, copy the exact supplied segment location. Do not substitute another city or country.
- Describe only supplied risk_reasons as hazards. If there are none, say no listed weather risk signals were detected in the sampled forecast.
- Treat risk scores as forecast estimates, not measured road safety. Avoid claiming that travel is safe or guaranteed.
- Recommendation may be Go, Delay, or Adjust, but explain it as a forecast-based suggestion and acknowledge missing coverage.
- Compare the supplied departure windows. Use their supplied readable local times; never output raw ISO timestamps.
- Use normal Markdown: one # title at most, ## section headings, short paragraphs, and simple bullets. No numbered heading labels, bolded heading markup, nested lists, or long dense paragraphs.
- Keep the briefing under 220 words and state that it is not an official safety advisory.`;

export function buildGemmaPayload({
  origin,
  destination,
  totalDistance,
  duration,
  segmentForecasts,
  departureOptimizerWindows,
  departureDateTime,
}) {
  if (!origin?.trim() || !destination?.trim()) {
    throw new Error("Origin and destination are required for the briefing.");
  }

  if (!Array.isArray(segmentForecasts) || segmentForecasts.length === 0) {
    throw new Error("Route forecast data is not available yet.");
  }

  if (
    !Array.isArray(departureOptimizerWindows) ||
    departureOptimizerWindows.length < 2
  ) {
    throw new Error("At least two departure comparison windows are required.");
  }

  return {
    origin: origin.trim(),
    destination: destination.trim(),
    departure_datetime: departureDateTime,
    total_distance: totalDistance,
    duration,
    segment_forecasts: segmentForecasts.map((segment) => ({
      location: segment.location ?? segment.name ?? "Unknown segment",
      expected_arrival: segment.expected_arrival ?? null,
      temperature_c: segment.temperature_c ?? segment.temperature ?? null,
      rain_probability: segment.rain_probability ?? segment.precipitation_probability ?? null,
      visibility_km: segment.visibility_km ?? segment.visibility ?? null,
      wind_speed_kmh: segment.wind_speed_kmh ?? segment.wind_speed ?? null,
      weather: segment.weather ?? segment.condition ?? "Unknown",
      risk_score: segment.risk_score ?? segment.riskScore ?? null,
      risk_level: segment.risk_level ?? segment.riskLevel ?? "unknown",
      risk_reasons: Array.isArray(segment.risk_reasons) ? segment.risk_reasons : [],
    })),
    departure_optimizer_windows: departureOptimizerWindows.map((window) => ({
      departure_time: window.departure_time ?? window.time ?? null,
      risk_score: window.risk_score ?? window.riskScore ?? null,
      high_risk_samples: window.high_risk_samples ?? window.highRiskSamples ?? null,
      recommendation: window.recommendation ?? null,
    })),
  };
}

function extractText(data) {
  if (typeof data === "string") return data;

  if (typeof data?.text === "string") return data.text;
  if (typeof data?.output_text === "string") return data.output_text;
  if (typeof data?.briefing === "string") return data.briefing;
  if (typeof data?.response === "string") return data.response;

  // Common model-provider response shapes.
  const candidateText = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("");

  if (candidateText) return candidateText;

  throw new Error("The AI service returned no readable briefing.");
}

async function readResponse(response, onToken) {
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.body || !contentType.includes("text/event-stream")) {
    const data = await response.json();
    const text = extractText(data);

    if (onToken) {
      // Typing animation can be rendered by the caller.
      onToken(text);
    }

    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const dataLine = event
        .split("\n")
        .find((line) => line.startsWith("data:"));

      if (!dataLine) continue;

      const raw = dataLine.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { text: raw };
      }

      const chunk =
        parsed.text ??
        parsed.delta ??
        parsed.token ??
        parsed.choices?.[0]?.delta?.content ??
        "";

      if (typeof chunk === "string" && chunk) {
        result += chunk;
        onToken?.(chunk, result);
      }
    }

    if (done) break;
  }

  if (!result.trim()) {
    throw new Error("The AI stream ended without a briefing.");
  }

  return result;
}

export async function generateGemmaBriefing(
  payload,
  { onToken, timeoutMs = 30_000, signal } = {}
) {
  const endpoint = import.meta.env.VITE_GEMMA_API_URL;

  if (!endpoint) {
    throw new Error(
      "Gemma backend is not configured. Set VITE_GEMMA_API_URL to your backend proxy."
    );
  }

  const controller = new AbortController();
  let timedOut = false;

  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        system_prompt: SYSTEM_PROMPT,
        ...payload,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Gemma service returned HTTP ${response.status}` +
          (detail ? `: ${detail.slice(0, 250)}` : "")
      );
    }

    return await readResponse(response, onToken);
  } catch (error) {
    if (timedOut) {
      throw new Error("Gemma briefing timed out. Please try again.");
    }

    if (error.name === "AbortError") {
      throw new Error("The Gemma request was cancelled.");
    }

    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
