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

interface StreamHandlers {
  onTool: (tc: ToolCall) => void;
  onDone: (answer: string) => void;
  onError: (msg: string) => void;
  onStep?: (step: number) => void;
}

async function streamAgent(
  question: string,
  maxSteps: number,
  handlers: StreamHandlers,
) {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, stream: true, maxSteps }),
  });
  if (!res.ok || !res.body) {
    handlers.onError(`HTTP ${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      if (!part.trim()) continue;
      let event = '';
      let dataLine = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
      }
      if (!event || !dataLine) continue;
      try {
        const parsed = JSON.parse(dataLine);
        if (event === 'tool') handlers.onTool(parsed);
        else if (event === 'done') handlers.onDone(parsed.answer);
        else if (event === 'error') handlers.onError(parsed.message);
        else if (event === 'step') handlers.onStep?.(parsed.step);
      } catch {
        // skip malformed event
      }
    }
  }
}

function extractSql(tc: ToolCall): string {
  const a = tc.args as Record<string, unknown>;
  if (typeof a.query === 'string') return a.query;
  if (typeof a.sql === 'string') return a.sql;
  return JSON.stringify(a, null, 2);
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function ResultsTable({
  rows,
  highlightTopRow = false,
}: {
  rows: Row[];
  highlightTopRow?: boolean;
}) {
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
          {rows.map((row, i) => {
            const isTop = highlightTopRow && i === 0;
            const rowClass = isTop
              ? 'bg-red-950/40 border-b border-red-900/40 last:border-0'
              : 'border-b border-zinc-800/50 last:border-0';
            return (
              <tr key={i} className={rowClass}>
                {columns.map((c) => {
                  const isNumber = typeof row[c] === 'number';
                  const cellClass = isTop
                    ? isNumber
                      ? 'py-2 pr-4 font-mono text-red-300 font-bold'
                      : 'py-2 pr-4 font-mono text-red-300'
                    : 'py-2 pr-4 font-mono text-zinc-200';
                  return (
                    <td key={c} className={cellClass}>
                      {formatCell(row[c])}
                    </td>
                  );
                })}
              </tr>
            );
          })}
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
          {sqlCalls.map((tc, i) => (
            <pre
              key={i}
              className="bg-zinc-950 border border-zinc-800 p-3 rounded text-xs font-mono text-zinc-300 overflow-x-auto whitespace-pre-wrap"
            >
              {extractSql(tc)}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}

const INVESTIGATION_PROMPT = `You are diagnosing the health of a production RAG system. Run a thorough multi-step investigation: (1) Find how many negative-feedback events exist and which plans they come from. (2) Compute average user-feedback score per plan (enterprise/pro/free) by joining posthog.events, langfuse.traces, and langfuse.scores. (3) Compare average token count between positively and negatively rated calls. (4) Check for any Datadog incidents. Then write a clear 2-paragraph diagnosis: what is wrong, which user segment is most affected, and your best hypothesis for the root cause. Be specific with numbers.`;

function InvestigateSection() {
  const [running, setRunning] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [step, setStep] = useState(0);
  const [showSql, setShowSql] = useState(false);

  async function start() {
    setRunning(true);
    setToolCalls([]);
    setAnswer('');
    setError('');
    setStep(0);
    setShowSql(false);
    try {
      await streamAgent(INVESTIGATION_PROMPT, 8, {
        onTool: (tc) => setToolCalls((prev) => [...prev, tc]),
        onDone: (a) => {
          setAnswer(a);
          setRunning(false);
        },
        onError: (msg) => {
          setError(msg);
          setRunning(false);
        },
        onStep: (s) => setStep(s),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }

  return (
    <div className="mb-6">
      <button
        onClick={start}
        disabled={running}
        className="w-full px-6 py-4 rounded-md bg-blue-600 hover:bg-blue-500 disabled:bg-blue-700 disabled:cursor-wait font-semibold text-lg shadow-lg shadow-blue-600/20 transition"
      >
        {running
          ? `Investigating… (step ${step || 1})`
          : '🔍 Investigate my RAG stack'}
      </button>

      {running && (
        <div className="mt-4 p-4 rounded-md bg-zinc-900 border border-zinc-800 flex items-center gap-3">
          <span className="animate-pulse text-blue-400 text-lg leading-none">●</span>
          <span className="text-sm text-zinc-300">
            Running step {step || 1}
            {toolCalls.length > 0 ? ` · ${toolCalls.length} ${toolCalls.length === 1 ? 'query' : 'queries'} completed` : ''}
            …
          </span>
        </div>
      )}

      {error && (
        <div className="mt-4 p-4 rounded-md bg-red-950/40 border border-red-900/40 text-sm font-mono text-red-300">
          {error}
        </div>
      )}

      {answer && (
        <div className="mt-4 p-6 rounded-lg bg-gradient-to-br from-blue-950/30 via-zinc-900 to-zinc-900 border border-blue-700/40 shadow-xl shadow-blue-900/20">
          <div className="text-xs uppercase tracking-wider text-blue-400 mb-3 font-semibold">
            Diagnosis
          </div>
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-100">
            {answer}
          </div>
        </div>
      )}

      {toolCalls.length > 0 && !running && (
        <div className="mt-3 px-1">
          <button
            onClick={() => setShowSql(!showSql)}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            {showSql ? '▼' : '▶'} Show SQL ({toolCalls.length})
          </button>
          {showSql && (
            <div className="mt-2 space-y-3">
              {toolCalls.map((tc, i) => (
                <div key={i}>
                  <div className="text-xs text-zinc-500 mb-1">
                    #{i + 1} · {tc.name}
                  </div>
                  <pre className="bg-zinc-950 border border-zinc-800 p-3 rounded text-xs font-mono text-zinc-300 overflow-x-auto whitespace-pre-wrap">
                    {extractSql(tc)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SqlCard({
  title,
  subtitle,
  sql,
  highlightTopRow = false,
  insight,
  renderRows,
}: {
  title: string;
  subtitle: string;
  sql: string;
  highlightTopRow?: boolean;
  insight?: (rows: Row[]) => string | null;
  renderRows?: (rows: Row[]) => React.ReactNode;
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

  const insightText = rows && insight ? insight(rows) : null;

  return (
    <div className="p-5 rounded-md bg-zinc-900 border border-zinc-800 h-full flex flex-col">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
        <p className="text-xs text-zinc-500">{subtitle}</p>
      </div>
      <div className="flex-1">
        {loading && <div className="text-sm text-zinc-400">Querying…</div>}
        {error && <div className="text-sm font-mono text-red-300">{error}</div>}
        {rows &&
          (renderRows ? (
            renderRows(rows)
          ) : (
            <ResultsTable rows={rows} highlightTopRow={highlightTopRow} />
          ))}
        {insightText && (
          <div className="mt-3 text-sm text-red-300 font-medium">
            {insightText}
          </div>
        )}
      </div>
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
    <div className="p-5 rounded-md bg-zinc-900 border border-zinc-800 h-full flex flex-col">
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

const SECTIONS: Array<{
  title: string;
  subtitle: string;
  sql: string;
  highlightTopRow?: boolean;
  insight?: (rows: Row[]) => string | null;
  renderRows?: (rows: Row[]) => React.ReactNode;
}> = [
  {
    title: 'Retrieval health',
    subtitle: 'Vector index status',
    sql: "SELECT name, status, json_get_str(json_get(shards, 0), 'class') AS collection, json_get_int(json_get(shards, 0), 'objectCount') AS object_count, json_get_str(json_get(shards, 0), 'vectorIndexingStatus') AS index_status FROM weaviate.nodes",
    renderRows: (rows) => {
      const r = rows[0];
      if (!r) return <div className="text-sm text-zinc-400">No data.</div>;
      const isHealthy = String(r.status ?? '').toUpperCase() === 'HEALTHY';
      const fields: Array<{ label: string; key: keyof typeof r; healthy?: boolean }> = [
        { label: 'Collection', key: 'collection' },
        { label: 'Objects', key: 'object_count' },
        { label: 'Status', key: 'status', healthy: true },
        { label: 'Indexing', key: 'index_status' },
      ];
      return (
        <dl className="text-sm space-y-3">
          {fields.map((f) => {
            const value = r[f.key];
            const display = value === null || value === undefined ? '—' : String(value);
            const valueClass =
              f.healthy && isHealthy
                ? 'font-mono text-green-400'
                : 'font-mono text-zinc-200';
            return (
              <div key={f.label} className="flex justify-between gap-4">
                <dt className="text-zinc-500">{f.label}</dt>
                <dd className={valueClass}>
                  {display}
                  {f.healthy && isHealthy ? ' ✅' : ''}
                </dd>
              </div>
            );
          })}
        </dl>
      );
    },
  },
  {
    title: 'LLM performance',
    subtitle: 'Models and token usage from Langfuse',
    sql: "SELECT model, COUNT(*) AS calls, SUM(total_tokens) AS total_tokens FROM langfuse.observations WHERE type = 'GENERATION' GROUP BY model",
  },
  {
    title: 'Negative feedback by plan',
    subtitle: 'PostHog ↔ Langfuse cross-source JOIN',
    sql: "SELECT json_get_str(e.properties, 'plan') AS plan, COUNT(*) AS negative_count FROM posthog.events e JOIN langfuse.traces t ON json_get_str(e.properties, 'trace_id') = t.id WHERE e.environment_id = '440785' AND e.event = 'feedback_negative' GROUP BY json_get_str(e.properties, 'plan') ORDER BY negative_count DESC",
    highlightTopRow: true,
    insight: (rows) => {
      const top = rows[0]?.plan;
      if (top === undefined || top === null) return null;
      const s = String(top);
      const cap = s.charAt(0).toUpperCase() + s.slice(1);
      return `⚠️ ${cap} users report the most failures`;
    },
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-semibold mb-2">RAG Doctor</h1>
        <p className="text-zinc-400 mb-8">AI observability agent powered by Coral</p>

        <InvestigateSection />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {SECTIONS.map((s) => (
            <SqlCard
              key={s.title}
              title={s.title}
              subtitle={s.subtitle}
              sql={s.sql}
              highlightTopRow={s.highlightTopRow}
              insight={s.insight}
              renderRows={s.renderRows}
            />
          ))}
          <AskAnythingCard />
        </div>
      </div>
    </main>
  );
}
