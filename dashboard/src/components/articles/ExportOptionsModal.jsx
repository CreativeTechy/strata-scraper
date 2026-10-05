import { FileText, Building2, X } from 'lucide-react';
import { useId, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import Dialog from '../Dialog.jsx';

// Lets the user pick what to export as JSONL: the articles matching the
// current filters, or (competitor-mode projects only) the study's tracked
// competitors. Picking an option hands off to a per-type confirm modal that
// shows the exact row count before downloading.
export default function ExportOptionsModal({ open, articlesCount, showCompetitorsOption, competitorProjectName, onClose, onChooseArticles, onChooseCompetitors }) {
  const { t } = useTranslation('articles');
  const titleId = useId();
  const introId = useId();
  const firstOptionRef = useRef(null);
  if (!open) return null;

  return (
    <Dialog titleId={titleId} descriptionId={introId} onClose={onClose} initialFocusRef={firstOptionRef}>
      <div className="confirm-modal-header">
        <div>
          <h2 id={titleId} className="confirm-modal-title">
            {t('exportModal.title')}
          </h2>
        </div>
        <button type="button" className="confirm-modal-close" onClick={onClose} aria-label={t('exportModal.closeDialog')}>
          <X size={18} />
        </button>
      </div>

      <p id={introId} className="confirm-modal-message">{t('exportModal.intro')}</p>

      <div className="import-options-list">
        <button ref={firstOptionRef} type="button" className="import-option-card" onClick={onChooseArticles}>
          <span className="import-option-icon">
            <FileText size={20} />
          </span>
          <span className="import-option-copy">
            <strong>{t('exportModal.articlesTitle')}</strong>
            <span>{t('exportModal.articlesDescription', { count: articlesCount, formatted: formatNumber(articlesCount) })}</span>
          </span>
        </button>
        {showCompetitorsOption && (
          <button type="button" className="import-option-card" onClick={onChooseCompetitors}>
            <span className="import-option-icon">
              <Building2 size={20} />
            </span>
            <span className="import-option-copy">
              <strong>{t('exportModal.competitorsTitle')}</strong>
              <span>
                <Trans
                  t={t}
                  i18nKey="exportModal.competitorsDescription"
                  values={{ name: competitorProjectName || t('exportModal.thisProject') }}
                  components={{ name: <bdi /> }}
                />
              </span>
            </span>
          </button>
        )}
      </div>
    </Dialog>
  );
}
