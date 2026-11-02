// Flat list of applications for phone viewports (below 60rem).
// Scannable, accessible, and separates closed applications under their own heading.

import { Fragment } from "react";
import type { ApplicationEventRow, ApplicationRow } from "../../lib/types";
import { currentStageSince, isOpen } from "../../lib/jobs";
import { AppRow } from "./AppRow";

export function AppList({
  apps,
  eventsFor,
  closedHeading,
}: {
  apps: ApplicationRow[];
  eventsFor: (id: string) => ApplicationEventRow[];
  closedHeading: boolean;
}) {
  return (
    <ul className="app-cards app-list" aria-label="Applications">
      {apps.map((app, i) => {
        const showClosedHead =
          closedHeading &&
          !isOpen(app) &&
          (i === 0 || isOpen(apps[i - 1]));
        const events = eventsFor(app.id);
        const since = currentStageSince(app, events);

        return (
          <Fragment key={app.id}>
            {showClosedHead && (
              <li className="closed-head" role="separator">
                <h2 className="closed-title">Closed</h2>
              </li>
            )}
            <AppRow app={app} since={since} />
          </Fragment>
        );
      })}
    </ul>
  );
}
