import { Link } from 'react-router-dom';
import { LayoutDashboard, Newspaper, Database } from 'lucide-react';

/**
 * Placeholder for the Dashboard. This app collects articles and stores them
 * unanalyzed, so there are no sentiment/topic rollups to chart yet - whatever
 * this page eventually shows will be built on collection metrics (volume by
 * source over time, coverage gaps, fetch failures), not analysis output.
 *
 * Deliberately a real page rather than a hidden nav item: the slot in the
 * navigation is the reminder that it's coming, and the two links below send
 * people to what does work today.
 */
export default function ComingSoonPage() {
  return (
    <div className="content-shell">
      <header className="page-header">
        <span className="report-kicker">
          <LayoutDashboard size={13} /> Dashboard
        </span>
        <h2 className="report-title">Coming soon</h2>
        <p className="subtitle">
          Collection metrics for this workspace will live here. In the meantime, the
          data itself and every run that produced it are already available.
        </p>
      </header>

      <div className="empty-state" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link to="/articles" className="btn-secondary toolbar-button">
          <Newspaper size={16} /> Browse articles
        </Link>
        <Link to="/pipeline-runs" className="btn-secondary toolbar-button">
          <Database size={16} /> Pipeline runs
        </Link>
      </div>
    </div>
  );
}
