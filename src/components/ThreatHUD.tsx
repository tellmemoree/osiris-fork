'use client';

interface ThreatHUDProps {
  uavCount: number; // 0 = hidden
}

export default function ThreatHUD({ uavCount }: ThreatHUDProps) {
  if (uavCount <= 0) return null;
  return (
    <div style={{
      position: 'absolute',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 40,
      background: 'rgba(20,18,14,0.85)',
      border: '1px solid rgba(255,152,0,0.5)',
      borderRadius: '6px',
      padding: '5px 14px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      backdropFilter: 'blur(6px)',
      pointerEvents: 'none',
    }}>
      <span style={{ color: '#FF9800', fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em' }}>
        БпЛА
      </span>
      <span style={{ color: '#E8E6E0', fontSize: '20px', fontWeight: 700, lineHeight: 1 }}>
        {uavCount}
      </span>
      <span style={{ color: '#5C5A54', fontSize: '9px' }}>ACTIVE</span>
    </div>
  );
}
