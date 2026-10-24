
const MINUTE_MS = 60_000;

export function parseDurationMinutes(duration) {
  if (typeof duration === "number" && Number.isFinite(duration)) {
    if (duration < 0) throw new Error("Duration cannot be negative.");
    return Math.round(duration);
  }

  if (typeof duration !== "string" || !duration.trim()) {
    throw new Error("A valid trip duration is required.");
  }

  const value = duration.trim().toLowerCase();

  // Supports "98 hours", "3h 25m", "3 hr 25 min", "205 minutes".
  const pattern =
    /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/g;

  let totalMinutes = 0;
  let matched = false;
  let match;

  while ((match = pattern.exec(value)) !== null) {
    matched = true;

    const amount = Number(match[1]);
    const unit = match[2];

    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("Invalid duration value.");
    }

    if (unit.startsWith("d")) totalMinutes += amount * 1440;
    else if (unit.startsWith("h")) totalMinutes += amount * 60;
    else totalMinutes += amount;
  }

  // Also allow a plain numeric string to mean minutes.
  if (!matched && /^\d+(?:\.\d+)?$/.test(value)) {
    totalMinutes = Number(value);
    matched = true;
  }

  if (!matched || !Number.isFinite(totalMinutes)) {
    throw new Error(
      'Unsupported duration. Use minutes, "3h 25m", or "2 days".'
    );
  }

  return Math.round(totalMinutes);
}

export function calculateArrivalDate(departure, duration) {
  if (!departure) {
    throw new Error("A departure date and time are required.");
  }

  // datetime-local values are interpreted in the browser's local timezone.
  const departureDate =
    departure instanceof Date ? new Date(departure.getTime()) : new Date(departure);

  if (Number.isNaN(departureDate.getTime())) {
    throw new Error("The departure date is invalid.");
  }

  const durationMinutes = parseDurationMinutes(duration);

  return new Date(departureDate.getTime() + durationMinutes * MINUTE_MS);
}

export function formatArrivalDateTime(
  departure,
  duration,
  { locale = "en-IN", timeZone } = {}
) {
  const arrival = calculateArrivalDate(departure, duration);

  const dateOptions = {
    day: "2-digit",
    month: "short",
    year: "numeric",
  };

  const timeOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  };

  if (timeZone) {
    dateOptions.timeZone = timeZone;
    timeOptions.timeZone = timeZone;
  }

  const date = new Intl.DateTimeFormat(locale, dateOptions).format(arrival);
  const time = new Intl.DateTimeFormat(locale, timeOptions)
    .format(arrival)
    .toLowerCase();

  return {
    date,
    time,
    full: `${date}, ${time}`,
    iso: arrival.toISOString(),
    timestamp: arrival.getTime(),
  };
}
