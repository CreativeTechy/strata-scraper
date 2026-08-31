import { FileText, Building2, X } from 'lucide-react';

// Lets the user pick what to export as JSONL: the articles matching the
// current filters, or (competitor-mode projects only) the study's tracked
// competitors. Picking an option hands off to a per-type confirm modal that
// shows the exact row count before downloading.
export default function ExportOptionsModal({ open, articlesCount, showCompetitorsOption, competitorProjectName, onClose, onChooseArticles, onChooseCompetitors }) {
  if (!open) return null;

  return (
    <div className="confirm-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-modal-header">
          <div>
            <h2 id="export-modal-title" className="confirm-modal-title">
              Export data
            </h2>
          </div>
          <button type="button" className="confirm-modal-close" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>

        <p className="confirm-modal-message">Choose what to download as a JSONL file.</p>

        <div className="import-options-list">
          <button type="button" className="import-option-card" onClick={onChooseArticles}>
            <span className="import-option-icon">
              <FileText size={20} />
            </span>
            <span className="import-option-copy">
              <strong>Export articles</strong>
              <span>{articlesCount.toLocaleString()} article{articlesCount === 1 ? '' : 's'} matching your current filters.</span>
            </span>
          </button>
          {showCompetitorsOption && (
            <button type="button" className="import-option-card" onClick={onChooseCompetitors}>
              <span className="import-option-icon">
                <Building2 size={20} />
              </span>
              <span className="import-option-copy">
                <strong>Export competitors</strong>
                <span>Every tracked competitor for {competitorProjectName || 'this project'}.</span>
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
