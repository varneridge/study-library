// An application card in the job search, built on the shared JobCard so it
// reads exactly as a shortlist card does: employer in serif with its stage
// pill, the role, a deadline banner, then salary, link, applied date and the
// file badges. Tapping opens the application sheet without changing anything.

import { deadlineState, deadlineWords, formatDate, inStageWords, isOpen, stageOf, SLOTS, slotColumn } from "../../lib/jobs";
import { parseJobLink } from "../../lib/prospects";
import type { ApplicationRow } from "../../lib/types";
import { JobCard } from "./JobCard";

// The link written on the application, or failing that the role description
// link that promotion from the shortlist stored before links had a column.
export function applicationLink(app: ApplicationRow): string | null {
  if (app.link?.trim()) return app.link;
  const rd = app.file_rd;
  return rd && rd.state === "saved" && rd.url ? rd.url : null;
}

export function AppRow({
  app,
  since,
}: {
  app: ApplicationRow;
  since: string | null;
}) {
  const stage = stageOf(app.stage);
  const open = isOpen(app);
  const state = open ? deadlineState(app) : "none";
  const dWords = open ? deadlineWords(app) : null;
  const sWords = since && open ? inStageWords(since) : null;
  const filledSlots = SLOTS.filter((s) => Boolean(app[slotColumn(s.name)]));

  return (
    <JobCard
      dataKey="app"
      id={app.id}
      to={{ view: "jobs", app: app.id }}
      employer={app.employer}
      fallbackEmployer="Application"
      subtitle={app.role}
      status={stage}
      statusWord="Stage"
      closed={!open}
      timing={app.next_deadline ? { state, label: dWords || "Due", date: formatDate(app.next_deadline) } : null}
      emptyTiming="No upcoming deadline set"
      salary={app.salary}
      link={parseJobLink(applicationLink(app))}
      meta={[app.applied && `Applied ${formatDate(app.applied)}`, sWords]}
      badges={filledSlots.map((s) => ({ key: s.name, label: s.short }))}
      badgesTitle="Files attached"
    />
  );
}

export default AppRow;
