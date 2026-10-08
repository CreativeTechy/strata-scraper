// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import CardLanguageSwitcher from './CardLanguageSwitcher.jsx';

afterEach(cleanup);

describe('CardLanguageSwitcher', () => {
  it('marks the card language and reports a pick', () => {
    const onChange = vi.fn();
    render(<CardLanguageSwitcher value="en" onChange={onChange} label="Names language" hint="hint" />);

    expect(screen.getByRole('group', { name: 'Names language' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'العربية' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'العربية' }));
    expect(onChange).toHaveBeenCalledWith('ar');
  });

  it('locks the options while the card is translating', () => {
    render(<CardLanguageSwitcher value="ar" onChange={vi.fn()} label="Names language" busy />);

    expect(screen.getByRole('group', { name: 'Names language' })).toHaveAttribute('aria-busy', 'true');
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });
});
