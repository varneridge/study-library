-- Version 0.49: salary on job applications, and the graduate shortlist of
-- prospective programmes to check and apply to.

ALTER TABLE applications ADD COLUMN salary TEXT;

CREATE TABLE prospects (
  id TEXT PRIMARY KEY,
  employer TEXT NOT NULL DEFAULT '',
  programme TEXT NOT NULL DEFAULT '',
  salary TEXT,
  link TEXT,
  last_year_open TEXT,
  next_check TEXT,
  status TEXT NOT NULL DEFAULT 'not_started',
  notes TEXT,
  application_id TEXT,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX prospects_seq ON prospects (seq);
CREATE TRIGGER prospects_seq_insert AFTER INSERT ON prospects
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE prospects SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;
CREATE TRIGGER prospects_seq_update AFTER UPDATE ON prospects
WHEN NEW.seq = OLD.seq
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'seq';
  UPDATE prospects SET seq = (SELECT value FROM counters WHERE name = 'seq') WHERE id = NEW.id;
END;

INSERT OR IGNORE INTO prospects (id, next_check, last_year_open, employer, programme, salary, link, status, modified_at)
VALUES
  ('shortlist-01', '2026-11-16', '7 Oct 2024 (2025 intake); 26 Jan 2026 (2026 intake, Leeds only)', 'Bank of England', 'Graduate Development Programme 2027', 'About £30,000 to £35,000 (2026 intake)', 'https://www.bankofengland.co.uk/careers/future-talent/graduate-programme', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-02', '2026-11-16', 'Not found', 'Ofgem', 'Graduate Programme (Policy and Strategy, Analysis)', '£29,500 to £32,500 (recent listing)', 'https://www.ofgem.gov.uk/about-us/working-ofgem/', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-03', '2026-11-16', 'Not found', 'Arcadis', 'Graduate Management Consultant (Business Advisory)', 'Not published', 'https://www.brightnetwork.co.uk/graduate-jobs/arcadis/graduate-management-consultant-london-2027-ak0c', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-04', '2026-11-16', 'Rolling', 'Civil Service Jobs (direct entry)', 'EO and HEO policy, analyst and adviser roles', 'Varies by grade', 'https://www.civilservicejobs.service.gov.uk/', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-05', '2026-11-16', 'Rolling (no set windows for Library researchers)', 'House of Commons', 'Library researcher, committee and other direct-entry roles', 'Varies', 'https://commonslibrary.parliament.uk/work-with-us/opportunities/', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-06', '2026-11-20', 'Rolling', 'MPs'' offices', 'Parliamentary assistant, caseworker or researcher', 'IPSA scales (one 2025 advert: £26,775 to £42,991)', 'Search: W4MP jobs board', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-07', '2026-11-27', 'Oct 2025', 'Transport for London', 'General Management Graduate Scheme (one TfL application a year)', '£32,250', 'https://www.gradcracker.com/hub/101/transport-for-london/graduate-job/85855/general-management-graduate-scheme', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-08', '2026-11-30', 'By Oct 2025 (closed 8 Dec 2025)', 'National Audit Office', 'Graduate Audit Associate (ACA Training Scheme)', '£35,787, rising to over £62,000 after qualification', 'https://targetjobs.co.uk/jobs/graduate-audit-associate-aca-training-scheme-september-2027-london-251233', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-09', '2026-12-01', '8 Oct 2025 (closed 6 Jan 2026)', 'Impact (Local Government Association)', 'Local Government Graduate Programme, Cohort 29 (one Impact application a year)', 'Minimum £32,597', 'https://www.local.gov.uk/our-support/leadership-workforce-and-communications/national-graduate-development-programme', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-10', '2026-12-01', 'Oct 2025', 'Impact (Local Government Association)', 'Finance Pathway, CIPFA (shares the one Impact application)', 'Minimum £33,673', 'https://www.local.gov.uk/ngdp-candidates/finance-scheme', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-11', '2026-12-01', 'Not found (earlier rounds closed 20 Dec 2024 and 30 Mar 2026)', 'Forvis Mazars', 'Management Consulting graduate', 'Not published', 'Search: Forvis Mazars graduate careers', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-12', '2026-12-01', 'Not found (latest found: May 2023)', 'Behavioural Insights Team (Nesta)', 'Associate Advisor (cohort)', 'Not published', 'https://www.nesta.org.uk/jobs/associate-advisor', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-13', '2026-12-01', 'Not found (a spring cohort closed 10 Jan 2025)', 'Brunswick Group', 'Executive (London cohort)', 'Not published', 'https://job-boards.greenhouse.io/brunswickgroup/jobs/8305464002', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-14', '2027-01-04', 'Not found', 'Cancer Research UK', 'Accelerate (incl. Policy, Information and Communications stream)', 'Not published', 'https://www.brightnetwork.co.uk/graduate-jobs/cancer-research-uk/accelerate-scheme-register-your-interest', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-15', '2027-01-11', 'Jan 2025 (latest found)', 'Lloyd''s of London', 'Graduate schemes (seven, including Business); opens 11 Jan 2027', 'Not published', 'https://www.lloyds.com/about-lloyds/careers/early-careers/graduates', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-16', '2027-01-15', 'Jan 2026 (closed 19 Apr 2026)', 'Local Partnerships', 'Graduate Consultant', '£27,000 (2026 round)', 'https://www.careers.local.gov.uk/job/graduate-consultant-004842', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-17', '2027-02-01', 'Normally Feb to Apr', 'Institute for Government', 'Research internship 2027-28', 'Not published', 'https://www.instituteforgovernment.org.uk/about-us/careers/internship-programme', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-18', '2027-02-01', 'Not found (spring round closed in March)', 'The PSC', 'Entry-level public sector consultant', 'Not published', 'Search: The PSC careers', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-19', '2027-03-01', 'Open by 22 Apr 2026', 'Competition and Markets Authority', 'Delivery Graduate Scheme (Case Officer)', '£39,500', 'https://competitionandmarkets.blog.gov.uk/category/recruitment', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-20', '2027-03-01', 'By 13 Apr 2026', 'KPMG', 'Consulting graduate programmes (one KPMG application a year)', 'Not published', 'Search: KPMG UK graduate vacancies', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-21', '2027-03-01', '23 Mar 2026 (may close within hours)', 'MI5', 'Intelligence Officer Development Programme', '£40,428 (last round)', 'https://www.brightnetwork.co.uk/graduate-jobs/mi5-mi6-gchq/intelligence-officer-development-programme-iodp-registration-of-interest-mi5', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shortlist-22', '2027-03-01', '24 Apr 2026', 'Social Finance', 'Analyst Programme', '£33,600 (2026 round)', 'https://www.socialfinance.org.uk/join-us/current-vacancies/analyst-programme-2026', 'not_started', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
