import { useEffect, useMemo, useState } from 'react';
import type { Filters } from '@gw/shared';
import { clearKey, fetchModels, loadKey, saveKey } from './api';
import { useLogFeed } from './useLogFeed';
import { DetailDrawer } from './components/DetailDrawer';
import { FilterBar } from './components/FilterBar';
import { LogTable } from './components/LogTable';
import { Login } from './components/Login';
import { StatsBar } from './components/StatsBar';

/** Filters live in the query string, so a filtered view is a shareable link. */
function readFilters(): Filters {
  const p = new URLSearchParams(location.search);
  const list = (k: string) => p.get(k)?.split(',').filter(Boolean);
  return {
    methods: list('methods'),
    statusClasses: list('status'),
    terminalStates: list('states'),
    models: list('models'),
    q: p.get('q') ?? undefined,
  };
}

function writeFilters(filters: Filters) {
  const p = new URLSearchParams();
  if (filters.methods?.length) p.set('methods', filters.methods.join(','));
  if (filters.statusClasses?.length) p.set('status', filters.statusClasses.join(','));
  if (filters.terminalStates?.length) p.set('states', filters.terminalStates.join(','));
  if (filters.models?.length) p.set('models', filters.models.join(','));
  if (filters.q) p.set('q', filters.q);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

export function App() {
  const [apiKey, setApiKey] = useState<string | null>(loadKey);
  const [keyName, setKeyName] = useState<string>('');

  if (!apiKey) {
    return (
      <Login
        onSignedIn={(key, name) => {
          saveKey(key);
          setApiKey(key);
          setKeyName(name);
        }}
      />
    );
  }

  return (
    <Dashboard
      apiKey={apiKey}
      keyName={keyName}
      onSignOut={() => {
        clearKey();
        setApiKey(null);
      }}
    />
  );
}

function Dashboard({
  apiKey,
  keyName,
  onSignOut,
}: {
  apiKey: string;
  keyName: string;
  onSignOut: () => void;
}) {
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [paused, setPaused] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);

  const { rows, loading, connection, loadMore, hasMore, pendingCount } = useLogFeed(
    apiKey,
    filters,
    paused,
  );

  useEffect(() => writeFilters(filters), [JSON.stringify(filters)]);

  useEffect(() => {
    fetchModels(apiKey)
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
  }, [apiKey, rows.length === 0]);

  // Cheap way to refresh the tiles as traffic arrives without polling hard.
  const statsToken = useMemo(() => Math.floor(rows.length / 5), [rows.length]);

  return (
    <div className={`app ${selectedId ? 'with-drawer' : ''}`}>
      <header className="top">
        <span className="brand">LLM Gateway</span>
        <StatsBar apiKey={apiKey} refreshToken={statsToken} />
        <div className="spacer" />
        <span className="muted small">{keyName}</span>
        <button className="link" onClick={onSignOut}>
          sign out
        </button>
      </header>

      <FilterBar
        filters={filters}
        onChange={setFilters}
        models={models}
        paused={paused}
        onTogglePause={() => setPaused((p) => !p)}
        pendingCount={pendingCount}
        connection={connection}
      />

      <main>
        <LogTable
          rows={rows}
          loading={loading}
          selectedId={selectedId}
          onSelect={setSelectedId}
          hasMore={hasMore}
          onLoadMore={loadMore}
        />
      </main>

      {selectedId && (
        <DetailDrawer apiKey={apiKey} id={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
