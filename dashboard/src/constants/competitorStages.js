// Staged-progress copy for slow competitor-study requests, shared between
// CompetitorOnboarding.jsx (step 3's first read) and CompetitorEditPage.jsx
// (its "Re-run analysis" button) since both drive the same StageList through
// the same buildProfile() call. Entries are i18n keys; StageList translates
// them at render time.
export const SCRAPE_STAGES = [
  'common:competitorStages.fetchWebsite',
  'common:competitorStages.extractText',
  'common:competitorStages.readPositioning',
  'common:competitorStages.writeContext',
];
