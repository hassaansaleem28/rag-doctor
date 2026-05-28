## Coral SQL dialect (CRITICAL — not Postgres)

- JSON access: `json_get_str(properties, 'key')` — NOT `->>`, NOT JSON_EXTRACT/JSON_VALUE/to_jsonb
- These don't exist: `->>`, `->`, to_jsonb, json_extract, json_value

## Confirmed working cross-source JOIN

PostHog feedback ↔ Langfuse traces (IDs match exactly):

```sql
SELECT t.id AS trace_id, t.name, json_get_str(e.properties, 'plan') AS plan
FROM posthog.events e
JOIN langfuse.traces t ON json_get_str(e.properties, 'trace_id') = t.id
WHERE e.environment_id = '440785' AND e.event = 'feedback_negative';
```

## Confirmed data facts

- Langfuse trace.id == PostHog event properties.trace_id (exact match)
- Negative feedback = langfuse.scores.value = 0.0 (NOT < 0); positive = 1.0
- PostHog feedback events: 'feedback_negative' / 'feedback_positive'
- PostHog event properties: trace_id, question, plan ('free'|'pro'|'enterprise')
- KEY INSIGHT for demo: most negative feedback comes from 'enterprise' plan users
