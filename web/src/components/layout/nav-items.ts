import { MessageSquare, Clock, Activity, Settings, ScrollText, Search, Workflow } from 'lucide-react';

export const baseNavItems = [
  { path: '/chat', icon: MessageSquare, label: '工作台' },
  { path: '/search', icon: Search, label: '搜索' },
  { path: '/tasks', icon: Clock, label: '任务' },
  { path: '/workflows', icon: Workflow, label: '工作流' },
  { path: '/logs', icon: ScrollText, label: '日志' },
  { path: '/monitor', icon: Activity, label: '监控' },
  { path: '/settings', icon: Settings, label: '设置' },
];
