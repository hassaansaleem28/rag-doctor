'use client';

import { useState } from 'react';

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export default function Home() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function ask() {
    if (!question.trim()) return;
    setLoading(true);
    setError('');
    setAnswer('');
    setToolCalls([]);

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setAnswer(data.answer);
      setToolCalls(data.toolCalls || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const examples = [
    'How many traces are in Langfuse?',
    'What collections exist in Weaviate?',
    'Show me the latest 3 negative feedback events from PostHog',
    'What models have been used in Langfuse, and how many tokens did each use?',
  ];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-semibold mb-2">RAG Doctor</h1>
        <p className="text-zinc-400 mb-8">AI observability agent powered by Coral</p>

        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !loading && ask()}
            placeholder="Ask about your RAG stack..."
            className="flex-1 px-4 py-2 rounded-md bg-zinc-900 border border-zinc-800 focus:outline-none focus:border-zinc-600"
            disabled={loading}
          />
          <button
            onClick={ask}
            disabled={loading || !question.trim()}
            className="px-5 py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            {loading ? 'Thinking...' : 'Ask'}
          </button>
        </div>

        <div className="flex flex-wrap gap-2 mb-8">
          {examples.map((ex) => (
            <button
              key={ex}
              onClick={() => setQuestion(ex)}
              className="text-xs px-3 py-1 rounded-full bg-zinc-900 border border-zinc-800 hover:border-zinc-600 text-zinc-300"
            >
              {ex}
            </button>
          ))}
        </div>

        {error && (
          <div className="p-4 mb-4 rounded-md bg-red-950 border border-red-900 text-red-200">
            <div className="font-medium mb-1">Error</div>
            <div className="text-sm font-mono">{error}</div>
          </div>
        )}

        {answer && (
          <div className="p-4 mb-4 rounded-md bg-zinc-900 border border-zinc-800">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Answer</div>
            <div className="whitespace-pre-wrap">{answer}</div>
          </div>
        )}

        {toolCalls.length > 0 && (
          <div className="p-4 rounded-md bg-zinc-900 border border-zinc-800">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
              Tool calls ({toolCalls.length})
            </div>
            {toolCalls.map((tc, i) => (
              <details key={i} className="mb-2 last:mb-0">
                <summary className="cursor-pointer text-sm font-mono text-blue-300 hover:text-blue-200">
                  {i + 1}. {tc.name}
                </summary>
                <div className="mt-2 ml-4 text-xs font-mono">
                  <div className="text-zinc-500 mb-1">Arguments:</div>
                  <pre className="bg-zinc-950 p-2 rounded overflow-x-auto">
                    {JSON.stringify(tc.args, null, 2)}
                  </pre>
                  <div className="text-zinc-500 mt-2 mb-1">Result:</div>
                  <pre className="bg-zinc-950 p-2 rounded overflow-x-auto max-h-60">
                    {tc.result}
                  </pre>
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}