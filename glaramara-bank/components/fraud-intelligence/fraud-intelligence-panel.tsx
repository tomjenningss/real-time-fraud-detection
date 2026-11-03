"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  Gauge,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  FraudIntelligenceView,
  FraudIntelligenceViewResponse,
  InvestigationStage,
  InvestigationStageId,
  InvestigationStageStatus,
  InvestigationTimelineEvent,
  JsonValue,
} from "@/lib/fraud-intelligence-view";
import { bankingFetch } from "@/lib/banking-api";
import { cn } from "@/lib/utils";

type ReplayMode = "LIVE" | "PLAYING" | "PAUSED" | "COMPLETE";
type ReplayItem = InvestigationTimelineEvent & { offsetMs: number };

const nodePositions: Record<InvestigationStageId, { x: number; y: number }> = {
  payment_submitted: { x: 12, y: 24 },
  postgres_outbox: { x: 199, y: 24 },
  kafka: { x: 386, y: 24 },
  flink_enrichment: { x: 573, y: 24 },
  authoritative_policy: { x: 105, y: 176 },
  lightgbm_shadow: { x: 503, y: 176 },
  go_correlation: { x: 304, y: 326 },
  go_shadow_policy: { x: 503, y: 462 },
  customer_questionnaire: { x: 12, y: 626 },
  fraud_intelligence_provider: { x: 199, y: 626 },
  structured_evidence: { x: 386, y: 626 },
  governed_reassessment: { x: 573, y: 626 },
  simulated_outcome: { x: 573, y: 758 },
};

const edges: Array<{
  id: string;
  from: InvestigationStageId;
  to: InvestigationStageId;
  path: string;
  kind?: "shadow" | "reassessment";
}> = [
  { id: "submit-outbox", from: "payment_submitted", to: "postgres_outbox", path: "M176 72 H199" },
  { id: "outbox-kafka", from: "postgres_outbox", to: "kafka", path: "M363 72 H386" },
  { id: "kafka-flink", from: "kafka", to: "flink_enrichment", path: "M550 72 H573" },
  { id: "flink-router", from: "flink_enrichment", to: "authoritative_policy", path: "M655 120 C655 145 187 142 187 176" },
  { id: "flink-ml", from: "flink_enrichment", to: "lightgbm_shadow", path: "M655 120 C655 145 585 142 585 176", kind: "shadow" },
  { id: "router-correlation", from: "authoritative_policy", to: "go_correlation", path: "M187 272 C187 303 386 294 386 326", kind: "shadow" },
  { id: "ml-correlation", from: "lightgbm_shadow", to: "go_correlation", path: "M585 272 C585 303 386 294 386 326", kind: "shadow" },
  { id: "correlation-shadow", from: "go_correlation", to: "go_shadow_policy", path: "M468 374 C523 374 585 405 585 462", kind: "shadow" },
  { id: "router-questionnaire", from: "authoritative_policy", to: "customer_questionnaire", path: "M145 272 C145 410 94 478 94 626", kind: "reassessment" },
  { id: "questionnaire-provider", from: "customer_questionnaire", to: "fraud_intelligence_provider", path: "M176 674 H199", kind: "reassessment" },
  { id: "provider-structured", from: "fraud_intelligence_provider", to: "structured_evidence", path: "M363 674 H386", kind: "reassessment" },
  { id: "structured-reassessment", from: "structured_evidence", to: "governed_reassessment", path: "M550 674 H573", kind: "reassessment" },
  { id: "reassessment-outcome", from: "governed_reassessment", to: "simulated_outcome", path: "M655 722 V758", kind: "reassessment" },
];

export function FraudIntelligencePanel({ paymentId }: { paymentId: string }) {
  const [data, setData] = useState<FraudIntelligenceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<InvestigationStageId | null>(null);
  const [mode, setMode] = useState<ReplayMode>("LIVE");
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [replay, setReplay] = useState<ReplayItem[]>([]);
  const pollCount = useRef(0);

  const load = useCallback(async () => {
    try {
      const response = await bankingFetch<FraudIntelligenceViewResponse>(
        `/api/v1/payments/${encodeURIComponent(paymentId)}/fraud-intelligence`,
      );
      setData(response.investigation);
      setError(null);
      pollCount.current += 1;
      return response.investigation;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Fraud Intelligence evidence is unavailable.");
      return null;
    }
  }, [paymentId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const latest = await load();
      if (cancelled) return;
      const active = latest?.stages.some((item) => item.status === "PENDING" || item.status === "PROCESSING") ?? true;
      timer = setTimeout(poll, active && pollCount.current < 80 ? 1_500 : 10_000);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const replayDuration = replay.at(-1)?.offsetMs ?? 0;
  useEffect(() => {
    if (mode !== "PLAYING") return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = now - previous;
      previous = now;
      setElapsedMs((current) => {
        const next = Math.min(replayDuration, current + delta * speed);
        if (next >= replayDuration) setMode("COMPLETE");
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mode, replayDuration, speed]);

  function beginReplay() {
    if (!data?.timeline.length) return;
    const first = new Date(data.timeline[0].occurredAt).getTime();
    const last = new Date(data.timeline.at(-1)!.occurredAt).getTime();
    const range = Math.max(1, last - first);
    const duration = Math.min(22_000, Math.max(7_000, 6_000 + Math.log1p(range / 1_000) * 1_550));
    const items = data.timeline.map((event) => {
      const raw = Math.max(0, new Date(event.occurredAt).getTime() - first);
      const ratio = raw === 0 ? 0 : Math.log1p(raw) / Math.log1p(range);
      return { ...event, offsetMs: ratio * duration };
    });
    setReplay(items);
    setElapsedMs(0);
    setSelectedId(null);
    setMode("PLAYING");
  }

  function replayStatus(stage: InvestigationStage): InvestigationStageStatus {
    if (mode === "LIVE") return stage.status;
    if (stage.status === "NOT_APPLICABLE") return "NOT_APPLICABLE";
    const stageEvents = replay.filter((event) => event.stageId === stage.id);
    const reached = stageEvents.filter((event) => event.offsetMs <= elapsedMs).at(-1);
    if (reached) return reached.status;
    const next = stageEvents[0];
    if (next && next.offsetMs - elapsedMs <= 850) return "PROCESSING";
    return stage.status === "NOT_OBSERVED" ? "NOT_OBSERVED" : "PENDING";
  }

  const stages = useMemo(() => new Map(
    (data?.stages ?? []).map((item) => [item.id, { ...item, status: replayStatus(item) }]),
  ), [data?.stages, elapsedMs, mode, replay]);
  const selected = selectedId ? stages.get(selectedId) ?? null : null;

  return (
    <section className="fraud-system-panel relative min-w-0 overflow-hidden rounded-[22px] border border-[#d9e5d7] bg-[#f9fcf7] shadow-[0_18px_55px_#173f3310]" aria-label="Fraud Intelligence system view">
      <div className="border-b border-[#dfe8dc] bg-[linear-gradient(135deg,#173f33_0%,#214f3f_70%,#2d634e_100%)] px-5 pb-4 pt-5 text-white">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[9px] font-extrabold tracking-[.18em] text-[#bcd9c4]">
              <Sparkles className="size-3" aria-hidden="true" /> LIVE FRAUD INTELLIGENCE
            </div>
            <h2 className="mt-1.5 text-lg font-extrabold tracking-[-.45px]">System investigation</h2>
            <p className="mt-1 text-[10px] leading-relaxed text-[#d8e9dc]">Persisted evidence · read only · no decision authority</p>
          </div>
          <div className="rounded-full border border-[#ffffff2e] bg-[#ffffff12] px-2.5 py-1.5 text-[9px] font-extrabold tracking-[.08em]">
            {data?.authoritativeVerdict ?? "LOADING"}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2" aria-label="Investigation replay controls">
          {mode === "LIVE" ? (
            <ControlButton onClick={beginReplay} disabled={!data?.timeline.length}><Play className="size-3" /> Replay investigation</ControlButton>
          ) : (
            <>
              <ControlButton onClick={() => setMode(mode === "PLAYING" ? "PAUSED" : "PLAYING")}>
                {mode === "PLAYING" ? <Pause className="size-3" /> : <Play className="size-3" />}
                {mode === "PLAYING" ? "Pause" : mode === "COMPLETE" ? "Replay" : "Resume"}
              </ControlButton>
              <ControlButton onClick={beginReplay}><RotateCcw className="size-3" /> Restart</ControlButton>
              <label className="flex items-center gap-1.5 text-[9px] font-bold text-[#dceadf]">
                Speed
                <select value={speed} onChange={(event) => setSpeed(Number(event.target.value) as 1 | 2 | 4)} className="rounded-md border border-[#ffffff2b] bg-[#ffffff14] px-1.5 py-1 text-[10px] font-bold text-white outline-none">
                  <option className="text-[#173f33]" value={1}>1×</option>
                  <option className="text-[#173f33]" value={2}>2×</option>
                  <option className="text-[#173f33]" value={4}>4×</option>
                </select>
              </label>
              <ControlButton onClick={() => { setMode("LIVE"); setElapsedMs(0); }}>Live</ControlButton>
            </>
          )}
          <button type="button" onClick={() => void load()} className="ml-auto grid size-7 place-items-center rounded-lg border border-[#ffffff29] text-[#dceadf] transition hover:bg-white/10" aria-label="Refresh investigation evidence">
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        {mode !== "LIVE" && (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-[#ffffff20]" aria-label={`Replay ${Math.round((elapsedMs / Math.max(1, replayDuration)) * 100)} percent complete`}>
            <div className="h-full rounded-full bg-[#bce496] transition-[width]" style={{ width: `${Math.min(100, (elapsedMs / Math.max(1, replayDuration)) * 100)}%` }} />
          </div>
        )}
      </div>

      {error && <div className="m-4 flex items-start gap-2 rounded-xl border border-[#efd4d0] bg-[#fff6f4] p-3 text-[10px] leading-relaxed text-[#8c4841]"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{error}</div>}
      {!data && !error && <div className="grid min-h-[520px] place-items-center text-xs text-[#6c7c71]"><RefreshCw className="mr-2 inline size-4 animate-spin" />Loading persisted evidence…</div>}
      {data && (
        <>
          <div className="px-3 pb-1 pt-3">
            <div className="flex flex-wrap gap-3 px-2 text-[8px] font-extrabold tracking-[.1em] text-[#6f8074]">
              <Legend colour="bg-[#39845d]" label="AUTHORITATIVE" />
              <Legend colour="border border-dashed border-[#718c7a] bg-[#edf2ed]" label="SHADOW ONLY" />
              <Legend colour="bg-[#cce5ad]" label="REASSESSMENT" />
            </div>
          </div>
          <div className="overflow-x-auto px-2 pb-4" data-testid="fraud-architecture-diagram">
            <svg viewBox="0 0 750 866" className="mx-auto block min-w-[620px]" role="img" aria-label="Live fraud-platform dependency diagram">
              <defs>
                <filter id="system-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                <marker id="system-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#769282" /></marker>
                <marker id="system-arrow-shadow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#9aaa9f" /></marker>
              </defs>
              <text x="12" y="155" className="system-lane-label">INITIAL PAYMENT DECISION</text>
              <text x="304" y="307" className="system-lane-label">CORRELATED SHADOW EVIDENCE</text>
              <line x1="12" x2="738" y1="584" y2="584" stroke="#d9e4d6" strokeDasharray="4 6" />
              <text x="12" y="608" className="system-lane-label">SUBSEQUENT CUSTOMER EVIDENCE · SIMULATED REASSESSMENT</text>
              {edges.map((edge) => {
                const from = stages.get(edge.from);
                const to = stages.get(edge.to);
                const applicable = to?.status !== "NOT_APPLICABLE";
                const energised = applicable && from?.status === "COMPLETE";
                return (
                  <g key={edge.id} className={cn(!applicable && "opacity-20")}>
                    <path id={`edge-${edge.id}`} d={edge.path} fill="none" stroke={edge.kind === "shadow" ? "#a8b7ad" : edge.kind === "reassessment" ? "#9ab77e" : "#769282"} strokeWidth={energised ? 1.8 : 1.2} strokeDasharray={edge.kind === "shadow" ? "4 5" : undefined} markerEnd={`url(#${edge.kind === "shadow" ? "system-arrow-shadow" : "system-arrow"})`} />
                    {energised && (
                      <>
                        <circle r="3.2" fill={edge.kind === "shadow" ? "#7eaa88" : "#63bd78"} className="system-flow-particle" filter="url(#system-glow)">
                          <animateMotion dur={`${Math.max(1.4, 4.8 / speed)}s`} repeatCount="indefinite" path={edge.path} />
                        </circle>
                        <circle r="2.1" fill="#b8e98b" className="system-flow-particle" opacity=".72">
                          <animateMotion dur={`${Math.max(1.4, 4.8 / speed)}s`} begin="-2.4s" repeatCount="indefinite" path={edge.path} />
                        </circle>
                      </>
                    )}
                  </g>
                );
              })}
              {[...stages.values()].map((item) => (
                <ArchitectureNode key={item.id} stage={item} position={nodePositions[item.id]} selected={selectedId === item.id} onSelect={() => setSelectedId(item.id)} />
              ))}
              <text x="226" y="157" className="system-edge-note">parallel branches</text>
              <text x="22" y="430" className="system-edge-note">challenge only</text>
            </svg>
          </div>
        </>
      )}

      {selected && <EvidenceDrawer stage={selected} onClose={() => setSelectedId(null)} />}
    </section>
  );
}

function ArchitectureNode({ stage, position, selected, onSelect }: {
  stage: InvestigationStage;
  position: { x: number; y: number };
  selected: boolean;
  onSelect: () => void;
}) {
  const shadow = stage.authority === "SHADOW_ONLY";
  const reassessment = stage.authority === "SIMULATED";
  const watsonx = stage.id === "fraud_intelligence_provider" && stage.component === "IBM";
  return (
    <foreignObject x={position.x} y={position.y} width="164" height="98">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "system-node group h-[96px] w-[164px] overflow-hidden rounded-[15px] border bg-white px-3 py-2.5 text-left shadow-[0_8px_24px_#173f330d] transition",
          shadow && "border-dashed border-[#a8b6ac] bg-[#f5f7f4]",
          reassessment && "border-[#d4e4c4] bg-[#fbfdf8]",
          stage.status === "PROCESSING" && "system-node-processing border-[#66a778]",
          stage.status === "COMPLETE" && "border-[#a9cda9]",
          stage.status === "FAILED" && "border-[#db9b94] bg-[#fff8f7]",
          stage.status === "NOT_APPLICABLE" && "opacity-40 grayscale",
          selected && "ring-2 ring-[#275A47] ring-offset-2",
          watsonx && stage.status === "COMPLETE" && "system-node-watsonx border-[#61a67a] bg-[linear-gradient(145deg,#f5fff6,#e8f5e8)]",
        )}
        aria-label={`${stage.label}: ${stage.status.toLowerCase().replaceAll("_", " ")}. Open evidence details.`}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-[8px] font-extrabold uppercase tracking-[.1em] text-[#718077]">{stage.component}</span>
          <StatusMark status={stage.status} />
        </span>
        <strong className="mt-1.5 block text-[11px] font-extrabold leading-tight tracking-[-.15px] text-[#183b2f]">{stage.label}</strong>
        <span className="mt-1.5 line-clamp-2 block text-[8px] leading-[1.35] text-[#68796e]">{stage.summary}</span>
        {shadow && <span className="mt-1 block text-[7px] font-extrabold tracking-[.09em] text-[#74867b]">SHADOW ONLY</span>}
      </button>
    </foreignObject>
  );
}

function StatusMark({ status }: { status: InvestigationStageStatus }) {
  if (status === "COMPLETE") return <span className="grid size-4 place-items-center rounded-full bg-[#dff2d8] text-[#2b7547]"><Check className="size-2.5 stroke-[3]" /></span>;
  if (status === "PROCESSING") return <span className="system-pulse grid size-4 place-items-center rounded-full bg-[#e7f2df] text-[#397650]"><RefreshCw className="size-2.5 animate-spin" /></span>;
  if (status === "FAILED") return <span className="grid size-4 place-items-center rounded-full bg-[#f8dfdc] text-[#9a403b]"><X className="size-2.5 stroke-[3]" /></span>;
  if (status === "NOT_APPLICABLE") return <span className="text-[7px] font-bold text-[#89958d]">N/A</span>;
  if (status === "NOT_OBSERVED") return <span className="grid size-4 place-items-center rounded-full border border-[#bdc8c0] text-[#829087]">?</span>;
  return <span className="size-2 rounded-full border border-[#9caaa1]" />;
}

function EvidenceDrawer({ stage, onClose }: { stage: InvestigationStage; onClose: () => void }) {
  const [rawOpen, setRawOpen] = useState(false);
  const summary = Array.isArray(stage.details.humanSummary)
    ? stage.details.humanSummary.filter((item): item is string => typeof item === "string") : [];
  const provenance = Array.isArray(stage.details.provenance) ? stage.details.provenance : [];
  const raw = stage.details.structuredResponse ?? stage.rawJson ?? stage.details;
  return (
    <div className="absolute inset-0 z-20 flex justify-end bg-[#173f332b] backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="h-full w-full max-w-[430px] overflow-y-auto border-l border-[#d7e2d4] bg-[#fbfdf9] p-5 shadow-[-18px_0_50px_#173f3322]" aria-label={`${stage.label} evidence details`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[9px] font-extrabold tracking-[.14em] text-[#64806e]">{stage.component.toUpperCase()} · {stage.authority.replaceAll("_", " ")}</p>
            <h3 className="mt-1 text-xl font-extrabold tracking-[-.55px] text-[#173f33]">{stage.label}</h3>
          </div>
          <button type="button" onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-full border border-[#dce5d9] bg-white text-[#416251]" aria-label="Close evidence details"><X className="size-4" /></button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Pill>{stage.status.replaceAll("_", " ")}</Pill>
          <Pill>{stage.observation.replaceAll("_", " ")}</Pill>
          {stage.durationMs !== null && <Pill>{formatDuration(stage.durationMs)}</Pill>}
        </div>
        <p className="mt-4 text-[11px] leading-relaxed text-[#536b5d]">{stage.summary}</p>

        {summary.length > 0 && (
          <div className="mt-5 rounded-[15px] border border-[#cfe2cb] bg-[linear-gradient(145deg,#eef8e9,#f9fcf7)] p-4">
            <div className="flex items-center gap-2 text-[9px] font-extrabold tracking-[.12em] text-[#3e7654]"><Sparkles className="size-3.5" /> VALIDATED FINDINGS</div>
            <ul className="mt-3 space-y-2 text-[11px] leading-relaxed text-[#405b4b]">
              {summary.map((item) => <li className="flex gap-2" key={item}><Check className="mt-0.5 size-3.5 shrink-0 text-[#4f9664]" />{item}</li>)}
            </ul>
          </div>
        )}

        <dl className="mt-5 divide-y divide-[#e5ebe2] rounded-[14px] border border-[#e0e8dd] bg-white px-4">
          {stage.occurredAt && <Detail label="Event time" value={formatTime(stage.occurredAt)} icon={<Clock3 />} />}
          {stage.observedAt && <Detail label="Observed" value={formatTime(stage.observedAt)} icon={<ShieldCheck />} />}
          {Object.entries(stage.details).filter(([key, value]) => !["humanSummary", "structuredResponse", "provenance", "assessment", "decision", "evidenceSnapshot", "answers"].includes(key) && isScalar(value)).map(([key, value]) => (
            <Detail key={key} label={humanise(key)} value={String(value ?? "Unavailable")} icon={<Gauge />} />
          ))}
        </dl>

        {provenance.length > 0 && (
          <div className="mt-5">
            <h4 className="text-[10px] font-extrabold tracking-[.1em] text-[#526c5c]">EVIDENCE PROVENANCE</h4>
            <div className="mt-2 space-y-2">
              {provenance.map((item, index) => <div key={index} className="rounded-xl border border-[#e0e8dd] bg-white p-3 text-[10px] leading-relaxed text-[#53675b]">{formatJsonValue(item)}</div>)}
            </div>
          </div>
        )}

        {stage.evidenceReferences.length > 0 && (
          <div className="mt-5">
            <h4 className="text-[10px] font-extrabold tracking-[.1em] text-[#526c5c]">REFERENCES</h4>
            <div className="mt-2 flex flex-wrap gap-1.5">{stage.evidenceReferences.map((reference) => <code key={reference} className="rounded-md bg-[#edf2eb] px-2 py-1 text-[8px] text-[#4a6555]">{reference}</code>)}</div>
          </div>
        )}

        <button type="button" onClick={() => setRawOpen((value) => !value)} className="mt-5 flex w-full items-center justify-between rounded-xl border border-[#dce5d9] bg-white px-3 py-2.5 text-left text-[10px] font-extrabold text-[#385c49]">
          <span className="flex items-center gap-2"><Code2 className="size-3.5" /> Structured JSON</span>
          {rawOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        {rawOpen && <pre className="mt-2 max-h-[340px] overflow-auto rounded-xl bg-[#132d25] p-4 text-[9px] leading-relaxed text-[#d9ebde]">{JSON.stringify(raw, null, 2)}</pre>}
        <p className="mt-5 text-[9px] leading-relaxed text-[#809087]">Only persisted evidence is shown. Missing telemetry is never reconstructed as backend fact.</p>
      </aside>
    </div>
  );
}

function ControlButton({ children, onClick, disabled = false }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} className="flex items-center gap-1.5 rounded-lg border border-[#ffffff2a] bg-[#ffffff12] px-2.5 py-1.5 text-[9px] font-extrabold text-white transition hover:bg-[#ffffff20] disabled:opacity-40">{children}</button>;
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className={cn("size-2 rounded-full", colour)} />{label}</span>;
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-[#d8e5d5] bg-[#edf5e9] px-2.5 py-1 text-[8px] font-extrabold tracking-[.05em] text-[#3f6d51]">{children}</span>;
}

function Detail({ label, value, icon }: { label: string; value: string; icon: React.ReactElement }) {
  return <div className="grid grid-cols-[18px_105px_1fr] items-start gap-2 py-3 text-[10px]"><span className="text-[#6e9079] [&>svg]:size-3.5">{icon}</span><dt className="text-[#7a8a80]">{label}</dt><dd className="break-words text-right font-semibold text-[#2e4b3c]">{value}</dd></div>;
}

function isScalar(value: JsonValue): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function humanise(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function formatDuration(value: number) {
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(2)} s`;
}

function formatJsonValue(value: JsonValue) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.claim === "string") {
    const sources = Array.isArray(value.sourceQuestionIds) ? value.sourceQuestionIds.join(", ") : "persisted response";
    return `${value.claim} · ${sources}`;
  }
  return JSON.stringify(value);
}
