export const CODEX_PRIVACY_ARGS = [
  '-c', 'analytics.enabled=false',
  '-c', 'feedback.enabled=false',
  '-c', 'otel.exporter="none"',
  '-c', 'otel.metrics_exporter="none"',
  '-c', 'otel.trace_exporter="none"',
] as const;
