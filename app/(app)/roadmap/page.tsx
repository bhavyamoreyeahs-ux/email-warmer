import { CalendarClock, FlaskConical, Plug, Thermometer, type LucideIcon } from "lucide-react";
import { requirePage } from "@/lib/auth/page";
import { ROADMAP_INTEGRATIONS } from "@/lib/integrations/service";
import { Callout, PageHeader, Pill } from "@/components/ui/primitives";

export const metadata = { title: "Roadmap" };

interface RoadmapItem {
  key: string;
  name: string;
  icon: LucideIcon;
  summary: string;
  planned: string[];
  notDoing: string[];
}

const ITEMS: RoadmapItem[] = [
  {
    key: "warmup",
    name: "Warm-up Center",
    icon: Thermometer,
    summary: "Deferred. A controlled, opt-in warm-up scheduler that ramps a new mailbox's real sending volume gradually.",
    planned: ["Opt-in only: nothing starts until you choose the mailboxes and the schedule.", "Based on real sending activity and the health signals QuikReach already observes."],
    notDoing: ["No automated engagement exchanges (warm-up networks that send and open each other's mail).", "No fabricated engagement — no fake opens, replies or “not spam” rescues."],
  },
  {
    key: "placement",
    name: "Inbox Placement Lab",
    icon: FlaskConical,
    summary: "Deferred. Placement tests sent to seed mailboxes that you or a provider have authorised, reporting where each test message landed.",
    planned: ["Tests only to seed mailboxes you are authorised to use.", "Results labelled with their sample size and the date of the test."],
    notDoing: ["QuikReach does not show inbox placement results until a genuine implementation exists — no estimates, scores or simulated results in the meantime."],
  },
];

function RoadmapCard({ id, name, icon: Icon, summary, planned, notDoing }: Omit<RoadmapItem, "key"> & { id: string }) {
  return (
    <article aria-labelledby={`roadmap-${id}`} className="flex flex-col rounded-lg border border-dashed border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon aria-hidden className="h-5 w-5 text-muted" />
          <h2 id={`roadmap-${id}`} className="text-base font-medium text-ink">
            {name}
          </h2>
        </div>
        <Pill tone="unknown">Not available in this release</Pill>
      </div>
      <p className="mt-3 text-sm text-muted">{summary}</p>
      {planned.length ? (
        <>
          <h3 className="mt-4 text-xs font-medium uppercase tracking-[0.08em] text-muted">Intended scope</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
            {planned.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      ) : null}
      {notDoing.length ? (
        <>
          <h3 className="mt-4 text-xs font-medium uppercase tracking-[0.08em] text-muted">What QuikReach will not do</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
            {notDoing.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      ) : null}
    </article>
  );
}

export default async function RoadmapPage() {
  await requirePage();
  return (
    <>
      <PageHeader
        title="Coming later"
        lede="Capabilities that are deliberately not part of this release. Nothing on this page is active, and QuikReach shows no results for them."
        meta={
          <span className="inline-flex items-center gap-1">
            <CalendarClock aria-hidden className="h-3.5 w-3.5" /> No dates are committed.
          </span>
        }
      />
      <div className="mb-6">
        <Callout tone="unknown">Everything below is not available in this release. There are no previews, sample results or placeholder numbers for these features.</Callout>
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {ITEMS.map(({ key, ...item }) => (
          <RoadmapCard key={key} id={key} {...item} />
        ))}
        {ROADMAP_INTEGRATIONS.map((r) => (
          <RoadmapCard key={r.kind} id={r.kind} name={`${r.name} integration`} icon={Plug} summary={r.description} planned={[]} notDoing={[]} />
        ))}
      </div>
    </>
  );
}
