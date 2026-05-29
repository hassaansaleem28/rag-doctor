import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { getCoralTools, callCoralTool } from "@/lib/coral";

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

interface AgentResult {
  answer: string;
  toolCalls: ToolCall[];
}

const answerCache = new Map<string, AgentResult>();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT = `You are RAG Doctor — an AI observability agent.

You answer questions by running SQL through the Coral MCP server. Skip exploration; the schema is below.

AVAILABLE TABLES (use directly — do NOT call list_catalog/search_catalog unless asked about something outside this list):

langfuse:
  - traces (id, name, user_id, input, output, created_at)
  - observations (id, trace_id, name, type, model, total_tokens, start_time, end_time, latency)
  - scores (id, trace_id, name, value, comment)
  - projects (id, name)

weaviate:
  - collections (name, description, vector_index_type, properties)
  - meta, nodes

posthog:
  - events: REQUIRES WHERE environment_id = '${process.env.POSTHOG_PROJECT_ID}'. columns: event, timestamp, distinct_id, properties
  - organizations (id, name)

datadog:
  - monitors, incidents, hosts, metric_names, services, slos

CORAL SQL DIALECT (this is NOT Postgres):
- JSON access: json_get_str(properties, 'key') — NOT ->>, NOT JSON_EXTRACT, NOT JSON_VALUE, NOT to_jsonb. Those functions do not exist.

KNOWN DATA FACTS:
- Langfuse trace.id == the trace_id stored in PostHog event properties. Join with:
    JOIN langfuse.traces t ON json_get_str(e.properties, 'trace_id') = t.id
- Feedback: PostHog events 'feedback_negative' / 'feedback_positive'. langfuse.scores name='user-feedback', value=1.0 positive, value=0.0 NEGATIVE (not <0).
- PostHog event properties include: trace_id, question, plan ('free'|'pro'|'enterprise').

WORKING CROSS-SOURCE QUERY (negative feedback by plan):
  SELECT t.id AS trace_id, t.name, json_get_str(e.properties, 'plan') AS plan
  FROM posthog.events e
  JOIN langfuse.traces t ON json_get_str(e.properties, 'trace_id') = t.id
  WHERE e.environment_id = '${process.env.POSTHOG_PROJECT_ID}'
    AND e.event = 'feedback_negative';

RULES:
- Prefer ONE sql query with a JOIN over multiple separate queries.
- Always include the PostHog environment_id filter when querying posthog.events.
- After getting data, write a concise plain-English answer.`;

const ALLOWED_TOOLS = [
  "sql",
  "list_catalog",
  "search_catalog",
  "describe_table",
  "list_columns",
];

async function getFunctionDeclarations() {
  const coralTools = await getCoralTools();
  return coralTools
    .filter((t) => ALLOWED_TOOLS.includes(t.name))
    .map((t) => ({
      name: t.name,
      description: (t.description || "").slice(0, 500),
      parametersJsonSchema: t.inputSchema as Record<string, unknown>,
    }));
}

async function runAgentLoop(
  question: string,
  maxSteps: number,
  onTool?: (tc: ToolCall) => void,
  onStep?: (step: number) => void,
): Promise<AgentResult> {
  const functionDeclarations = await getFunctionDeclarations();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contents: any[] = [{ role: "user", parts: [{ text: question }] }];
  const toolCalls: ToolCall[] = [];
  let finalAnswer = "";

  for (let step = 0; step < maxSteps; step++) {
    onStep?.(step + 1);

    let response;
    let attempts = 0;
    while (true) {
      try {
        response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            tools: [{ functionDeclarations }],
          },
        });
        break;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        attempts++;
        if (e?.status === 429 && attempts < 4) {
          await new Promise((r) => setTimeout(r, 12000));
          continue;
        }
        throw e;
      }
    }

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fnCalls = parts.filter((p: any) => p.functionCall);

    if (fnCalls.length === 0) {
      finalAnswer = response.text || "";
      break;
    }

    contents.push({ role: "model", parts });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const responseParts: any[] = [];
    for (const part of fnCalls) {
      const fc = part.functionCall;
      const args = fc.args || {};
      let resultText = "";
      try {
        const result = await callCoralTool(fc.name, args);
        resultText = JSON.stringify(result.content);
      } catch (err) {
        resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      const toolCall: ToolCall = { name: fc.name, args, result: resultText };
      toolCalls.push(toolCall);
      onTool?.(toolCall);
      responseParts.push({
        functionResponse: { name: fc.name, response: { result: resultText } },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  if (!finalAnswer) {
    finalAnswer =
      "I ran several queries but could not synthesize a final answer within the step limit. Check the tool calls below.";
  }
  return { answer: finalAnswer, toolCalls };
}

export async function POST(req: NextRequest) {
  try {
    const { question, stream = false, maxSteps = 5 } = await req.json();
    if (!question) {
      return NextResponse.json({ error: "Missing question" }, { status: 400 });
    }
    if (stream) {
      return streamingResponse(question, maxSteps);
    }

    const cached = answerCache.get(question);
    if (cached) {
      return NextResponse.json(cached);
    }
    const result = await runAgentLoop(question, maxSteps);
    answerCache.set(question, result);
    return NextResponse.json(result);
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

function streamingResponse(question: string, maxSteps: number) {
  const encoder = new TextEncoder();
  const sseStream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      try {
        const cached = answerCache.get(question);
        if (cached) {
          for (const tc of cached.toolCalls) send("tool", tc);
          send("done", { answer: cached.answer, cached: true });
          controller.close();
          return;
        }

        const result = await runAgentLoop(
          question,
          maxSteps,
          (tc) => send("tool", tc),
          (step) => send("step", { step }),
        );
        answerCache.set(question, result);
        send("done", { answer: result.answer });
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
