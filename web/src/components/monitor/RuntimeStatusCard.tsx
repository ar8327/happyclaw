import { Server } from 'lucide-react';
import { SystemStatus } from '../../stores/monitor';

interface ContainerStatusProps {
  status: SystemStatus;
}

export function RuntimeStatusCard({ status }: ContainerStatusProps) {
  const activeCount = status.activeRuntimes;
  const maxConcurrent = Math.max(1, status.maxConcurrentRuntimes || 20);
  const percentage = (activeCount / maxConcurrent) * 100;
  const progressWidth = Math.min(100, percentage);

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-brand-100 rounded-lg">
          <Server className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-slate-500">活跃 Runtime</h3>
          <p className="text-2xl font-bold text-foreground">
            {activeCount} / {maxConcurrent}
          </p>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-muted rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all duration-300 ${
            percentage > 80
              ? 'bg-red-500'
              : percentage > 60
              ? 'bg-amber-500'
              : 'bg-green-500'
          }`}
          style={{ width: `${progressWidth}%` }}
        />
      </div>

      <div className="mt-2 text-xs text-slate-500">
        {percentage > 80 && 'Runtime 使用率较高'}
        {percentage > 60 && percentage <= 80 && 'Runtime 使用正常'}
        {percentage <= 60 && 'Runtime 资源充足'}
      </div>
    </div>
  );
}
