'use client';
import React, { memo, type MouseEvent } from 'react';
import { Handle, Position, NodeResizer, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { Server, Database, Smartphone, CheckCircle, AlertCircle, Loader2, Sparkles } from 'lucide-react';

export type NodeStatus = 'idle' | 'running' | 'error' | 'success';

export type ServiceNodeData = {
  label: string;
  type: 'client' | 'service' | 'database';
  file?: string;
  status: NodeStatus;
  code: string;
  /*Real error text from the last run, shown on the node. */
  message?: string;
};

export type ServiceFlowNode = Node<ServiceNodeData, 'serviceNode'>;

const BORDER_BY_STATUS: Record<Exclude<NodeStatus, 'idle'>, string> = {
  running: 'border-amber-400 shadow-2xl shadow-amber-500/20 ring-2 ring-amber-400/50',
  error: 'border-rose-500 shadow-2xl shadow-rose-500/40 ring-2 ring-rose-500 animate-pulse',
  success: 'border-emerald-500 shadow-2xl shadow-emerald-500/20 ring-2 ring-emerald-500/50',
};

function ServiceNodeComponent({ id, data, selected }: NodeProps<ServiceFlowNode>) {
  const { setNodes, updateNodeData } = useReactFlow<ServiceFlowNode>();

  const icon =
    data.type === 'client' ? (
      <Smartphone className="w-4 h-4 text-sky-400" />
    ) : data.type === 'database' ? (
      <Database className="w-4 h-4 text-emerald-400" />
    ) : (
      <Server className="w-4 h-4 text-indigo-400" />
    );

  const borderClass =
    data.status !== 'idle'
      ? BORDER_BY_STATUS[data.status]
      : selected
        ? 'border-indigo-500 shadow-2xl shadow-indigo-500/20 ring-2 ring-indigo-500/60 bg-neutral-900'
        : 'border-neutral-800 hover:border-neutral-700 bg-neutral-900/90';

  // Elements with `nodrag` don't trigger React Flow's own selection, so select manually,
  // but never fight the user's multi-select (shift / ctrl / cmd).
  const handleSelectNode = (e: MouseEvent) => {
    if (selected || e.shiftKey || e.metaKey || e.ctrlKey) return;
    setNodes((nds) => nds.map((n) => (Boolean(n.selected) === (n.id === id) ? n : { ...n, selected: n.id === id })));
  };

  return (
    <div
      onClick={handleSelectNode}
      className={`group relative flex flex-col h-full w-full min-w-[320px] min-h-[240px] rounded-2xl border backdrop-blur-xl p-4 text-white transition-all duration-150 cursor-default ${borderClass}`}
    >
      <NodeResizer
        minWidth={320}
        minHeight={240}
        isVisible={Boolean(selected)}
        lineClassName="!border-indigo-500 !border"
        handleClassName="!w-3.5 !h-3.5 !bg-indigo-500 !border-2 !border-white !rounded-full !z-50 hover:!scale-125 !transition-transform"
      />

      <Handle
        type="target"
        position={Position.Left}
        className="!w-3.5 !h-3.5 !-left-2 !bg-neutral-800 !border-2 !border-neutral-500 !rounded-full !z-40"
      />

      <div className="flex items-center justify-between pb-3 border-b border-neutral-800 select-none">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-neutral-800/80 border border-neutral-700/50">{icon}</div>
          <div>
            <h2 className="font-semibold text-xs tracking-wide text-neutral-100">{data.label}</h2>
            <p className="text-[10px] text-neutral-400 font-mono tracking-tight">{data.file || 'service.ts'}</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-xs font-mono">
          {data.status === 'running' && (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[11px]">
              <Loader2 className="w-3 h-3 animate-spin" /> In-Flight
            </span>
          )}
          {data.status === 'error' && (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-300 border border-rose-500/30 text-[11px] font-bold">
              <AlertCircle className="w-3 h-3" /> Error
            </span>
          )}
          {data.status === 'success' && (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-[11px]">
              <CheckCircle className="w-3 h-3" /> 200 OK
            </span>
          )}
          {data.status === 'idle' && (
            <span className="text-[11px] text-neutral-500 px-2 py-0.5 rounded-full bg-neutral-800/60 border border-neutral-700/40">
              Standby
            </span>
          )}
        </div>
      </div>

      {data.message && (
        <p className="mt-2 text-[10px] leading-snug text-rose-300 font-mono line-clamp-3 select-text" title={data.message}>
          {data.message}
        </p>
      )}

      <div className="flex-1 flex flex-col mt-3 bg-neutral-950/80 rounded-xl border border-neutral-800/80 overflow-hidden shadow-inner min-h-0">
        <div className="flex items-center justify-between px-3 py-1.5 bg-neutral-900/60 border-b border-neutral-800/60 select-none">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
            <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
          </div>
          <span className="text-[10px] text-neutral-500 font-mono">{data.type === 'database' ? 'PostgreSQL' : 'TypeScript / Node.js'}</span>
          <div className="flex items-center gap-1 text-[10px] text-neutral-600 font-mono">
            <Sparkles className="w-2.5 h-2.5" /> AST
          </div>
        </div>

        {/* nodrag = don't drag node while selecting text
            nopan  = don't pan canvas while selecting text
            nowheel = scrolling the textarea must NOT zoom the canvas */}
        <textarea
          value={data.code}
          onChange={(e) => updateNodeData(id, { code: e.target.value })}
          className="nodrag nopan nowheel flex-1 w-full min-h-0 p-3 bg-transparent resize-none outline-none text-neutral-200 font-mono text-[11.5px] leading-relaxed selection:bg-indigo-500/30"
          spellCheck={false}
          placeholder="// Paste or write code here..."
        />
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-3.5 !h-3.5 !-right-2 !bg-neutral-800 !border-2 !border-neutral-500 !rounded-full !z-40"
      />
    </div>
  );
}

export const ServiceNode = memo(ServiceNodeComponent);