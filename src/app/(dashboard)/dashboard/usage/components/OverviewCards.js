"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

export default function OverviewCards({ stats, onFilterChange, selectedApiKey, selectedModel, apiKeyOptions = [], modelOptions = [] }) {
  return (
    <div className="flex flex-col gap-3">
      {/* Filters for Overview */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-text-muted flex items-center gap-1">
          <span className="material-symbols-outlined text-[16px]">filter_alt</span> Filter:
        </span>
        <select
          value={selectedApiKey}
          onChange={(e) => onFilterChange?.({ apiKey: e.target.value, model: selectedModel })}
          className="rounded-lg border border-border bg-surface px-2.5 py-1 text-xs text-text-main focus:outline-none focus:border-primary"
        >
          <option value="">All API Keys</option>
          {apiKeyOptions.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
        <select
          value={selectedModel}
          onChange={(e) => onFilterChange?.({ apiKey: selectedApiKey, model: e.target.value })}
          className="rounded-lg border border-border bg-surface px-2.5 py-1 text-xs text-text-main focus:outline-none focus:border-primary"
        >
          <option value="">All Models</option>
          {modelOptions.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        {(selectedApiKey || selectedModel) && (
          <button
            onClick={() => onFilterChange?.({ apiKey: "", model: "" })}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors px-1 py-0.5"
          >
            <span className="material-symbols-outlined text-[14px]">close</span> Reset
          </button>
        )}
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4">
        <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
          <span className="text-text-muted text-sm uppercase font-semibold">Total Requests</span>
          <span className="truncate text-2xl font-bold">{fmt(stats.totalRequests)}</span>
          {(stats.totalImages > 0 || stats.totalVideos > 0) && (
            <span className="text-[11px] text-text-muted flex items-center gap-1.5 mt-0.5">
              {stats.totalImages > 0 && <span className="text-purple-400 font-medium">{stats.totalImages} imgs</span>}
              {stats.totalImages > 0 && stats.totalVideos > 0 && <span>·</span>}
              {stats.totalVideos > 0 && <span className="text-pink-400 font-medium">{stats.totalVideos} vids</span>}
            </span>
          )}
        </Card>
        <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
          <span className="text-text-muted text-sm uppercase font-semibold">Total Input Tokens</span>
          <span className="truncate text-2xl font-bold text-primary">{fmt(stats.totalPromptTokens)}</span>
        </Card>
        <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
          <span className="text-text-muted text-sm uppercase font-semibold">Cached Tokens</span>
          <span className="truncate text-2xl font-bold text-info">{fmt(stats.totalCachedTokens)}</span>
        </Card>
        <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
          <span className="text-text-muted text-sm uppercase font-semibold">Output Tokens</span>
          <span className="truncate text-2xl font-bold text-success">{fmt(stats.totalCompletionTokens)}</span>
        </Card>
        <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
          <span className="text-text-muted text-sm uppercase font-semibold">Est. Cost</span>
          <span className="truncate text-2xl font-bold text-warning">~{fmtCost(stats.totalCost)}</span>
          <span className="text-[10px] text-text-muted">Estimated, not actual billing</span>
        </Card>
      </div>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
