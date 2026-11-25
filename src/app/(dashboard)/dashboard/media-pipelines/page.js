"use client";

import { useEffect, useState } from "react";
import { Card, Button } from "@/shared/components";

const TYPES = ["text_to_image", "image_to_image", "image_to_video", "two_step_pipeline", "text_to_video"];
const TYPE_LABELS = { text_to_image: "Text to image", image_to_image: "Image to image", image_to_video: "Image to video", two_step_pipeline: "Two-step video pipeline", text_to_video: "Text to video" };
const category = (type) => ["text_to_image", "image_to_image"].includes(type) ? "image" : "video";
const EMPTY = { type: "text_to_image", name: "", is_default: false, steps: [], final_response: {}, required_env_keys: [] };

export default function MediaPipelinesPage() {
  const [pipelines, setPipelines] = useState([]);
  const [enabled, setEnabled] = useState(false);
  const [json, setJson] = useState("[]");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    fetch("/api/settings").then(async (r) => { if (!r.ok) throw new Error("Failed to load settings"); return r.json(); }).then((data) => {
      setPipelines(data.mediaPipelines || []);
      setJson(JSON.stringify(data.mediaPipelines || [], null, 2));
      setEnabled(Boolean(data.mediaPipelinesEnabled));
    }).catch((e) => setStatus(e.message)).finally(() => setBusy(false));
  }, []);

  const save = async (patch) => {
    setStatus("");
    try {
      const response = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Save failed");
      if (patch.mediaPipelines) {
        setPipelines(result.mediaPipelines);
        setJson(JSON.stringify(result.mediaPipelines, null, 2));
      }
      if ("mediaPipelinesEnabled" in patch) setEnabled(patch.mediaPipelinesEnabled);
      setStatus("Saved");
    } catch (error) { setStatus(error.message); }
  };

  const addPipeline = () => {
    try {
      const current = JSON.parse(json);
      if (!Array.isArray(current)) throw new Error("Expected a JSON array");
      setJson(JSON.stringify([...current, { ...EMPTY, name: `Pipeline ${current.length + 1}` }], null, 2));
      setStatus("Complete the new pipeline and save it.");
    } catch (error) { setStatus(error.message); }
  };

  return <div className="max-w-5xl mx-auto px-4 sm:px-0 space-y-6">
    <header className="flex items-center justify-between gap-4">
      <div><h1 className="text-2xl font-semibold">Media Pipelines</h1><p className="text-sm text-text-muted">Configure image and video generation routes.</p></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={(event) => save({ mediaPipelinesEnabled: event.target.checked })} /> Enable pipelines</label>
    </header>
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {pipelines.map((pipeline, index) => <Card key={`${pipeline.name}-${index}`}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{pipeline.name || "Unnamed pipeline"}</h2><p className="text-xs text-text-muted mt-1">{TYPE_LABELS[pipeline.type] || pipeline.type}</p></div>{pipeline.is_default && <span className="text-xs rounded-full px-2 py-1 bg-primary/10 text-primary">Default</span>}</div>
        <p className="text-sm text-text-muted mt-4">{pipeline.steps?.length || 0} steps</p>
        <div className="flex gap-2 mt-4"><Button onClick={() => save({ mediaPipelines: pipelines.map((item, i) => {
          return category(item.type) === category(pipeline.type) ? { ...item, is_default: i === index ? !pipeline.is_default : false } : item;
        }) })}>{pipeline.is_default ? "Deactivate" : "Activate"}</Button><Button onClick={() => { document.getElementById("pipeline-json")?.scrollIntoView({ behavior: "smooth" }); }}>Edit JSON</Button></div>
      </Card>)}
      {!pipelines.length && <Card><h2 className="font-semibold">No pipelines yet</h2><p className="text-sm text-text-muted mt-2">Add a pipeline configuration to get started.</p></Card>}
    </div>
    <Card>
      <div className="flex justify-between items-center gap-3"><div><h2 className="text-lg font-semibold">Pipeline configuration</h2><p className="text-sm text-text-muted">JSON editor. Types: {TYPES.map((type) => `${TYPE_LABELS[type]} (${type})`).join(", ")}. One default per image or video category. Use environment references for secrets; never paste secret values. List permitted keys in the server environment variable MCP_MEDIA_ALLOWED_ENV_KEYS (comma-separated).</p></div><Button onClick={addPipeline} disabled={busy}>Add pipeline</Button></div>
      <label htmlFor="pipeline-json" className="block text-sm mt-4 mb-2">Pipelines JSON</label>
      <textarea id="pipeline-json" className="w-full min-h-80 p-3 rounded border bg-transparent font-mono text-sm" value={json} onChange={(event) => setJson(event.target.value)} spellCheck={false} />
      <div className="flex items-center gap-3 mt-3"><Button onClick={() => { try { const data = JSON.parse(json); if (!Array.isArray(data)) throw new Error("Expected a JSON array"); save({ mediaPipelines: data }); } catch (error) { setStatus(error.message); } }} disabled={busy}>Save pipelines</Button><p role="status" className="text-sm">{status}</p></div>
    </Card>
  </div>;
}
