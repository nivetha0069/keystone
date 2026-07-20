"use client";

import { useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { PreviewRow, buildStructuredStagingPayloadFromText, previewFromText } from "./lib/cmdb/import-staging";
import { importedRunFromResponse, isSysId, type ImportedRun } from "./lib/cmdb/run-id";

type ImportMode = "file" | "url" | "paste";
type ImportStatus = "idle" | "staging" | "staged" | "demo" | "error";
export type { ImportedRun } from "./lib/cmdb/run-id";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PREVIEW_LIMIT = 6;

const sourcePresets = [
  {
    id: "microsoft-365",
    company: "Microsoft",
    label: "Microsoft 365 endpoints",
    format: "Nested JSON",
    url: "https://endpoints.office.com/endpoints/worldwide?clientrequestid=00000000-0000-0000-0000-000000000000",
    note: "Services, endpoint categories, URLs and IP ranges.",
  },
  {
    id: "cloudflare-status",
    company: "Cloudflare",
    label: "Cloudflare service components",
    format: "Nested JSON",
    url: "https://www.cloudflarestatus.com/api/v2/components.json",
    note: "Component hierarchy and current operational state.",
  },
  {
    id: "atlassian-status",
    company: "Atlassian",
    label: "Atlassian service components",
    format: "Nested JSON",
    url: "https://status.atlassian.com/api/v2/components.json",
    note: "Products, regional components and live status.",
  },
  {
    id: "legacy-export",
    company: "Legacy estate",
    label: "IMS / Db2 export",
    format: "CSV or spreadsheet",
    url: "",
    note: "Hierarchical and relational exports uploaded as files.",
  },
] as const;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImportGatewayView({ onOpenRun }: { onOpenRun: (run?: ImportedRun, startAnalysis?: boolean) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<ImportMode>("file");
  const [sourceName, setSourceName] = useState("External company dataset");
  const [runName, setRunName] = useState(`MIG-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`);
  const [sourceUrl, setSourceUrl] = useState("");
  const [pasteValue, setPasteValue] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [parseError, setParseError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [stagedRun, setStagedRun] = useState<ImportedRun | undefined>();

  const previewColumns = useMemo(() => {
    const columns = new Set<string>();
    previewRows.slice(0, PREVIEW_LIMIT).forEach(row => Object.keys(row).forEach(key => columns.add(key)));
    return Array.from(columns).slice(0, 6);
  }, [previewRows]);

  function changeMode(nextMode: ImportMode) {
    setMode(nextMode);
    setPreviewRows([]);
    setParseError("");
    setStatus("idle");
    setStatusMessage("");
    setStagedRun(undefined);
  }

  async function inspectFile(selected: File) {
    setFile(selected);
    setSourceName(current => current === "External company dataset" ? selected.name.replace(/\.[^.]+$/, "") : current);
    setStatus("idle");
    setStatusMessage("");
    if (selected.size > MAX_FILE_BYTES) {
      setPreviewRows([]);
      setParseError("This gateway accepts files up to 10 MB per batch.");
      return;
    }
    const extension = selected.name.split(".").pop()?.toLowerCase();
    if (extension === "xlsx" || extension === "xls") {
      setFile(null);
      setPreviewRows([]);
      setParseError("Convert to CSV first — Excel binary files are not supported yet.");
      return;
    }
    if (extension === "csv" || extension === "json" || extension === "txt") {
      const parsed = previewFromText(await selected.text(), extension);
      setPreviewRows(parsed.rows);
      setParseError(parsed.error);
    } else {
      setPreviewRows([]);
      setParseError("");
    }
  }

  function choosePreset(preset: typeof sourcePresets[number]) {
    setSourceName(preset.label);
    if (preset.url) {
      changeMode("url");
      setSourceUrl(
        preset.id === "microsoft-365" && typeof crypto !== "undefined" && "randomUUID" in crypto
          ? preset.url.replace("00000000-0000-0000-0000-000000000000", crypto.randomUUID())
          : preset.url,
      );
    } else {
      changeMode("file");
      fileInput.current?.click();
    }
  }

  function inspectPaste(value: string) {
    setPasteValue(value);
    const parsed = previewFromText(value);
    setPreviewRows(parsed.rows);
    setParseError(parsed.error);
    setStatus("idle");
    setStatusMessage("");
  }

  async function stageImport() {
    if (!sourceName.trim() || !runName.trim()) {
      setStatus("error");
      setStatusMessage("Add a source name and run name before staging.");
      return;
    }
    if (mode === "file" && !file) {
      setStatus("error");
      setStatusMessage("Choose a CSV, JSON or TXT file first.");
      return;
    }
    if (mode === "url" && !sourceUrl.trim()) {
      setStatus("error");
      setStatusMessage("Enter a public API or data URL first.");
      return;
    }
    if (mode === "paste" && !pasteValue.trim()) {
      setStatus("error");
      setStatusMessage("Paste JSON or CSV data first.");
      return;
    }

    setStatus("staging");
    setStatusMessage("Creating a quarantined staging batch…");
    try {
      let response: Response;
      if (mode === "file" && file) {
        const extension = file.name.split(".").pop()?.toLowerCase() || "file";
        const text = await file.text();
        const payload = buildStructuredStagingPayloadFromText(text, extension, sourceName.trim()) || text;
        response = await fetch("/api/cmdb/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sourceType: "file",
            sourceName: sourceName.trim(),
            runName: runName.trim(),
            format: extension,
            sourceFileName: file.name,
            payload,
          }),
        });
      } else {
        const payload = mode === "paste" ? buildStructuredStagingPayloadFromText(pasteValue, "auto", sourceName.trim()) || pasteValue : pasteValue;
        response = await fetch("/api/cmdb/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sourceType: mode,
            sourceName: sourceName.trim(),
            runName: runName.trim(),
            sourceUrl: mode === "url" ? sourceUrl.trim() : undefined,
            format: mode === "paste" && pasteValue.trim().startsWith("<") ? "xml" : "auto",
            payload: mode === "paste" ? payload : undefined,
          }),
        });
      }

      const result = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "The staging endpoint rejected this batch.");
      const importedRun = importedRunFromResponse(result, runName);
      setStagedRun(importedRun);

      // Without a real sys_id the handoff would open Comprehend on "ALL RUNS",
      // so surface the problem instead of navigating to an empty run.
      if (!isSysId(importedRun.id)) {
        console.error("Import staging response contained no valid migration run sys_id:", result);
        setStatus("error");
        setStatusMessage(
          "Staging landed, but ServiceNow did not return a migration run sys_id. Open Comprehend and paste the run sys_id manually.",
        );
        return;
      }

      const batchId = importedRun.label || importedRun.id;
      setStatus("staged");
      setStatusMessage(`Batch ${batchId} landed in staging. Starting analysis…`);
      // Opens the run and asks ServiceNow to start Comprehend once. Comprehend
      // queues Mara and Mara queues Prioritize, so nothing else is triggered here.
      onOpenRun(importedRun, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The staging endpoint is unavailable.";
      if (message.includes("not configured")) {
        setStatus("demo");
        setStatusMessage("Gateway validated in demo mode. Configure CMDB_IMPORT_URL to land this batch in ServiceNow staging.");
      } else {
        setStatus("error");
        setStatusMessage(message);
      }
    }
  }

  const canStage =
    Boolean(sourceName.trim() && runName.trim()) &&
    ((mode === "file" && Boolean(file) && !parseError) ||
      (mode === "url" && Boolean(sourceUrl.trim())) ||
      (mode === "paste" && Boolean(pasteValue.trim()) && !parseError));

  return <div className="page">
    <section className="page-heading import-heading">
      <div>
        <span className="eyebrow accent">IMPORT GATEWAY</span>
        <h1>Bring the outside estate in.</h1>
        <p>Upload exports or connect public datasets. Everything lands in quarantine—not the CMDB.</p>
      </div>
      <div className="ire-lock staging-lock">
        <Icon name="shield" size={18} />
        <span><small>LANDING CONTROL</small><strong>Staging only</strong></span>
      </div>
    </section>

    <section className="import-principles">
      <div><span>01</span><strong>Source enters</strong><small>File, public API, or pasted payload</small></div>
      <Icon name="arrow" size={16} />
      <div><span>02</span><strong>Quarantine</strong><small>Raw values preserved outside CMDB</small></div>
      <Icon name="arrow" size={16} />
      <div><span>03</span><strong>AI + confidence gate</strong><small>Classification begins after staging</small></div>
      <Icon name="arrow" size={16} />
      <div><span>04</span><strong>IRE governs</strong><small>Only approved records reach CMDB</small></div>
    </section>

    <section className="gateway-layout">
      <div className="gateway-main">
        <div className="panel import-source-panel">
          <div className="panel-heading">
            <div><span className="section-index">01</span><div><h2>Choose an intake door</h2><p>Keep the original payload intact for audit and replay.</p></div></div>
            <span className="panel-stat">NO DIRECT CMDB WRITE</span>
          </div>
          <div className="import-tabs" role="tablist" aria-label="Import method">
            <button className={mode === "file" ? "active" : ""} onClick={() => changeMode("file")}><Icon name="upload" size={16} /> Upload file</button>
            <button className={mode === "url" ? "active" : ""} onClick={() => changeMode("url")}><Icon name="link" size={16} /> Public URL</button>
            <button className={mode === "paste" ? "active" : ""} onClick={() => changeMode("paste")}><Icon name="file" size={16} /> Paste data</button>
          </div>

          <div className="import-fields">
            <label><span>SOURCE NAME</span><input value={sourceName} onChange={event => setSourceName(event.target.value)} placeholder="Example: IBM legacy estate export" /></label>
            <label><span>RUN NAME</span><input value={runName} onChange={event => setRunName(event.target.value)} placeholder="Example: MIG-20260716" /></label>
          </div>

          {mode === "file" && <div
            className={`drop-zone ${dragging ? "dragging" : ""} ${file ? "has-file" : ""}`}
            onDragEnter={event => { event.preventDefault(); setDragging(true); }}
            onDragOver={event => event.preventDefault()}
            onDragLeave={event => { event.preventDefault(); setDragging(false); }}
            onDrop={event => {
              event.preventDefault();
              setDragging(false);
              const selected = event.dataTransfer.files[0];
              if (selected) void inspectFile(selected);
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.json,.xlsx,.xls,.txt"
              onChange={event => {
                const selected = event.target.files?.[0];
                if (selected) void inspectFile(selected);
              }}
            />
            <span className="drop-icon"><Icon name={file ? "check" : "upload"} size={22} /></span>
            {file ? <>
              <strong>{file.name}</strong>
              <p>{formatBytes(file.size)} · ready for quarantined staging</p>
              <button className="ghost-button" onClick={() => fileInput.current?.click()}>Replace file</button>
            </> : <>
              <strong>Drop an export here</strong>
              <p>CSV, JSON, XLSX or XLS · up to 10 MB</p>
              <button className="primary-button" onClick={() => fileInput.current?.click()}><Icon name="upload" size={15} /> Choose file</button>
            </>}
          </div>}

          {mode === "url" && <div className="url-intake">
            <label><span>PUBLIC DATA URL</span><div><Icon name="link" size={16} /><input value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} placeholder="https://company.example/api/inventory" /></div></label>
            <div className="gateway-note"><Icon name="shield" size={15} /><p>The browser never writes this response to CMDB. Your configured staging service fetches and stores the raw source.</p></div>
          </div>}

          {mode === "paste" && <div className="paste-intake">
            <label><span>RAW JSON OR CSV</span><textarea value={pasteValue} onChange={event => inspectPaste(event.target.value)} placeholder={'hostname,ip,os_type\nsrv-prod-01,10.40.1.21,Linux Srv'} /></label>
          </div>}

          {parseError && <div className="gateway-error"><Icon name="alert" size={16} />{parseError}</div>}
        </div>

        <div className="panel preview-panel">
          <div className="panel-heading compact">
            <div><span className="section-index">02</span><div><h2>Raw preview</h2><p>Values shown exactly as supplied. Mapping happens later.</p></div></div>
            <span className="panel-stat">{previewRows.length ? `${previewRows.length.toLocaleString()} ROWS DETECTED` : "AWAITING DATA"}</span>
          </div>
          {previewRows.length ? <div className="preview-table-wrap"><table className="preview-table"><thead><tr>{previewColumns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>
            {previewRows.slice(0, PREVIEW_LIMIT).map((row, index) => <tr key={index}>{previewColumns.map(column => <td key={column}>{typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column] ?? "")}</td>)}</tr>)}
          </tbody></table></div> : <div className="preview-empty"><Icon name="file" size={25} /><strong>{mode === "url" ? "URL payload will be profiled after staging" : "Choose or paste data to inspect its raw shape"}</strong><p>Spreadsheet rows are profiled server-side after upload.</p></div>}
        </div>
      </div>

      <aside className="gateway-side">
        <div className="panel source-library">
          <div className="panel-heading compact"><div><span className="section-index">03</span><div><h2>Source starters</h2><p>Versatile demo inputs</p></div></div></div>
          <div className="source-list">
            {sourcePresets.map(preset => <button key={preset.id} onClick={() => choosePreset(preset)}>
              <span className="source-company">{preset.company}</span>
              <strong>{preset.label}</strong>
              <p>{preset.note}</p>
              <small>{preset.format}</small>
              <Icon name="arrow" size={14} />
            </button>)}
          </div>
        </div>

        <div className="panel stage-card">
          <span className="eyebrow accent">STAGING CONTRACT</span>
          <h2>Land first. Decide second.</h2>
          <ul>
            <li><Icon name="check" size={13} /> Original values retained</li>
            <li><Icon name="check" size={13} /> Source and run attributed</li>
            <li><Icon name="check" size={13} /> Bad rows remain quarantined</li>
            <li><Icon name="shield" size={13} /> CMDB inaccessible from gateway</li>
          </ul>
          {statusMessage && <div className={`gateway-status status-${status}`}><Icon name={status === "error" ? "alert" : status === "staging" ? "refresh" : "check"} size={16} /><span>{statusMessage}</span></div>}
          <button className="primary-button full" disabled={!canStage || status === "staging"} onClick={() => void stageImport()}>
            <Icon name={status === "staging" ? "refresh" : "database"} size={16} /> {status === "staging" ? "Staging batch…" : "Land in staging"}
          </button>
          {(status === "staged" || status === "demo") && <button className="ghost-button full open-run" onClick={() => onOpenRun(stagedRun)}>Open run playback <Icon name="arrow" size={15} /></button>}
          <small>Next: AI classifies rows and assigns confidence. Only later does IRE receive approved records.</small>
        </div>
      </aside>
    </section>
  </div>;
}
