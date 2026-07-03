'use client';
import { useEffect, useState } from 'react';

interface Props {
  activeLayers: Record<string, boolean>;
  layerTimestamps: Record<string, number>;
}

const LAYER_LABELS: Record<string, string> = {
  air_raids:       'AIR RAIDS',
  flights:         'FLIGHTS',
  kab_threats:     'KAB',
  drone_threats:   'DRONES',
  missile_threats: 'MISSILES',
  weapon_threats:  'WPNS',
  captures:        'CAPTURES',
  frontlines:      'FRONTLINE',
};

// layers where >5 min is stale; everything else uses 15 min
const FAST_LAYERS = new Set(['air_raids', 'kab_threats', 'drone_threats', 'missile_threats', 'weapon_threats']);

export default function LayerFreshness({ activeLayers, layerTimestamps }: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(iv);
  }, []);

  const entries = Object.entries(LAYER_LABELS)
    .filter(([key]) => activeLayers[key] && layerTimestamps[key])
    .map(([key, label]) => {
      const ageMs = now - layerTimestamps[key];
      const ageMins = Math.floor(ageMs / 60_000);
      const staleThresh = FAST_LAYERS.has(key) ? 5 : 15;
      const isStale = ageMins > staleThresh;
      return { key, label, ageMins, isStale };
    });

  if (entries.length === 0) return null;

  return (
    <div className="absolute bottom-6 left-[320px] z-[150] flex flex-col gap-0.5 pointer-events-none">
      {entries.map(({ key, label, ageMins, isStale }) => (
        <div
          key={key}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono bg-black/70 border border-white/10 backdrop-blur-sm"
        >
          <span
            className={`w-1 h-1 rounded-full flex-shrink-0 ${isStale ? 'bg-red-500' : 'bg-[var(--alert-green)]'}`}
          />
          <span className="text-white/50">{label}</span>
          <span className={isStale ? 'text-red-400 font-bold' : 'text-white/70'}>
            {ageMins === 0 ? '<1m' : `${ageMins}m`}{isStale ? ' STALE' : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
