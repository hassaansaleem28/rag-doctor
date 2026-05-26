import { NextRequest, NextResponse } from 'next/server';
import Groq from 'groq-sdk';
import { getCoralTools, callCoralTool } from '@/lib/coral';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are RAG Doctor — an AI observability agent.

You help engineers diagnose problems with RAG systems by querying their stack via SQL.

You have access to these data sources through the Coral MCP server:
- langfuse: LLM call traces, observations (with latency, tokens, model), scores, sessions
- weaviate: vector database collections, metadata, node health
- posthog: user events, feedback, sessions. NOTE: posthog.events and posthog.projects REQUIRE a WHERE filter on environment_id = '${process.env.POSTHOG_PROJECT_ID}'. posthog.projects requires WHERE organization_id filter.
- datadog: infrastructure metrics, monitors, incidents, hosts

When the user asks a question:
1. Use list_catalog or search_catalog to find relevant tables if unsure
2. Use describe_table to understand a table's columns before querying it
3. Use the sql tool to run queries
4. Prefer cross-source JOINs when the question spans multiple systems
5. After getting data, write a clear answer in plain English

Always show what tables you used. Keep answers concise.`;

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export async function POST(req: NextRequest) {
  try {
    const { question } = await req.json();
    if (!question) {
      return NextResponse.json({ error: 'Missing question' }, { status: 400 });
    }

    const coralTools = await getCoralTools();
    const groqTools = coralTools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));

    const messages: Groq.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: question },
    ];

    const toolCalls: ToolCall[] = [];
    let finalAnswer = '';

    for (let step = 0; step < 8; step++) {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        tools: groqTools,
        tool_choice: 'auto',
      });

      const message = completion.choices[0].message;
      messages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        finalAnswer = message.content || '';
        break;
      }

      for (const tc of message.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        let resultText = '';
        try {
          const result = await callCoralTool(tc.function.name, args);
          resultText = JSON.stringify(result.content);
        } catch (err) {
          resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        toolCalls.push({ name: tc.function.name, args, result: resultText });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultText,
        });
      }
    }

    return NextResponse.json({ answer: finalAnswer, toolCalls });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

