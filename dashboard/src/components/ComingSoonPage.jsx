import { LayoutDashboard } from 'lucide-react';

export default function ComingSoonPage() {
  return (
    <div className="content-shell">
      <header className="page-header">
        <span className="report-kicker">
          <LayoutDashboard size={13} /> Dashboard
        </span>
        <h2 className="report-title">Coming soon</h2>
        <p className="subtitle">
          Collection metrics for this workspace will live here.
        </p>
      </header>
    </div>
  );
}
