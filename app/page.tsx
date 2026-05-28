'use client';

import { useEffect, useState } from 'react';

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

interface AgentResponse {
  answer: string;
  toolCalls: ToolCall[];
}

type Row = Record<string, unknown>;

async function runSql(sql: string): Promise<Row[]> {
  const res = await fetch('/api/sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return (data.rows || []) as Row[];
}

async function askAgent(question: string): Promise<AgentResponse> {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function ResultsTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return <div className="text-sm text-zinc-400">No rows.</div>;
  }
  const columns = Object.keys(rows[0]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
            {columns.map((c) => (
              <th key={c} className="py-2 pr-4 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-zinc-800/50 last:border-0">
              {columns.map((c) => (
                <td key={c} className="py-2 pr-4 text-zinc-200 font-mono">
                  {formatCell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SqlToggle({ sql }: { sql: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-zinc-400 hover:text-zinc-200"
      >
        {open ? '▼' : '▶'} Show SQL
      </button>
      {open && (
        <pre className="mt-2 bg-zinc-950 border border-zinc-800 p-3 rounded text-xs font-mono text-zinc-300 overflow-x-auto whitespace-pre-wrap">
          {sql}
        </pre>
      )}
    </div>
  );
}

function AgentSqlToggle({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  const sqlCalls = toolCalls.filter((t) => t.name === 'sql');
  if (sqlCalls.length === 0) return null;
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-zinc-400 hover:text-zinc-200"
      >
        {open ? '▼' : '▶'} Show SQL ({sqlCalls.length})
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {sqlCalls.map((tc, i) => {
            const a = tc.args as Record<string, unknown>;
            const text =
              typeof a.query === 'string'
                ? a.query
                : typeof a.sql === 'string'
                ? a.sql
                : JSON.stringify(a, null, 2);
            return (
              <pre
                key={i}
                className="bg-zinc-950 border border-zinc-800 p-3 rounded text-xs font-mono text-zinc-300 overflow-x-auto whitespace-pre-wrap"
              >
                {text}
              </pre>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SqlCard({
  title,
  subtitle,
  sql,
}: {
  title: string;
  subtitle: string;
  sql: string;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    runSql(sql)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sql]);

  return (
    <div className="p-5 rounded-md bg-zinc-900 border border-zinc-800">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
        <p className="text-xs text-zinc-500">{subtitle}</p>
      </div>
      {loading && <div className="text-sm text-zinc-400">Querying…</div>}
      {error && <div className="text-sm font-mono text-red-300">{error}</div>}
      {rows && <ResultsTable rows={rows} />}
      <SqlToggle sql={sql} />
    </div>
  );
}

function AskAnythingCard() {
  const [question, setQuestion] = useState('');
  const [data, setData] = useState<AgentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function ask() {
    if (!question.trim()) return;
    setLoading(true);
    setError('');
    setData(null);
    try {
      setData(await askAgent(question));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-5 rounded-md bg-zinc-900 border border-zinc-800">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-zinc-100">Ask anything</h2>
        <p className="text-xs text-zinc-500">Free-form question across the whole stack</p>
      </div>
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !loading && ask()}
          placeholder="e.g. which question gets the most thumbs down?"
          className="flex-1 px-3 py-2 text-sm rounded-md bg-zinc-950 border border-zinc-800 focus:outline-none focus:border-zinc-600"
          disabled={loading}
        />
        <button
          onClick={ask}
          disabled={loading || !question.trim()}
          className="px-4 py-2 text-sm rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
        >
          {loading ? '…' : 'Ask'}
        </button>
      </div>
      {error && <div className="text-sm font-mono text-red-300">{error}</div>}
      {data && (
        <>
          <div className="whitespace-pre-wrap text-sm text-zinc-200">{data.answer}</div>
          <AgentSqlToggle toolCalls={data.toolCalls} />
        </>
      )}
    </div>
  );
}

const SECTIONS = [
  {
    title: 'Retrieval health',
    subtitle: 'Weaviate collections',
    sql: 'SELECT name, vector_index_type FROM weaviate.collections',
  },
  {
    title: 'LLM performance',
    subtitle: 'Models and token usage from Langfuse',
    sql: "SELECT model, COUNT(*) AS calls, SUM(total_tokens) AS total_tokens FROM langfuse.observations WHERE type = 'GENERATION' GROUP BY model",
  },
  {
    title: 'Negative feedback by plan',
    subtitle: 'PostHog ↔ Langfuse cross-source JOIN',
    sql: "SELECT json_get_str(e.properties, 'plan') AS plan, COUNT(*) AS negative_count FROM posthog.events e JOIN langfuse.traces t ON json_get_str(e.properties, 'trace_id') = t.id WHERE e.environment_id = '440785' AND e.event = 'feedback_negative' GROUP BY json_get_str(e.properties, 'plan')",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-semibold mb-2">RAG Doctor</h1>
        <p className="text-zinc-400 mb-8">AI observability agent powered by Coral</p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {SECTIONS.map((s) => (
            <SqlCard
              key={s.title}
              title={s.title}
              subtitle={s.subtitle}
              sql={s.sql}
            />
          ))}
          <AskAnythingCard />
        </div>
      </div>
    </main>
  );
}
