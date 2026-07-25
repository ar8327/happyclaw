import { useState, useEffect, useRef } from 'react';
import { Loader2, WifiOff, CheckCircle2 } from 'lucide-react';
import { useConnectionStatus, type ConnectionStatus } from '../../hooks/useConnectionStatus';

export function ConnectionBanner() {
  const status = useConnectionStatus();
  const [showRecovered, setShowRecovered] = useState(false);
  const prevStatus = useRef<ConnectionStatus>(status);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (prevStatus.current !== 'connected' && status === 'connected') {
      setShowRecovered(true);
      timerRef.current = setTimeout(() => setShowRecovered(false), 2000);
    }
    prevStatus.current = status;
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [status]);

  if (status === 'connected' && !showRecovered) return null;

  if (showRecovered) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-2 bg-success-bg border-b border-success-border text-success text-xs font-medium transition-all duration-300 animate-in fade-in slide-in-from-top-2">
        <CheckCircle2 className="w-3.5 h-3.5" />
        <span>已恢复连接</span>
      </div>
    );
  }

  if (status === 'offline') {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-2 bg-error-bg border-b border-error-border text-error text-xs font-medium">
        <WifiOff className="w-3.5 h-3.5" />
        <span>网络已断开</span>
      </div>
    );
  }

  // reconnecting
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-2 bg-warning-bg border-b border-warning-border text-warning text-xs font-medium">
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      <span>连接中断，正在重连...</span>
    </div>
  );
}
