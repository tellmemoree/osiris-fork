'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X, MapPin } from 'lucide-react';
import { SearchEntity, searchEntities } from '@/lib/entitySearch';

/* ═══════════════════════════════════════════════════════════════
   OSIRIS — Search / Locate Bar
   Coordinates, place names (geocoded), AND any live map entity by name.
   ═══════════════════════════════════════════════════════════════ */

interface SearchBarProps {
  onLocate: (lat: number, lng: number) => void;
  entities?: SearchEntity[];
  onEnsureLoaded?: () => void;
  onSelectEntity?: (e: SearchEntity) => void;
}

type Result =
  | { type: 'place'; label: string; sublabel?: string; lat: number; lng: number }
  | { type: 'entity'; entity: SearchEntity };

// Badge colour per entity kind (place = gold default).
const KIND_COLOR: Record<string, string> = {
  Flight: '#00E5FF', Private: '#00E5FF', Jet: '#00E5FF', Military: '#FF6B00',
  Ship: '#4DD0E1', Satellite: '#B388FF', Camera: '#FF4081', Infra: '#FFD54F',
  'Live feed': '#FF4081', Incident: '#FF1744', Quake: '#FF9500', Radiation: '#76FF03',
  Weather: '#80DEEA', Port: '#4DD0E1', KAB: '#FF6B00', Outage: '#FFB300', Place: '#D4AF37',
};

export default function SearchBar({ onLocate, entities = [], onEnsureLoaded, onSelectEntity }: SearchBarProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const openSearch = () => {
    setOpen(true);
    onEnsureLoaded?.(); // pull entity sources so search covers all layers
  };

  const parseCoords = (s: string): { lat: number; lng: number } | null => {
    const m = s.trim().match(/^([+-]?\d+\.?\d*)[,\s]+([+-]?\d+\.?\d*)$/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
    return null;
  };

  const handleSearch = useCallback((q: string) => {
    setValue(q);
    if (timerRef.current) clearTimeout(timerRef.current);

    const coords = parseCoords(q);
    if (coords) {
      setResults([{ type: 'place', label: `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`, ...coords }]);
      return;
    }
    if (q.trim().length < 2) { setResults([]); return; }

    // Entity matches are local + instant — show them immediately.
    const entityHits: Result[] = searchEntities(entities, q).map((e) => ({ type: 'entity', entity: e }));
    setResults(entityHits);

    // Place geocoding is remote — debounce, then append below the entities.
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`, {
          headers: { 'Accept-Language': 'en' },
        });
        const data = await res.json();
        const places: Result[] = (data as { display_name: string; lat: string; lon: string }[]).map((r) => ({
          type: 'place', label: r.display_name, lat: parseFloat(r.lat), lng: parseFloat(r.lon),
        }));
        setResults([...entityHits, ...places]);
      } catch { /* keep entity hits */ }
      setLoading(false);
    }, 350);
  }, [entities]);

  const handleSelect = (r: Result) => {
    if (r.type === 'entity') {
      if (onSelectEntity) onSelectEntity(r.entity);
      else onLocate(r.entity.lat, r.entity.lng);
    } else {
      onLocate(r.lat, r.lng);
    }
    setOpen(false);
    setValue('');
    setResults([]);
  };

  if (!open) {
    return (
      <button
        onClick={openSearch}
        className="flex items-center gap-1.5 glass-panel-sm px-3 py-2 text-[9px] font-mono tracking-[0.15em] text-[var(--text-muted)] hover:text-[var(--gold-primary)] hover:border-[var(--border-active)] transition-all hover:shadow-[0_0_12px_rgba(212,175,55,0.08)]"
      >
        <Search className="w-3 h-3" />
        CMD: LOCATE
      </button>
    );
  }

  return (
    <div className="relative w-full">
      <div className="flex items-center gap-2 w-full glass-panel px-3 py-2.5 !border-[var(--border-active)]">
        <Search className="w-3.5 h-3.5 text-[var(--gold-primary)] flex-shrink-0" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => handleSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setOpen(false); setValue(''); setResults([]); }
            if (e.key === 'Enter' && results.length > 0) handleSelect(results[0]);
          }}
          placeholder="COORDS, PLACE, OR ENTITY NAME (ship, flight, cam…)"
          inputMode="search"
          className="flex-1 min-w-0 bg-transparent text-[10px] text-[var(--text-primary)] font-mono tracking-wider outline-none placeholder:text-[var(--text-muted)]"
        />
        {loading && <div className="w-3 h-3 border border-[var(--gold-primary)] border-t-transparent rounded-full animate-spin" />}
        <button onClick={() => { setOpen(false); setValue(''); setResults([]); }} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          <X className="w-3 h-3" />
        </button>
      </div>

      {results.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 glass-panel overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.5)] max-h-[280px] overflow-y-auto styled-scrollbar z-50">
          {results.map((r, i) => {
            const kind = r.type === 'entity' ? r.entity.kind : 'Place';
            const label = r.type === 'entity' ? r.entity.name : r.label;
            const sublabel = r.type === 'entity' ? r.entity.sublabel : r.sublabel;
            const color = KIND_COLOR[kind] || 'var(--gold-primary)';
            return (
              <button
                key={i}
                onClick={() => handleSelect(r)}
                className="w-full text-left px-3 py-2 hover:bg-[var(--hover-accent)] transition-colors border-b border-[var(--border-secondary)] last:border-0 flex items-center gap-2"
              >
                {r.type === 'entity'
                  ? <span className="text-[7px] font-mono font-bold px-1.5 py-0.5 rounded flex-shrink-0 tracking-wider" style={{ color, border: `1px solid ${color}55` }}>{kind.toUpperCase()}</span>
                  : <MapPin className="w-3 h-3 text-[var(--gold-primary)] flex-shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-[9px] text-[var(--text-secondary)] font-mono truncate">{label}</span>
                  {sublabel && <span className="block text-[8px] text-[var(--text-muted)] font-mono truncate">{sublabel}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
