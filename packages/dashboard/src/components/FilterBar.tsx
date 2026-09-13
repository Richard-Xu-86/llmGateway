import type { Filters } from '@gw/shared';

const METHODS = ['POST', 'GET'];
const STATUS_CLASSES = ['2xx', '4xx', '5xx'];
const STATES = [
  { id: 'completed', label: 'completed' },
  { id: 'upstream_error', label: 'upstream error' },
  { id: 'client_aborted', label: 'aborted' },
  { id: 'truncated', label: 'truncated' },
];

export function FilterBar({
  filters,
  onChange,
  models,
  paused,
  onTogglePause,
  pendingCount,
  connection,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  models: string[];
  paused: boolean;
  onTogglePause: () => void;
  pendingCount: number;
  connection: string;
}) {
  const toggle = (field: keyof Filters, value: string) => {
    const current = (filters[field] as string[] | undefined) ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange({ ...filters, [field]: next.length ? next : undefined });
  };

  const active = (field: keyof Filters, value: string) =>
    ((filters[field] as string[] | undefined) ?? []).includes(value);

  return (
    <div className="filters">
      <input
        className="search mono"
        placeholder="filter by URL substring…"
        value={filters.q ?? ''}
        onChange={(e) => onChange({ ...filters, q: e.target.value || undefined })}
      />

      <Group>
        {METHODS.map((m) => (
          <Chip key={m} active={active('methods', m)} onClick={() => toggle('methods', m)}>
            {m}
          </Chip>
        ))}
      </Group>

      <Group>
        {STATUS_CLASSES.map((s) => (
          <Chip
            key={s}
            active={active('statusClasses', s)}
            onClick={() => toggle('statusClasses', s)}
            tone={s === '2xx' ? 'ok' : s === '4xx' ? 'warn' : 'bad'}
          >
            {s}
          </Chip>
        ))}
      </Group>

      <Group>
        {STATES.map((s) => (
          <Chip
            key={s.id}
            active={active('terminalStates', s.id)}
            onClick={() => toggle('terminalStates', s.id)}
          >
            {s.label}
          </Chip>
        ))}
      </Group>

      {models.length > 0 && (
        <Group>
          {models.map((m) => (
            <Chip key={m} active={active('models', m)} onClick={() => toggle('models', m)}>
              {m}
            </Chip>
          ))}
        </Group>
      )}

      <div className="spacer" />

      <button className={`pause ${paused ? 'on' : ''}`} onClick={onTogglePause}>
        {paused ? `Resume${pendingCount ? ` (${pendingCount})` : ''}` : 'Pause'}
      </button>
      <span className={`conn ${connection}`} title={`stream ${connection}`} />
    </div>
  );
}

const Group = ({ children }: { children: React.ReactNode }) => (
  <div className="chip-group">{children}</div>
);

function Chip({
  active,
  onClick,
  children,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <button className={`chip ${active ? 'active' : ''} ${tone ?? ''}`} onClick={onClick}>
      {children}
    </button>
  );
}
