import i18n from '../i18n/index.js';

// `value` is the stable code sent to the API; `label` is read at render time
// so it follows the UI language.
const unit = (value) => ({
  value,
  get label() {
    return i18n.t(`common:scheduleUnits.${value}`);
  },
});

export const REPEAT_UNIT_OPTIONS = [unit('minutes'), unit('hours'), unit('days')];
