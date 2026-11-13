// Flat list of shortlist cards for phone viewports (below 60rem).

import { Fragment } from "react";
import type { ApplicationRow, ProspectRow } from "../../lib/types";
import { isProspectOpen } from "../../lib/prospects";
import { ProspectRow as ProspectRowCard } from "./ProspectRow";

export function ProspectList({
  prospects,
  appsById,
  closedHeading,
}: {
  prospects: ProspectRow[];
  appsById: Map<string, ApplicationRow>;
  closedHeading: boolean;
}) {
  return (
    <ul className="app-cards app-list" aria-label="Shortlist">
      {prospects.map((p, i) => {
        const linked = p.application_id ? appsById.get(p.application_id) : undefined;
        const open = isProspectOpen(p, linked);
        const prevLinked = i > 0 && prospects[i - 1].application_id ? appsById.get(prospects[i - 1].application_id!) : undefined;
        const showClosedHead =
          closedHeading &&
          !open &&
          (i === 0 || isProspectOpen(prospects[i - 1], prevLinked));

        return (
          <Fragment key={p.id}>
            {showClosedHead && (
              <li className="closed-head" role="separator">
                <h2 className="closed-title">Closed</h2>
              </li>
            )}
            <ProspectRowCard prospect={p} linkedApp={linked} />
          </Fragment>
        );
      })}
    </ul>
  );
}
