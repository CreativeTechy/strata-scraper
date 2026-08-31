import { Upload, FolderInput, X } from 'lucide-react';

// Lets the user pick between a file picker and a folder picker for import.
// Only JSONL/NDJSON exports are accepted here - unlike data-analysis's
// project-documents pipeline, this app has no document extraction step.
export default function ImportOptionsModal({ open, hasProject, disabled, onClose, onChooseFiles, onChooseFolder }) {
  if (!open) return null;

  return (
    <div className="confirm-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-modal-header">
          <div>
            <h2 id="import-modal-title" className="confirm-modal-title">
              Import articles
            </h2>
          </div>
          <button type="button" className="confirm-modal-close" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>

        <p className="confirm-modal-message">
          {hasProject
            ? 'Import JSONL exports (.jsonl, .ndjson) into the project currently in scope.'
            : 'Import JSONL exports (.jsonl, .ndjson). Articles are not linked to a project - select a project scope above to import into one.'}
        </p>

        <div className="import-options-list">
          <button type="button" className="import-option-card" onClick={onChooseFiles} disabled={disabled}>
            <span className="import-option-icon">
              <Upload size={20} />
            </span>
            <span className="import-option-copy">
              <strong>Upload file(s)</strong>
              <span>Pick one or more JSONL exports from your computer.</span>
            </span>
          </button>
          <button type="button" className="import-option-card" onClick={onChooseFolder} disabled={disabled}>
            <span className="import-option-icon">
              <FolderInput size={20} />
            </span>
            <span className="import-option-copy">
              <strong>Upload a folder</strong>
              <span>Import every JSONL export found inside a folder.</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
