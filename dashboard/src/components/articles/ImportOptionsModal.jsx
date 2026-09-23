import { Upload, FolderInput, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Lets the user pick between a file picker and a folder picker for import.
// Only JSONL/NDJSON exports are accepted here - unlike data-analysis's
// project-documents pipeline, this app has no document extraction step.
export default function ImportOptionsModal({ open, hasProject, disabled, onClose, onChooseFiles, onChooseFolder }) {
  const { t } = useTranslation('articles');
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
              {t('importModal.title')}
            </h2>
          </div>
          <button type="button" className="confirm-modal-close" onClick={onClose} aria-label={t('importModal.closeDialog')}>
            <X size={18} />
          </button>
        </div>

        <p className="confirm-modal-message">
          {hasProject ? t('importModal.introWithProject') : t('importModal.introWithoutProject')}
        </p>

        <div className="import-options-list">
          <button type="button" className="import-option-card" onClick={onChooseFiles} disabled={disabled}>
            <span className="import-option-icon">
              <Upload size={20} />
            </span>
            <span className="import-option-copy">
              <strong>{t('importModal.filesTitle')}</strong>
              <span>{t('importModal.filesDescription')}</span>
            </span>
          </button>
          <button type="button" className="import-option-card" onClick={onChooseFolder} disabled={disabled}>
            <span className="import-option-icon">
              <FolderInput size={20} />
            </span>
            <span className="import-option-copy">
              <strong>{t('importModal.folderTitle')}</strong>
              <span>{t('importModal.folderDescription')}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
