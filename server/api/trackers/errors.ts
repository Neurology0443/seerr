export type TrackerErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'authentication'
  | 'rate_limited'
  | 'service_unavailable'
  | 'timeout'
  | 'transport'
  | 'http_error'
  | 'invalid_xml'
  | 'torznab_error'
  | 'invalid_response';

const descriptions: Record<TrackerErrorCode, string> = {
  invalid_configuration: 'Invalid tracker configuration',
  invalid_request: 'Invalid tracker page request',
  authentication: 'Tracker authentication or authorization failed',
  rate_limited: 'Tracker rate limit reached',
  service_unavailable: 'Tracker temporarily unavailable',
  timeout: 'Tracker request timed out',
  transport: 'Tracker transport failed',
  http_error: 'Tracker HTTP request failed',
  invalid_xml: 'Invalid tracker XML',
  torznab_error: 'Tracker returned an API error',
  invalid_response: 'Invalid tracker response structure',
};

export type RetryAfter = { seconds: number } | { date: string };

export class TrackerAdapterError extends Error {
  readonly name = 'TrackerAdapterError';
  readonly httpStatus: number | null;
  readonly retryAfter: RetryAfter | null;
  readonly apiCode: number | null;

  constructor(
    readonly code: TrackerErrorCode,
    readonly retryable = false,
    details: {
      httpStatus?: number | null;
      retryAfter?: RetryAfter | null;
      apiCode?: number | null;
    } = {}
  ) {
    super(descriptions[code]);
    this.httpStatus = details.httpStatus ?? null;
    this.retryAfter = details.retryAfter ?? null;
    this.apiCode = details.apiCode ?? null;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
      retryAfter: this.retryAfter,
      apiCode: this.apiCode,
    };
  }
}

export function parseRetryAfter(value: unknown): RetryAfter | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) ? { seconds } : null;
  }
  // Only emit a canonical date, never arbitrary upstream header text.
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      text
    )
  )
    return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) && date.toUTCString() === text
    ? { date: date.toISOString() }
    : null;
}

export function httpError(
  status: number,
  retryAfter?: unknown
): TrackerAdapterError {
  const details = { httpStatus: status };
  if (status === 401 || status === 403)
    return new TrackerAdapterError('authentication', false, details);
  if (status === 429)
    return new TrackerAdapterError('rate_limited', true, {
      ...details,
      retryAfter: parseRetryAfter(retryAfter),
    });
  if (status === 503)
    return new TrackerAdapterError('service_unavailable', true, details);
  return new TrackerAdapterError(
    'http_error',
    status >= 500 || status === 408,
    details
  );
}
