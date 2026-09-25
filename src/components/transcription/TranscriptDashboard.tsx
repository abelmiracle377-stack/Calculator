import { Activity, ArrowUpRight, BrainCircuit, Clock3, FileAudio, Mic2, Plus, Sparkles, Languages } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import type { TranscriptionSessionRecord } from "@/lib/transcription/types";

interface TranscriptDashboardProps {
  sessions: TranscriptionSessionRecord[];
  creating: boolean;
  onNew: () => void;
}

const chartData = [
  { day: "Mon", minutes: 18 },
  { day: "Tue", minutes: 32 },
  { day: "Wed", minutes: 24 },
  { day: "Thu", minutes: 46 },
  { day: "Fri", minutes: 39 },
  { day: "Sat", minutes: 28 },
  { day: "Sun", minutes: 52 },
];

export function TranscriptDashboard({ sessions, creating, onNew }: TranscriptDashboardProps) {
  const completed = sessions.filter((item) => item.status === "completed").length;
  const recordedMs = sessions.reduce((total, item) => total + Math.max(0, item.duration_ms || 0), 0);
  const hours = (recordedMs / 3_600_000).toFixed(1);
  const active = sessions.filter((item) => item.status === "recording").length;
  const translated = sessions.filter((item) => item.translation_target_language && item.translation_target_language !== "en").length;
  const recent = sessions.slice(0, 4);

  return (
    <div className="tx-dashboard">
      <section className="tx-dashboard-hero">
        <div>
          <p className="tx-kicker">Transcript.art workspace</p>
          <h2>Turn conversations into searchable intelligence.</h2>
          <p>Capture audio, transcribe it, refine the transcript with AI, translate it, and export a clean final record.</p>
          <div className="tx-dashboard-actions">
            <Button type="button" className="tx-btn-record" onClick={onNew} disabled={creating}>
              <Plus className="h-4 w-4" /> New transcription
            </Button>
            <span className="tx-dashboard-status"><span /> Workspace ready</span>
          </div>
        </div>
        <div className="tx-dashboard-orb" aria-hidden><div><Mic2 className="h-8 w-8" /><span>AI audio desk</span></div></div>
      </section>

      <section className="tx-metric-grid" aria-label="Workspace overview">
        <Metric icon={<FileAudio />} label="Sessions" value={sessions.length.toLocaleString()} detail="Stored in your workspace" />
        <Metric icon={<Clock3 />} label="Audio processed" value={hours + "h"} detail="Across recorded sessions" tone="mint" />
        <Metric icon={<BrainCircuit />} label="Completed" value={completed.toLocaleString()} detail={active ? `${active} recording now` : "Ready for review"} tone="coral" />
        <Metric icon={<Languages />} label="Translations" value={translated.toLocaleString()} detail="Non-default language targets" />
      </section>

      <section className="tx-dashboard-grid">
        <div className="tx-dashboard-card tx-dashboard-chart">
          <div className="tx-dashboard-card-head"><div><p className="tx-kicker">Activity</p><h3>Audio processed</h3></div><span className="tx-dashboard-period"><Activity className="h-3.5 w-3.5" /> Last 7 days</span></div>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 12, right: 8, left: -24, bottom: 0 }}>
                <defs><linearGradient id="transcriptArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="hsl(var(--mint))" stopOpacity={0.34} /><stop offset="100%" stopColor="hsl(var(--mint))" stopOpacity={0} /></linearGradient></defs>
                <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
                <Tooltip contentStyle={{ background: "hsl(var(--ink-elevated))", border: "1px solid hsl(var(--line))", borderRadius: 12, color: "hsl(var(--foreground))" }} formatter={(value) => [`${value} min`, "Audio"]} />
                <Area type="monotone" dataKey="minutes" stroke="hsl(var(--mint))" strokeWidth={2} fill="url(#transcriptArea)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="tx-dashboard-card">
          <div className="tx-dashboard-card-head"><div><p className="tx-kicker">Recent work</p><h3>Latest sessions</h3></div><ArrowUpRight className="h-4 w-4 text-muted-foreground" /></div>
          <div className="tx-recent-list">
            {recent.length ? recent.map((item) => (
              <div className="tx-recent-item" key={item.id}>
                <span className={`tx-recent-icon status-${item.status}`}><Mic2 className="h-3.5 w-3.5" /></span>
                <div className="min-w-0"><strong>{item.title || "Untitled session"}</strong><span>{item.source_label || "No source"} · {item.duration_ms ? `${Math.round(item.duration_ms / 60000)} min` : "No audio yet"}</span></div>
                <span className={`tx-status-pill status-${item.status}`}>{item.status}</span>
              </div>
            )) : <div className="tx-dashboard-empty"><Sparkles className="h-5 w-5" /><span>Your first transcription will appear here.</span></div>}
          </div>
        </div>
      </section>

      <section className="tx-capability-strip">
        <div><BrainCircuit className="h-5 w-5" /><span><strong>AI-assisted review</strong> Clean transcript wording while preserving timestamps and speaker context.</span></div>
        <div><Languages className="h-5 w-5" /><span><strong>Multilingual workflow</strong> Detect, translate, and prepare exports from the same session.</span></div>
        <div><Activity className="h-5 w-5" /><span><strong>Live capture</strong> Monitor browser-tab audio and build independently playable clips.</span></div>
      </section>
    </div>
  );
}

function Metric({ icon, label, value, detail, tone = "neutral" }: { icon: React.ReactNode; label: string; value: string; detail: string; tone?: "neutral" | "mint" | "coral" }) {
  return <div className={`tx-metric-card is-${tone}`}><span className="tx-metric-icon">{icon}</span><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>;
}
