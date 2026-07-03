'use client';

import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

export interface TimelineLayerToastItem {
  id: string;
  layerKey: string;
  layerLabel: string;
  eventCount: number;
  timeLabel: string;
  onUndo: () => void;
}

interface Props {
  toasts: TimelineLayerToastItem[];
  onDismiss: (id: string) => void;
}

const AUTO_DISMISS_MS = 8000;

function Toast({ item, onDismiss }: { item: TimelineLayerToastItem; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="glass-panel pointer-events-auto overflow-hidden"
      style={{ width: 280 }}
    >
      <div className="px-3 py-2.5">
        {/* Header row */}
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-1.5 min-w-0">
            {/* Cyan dot indicator */}
            <div
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{
                background: 'var(--cyan-primary, #00e5ff)',
                boxShadow: '0 0 6px rgba(0,229,255,0.7)',
              }}
            />
            <span className="text-[9px] font-mono font-bold tracking-widest text-[var(--cyan-primary,#00e5ff)] uppercase truncate">
              LAYER AUTO-ENABLED
            </span>
          </div>
          <button
            onClick={onDismiss}
            className="text-white/30 hover:text-white/60 flex-shrink-0 transition-colors"
            aria-label="Dismiss"
          >
            <X size={11} />
          </button>
        </div>

        {/* Message */}
        <p className="text-[10px] font-mono text-white/80 leading-snug mb-1.5">
          <span className="text-white/95 font-semibold">{item.layerLabel}</span>{' '}
          enabled &mdash; {item.eventCount} event{item.eventCount !== 1 ? 's' : ''} at{' '}
          <span className="text-[var(--cyan-primary,#00e5ff)]">{item.timeLabel}</span>
        </p>

        {/* Undo row */}
        <div className="flex justify-end">
          <button
            onClick={() => {
              item.onUndo();
              onDismiss();
            }}
            className="text-[9px] font-mono text-[var(--cyan-primary,#00e5ff)] hover:underline transition-colors"
          >
            Undo
          </button>
        </div>
      </div>
    </motion.div>
  );
}

export default function TimelineLayerToast({ toasts, onDismiss }: Props) {
  return (
    <div className="absolute bottom-[130px] left-[315px] z-[300] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map(item => (
          <Toast
            key={item.id}
            item={item}
            onDismiss={() => onDismiss(item.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
