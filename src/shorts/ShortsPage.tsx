import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

export type CaptionStyle = "bold_yellow_pop" | "clean_white" | "minimal_bottom" | "off";

export const CAPTION_STYLES: { id: CaptionStyle; label: string; description: string }[] = [
  { id: "bold_yellow_pop", label: "Bold Yellow Pop", description: "Large yellow captions with a strong outline." },
  { id: "clean_white", label: "Clean White", description: "White captions with a clean shadow." },
  { id: "minimal_bottom", label: "Minimal Bottom", description: "Smaller captions anchored lower." },
  { id: "off", label: "No Captions", description: "Skip burned-in captions." },
];

interface UploadedSource {
  filename: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  url: string;
}

interface SelectedClip {
  title: string;
  reason: string;
  hook: string;
  start: number;
  end: number;
  duration: number;
}

interface TargetInfo {
  duration?: number;
  width?: number;
  height?: number;
  aspect?: string;
}

interface ShortsJobStatus {
  jobId: string;
  status: string;
  progress?: number;
  logs?: string[];
  finalUrl?: string;
  downloadUrl?: string;
  selectedClip?: SelectedClip;
  target?: TargetInfo;
  error?: string;
}

const GENERATION_STEPS = [
  "Transcribing audio",
  "Finding best clip",
  "Building captions",
  "Rendering video",
  "Ready",
];

function formatDuration(totalSeconds?: number | null): string {
  const total = Math.max(0, Math.round(Number(totalSeconds || 0)));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatOneDecimal(value?: number | null): string {
  return `${(Number(value || 0)).toFixed(1)}s`;
}

function cacheBust(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
}

function stepFromJob(job: ShortsJobStatus): number {
  if (job.status === "ready") return 4;
  if (job.status === "rendering") return 3;
  if (job.status === "captioning") return 2;
  if (job.status === "picking") return 1;
  if (job.status === "transcribing") return 0;

  const progress = Number(job.progress || 0);
  if (progress >= 100) return 4;
  if (progress >= 80) return 3;
  if (progress >= 50) return 2;
  if (progress >= 20) return 1;
  return 0;
}

const panelStyle = {
  background: "#202124",
  border: "1px solid #34363a",
  borderRadius: "8px",
  padding: "1rem",
} as const;

export default function ShortsPage() {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [source, setSource] = useState<UploadedSource | null>(null);
  const [serverSessionId, setServerSessionId] = useState<string | null>(null);

  const [instruction, setInstruction] = useState("");
  const [duration, setDuration] = useState(60);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>("bold_yellow_pop");
  const [submitting, setSubmitting] = useState(false);

  const [isGenerating, setIsGenerating] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [shortId, setShortId] = useState("");
  const [shortVideoUrl, setShortVideoUrl] = useState<string | null>(null);
  const [shortDownloadUrl, setShortDownloadUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [selectedClip, setSelectedClip] = useState<SelectedClip | null>(null);
  const [targetInfo, setTargetInfo] = useState<TargetInfo | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (currentStep === 4 && shortVideoUrl && videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  }, [currentStep, shortVideoUrl]);

  const resetGeneratedState = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setCurrentStep(0);
    setShortVideoUrl(null);
    setShortDownloadUrl(null);
    setVideoLoading(false);
    setSelectedClip(null);
    setTargetInfo(null);
  };

  const handleGenerateShort = async () => {
    if (!serverSessionId || !source) {
      alert("Please wait for the video to finish uploading.");
      return;
    }

    resetGeneratedState();
    setSubmitting(true);
    setIsGenerating(true);
    setShortId("Initializing...");
    setLogs([`[${new Date().toISOString()}] Pipeline start. Requesting backend generation...`]);

    try {
      const generateRes = await fetch("/api/shorts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: source.filename,
          sessionId: serverSessionId,
          duration,
          captionStyle,
          instruction,
          videoDuration: source.duration,
          width: source.width,
          height: source.height,
          fps: source.fps,
        }),
      });

      if (!generateRes.ok) {
        const errData = await generateRes.json().catch(() => ({}));
        throw new Error(errData.detail || "Failed to start short generation");
      }

      const data = await generateRes.json();
      if (!data.jobId) throw new Error("No job ID returned from server");
      setShortId(data.jobId);

      pollTimerRef.current = window.setInterval(async () => {
        try {
          const res = await fetch(`/api/shorts/status/${data.jobId}`);
          if (!res.ok) throw new Error("Status check failed");
          const job = (await res.json()) as ShortsJobStatus;

          setCurrentStep(stepFromJob(job));
          setLogs(job.logs?.length ? job.logs : [`[${new Date().toISOString()}] Status: ${job.status} (${job.progress || 0}%)`]);
          if (job.selectedClip) setSelectedClip(job.selectedClip);
          if (job.target) setTargetInfo(job.target);

          if (job.status === "ready") {
            if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setCurrentStep(4);
            setVideoLoading(true);
            setShortVideoUrl(job.finalUrl ? cacheBust(job.finalUrl) : null);
            setShortDownloadUrl(job.downloadUrl || job.finalUrl || null);
            setSubmitting(false);
          } else if (job.status === "error") {
            if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setSubmitting(false);
            throw new Error(job.error || "Unknown pipeline error");
          }
        } catch (pollErr) {
          const message = pollErr instanceof Error ? pollErr.message : String(pollErr);
          setLogs((prev) => [...prev, `[${new Date().toISOString()}] Poll error: ${message}`]);
        }
      }, 1200);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setSubmitting(false);
      setLogs((prev) => [...prev, `[${new Date().toISOString()}] Error: ${errorMessage}`]);
      alert(`Generation failed: ${errorMessage}`);
    }
  };

  async function handleFileUpload(file: File) {
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) {
      alert("Please select a valid video file (MP4, MOV, WebM, MKV).");
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    resetGeneratedState();

    try {
      const formData = new FormData();
      formData.append("file", file);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/videos/upload");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
      };

      const data = await new Promise<any>((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
          else reject(new Error("Upload failed"));
        };
        xhr.onerror = () => reject(new Error("Upload error"));
        xhr.send(formData);
      });

      setServerSessionId(data.sessionId);
      setSource({
        filename: file.name,
        duration: data.duration || 60,
        width: data.resolution?.width || 1920,
        height: data.resolution?.height || 1080,
        fps: 30,
        url: `/api/videos/${data.sessionId}/stream`,
      });
      setUploading(false);
      setUploadProgress(100);
    } catch {
      setUploading(false);
      alert("Failed to upload video to backend. Please check if the server is running.");
    }
  }

  function onDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFileUpload(file);
  }

  const title = selectedClip?.title || (currentStep === 4 ? "Your AI short is ready" : "Building your short");
  const reason =
    selectedClip?.reason ||
    "The pipeline is preparing a vertical short, caption layer, and downloadable MP4 from your uploaded source.";
  const targetDuration = targetInfo?.duration || duration;

  return (
    <main style={{ minHeight: "100vh", backgroundColor: "#141518", color: "#fff", display: "flex", flexDirection: "column" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1rem 1.5rem", borderBottom: "1px solid #303136", backgroundColor: isGenerating ? "#101114" : "#1e1f24" }}>
        <button onClick={() => setIsGenerating(false)} style={{ background: "none", border: "none", color: "#fff", fontWeight: 700, cursor: "pointer", padding: 0 }}>
          {isGenerating ? "< New short" : "AutoEdit - Shorts Creator"}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", color: "#aaa", fontSize: "0.86rem" }}>
          <Link to="/" style={{ textDecoration: "none", color: "#ddd" }}>AI Editor</Link>
        </div>
      </header>

      <div style={{ flex: 1, padding: "2rem", width: "100%", boxSizing: "border-box" }}>
        {isGenerating && source ? (
          <section style={{ width: "100%", maxWidth: "1180px", margin: "0 auto", display: "grid", gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)", gap: "1.5rem", alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div style={{ position: "relative", width: "100%", aspectRatio: "9/16", overflow: "hidden", borderRadius: "8px", border: "1px solid #383a40", background: "#090a0c", boxShadow: "0 16px 40px rgba(0,0,0,0.4)" }}>
                {currentStep === 4 && shortVideoUrl ? (
                  <>
                    <video
                      key={shortVideoUrl}
                      ref={videoRef}
                      src={shortVideoUrl}
                      controls
                      autoPlay
                      playsInline
                      loop
                      preload="auto"
                      onLoadedData={() => setVideoLoading(false)}
                      onCanPlay={() => setVideoLoading(false)}
                      onError={() => {
                        setVideoLoading(false);
                        setLogs((prev) => [...prev, `[${new Date().toISOString()}] Preview failed to load. Try the download button.`]);
                      }}
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
                    />
                    {videoLoading && (
                      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.55)", color: "#d8d8d8", fontSize: "0.9rem" }}>
                        Loading preview...
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ height: "100%", display: "grid", placeItems: "center", gap: "0.75rem", color: "#aaa" }}>
                    <div style={{ width: "42px", height: "42px", border: "4px solid #303136", borderTopColor: "#4a9eff", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                    <div>Processing...</div>
                  </div>
                )}
              </div>

              {currentStep === 4 && (
                <a href={shortDownloadUrl || shortVideoUrl || source.url} download={`Short_${shortId}.mp4`} style={{ display: "block", textAlign: "center", padding: "0.9rem", borderRadius: "8px", background: "#4a9eff", color: "#fff", textDecoration: "none", fontWeight: 700 }}>
                  Download Short
                </a>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "1rem", minWidth: 0 }}>
              <div>
                <h1 style={{ margin: "0 0 0.45rem", fontSize: "1.7rem", lineHeight: 1.15 }}>{title}</h1>
                <p style={{ margin: 0, color: "#b9bcc4", lineHeight: 1.55, maxWidth: "780px" }}>{reason}</p>
              </div>

              <div style={panelStyle}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: "0.65rem" }}>
                  {GENERATION_STEPS.map((step, i) => {
                    const isReadyStep = currentStep === 4 && i === 4;
                    const isCompleted = currentStep > i || isReadyStep;
                    const isActive = currentStep === i && !isReadyStep;
                    return (
                      <div key={step} style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0, color: isCompleted ? "#fff" : isActive ? "#67b3ff" : "#777" }}>
                        <div style={{ width: 22, height: 22, borderRadius: "50%", display: "grid", placeItems: "center", flexShrink: 0, background: isCompleted ? "#16a36a" : "#303136", border: isActive ? "2px solid #4a9eff" : "0" }}>
                          {isCompleted ? (
                            <span style={{ fontSize: 14, lineHeight: 1 }}>✓</span>
                          ) : isActive ? (
                            <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#4a9eff" }} />
                          ) : (
                            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#666" }} />
                          )}
                        </div>
                        <span style={{ fontSize: "0.78rem", overflowWrap: "anywhere" }}>{step}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1rem" }}>
                <div style={panelStyle}>
                  <div style={{ color: "#8d929c", fontSize: "0.76rem", textTransform: "uppercase", marginBottom: "0.45rem" }}>Source</div>
                  <div style={{ fontSize: "1.05rem", fontWeight: 700 }}>{formatDuration(source.duration)}</div>
                  <div style={{ color: "#b9bcc4", fontSize: "0.9rem", marginTop: "0.25rem" }}>{source.width}x{source.height}</div>
                </div>
                <div style={panelStyle}>
                  <div style={{ color: "#8d929c", fontSize: "0.76rem", textTransform: "uppercase", marginBottom: "0.45rem" }}>Target</div>
                  <div style={{ fontSize: "1.05rem", fontWeight: 700 }}>~{formatDuration(targetDuration)}</div>
                  <div style={{ color: "#b9bcc4", fontSize: "0.9rem", marginTop: "0.25rem" }}>{targetInfo?.width || 1080}x{targetInfo?.height || 1920} ({targetInfo?.aspect || "9:16"})</div>
                </div>
                <div style={panelStyle}>
                  <div style={{ color: "#8d929c", fontSize: "0.76rem", textTransform: "uppercase", marginBottom: "0.45rem" }}>Your instruction</div>
                  <div style={{ color: "#e8e8e8", overflowWrap: "anywhere" }}>{instruction.trim() ? `"${instruction.trim()}"` : "Auto-pick the strongest moment"}</div>
                </div>
                <div style={panelStyle}>
                  <div style={{ color: "#8d929c", fontSize: "0.76rem", textTransform: "uppercase", marginBottom: "0.45rem" }}>Selected clip</div>
                  <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>{selectedClip?.title || "Selecting..."}</div>
                  {selectedClip ? (
                    <>
                      <div style={{ color: "#b9bcc4", fontSize: "0.9rem" }}>
                        {formatOneDecimal(selectedClip.start)} - {formatOneDecimal(selectedClip.end)} · {formatOneDecimal(selectedClip.duration)}
                      </div>
                      <div style={{ marginTop: "0.65rem", color: "#d7d7d7", fontSize: "0.92rem", lineHeight: 1.45 }}>"{selectedClip.hook}"</div>
                    </>
                  ) : (
                    <div style={{ color: "#b9bcc4", fontSize: "0.9rem" }}>Waiting for clip metadata.</div>
                  )}
                </div>
              </div>

              {currentStep === 4 && (
                <div style={panelStyle}>
                  <div style={{ color: "#8d929c", fontSize: "0.76rem", textTransform: "uppercase", marginBottom: "0.8rem" }}>Fine-tune trim & re-render</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 170px 170px", gap: "0.8rem", alignItems: "end" }}>
                    <label style={{ display: "block" }}>
                      <span style={{ display: "block", fontSize: "0.82rem", color: "#c7c9cf", marginBottom: "0.35rem" }}>Instruction or focus</span>
                      <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} style={{ width: "100%", height: 62, boxSizing: "border-box", background: "#15161a", color: "#fff", border: "1px solid #34363a", borderRadius: "6px", padding: "0.6rem", resize: "vertical" }} />
                    </label>
                    <label style={{ display: "block" }}>
                      <span style={{ display: "block", fontSize: "0.82rem", color: "#c7c9cf", marginBottom: "0.35rem" }}>Target duration</span>
                      <input type="number" min={3} max={120} value={duration} onChange={(e) => setDuration(Number(e.target.value))} style={{ width: "100%", boxSizing: "border-box", background: "#15161a", color: "#fff", border: "1px solid #34363a", borderRadius: "6px", padding: "0.65rem" }} />
                    </label>
                    <button onClick={handleGenerateShort} disabled={submitting} style={{ padding: "0.74rem", borderRadius: "6px", border: 0, background: "#4a9eff", color: "#fff", fontWeight: 700, cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.7 : 1 }}>
                      {submitting ? "Rendering..." : "Re-render"}
                    </button>
                  </div>
                </div>
              )}

              <div style={{ ...panelStyle, maxHeight: 170, overflowY: "auto", fontFamily: "Consolas, monospace", fontSize: "0.78rem", color: "#b9bcc4" }}>
                <div style={{ color: "#8d929c", fontFamily: "inherit", fontSize: "0.76rem", textTransform: "uppercase", marginBottom: "0.65rem" }}>Logs</div>
                {logs.map((line, i) => <div key={`${line}-${i}`} style={{ marginBottom: "0.35rem", whiteSpace: "pre-wrap" }}>{line}</div>)}
                <div ref={logsEndRef} />
              </div>
            </div>

            <style dangerouslySetInnerHTML={{ __html: "@keyframes spin { 100% { transform: rotate(360deg); } } @media (max-width: 860px) { section { grid-template-columns: 1fr !important; } }" }} />
          </section>
        ) : !source ? (
          <section style={{ minHeight: "calc(100vh - 130px)", display: "grid", placeItems: "center", textAlign: "center" }}>
            <label
              htmlFor="shorts-file"
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              style={{ display: "block", cursor: uploading ? "default" : "pointer", border: `3px dashed ${dragging ? "#4a9eff" : "#444"}`, borderRadius: "8px", padding: "4rem", width: "100%", maxWidth: "620px", backgroundColor: dragging ? "#182a42" : "#202124", boxSizing: "border-box", pointerEvents: uploading ? "none" : "auto" }}
            >
              <h1 style={{ margin: "0 0 0.5rem" }}>Create a Short</h1>
              <p style={{ color: "#aaa", margin: "0 0 2rem" }}>Upload a long video. AutoEdit will crop, caption, and render a 9:16 MP4.</p>
              {uploading ? (
                <>
                  <div style={{ fontSize: "1.4rem", marginBottom: "1rem" }}>Uploading... {uploadProgress}%</div>
                  <div style={{ height: 6, background: "#333", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${uploadProgress}%`, background: "#4a9eff" }} />
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: "1.35rem", fontWeight: 700, marginBottom: "0.5rem" }}>Drop your video here</div>
                  <div style={{ color: "#888" }}>or click to browse</div>
                </>
              )}
              <input ref={inputRef} id="shorts-file" type="file" accept="video/*" style={{ display: "none" }} onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileUpload(file);
              }} />
            </label>
          </section>
        ) : (
          <section style={{ width: "100%", maxWidth: "720px", margin: "2rem auto", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
            <div style={{ ...panelStyle, display: "flex", gap: "1rem", alignItems: "center" }}>
              <video src={source.url} style={{ width: 128, height: 72, objectFit: "cover", borderRadius: 6, background: "#000" }} muted playsInline />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{source.filename}</div>
                <div style={{ color: "#aaa", fontSize: "0.88rem", marginTop: "0.25rem" }}>{formatDuration(source.duration)} · {source.width}x{source.height} · {source.fps}fps</div>
              </div>
              <button onClick={() => { setSource(null); setServerSessionId(null); }} style={{ background: "none", border: 0, color: "#4a9eff", cursor: "pointer" }}>Change</button>
            </div>

            <label>
              <span style={{ display: "block", fontWeight: 700, marginBottom: "0.5rem" }}>Instruction or focus</span>
              <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Example: roasting, funniest moment, strongest hook" style={{ width: "100%", height: 100, boxSizing: "border-box", background: "#202124", color: "#fff", border: "1px solid #34363a", borderRadius: "8px", padding: "0.75rem", resize: "vertical" }} />
            </label>

            <label>
              <span style={{ display: "block", fontWeight: 700, marginBottom: "0.5rem" }}>Target duration: {duration}s</span>
              <input type="range" min="15" max="90" value={duration} onChange={(e) => setDuration(Number(e.target.value))} style={{ width: "100%", accentColor: "#4a9eff" }} />
            </label>

            <div>
              <div style={{ fontWeight: 700, marginBottom: "0.75rem" }}>Caption style</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.75rem" }}>
                {CAPTION_STYLES.map((style) => (
                  <button key={style.id} onClick={() => setCaptionStyle(style.id)} style={{ textAlign: "left", background: captionStyle === style.id ? "#1d3554" : "#202124", color: "#fff", border: `1px solid ${captionStyle === style.id ? "#4a9eff" : "#34363a"}`, borderRadius: "8px", padding: "0.85rem", cursor: "pointer" }}>
                    <div style={{ fontWeight: 700 }}>{style.label}</div>
                    <div style={{ color: "#aaa", fontSize: "0.84rem", marginTop: "0.3rem" }}>{style.description}</div>
                  </button>
                ))}
              </div>
            </div>

            <button onClick={handleGenerateShort} disabled={submitting} style={{ padding: "1rem", borderRadius: "8px", border: 0, background: "#4a9eff", color: "#fff", fontWeight: 800, cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.7 : 1 }}>
              {submitting ? "Starting..." : "Generate Short"}
            </button>
          </section>
        )}
      </div>
    </main>
  );
}
