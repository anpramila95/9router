"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";

export default function ConnectionImportExportModal({
  isOpen,
  providerId,
  providerName,
  connections = [],
  onClose,
  onImportSuccess,
}) {
  const [activeTab, setActiveTab] = useState("export"); // "export" | "import"
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Generate export JSON for this provider's connections
  const exportPayload = {
    version: 1,
    provider: providerId,
    exportedAt: new Date().toISOString(),
    connections: connections.map((c) => {
      const { id, lastTested, lastError, lastErrorAt, consecutiveUseCount, testStatus, rateLimitedUntil, ...clean } = c;
      return clean;
    }),
  };

  const exportJsonString = JSON.stringify(exportPayload, null, 2);

  const handleCopyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportJsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Failed to copy to clipboard");
    }
  };

  const handleDownloadExport = () => {
    try {
      const blob = new Blob([exportJsonString], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${providerId}-connections-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || "Failed to download file");
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setImportText(event.target?.result || "");
      setError("");
    };
    reader.onerror = () => setError("Failed to read file");
    reader.readAsText(file);
  };

  const handleRunImport = async () => {
    if (!importText.trim()) return;
    setError("");
    setImportResult(null);
    setImporting(true);

    try {
      let parsed;
      try {
        parsed = JSON.parse(importText);
      } catch {
        throw new Error("Invalid JSON format");
      }

      // Handle raw array or { connections: [...] }
      const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.connections) ? parsed.connections : null);
      if (!rawList || !rawList.length) {
        throw new Error("No connections array found in JSON");
      }

      // Call bulk import API endpoint
      const res = await fetch("/api/providers/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connections: rawList }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Import failed");
      }

      setImportResult({ imported: data.imported, failed: data.failed, total: data.total });
      if (onImportSuccess) await onImportSuccess();
    } catch (e) {
      setError(e.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Connections · Import & Export (${providerName || providerId})`}
    >
      <div className="flex flex-col gap-4">
        {/* Tabs */}
        <div className="flex rounded-lg bg-bg-subtle p-1 border border-border">
          <button
            onClick={() => { setActiveTab("export"); setError(""); }}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
              activeTab === "export" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text-main"
            }`}
          >
            Export ({connections.length})
          </button>
          <button
            onClick={() => { setActiveTab("import"); setError(""); }}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
              activeTab === "import" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text-main"
            }`}
          >
            Import
          </button>
        </div>

        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-2.5 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Export Tab */}
        {activeTab === "export" && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-text-muted">
              Copy or download all {connections.length} connections for <strong>{providerName || providerId}</strong> as a JSON file.
            </p>
            <div className="relative">
              <textarea
                readOnly
                value={exportJsonString}
                rows={8}
                className="w-full font-mono text-xs p-3 bg-sidebar rounded-lg border border-border focus:outline-none resize-none select-all"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleCopyExport} variant="secondary" fullWidth icon={copied ? "check" : "content_copy"}>
                {copied ? "Copied!" : "Copy JSON"}
              </Button>
              <Button onClick={handleDownloadExport} variant="primary" fullWidth icon="download">
                Download JSON
              </Button>
            </div>
          </div>
        )}

        {/* Import Tab */}
        {activeTab === "import" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-text-muted">Paste connections JSON or upload a exported file:</p>
              <label className="cursor-pointer text-xs text-primary hover:underline flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">upload_file</span>
                Upload File
                <input type="file" accept=".json,application/json" onChange={handleFileUpload} className="hidden" />
              </label>
            </div>

            <textarea
              value={importText}
              onChange={(e) => { setImportText(e.target.value); setError(""); }}
              rows={8}
              placeholder={`{\n  "connections": [\n    {\n      "name": "...",\n      "apiKey": "..."\n    }\n  ]\n}`}
              className="w-full font-mono text-xs p-3 bg-background rounded-lg border border-border focus:outline-none focus:border-primary resize-none"
            />

            {importResult && (
              <div className="rounded-lg bg-green-500/10 border border-green-500/30 p-2.5 text-xs text-green-600 dark:text-green-400">
                Imported successfully: <strong>{importResult.imported}</strong> / {importResult.total} connections {importResult.failed > 0 ? `(${importResult.failed} failed/skipped)` : ""}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleRunImport}
                variant="primary"
                fullWidth
                disabled={!importText.trim() || importing}
                icon="upload"
              >
                {importing ? "Importing..." : "Start Import"}
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

ConnectionImportExportModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerId: PropTypes.string.isRequired,
  providerName: PropTypes.string,
  connections: PropTypes.array,
  onClose: PropTypes.func.isRequired,
  onImportSuccess: PropTypes.func,
};
