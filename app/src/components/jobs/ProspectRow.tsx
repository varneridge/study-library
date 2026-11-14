// A prospect card in the graduate shortlist on phone viewports (below 60rem),
// built on the shared JobCard so it matches an application card. Its next
// check banner carries a Checked button, which moves the check a week on in
// place without opening the card.

import { formatDate } from "../../lib/jobs";
import {
  checkState,
  checkWords,
  effectiveProspectStatus,
  isProspectOpen,
  parseProspectLink,
} from "../../lib/prospects";
import type { ApplicationRow, ProspectRow as Prospect } from "../../lib/types";
import { JobCard } from "./JobCard";
import { CheckedButton } from "./ProspectControls";

export function ProspectRow({
  prospect,
  linkedApp,
}: {
  prospect: Prospect;
  linkedApp?: ApplicationRow;
}) {
  const status = effectiveProspectStatus(prospect, linkedApp);
  const open = isProspectOpen(prospect, linkedApp);
  const state = open ? checkState(prospect, linkedApp) : "none";
  const cWords = open ? checkWords(prospect, linkedApp) : "";
  const isLinked = Boolean(linkedApp && !linkedApp.deleted);

  return (
    <JobCard
      dataKey="prospect"
      id={prospect.id}
      to={{ view: "jobs", list: "shortlist", prospect: prospect.id }}
      employer={prospect.employer}
      fallbackEmployer="Programme"
      subtitle={prospect.programme}
      status={status}
      statusWord="Status"
      closed={!open}
      timing={prospect.next_check ? { state, label: cWords || "Next check", date: formatDate(prospect.next_check) } : null}
      emptyTiming="No next check date set"
      timingAction={<CheckedButton prospect={prospect} linkedApp={linkedApp} inCard />}
      salary={prospect.salary}
      link={parseProspectLink(prospect.link)}
      meta={[prospect.last_year_open && `Last open: ${prospect.last_year_open}`]}
      badges={isLinked ? [{ key: "applied", label: "Applied" }] : []}
      badgesTitle="Added to applications"
    />
  );
}
