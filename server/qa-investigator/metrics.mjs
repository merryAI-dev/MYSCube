export const emptyMetrics = () => ({
  plan_response_count: 0,
  plan_review_response_count: 0,
  model_response_count: 0,
  session_count: 0,
  review_response_count: 0,
  retry_count: 0,
  incomplete_response_count: 0,
  reported_usage_response_count: 0,
  total_tokens: 0,
});

// Provider usage repeats on tool and completion checkpoints. Count it only once
// per model response; missing/failed-response usage is not estimated as zero.
export function checkpointMetrics(previous, event) {
  const next = { ...previous };
  if (["model_retry_scheduled", "review_retry_scheduled"].includes(event.phase))
    next.retry_count++;
  if (["session_opened", "review_session_opened"].includes(event.phase)) {
    next.session_count = (next.session_count || 0) + 1;
    return next;
  }
  let usage;
  if (event.phase === "provider_response_incomplete") {
    next.incomplete_response_count = (next.incomplete_response_count || 0) + 1;
    usage = event.usage;
  } else if (
    event.phase === "plan_response_completed" ||
    event.phase === "plan_review_completed"
  ) {
    const key =
      event.phase === "plan_response_completed"
        ? "plan_response_count"
        : "plan_review_response_count";
    next[key] = (next[key] || 0) + 1;
    usage = event.usage;
  } else if (event.phase === "tools_requested") {
    next.model_response_count++;
    usage = event.usage;
  } else if (event.phase === "review_session_completed") {
    next.review_response_count = (next.review_response_count || 0) + 1;
    usage = event.usage;
  } else if (event.phase === "review_completed") {
    if (event.review?.usage_accounted_in_sessions === true) return next;
    next.review_response_count++;
    usage = event.review?.usage;
  } else return next;
  const tokens = usage?.total_tokens ?? usage?.totalTokenCount;
  if (Number.isSafeInteger(tokens) && tokens >= 0) {
    next.reported_usage_response_count++;
    next.total_tokens += tokens;
    if (!Number.isSafeInteger(next.total_tokens))
      throw new Error("investigation_metrics_overflow");
  }
  return next;
}
