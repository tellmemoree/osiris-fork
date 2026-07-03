'use client';

import { memo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plane, Satellite, Activity, Sun, AlertTriangle, Camera, Flame, Target,
  CloudLightning, Radiation, Tv, Anchor, Ship, Newspaper,
  Network, Share2, Radio, Siren, Bomb, Zap
} from 'lucide-react';

interface LayerPanelProps {
  data: any;
  activeLayers: any;
  setActiveLayers: React.Dispatch<React.SetStateAction<any>>;
  isMobile?: boolean;
  theme?: 'core' | 'ghost';
  setTheme?: (theme: 'core' | 'ghost') => void;
  onLayerDisable?: (key: string) => void;
}

const getLayerGroups = (theme: 'core' | 'ghost') => {
  const isGhost = theme === 'ghost';
  const phantomPurple = '#B388FF';
  const ghostPriv = '#CE93D8';
  const ghostGov = '#D500F9';

  const flightCom = isGhost ? phantomPurple : '#00E5FF';
  const flightPriv = isGhost ? ghostPriv : '#FFD700';
  const flightGov = isGhost ? ghostGov : '#FF9500';
  const flightMil = '#FF3D3D';

  return [
  {
    label: 'SDK',
    fullLabel: 'OSIRIS SDK',
    color: '#1565C0',
    layers: [
      { key: 'sdk_sea', label: 'Maritime Lines', icon: Anchor, color: '#4FC3F7', dataKey: 'sdk_entities' },
    ],
  },
  {
    label: 'AVIATION',
    fullLabel: 'AVIATION',
    color: flightCom,
    layers: [
      { key: 'flights', label: 'Commercial', icon: Plane, color: flightCom, dataKey: 'commercial_flights' },
      { key: 'private', label: 'Private', icon: Plane, color: flightPriv, dataKey: 'private_flights' },
      { key: 'jets', label: 'Private Jets', icon: Plane, color: flightGov, dataKey: 'private_jets' },
      { key: 'military', label: 'Military', icon: Shield, color: flightMil, dataKey: 'military_flights' },
    ],
  },
  {
    label: 'MARITIME',
    fullLabel: 'MARITIME & SPACE',
    color: '#00BCD4',
    layers: [
      { key: 'maritime', label: 'Maritime / Naval', icon: Anchor, color: '#00BCD4', dataKey: 'maritime_ports,maritime_chokepoints' },
      { key: 'ships', label: 'Live Ships (AIS)', icon: Ship, color: '#00BCD4', dataKey: 'maritime_ships' },
      { key: 'shadow_fleet', label: 'Shadow Fleet', icon: AlertTriangle, color: '#E040FB', dataKey: '' },
      { key: 'shadow_fleet_tracks', label: 'Fleet Tracks', icon: Activity, color: '#E040FB', dataKey: 'shadow_fleet_tracks' },
      { key: 'cables', label: 'Submarine Cables', icon: Share2, color: '#4FC3F7', dataKey: 'submarine_cables' },
      { key: 'satellites', label: 'Satellites', icon: Satellite, color: '#D4AF37', dataKey: 'satellites' },
    ],
  },
  {
    label: 'SURVEIL',
    fullLabel: 'SURVEILLANCE',
    color: isGhost ? '#9575CD' : '#39FF14',
    layers: [
      { key: 'cctv', label: 'CCTV Cameras', icon: Camera, color: isGhost ? '#B388FF' : '#39FF14', dataKey: 'cameras' },
      { key: 'live_news', label: 'Live News Feeds', icon: Tv, color: '#FF4081', dataKey: 'live_feeds' },
      { key: 'news_intel', label: 'News Geo-Dots', icon: Newspaper, color: isGhost ? phantomPurple : '#D4AF37', dataKey: 'news' },
    ],
  },
  {
    label: 'HAZARD',
    fullLabel: 'NATURAL HAZARDS',
    color: '#FF9500',
    layers: [
      { key: 'earthquakes', label: 'Earthquakes (24h)', icon: Activity, color: '#FF9500', dataKey: 'earthquakes' },
      { key: 'fires', label: 'Active Fires', icon: Flame, color: '#FF6B00', dataKey: 'fires' },
      { key: 'weather', label: 'Severe Weather', icon: CloudLightning, color: '#E040FB', dataKey: 'weather_events' },
      { key: 'air_quality', label: 'Air Quality (PM2.5)', icon: Activity, color: '#9CCC65', dataKey: 'air_quality' },
    ],
  },
  {
    label: 'THREAT',
    fullLabel: 'THREATS & INFRA',
    color: '#FF3D3D',
    layers: [
      { key: 'infrastructure', label: 'Nuclear Facilities', icon: Radiation, color: '#76FF03', dataKey: 'infrastructure' },
      { key: 'global_incidents', label: 'Global Incidents', icon: AlertTriangle, color: '#FF3D3D', dataKey: 'gdelt' },
      { key: 'gps_jamming', label: 'GPS Jamming', icon: Radio, color: '#FF4444', dataKey: 'gps_jamming' },
    ],
  },
  {
    label: 'UA WAR',
    fullLabel: 'UKRAINE WAR',
    color: '#FF1744',
    layers: [
      { key: 'frontlines', label: 'Frontline (DeepState)', icon: Target, color: '#FF3D3D', dataKey: 'frontlines' },
      { key: 'thermal_aoi', label: 'Thermal Strike AOIs', icon: Flame, color: '#FF6B00', dataKey: 'thermal_aoi' },
      { key: 'captures', label: 'Territorial Captures', icon: Target, color: '#FF3D3D', dataKey: 'captures' },
      { key: 'air_raids', label: 'Air Raid Alerts', icon: Siren, color: '#FF1744', dataKey: 'air_raids' },
      { key: 'kab_threats', label: 'KAB / Glide-Bomb', icon: Bomb, color: '#FF6B00', dataKey: 'kab_threats' },
      { key: 'drone_threats', label: 'Drone / UAV Swarms', icon: Plane, color: '#CE93D8', dataKey: 'drone_threats' },
      { key: 'alarm_vectors', label: 'Wave Vectors (inferred)', icon: Activity, color: '#FF9800', dataKey: '' },
      { key: 'missile_threats', label: 'Missile Threats', icon: Zap, color: '#FF4444', dataKey: 'missile_routes' },
      { key: 'power_outages', label: 'Power Outages', icon: Zap, color: '#FFD500', dataKey: 'power_outages' },
      { key: 'oblast_pressure', label: 'Oblast Pressure', icon: Activity, color: '#FF7043', dataKey: 'oblast_pressure' },
    ],
  },
  {
    label: 'RUSSIA',
    fullLabel: 'RUSSIA',
    color: '#B71C1C',
    layers: [
      { key: 'ru_air_raids', label: 'RU Oblast Alerts', icon: Siren, color: '#EF5350', dataKey: 'ru_air_raids' },
    ],
  },
  {
    label: 'NETWORK',
    fullLabel: 'NETWORK INTEL',
    color: isGhost ? phantomPurple : '#00E5FF',
    layers: [
      { key: 'internet_outages', label: 'Internet Outages', icon: Network, color: isGhost ? phantomPurple : '#00E5FF', dataKey: 'ioda_outages' },
      { key: 'malware', label: 'Live Malware', icon: AlertTriangle, color: '#FF1744', dataKey: 'malware_threats' },
    ],
  },
  {
    label: 'DISPLAY',
    fullLabel: 'DISPLAY',
    color: '#448AFF',
    layers: [
      { key: 'day_night', label: 'Day / Night Cycle', icon: Sun, color: '#448AFF', dataKey: '' },
    ],
  },
  ];
};

// SVG component for Shield which was missing in the imports above
function Shield(props: any) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  );
}

function LayerPanel({ data, activeLayers, setActiveLayers, isMobile, theme = 'core', setTheme, onLayerDisable }: LayerPanelProps) {
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);

  const LAYER_GROUPS = getLayerGroups(theme);
  const ALL_LAYERS = LAYER_GROUPS.flatMap(g => g.layers);

  const toggle = (key: string) => {
    const isCurrentlyOn = activeLayers[key];
    setActiveLayers((prev: any) => ({ ...prev, [key]: !prev[key] }));
    if (isCurrentlyOn && onLayerDisable) onLayerDisable(key);
  };

  // Toggle every layer in a group at once: if any are on, turn the whole group
  // off; otherwise turn them all on.
  const toggleGroup = (group: { layers: { key: string }[] }) => {
    const keys = group.layers.map(l => l.key);
    setActiveLayers((prev: any) => {
      const anyOn = keys.some(k => prev[k]);
      const next = { ...prev };
      keys.forEach(k => { next[k] = !anyOn; });
      return next;
    });
  };
  
  const getCount = (dk: string): number | null => {
    if (!dk) return null;
    let total = 0;
    let found = false;
    for (const k of dk.split(',')) {
      if (data[k] && Array.isArray(data[k])) {
        total += data[k].length;
        found = true;
      }
    }
    return found ? total : null;
  };
  // Shadow Fleet has no dedicated data array — its vessels are the
  // shadow_fleet-flagged subset of maritime_ships. Count them explicitly so the
  // layer shows a tally instead of nothing.
  const countFor = (layer: { key: string; dataKey: string }): number | null => {
    if (layer.key === 'shadow_fleet') {
      return Array.isArray(data.maritime_ships)
        ? data.maritime_ships.filter((s: { shadow_fleet?: boolean }) => s?.shadow_fleet === true).length
        : null;
    }
    // news_intel count must match OsirisMap's 24h freshness filter so the badge
    // reflects what's actually rendered, not the full unfiltered news array.
    if (layer.key === 'news_intel') {
      if (!Array.isArray(data.news)) return null;
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const n = data.news.filter((item: any) =>
        item.coords?.length === 2 && item.published &&
        new Date(item.published).getTime() >= cutoff
      ).length;
      return n > 0 ? n : null;
    }
    return getCount(layer.dataKey);
  };

  if (isMobile) {
    return (
      <div className="flex flex-col gap-4 py-2">
        {LAYER_GROUPS.map((group) => {
          const groupActiveCount = group.layers.filter(l => activeLayers[l.key]).length;
          return (
          <div key={group.label} className="flex flex-col gap-2">
            <button
              onClick={() => toggleGroup(group)}
              className="flex items-center justify-between border-b border-white/10 pb-1 active:opacity-80 transition-opacity"
            >
              <span className="text-[10px] font-bold font-mono tracking-widest" style={{ color: group.color }}>
                {group.fullLabel}
              </span>
              <span
                className="text-[8px] font-mono tracking-wider px-1.5 py-0.5 rounded border"
                style={{
                  color: groupActiveCount > 0 ? group.color : 'rgba(255,255,255,0.4)',
                  borderColor: groupActiveCount > 0 ? `${group.color}80` : 'rgba(255,255,255,0.15)',
                }}
              >
                {groupActiveCount > 0 ? 'ALL OFF' : 'ALL ON'}
              </span>
            </button>
            <div className="grid grid-cols-2 gap-2">
              {group.layers.map((layer) => {
                const isLayerActive = activeLayers[layer.key];
                const count = countFor(layer);
                
                return (
                  <button
                    key={layer.key}
                    onClick={() => toggle(layer.key)}
                    className={`flex items-center gap-2 px-2 py-2 rounded border transition-colors ${
                      isLayerActive 
                        ? 'bg-white/10 border-white/20' 
                        : 'bg-transparent border-white/5 hover:border-white/10'
                    }`}
                  >
                    <div 
                      className={`w-2 h-2 rounded-full border flex-shrink-0 transition-all ${
                        isLayerActive ? 'bg-current border-current scale-100' : 'bg-transparent border-white/30 scale-75'
                      }`}
                      style={{ color: isLayerActive ? layer.color : 'inherit', boxShadow: isLayerActive ? `0 0 8px ${layer.color}` : 'none' }}
                    />
                    <span className={`text-[9px] font-mono uppercase tracking-wider flex-1 text-left ${isLayerActive ? 'text-white' : 'text-white/60'}`}>
                      {layer.label}
                    </span>
                    {count !== null && (
                      <span className="text-[8px] font-mono tabular-nums opacity-60">
                        {count.toLocaleString()}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          );
        })}

        {/* MOBILE GHOST MODE TOGGLE */}
        {setTheme && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--border-primary)] px-2">
            <div className="text-[10px] font-bold font-mono tracking-widest text-[var(--text-secondary)]">
              GHOST MODE
            </div>
            <button
              onClick={() => setTheme(theme === 'core' ? 'ghost' : 'core')}
              className="relative w-12 h-6 rounded-full transition-all duration-500 ease-in-out border flex items-center px-0.5 cursor-pointer hover:shadow-lg"
              style={{
                backgroundColor: theme === 'ghost' ? 'rgba(179, 136, 255, 0.15)' : 'rgba(0,0,0,0.4)',
                borderColor: theme === 'ghost' ? 'rgba(179, 136, 255, 0.5)' : 'rgba(255,255,255,0.1)',
                boxShadow: theme === 'ghost' ? '0 0 15px rgba(179, 136, 255, 0.3), inset 0 0 8px rgba(179, 136, 255, 0.2)' : 'inset 0 0 5px rgba(0,0,0,0.5)',
              }}
            >
              <motion.div
                layout
                className="w-4 h-4 rounded-full"
                style={{
                  backgroundColor: theme === 'ghost' ? '#B388FF' : 'rgba(255,255,255,0.4)',
                  boxShadow: theme === 'ghost' ? '0 0 10px #B388FF' : 'none',
                }}
                animate={{ x: theme === 'ghost' ? 24 : 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              />
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="absolute top-0 left-0 h-full w-[80px] border-r border-white/5 flex flex-col pt-32 pb-8 z-50 pointer-events-auto bg-black/20 backdrop-blur-[2px]">
      
      <div className="flex-1 flex flex-col gap-8 px-2">
        {LAYER_GROUPS.map((group) => {
          const groupActiveCount = group.layers.filter(l => activeLayers[l.key]).length;
          const isActive = groupActiveCount > 0;
          const isHovered = hoveredGroup === group.label;

          return (
            <div 
              key={group.label} 
              className="relative flex justify-center items-center"
              onMouseEnter={() => setHoveredGroup(group.label)}
              onMouseLeave={() => setHoveredGroup(null)}
            >
              {/* The Vertical Label */}
              <div 
                className={`text-[10px] font-mono font-bold cursor-pointer select-none transition-all duration-300 flex items-center justify-center`}
                style={{
                  writingMode: 'horizontal-tb',
                  color: isActive ? group.color : 'rgba(255, 255, 255, 0.4)',
                  textShadow: isActive ? `0 0 10px ${group.color}80` : 'none',
                  letterSpacing: '0.1em',
                  opacity: isActive || isHovered ? 1 : 0.5,
                }}
              >
                {/* Active Indicator dot */}
                {isActive && (
                  <div 
                    className="absolute -left-1 w-1 h-1 rounded-full animate-pulse"
                    style={{ backgroundColor: group.color, boxShadow: `0 0 8px ${group.color}` }}
                  />
                )}
                {group.label}
              </div>

              {/* Slide-out Menu */}
              <AnimatePresence>
                {isHovered && (
                  <motion.div
                    initial={{ opacity: 0, x: -10, filter: 'blur(4px)' }}
                    animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, x: -5, filter: 'blur(2px)' }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="absolute left-[70px] top-1/2 -translate-y-1/2 min-w-[240px] bg-black/80 backdrop-blur-md border border-white/10 rounded-lg p-3 shadow-2xl z-50 pointer-events-auto"
                    style={{
                      boxShadow: `0 0 30px ${group.color}15, inset 0 0 20px ${group.color}05`
                    }}
                  >
                    <button
                      onClick={() => toggleGroup(group)}
                      className="w-full flex items-center justify-between mb-3 pb-2 border-b border-white/10 hover:opacity-90 transition-opacity"
                      title={groupActiveCount > 0 ? 'Turn entire group off' : 'Turn entire group on'}
                    >
                      <span className="text-[11px] font-bold font-mono tracking-widest" style={{ color: group.color }}>
                        {group.fullLabel}
                      </span>
                      <span
                        className="text-[8px] font-mono tracking-wider px-1.5 py-0.5 rounded border transition-colors"
                        style={{
                          color: groupActiveCount > 0 ? group.color : 'rgba(255,255,255,0.4)',
                          borderColor: groupActiveCount > 0 ? `${group.color}80` : 'rgba(255,255,255,0.15)',
                        }}
                      >
                        {groupActiveCount > 0 ? 'ALL OFF' : 'ALL ON'}
                      </span>
                    </button>
                    <div className="flex flex-col gap-1.5">
                      {group.layers.map((layer) => {
                        const isLayerActive = activeLayers[layer.key];
                        const count = countFor(layer);
                        const Icon = layer.icon || Shield;
                        
                        return (
                          <div key={layer.key}>
                            {layer.key === 'alarm_vectors' ? (
                              <button
                                onClick={() => toggle(layer.key)}
                                className="w-full flex items-center gap-2 pl-6 pr-2 py-1 rounded bg-transparent hover:bg-white/5 transition-colors"
                              >
                                <div
                                  className={`w-1.5 h-1.5 rounded-sm border flex-shrink-0 transition-all ${isLayerActive ? 'bg-current border-current' : 'bg-transparent border-white/25'}`}
                                  style={{ color: '#FF9800' }}
                                />
                                <span className={`text-[10px] font-mono tracking-wider flex-1 text-left ${isLayerActive ? 'text-orange-400' : 'text-white/35'}`}>
                                  {layer.label}
                                </span>
                              </button>
                            ) : (
                              <>
                                <button
                                  onClick={() => toggle(layer.key)}
                                  className="w-full flex items-center gap-3 px-2 py-1.5 rounded bg-transparent hover:bg-white/5 transition-colors group"
                                >
                                  <div
                                    className={`w-2 h-2 rounded-full border flex-shrink-0 transition-all duration-300 ${isLayerActive ? 'bg-current border-current scale-100' : 'bg-transparent border-white/30 scale-75'}`}
                                    style={{ color: isLayerActive ? layer.color : 'inherit', boxShadow: isLayerActive ? `0 0 8px ${layer.color}` : 'none' }}
                                  />
                                  <span className={`text-[11px] font-mono uppercase tracking-wider flex-1 text-left transition-colors duration-200 ${isLayerActive ? 'text-white' : 'text-white/50 group-hover:text-white/80'}`}>
                                    {layer.label}
                                  </span>
                                  {count !== null && (
                                    <span className="text-[9px] font-mono tabular-nums opacity-60">
                                      {count.toLocaleString()}
                                    </span>
                                  )}
                                </button>
                                {layer.key === 'thermal_aoi' && isLayerActive && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggle('thermal_aoi_fires_only'); }}
                                    className="w-full flex items-center gap-2 pl-6 pr-2 py-1 rounded bg-transparent hover:bg-white/5 transition-colors"
                                  >
                                    <div
                                      className={`w-1.5 h-1.5 rounded-sm border flex-shrink-0 transition-all ${activeLayers.thermal_aoi_fires_only ? 'bg-current border-current' : 'bg-transparent border-white/25'}`}
                                      style={{ color: '#FF6B00' }}
                                    />
                                    <span className={`text-[10px] font-mono tracking-wider flex-1 text-left ${activeLayers.thermal_aoi_fires_only ? 'text-orange-400' : 'text-white/35'}`}>
                                      active fires only
                                    </span>
                                  </button>
                                )}
                              </>
                            )}
                            {layer.key === 'missile_threats' && isLayerActive && (
                              <>
                                {([
                                  { key: 'missile_cruise',    label: 'Cruise (Kalibr/Kh-101)', color: '#FF4444' },
                                  { key: 'missile_ballistic', label: 'Ballistic (Iskander)',     color: '#FF8C00' },
                                  { key: 'missile_kinzhal',   label: 'Kinzhal',                 color: '#FFD700' },
                                  { key: 'missile_kh22',      label: 'Kh-22/32',                color: '#FF69B4' },
                                  { key: 'missile_s300',      label: 'S-300 (ground strike)',   color: '#9C27B0' },
                                ] as const).map(sub => (
                                  <button
                                    key={sub.key}
                                    onClick={(e) => { e.stopPropagation(); toggle(sub.key); }}
                                    className="w-full flex items-center gap-2 pl-6 pr-2 py-1 rounded bg-transparent hover:bg-white/5 transition-colors"
                                  >
                                    <div
                                      className={`w-1.5 h-1.5 rounded-sm border flex-shrink-0 transition-all ${activeLayers[sub.key] ? 'bg-current border-current' : 'bg-transparent border-white/25'}`}
                                      style={{ color: sub.color }}
                                    />
                                    <span className={`text-[10px] font-mono tracking-wider flex-1 text-left ${activeLayers[sub.key] ? 'text-white/80' : 'text-white/35'}`}>
                                      {sub.label}
                                    </span>
                                  </button>
                                ))}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* GHOST PROTOCOL TOGGLE */}
      {setTheme && (
        <div className="mt-auto px-2 pt-6 pb-2 border-t border-[var(--border-primary)] flex flex-col items-center gap-3 relative z-50">
          <div className="text-[9px] font-mono tracking-[0.25em] text-[var(--text-secondary)]">GHOST PROTOCOL</div>
          <button
            onClick={() => setTheme(theme === 'core' ? 'ghost' : 'core')}
            className="relative w-14 h-7 rounded-full transition-all duration-500 ease-in-out border flex items-center px-1 cursor-pointer hover:shadow-lg"
            style={{
              backgroundColor: theme === 'ghost' ? 'rgba(179, 136, 255, 0.15)' : 'rgba(0,0,0,0.4)',
              borderColor: theme === 'ghost' ? 'rgba(179, 136, 255, 0.5)' : 'rgba(255,255,255,0.1)',
              boxShadow: theme === 'ghost' ? '0 0 15px rgba(179, 136, 255, 0.3), inset 0 0 8px rgba(179, 136, 255, 0.2)' : 'inset 0 0 5px rgba(0,0,0,0.5)',
            }}
          >
            <motion.div
              layout
              className="w-5 h-5 rounded-full"
              style={{
                backgroundColor: theme === 'ghost' ? '#B388FF' : 'rgba(255,255,255,0.4)',
                boxShadow: theme === 'ghost' ? '0 0 10px #B388FF' : 'none',
              }}
              animate={{ x: theme === 'ghost' ? 28 : 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            />
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(LayerPanel);
