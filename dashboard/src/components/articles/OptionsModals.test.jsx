// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import i18n from '../../i18n/index.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ExportOptionsModal from './ExportOptionsModal.jsx'
import ImportOptionsModal from './ImportOptionsModal.jsx'

afterEach(cleanup);

beforeEach(async () => {
  await i18n.changeLanguage('en');
})

describe('ExportOptionsModal', () => {
  it('opens on the first option, traps Tab, and closes on Escape', () => {
    const onClose = vi.fn()
    render(<ExportOptionsModal open articlesCount={3} showCompetitorsOption onClose={onClose} />)
    expect(screen.getByRole('dialog', { name: 'Export data' })).toHaveAccessibleDescription('Choose what to download as a JSONL file.')

    const articles = screen.getByRole('button', { name: /Export articles/ })
    const competitors = screen.getByRole('button', { name: /Export competitors/ })
    expect(articles).toHaveFocus()

    competitors.focus()
    fireEvent.keyDown(document.activeElement, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus()

    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ImportOptionsModal', () => {
  it('falls back to the close button when the options are disabled', () => {
    render(<ImportOptionsModal open disabled onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus()
  })
})
