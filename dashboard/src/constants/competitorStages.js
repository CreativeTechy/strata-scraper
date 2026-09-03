// Staged-progress copy for slow competitor-study requests, shared between
// CompetitorOnboarding.jsx (step 3's first read) and CompetitorEditPage.jsx
// (its "Re-run analysis" button) since both drive the same StageList through
// the same buildProfile() call.
export const SCRAPE_STAGES = [
  'Fetching your website',
  'Extracting page text',
  'Reading how you position yourself',
  'Writing your market context',
];
