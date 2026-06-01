# RAG Doctor

> An AI observability agent that diagnoses production RAG stacks in plain English. Built on **Coral**, the MCP server that gives you one SQL surface over Langfuse, Weaviate, PostHog, and Datadog.

![dashboard](docs/screenshot.png)

---

## The problem

Teams running production RAG have observability data scattered across at least four tools:

- **Langfuse** — LLM traces, prompts, outputs, token spend
- **Weaviate** — vector store, retrieval quality
- **PostHog** — product events, user feedback, segmentation
- **Datadog** — infra latency, incidents, SLOs

Answering even a basic operational question like *"which user segment is most unhappy, and is it correlated with a specific model or retrieval failure?"* means jumping between four dashboards, copying IDs by hand, and stitching results in a spreadsheet. There is no single pane of glass, and the data shapes do not naturally JOIN.

## The fix

RAG Doctor uses **Coral** as a single MCP gateway over all four backends. Coral exposes a unified SQL surface — you write `SELECT ... FROM langfuse.traces JOIN posthog.events ...` and Coral translates the call to whatever each source needs.

The app has two complementary modes:

1. **Dashboard** — three cards run hardcoded cross-source SQL on page load. Direct queries to Coral, no LLM in the loop. Fast and free.
2. **Investigate** — a single button hands Coral's MCP tools to a Gemini agent. The agent decomposes a diagnostic question into multiple queries, runs them through Coral, and writes a two-paragraph root-cause analysis.

## Architecture

```
┌──────────────────┐
│   Next.js app    │
│   (page.tsx)     │
└────────┬─────────┘
         │
   ┌─────┴──────┐
   │            │
┌──▼─────┐  ┌───▼──────┐
│/api/   │  │/api/sql  │
│agent   │  └───┬──────┘
└──┬─────┘      │
   │ Gemini     │ direct
   │ tool-call  │ SQL
   │ loop       │
   ▼            ▼
 ┌──────────────────────┐
 │   lib/coral.ts       │
 │   MCP stdio client   │
 └──────────┬───────────┘
            │ coral mcp-stdio
            ▼
 ┌──────────────────────┐
 │        Coral         │
 └──┬─────┬─────┬───┬───┘
    ▼     ▼     ▼   ▼
 Langfuse Weaviate PostHog Datadog
```

### How Coral is wired in

[`lib/coral.ts`](rag-doctor/lib/coral.ts) spawns `coral mcp-stdio` as a subprocess via the official `@modelcontextprotocol/sdk` `StdioClientTransport`, then caches the client process-wide so both routes share one connection.

- [`/api/sql`](rag-doctor/app/api/sql/route.ts) is a thin pass-through. Accepts `{ sql }`, calls Coral's `sql` MCP tool, returns rows. Used by the dashboard cards.
- [`/api/agent`](rag-doctor/app/api/agent/route.ts) runs a tool-calling loop against Gemini 2.5 Flash, with Coral's MCP tools (`sql`, `list_catalog`, `search_catalog`, `describe_table`, `list_columns`) exposed as function declarations. Supports both JSON and SSE streaming responses, plus in-memory result caching.

The "negative feedback by plan" card is the showcase JOIN:

```sql
SELECT json_get_str(e.properties, 'plan') AS plan,
       COUNT(*) AS negative_count
FROM posthog.events e
JOIN langfuse.traces t
  ON json_get_str(e.properties, 'trace_id') = t.id
WHERE e.environment_id = '<your_posthog_env_id>'
  AND e.event = 'feedback_negative'
GROUP BY json_get_str(e.properties, 'plan')
ORDER BY negative_count DESC;
```

PostHog and Langfuse in one query, joined via a JSON property. Without Coral this needs two SDKs and manual ID stitching.

## Tech stack

- **Next.js 16** with React 19 (App Router)
- **TypeScript 5**, **Tailwind CSS 4**
- **Coral** as the MCP data plane
- **`@modelcontextprotocol/sdk`** v1.29 for the MCP client
- **Google GenAI SDK** with **Gemini 2.5 Flash** for the agent
- **Server-Sent Events** to stream live progress during investigations
- **Groq SDK** (alternate provider, used only by the demo seeder)

## Repo layout

```
coral-hackathon/
├── rag-doctor/                  # the Next.js app
│   ├── app/
│   │   ├── api/
│   │   │   ├── agent/route.ts   # LLM agent loop, SSE streaming, cache
│   │   │   └── sql/route.ts     # direct SQL pass-through
│   │   ├── page.tsx             # 4-card dashboard + Investigate button
│   │   └── layout.tsx
│   ├── lib/coral.ts             # MCP client (stdio transport)
│   └── package.json
└── demo-data/                   # one-shot seeder (optional)
    └── seed.mjs                 # creates Weaviate Docs collection,
                                 # generates 30 fake RAG calls,
                                 # emits Langfuse traces + PostHog events
```

## Setup

### 1. Install Coral

Follow the Coral CLI install guide. Verify:

```bash
coral --version
```

### 2. Clone

```bash
git clone https://github.com/<you>/coral-hackathon.git
cd coral-hackathon/rag-doctor
npm install
```

### 3. Configure Coral

Coral needs credentials for each backend (Langfuse, Weaviate, PostHog, Datadog). Configure them per the Coral docs so `coral mcp-stdio` exposes the four data sources used by this app.

### 4. Environment variables

Create `rag-doctor/.env.local`:

```bash
GEMINI_API_KEY=             # https://aistudio.google.com/apikey
POSTHOG_PROJECT_ID=         # your PostHog environment_id
LANGFUSE_PROJECT_ID=        # your Langfuse project id
```

(Optional, only if you want to re-seed demo data.) Create `demo-data/.env`:

```bash
GROQ_API_KEY=
WEAVIATE_URL=
WEAVIATE_API_KEY=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=https://cloud.langfuse.com
POSTHOG_API_KEY=
POSTHOG_HOST=https://us.i.posthog.com
```

### 5. Seed demo data (optional)

If you are starting from empty backends:

```bash
cd ../demo-data
npm install
node seed.mjs
```

The seeder creates a `Docs` collection in Weaviate, runs 30 fake RAG calls through Groq, traces them in Langfuse, and emits feedback events to PostHog. Negative feedback is biased toward rate-limit and refund questions, which creates the *"enterprise users are unhappy"* anomaly the agent finds during the investigation.

### 6. Run

```bash
cd ../rag-doctor
npm run dev
```

Open http://localhost:3000.

## Using it

### Dashboard cards

Three cards auto-load on page mount:

| Card | Source | What it shows |
|------|--------|---------------|
| **Retrieval health** | `weaviate.nodes` | Cluster status, collection name, object count, indexing state |
| **LLM performance** | `langfuse.observations` | Token spend grouped by model |
| **Negative feedback by plan** | `posthog.events` ⋈ `langfuse.traces` | Negative feedback count per plan, top row highlighted, dynamic insight caption |

Each card has a *Show SQL* toggle so you can read the raw query.

### Investigate

Click **🔍 Investigate my RAG stack**. The Gemini agent runs a four-step diagnostic plan:

1. Count negative-feedback events by plan
2. Average feedback score per plan (PostHog × Langfuse × Scores)
3. Compare token usage between thumbs-up and thumbs-down calls
4. Check Datadog incidents

It then writes a two-paragraph diagnosis. Progress is streamed over SSE, so you see *"Running step 3..."* updates live. After the diagnosis renders, expand *Show SQL* to see every query the agent wrote.

Results are cached in-memory per question, so re-running the same investigation is instant.

### Ask anything

Free-form box at the bottom of the dashboard. Goes through `/api/agent` in non-streaming JSON mode. Use it for one-off questions the dashboard cards do not cover, e.g. *"which user got the most negative feedback?"*.

## Coral SQL dialect notes

A few syntax differences from Postgres worth knowing:

- JSON access uses `json_get_str(col, 'key')` and `json_get_int(col, 'key')`. Postgres operators (`->>`, `->`), `JSON_EXTRACT`, `JSON_VALUE`, and `to_jsonb` do **not** exist.
- For array-typed JSON (like Weaviate's `shards`), index with `json_get(col, 0)`.
- PostHog event queries always require `WHERE environment_id = '<your_id>'`.
- Negative feedback in `langfuse.scores` is `value = 0.0` (not `< 0`); positive is `1.0`.

The full set of facts the agent relies on is in the [system prompt](rag-doctor/app/api/agent/route.ts).

## Known limitations

- **No Vercel deploy yet.** Coral runs as a local subprocess via stdio, which Vercel's serverless runtime cannot host. To deploy, run Coral on a separate VPS and add a network-MCP transport.
- **In-memory cache.** `answerCache` and the cached MCP client live in the Node process; restart wipes them.
- **No auth on the API routes.** Both `/api/sql` and `/api/agent` are open. Do not expose without an auth layer.
- **LLM rate limits.** Gemini's free tier is 5 req/min. The investigate cache softens this, but back-to-back fresh investigations will 429. Already wired with a 12-second retry on 429.
- **Datadog source not seeded.** The agent treats it as available but there is no fake data in this repo, so step 4 of the investigation will often return zero rows.

## Future work

- Network MCP transport so the app can deploy on Vercel or Render
- Streaming LLM tokens (not just step events) for a smoother investigate UI
- Persist `answerCache` to Redis so cached investigations survive restarts
- Slack/email digest of the investigate output
- Real Datadog seed data

## Built for

The Coral Hackathon. Thanks to the Coral team for making cross-source SQL feel boring.
