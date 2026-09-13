import { useEffect, useState } from 'react';
import type { Stats } from '@gw/shared';
import { fetchStats } from '../api';

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function StatsBar({ apiKey, refreshToken }: { apiKey: string; refreshToken: number }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetchStats(apiKey)
      .then(setStats)
      .catch(() => setStats(null));
  }, [apiKey, refreshToken]);

  const errorRate = stats && stats.total > 0 ? (stats.errors / stats.total) * 100 : 0;

  return (
    <div className="stats">
      <Tile label="requests / hr" value={stats ? fmt(stats.total) : '—'} />
      <Tile
        label="not completed"
        value={stats ? `${errorRate.toFixed(1)}%` : '—'}
        tone={errorRate > 5 ? 'bad' : undefined}
      />
      <Tile label="p50" value={stats ? `${stats.p50} ms` : '—'} />
      <Tile label="p95" value={stats ? `${stats.p95} ms` : '—'} />
      <Tile
        label="tokens in / out"
        value={stats ? `${fmt(stats.promptTokens)} / ${fmt(stats.completionTokens)}` : '—'}
      />
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className={`tile-value mono ${tone ?? ''}`}>{value}</div>
    </div>
  );
}
