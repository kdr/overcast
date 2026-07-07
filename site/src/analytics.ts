import posthog from 'posthog-js'

const POSTHOG_KEY = import.meta.env.VITE_PUBLIC_POSTHOG_KEY
const POSTHOG_HOST = import.meta.env.VITE_PUBLIC_POSTHOG_HOST

export function initAnalytics() {
  if (!POSTHOG_KEY || !POSTHOG_HOST) return

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: true,
    person_profiles: 'identified_only',
  })
}

export function captureEvent(name: string, properties?: Record<string, unknown>) {
  if (!POSTHOG_KEY || !POSTHOG_HOST) return
  posthog.capture(name, properties)
}
