import { NextRequest, NextResponse } from "next/server";
import Groq from "groq-sdk";
import { getCoralTools, callCoralTool } from "@/lib/coral";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are RAG Doctor — an AI observability agent.

You answer questions by running SQL through the Coral MCP server. Skip exploration; the schema is below.

AVAILABLE TABLES (use these directly — DO NOT call list_catalog or search_catalog unless the user asks about something outside this list):

langfuse:
  - traces (id, name, user_id, input, output, created_at)
  - observations (id, trace_id, name, type, model, total_tokens, start_time, end_time, latency)
  - scores (id, trace_id, name, value, comment)
  - sessions (id)
  - projects (id, name)

weaviate:
  - collections (name, description, vector_index_type, properties)
  - meta (version, hostname)
  - nodes (name, status, shards)

posthog (REQUIRES filters — see below):
  - events: needs WHERE environment_id = '${process.env.POSTHOG_PROJECT_ID}'
    columns: event, timestamp, distinct_id, properties
  - projects: needs WHERE organization_id = '...'
  - organizations (id, name)

datadog:
  - monitors, incidents, hosts, metric_names, services, slos

QUERY RULES:
- For PostHog events: always include WHERE environment_id = '${process.env.POSTHOG_PROJECT_ID}'
- For cross-source JOINs on Langfuse + PostHog: traces have id, PostHog events store the trace_id in properties->>'trace_id'
- Prefer one SQL query with JOIN over multiple separate queries
- Use only the sql tool. Use describe_table only if you genuinely need a column not listed above.

CORAL SQL DIALECT (critical — this is NOT Postgres):
- To read a JSON field use: json_get_str(properties, 'key')  — NOT ->>, NOT JSON_EXTRACT, NOT JSON_VALUE
- Example: json_get_str(e.properties, 'trace_id')
- These functions DO NOT exist: ->>, ->, to_jsonb, json_extract, json_value. Never use them.

KNOWN DATA FACTS:
- Langfuse trace IDs match the trace_id stored in PostHog event properties. Join with:
    JOIN langfuse.traces t ON json_get_str(e.properties, 'trace_id') = t.id
- User feedback: PostHog events named 'feedback_negative' and 'feedback_positive'. Also langfuse.scores has name='user-feedback' where value=1.0 means positive, value=0.0 means NEGATIVE (NOT value<0).
- PostHog event properties include: trace_id, question, plan ('free'|'pro'|'enterprise').

WORKING CROSS-SOURCE QUERY (negative feedback by plan):
  SELECT t.id AS trace_id, t.name, json_get_str(e.properties, 'plan') AS plan
  FROM posthog.events e
  JOIN langfuse.traces t ON json_get_str(e.properties, 'trace_id') = t.id
  WHERE e.environment_id = '${process.env.POSTHOG_PROJECT_ID}'
    AND e.event = 'feedback_negative';

After getting data, write a concise plain-English answer.`;

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export async function POST(req: NextRequest) {
  try {
    const { question } = await req.json();
    if (!question) {
      return NextResponse.json({ error: "Missing question" }, { status: 400 });
    }

    const coralTools = await getCoralTools();
    const ALLOWED_TOOLS = [
      "sql",
      "list_catalog",
      "search_catalog",
      "describe_table",
      "list_columns",
    ];
    const groqTools = coralTools
      .filter((t) => ALLOWED_TOOLS.includes(t.name))
      .map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: (t.description || "").slice(0, 500),
          parameters: t.inputSchema as Record<string, unknown>,
        },
      }));

    const messages: Groq.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: question },
    ];

    const toolCalls: ToolCall[] = [];
    let finalAnswer = "";

    for (let step = 0; step < 5; step++) {
      const completion = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages,
        tools: groqTools,
        tool_choice: "auto",
      });

      const message = completion.choices[0].message;
      messages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        finalAnswer = message.content || "";
        break;
      }

      for (const tc of message.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        let resultText = "";
        try {
          const result = await callCoralTool(tc.function.name, args);
          resultText = JSON.stringify(result.content);
        } catch (err) {
          resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        toolCalls.push({ name: tc.function.name, args, result: resultText });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultText,
        });
      }
    }
    if (!finalAnswer) {
      finalAnswer =
        "I ran several queries but could not synthesize a final answer within the step limit. Check the tool calls below for the raw results.";
    }
    return NextResponse.json({ answer: finalAnswer, toolCalls });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
