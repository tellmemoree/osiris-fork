'use client';

import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, CornerDownLeft, ArrowUp, ArrowDown, Command as CommandIcon } from 'lucide-react';

export interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  keywords?: string;
  icon?: ReactNode;
  /** Right-aligned status pill, e.g. a live count or "ON" */
  badge?: string;
  /** Renders the badge in the active/accent colour */
  active?: boolean;
  run: () => void;
  /** Keep palette open after running (for toggles) */
  keepOpen?: boolean;
}

interface CommandPaletteProps {
  commands: PaletteCommand[];
}

/** Subsequence fuzzy match — returns a score (higher = better) or -1 for no match. */
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const idx = h.indexOf(n);
  if (idx !== -1) return 1000 - idx; // contiguous substring — strongly preferred
  // fall back to subsequence
  let hi = 0;
  let score = 0;
  let streak = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni];
    let found = -1;
    for (; hi < h.length; hi++) {
      if (h[hi] === c) { found = hi; break; }
    }
    if (found === -1) return -1;
    streak = hi > 0 && h[hi - 1] === n[ni - 1] ? streak + 1 : 0;
    score += 1 + streak;
    hi++;
  }
  return score;
}

export default function CommandPalette({ commands }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => { setOpen(false); setQuery(''); setSelected(0); }, []);

  // ── Global open shortcut: ⌘K / Ctrl+K ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen(prev => {
          if (!prev) { setQuery(''); setSelected(0); } // reset on open
          return !prev;
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Focus the input whenever the palette opens (no state writes — lint-safe).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  const results = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map(c => ({ c, s: fuzzyScore(`${c.title} ${c.subtitle ?? ''} ${c.keywords ?? ''} ${c.group}`, query.trim()) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map(x => x.c);
  }, [commands, query]);

  // Group results while preserving the sorted order of first appearance.
  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, PaletteCommand[]>();
    for (const c of results) {
      if (!map.has(c.group)) { map.set(c.group, []); order.push(c.group); }
      map.get(c.group)!.push(c);
    }
    // Flat index lookup for keyboard navigation
    const flat: PaletteCommand[] = [];
    for (const g of order) flat.push(...map.get(g)!);
    return { order, map, flat };
  }, [results]);

  const runAt = useCallback((i: number) => {
    const cmd = groups.flat[i];
    if (!cmd) return;
    cmd.run();
    if (!cmd.keepOpen) close();
  }, [groups, close]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, groups.flat.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); runAt(selected); }
  };

  // Keep the selected row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  let flatIndex = -1;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[900] flex items-start justify-center pointer-events-auto"
          onClick={close}
          style={{ paddingTop: 'clamp(56px, 14vh, 160px)' }}
        >
          <div className="absolute inset-0 bg-[var(--bg-void)]/75 backdrop-blur-[3px]" />

          <motion.div
            initial={{ opacity: 0, y: -14, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.99 }}
            transition={{ type: 'spring', damping: 26, stiffness: 320 }}
            onClick={e => e.stopPropagation()}
            className="relative w-[92vw] max-w-[620px] rounded-2xl overflow-hidden osiris-glow"
            style={{
              background: 'rgba(6,8,16,0.86)',
              backdropFilter: 'blur(40px) saturate(1.4)',
              WebkitBackdropFilter: 'blur(40px) saturate(1.4)',
              border: '1px solid var(--border-active)',
              boxShadow: '0 24px 80px rgba(0,0,0,0.65), 0 0 40px var(--gold-glow)',
            }}
          >
            {/* ── Search header ── */}
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--border-primary)]">
              <Search className="w-4 h-4 text-[var(--gold-primary)] shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => { setQuery(e.target.value); setSelected(0); }}
                onKeyDown={onKeyDown}
                placeholder="Search layers, regions, tools, display…"
                spellCheck={false}
                autoComplete="off"
                className="flex-1 bg-transparent outline-none text-[14px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] tracking-wide"
              />
              <kbd className="hidden sm:flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono text-[var(--text-muted)] border border-[var(--border-primary)]">
                <CommandIcon className="w-2.5 h-2.5" />K
              </kbd>
            </div>

            {/* ── Results ── */}
            <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2 styled-scrollbar">
              {groups.flat.length === 0 && (
                <div className="px-4 py-10 text-center text-[11px] font-mono text-[var(--text-muted)] tracking-widest">
                  NO MATCHING COMMANDS
                </div>
              )}
              {groups.order.map(group => (
                <div key={group} className="mb-1">
                  <div className="px-4 pt-2 pb-1 text-[8px] font-mono tracking-[0.25em] uppercase text-[var(--text-muted)]/70">
                    {group}
                  </div>
                  {groups.map.get(group)!.map(cmd => {
                    flatIndex++;
                    const idx = flatIndex;
                    const isSel = idx === selected;
                    return (
                      <button
                        key={cmd.id}
                        data-idx={idx}
                        onMouseMove={() => setSelected(idx)}
                        onClick={() => runAt(idx)}
                        className="w-full flex items-center gap-3 px-4 py-2 text-left transition-colors"
                        style={{
                          background: isSel ? 'var(--hover-accent)' : 'transparent',
                          borderLeft: isSel ? '2px solid var(--gold-primary)' : '2px solid transparent',
                        }}
                      >
                        <span
                          className="w-4 h-4 shrink-0 flex items-center justify-center"
                          style={{ color: isSel ? 'var(--gold-primary)' : 'var(--text-secondary)' }}
                        >
                          {cmd.icon}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className={`block text-[12.5px] font-mono tracking-wide truncate ${isSel ? 'text-[var(--text-heading)]' : 'text-[var(--text-primary)]'}`}>
                            {cmd.title}
                          </span>
                          {cmd.subtitle && (
                            <span className="block text-[9px] font-mono text-[var(--text-muted)] truncate">{cmd.subtitle}</span>
                          )}
                        </span>
                        {cmd.badge && (
                          <span
                            className="shrink-0 px-1.5 py-0.5 rounded text-[8px] font-mono font-bold tabular-nums tracking-wider"
                            style={{
                              color: cmd.active ? 'var(--gold-primary)' : 'var(--text-muted)',
                              background: cmd.active ? 'var(--gold-glow)' : 'rgba(255,255,255,0.03)',
                              border: `1px solid ${cmd.active ? 'var(--border-active)' : 'var(--border-secondary)'}`,
                            }}
                          >
                            {cmd.badge}
                          </span>
                        )}
                        {isSel && <CornerDownLeft className="w-3 h-3 text-[var(--gold-primary)] shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* ── Footer hint ── */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--border-primary)] text-[8px] font-mono text-[var(--text-muted)] tracking-widest">
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-1"><ArrowUp className="w-2.5 h-2.5" /><ArrowDown className="w-2.5 h-2.5" /> NAVIGATE</span>
                <span className="flex items-center gap-1"><CornerDownLeft className="w-2.5 h-2.5" /> RUN</span>
                <span>ESC CLOSE</span>
              </span>
              <span className="text-[var(--gold-primary)]/60">{groups.flat.length} CMD</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
