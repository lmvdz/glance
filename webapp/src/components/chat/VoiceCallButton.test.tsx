import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceCallButton } from './VoiceCallButton';

describe('VoiceCallButton', () => {
  test('renders nothing when voice is not enabled — no button that 404s', () => {
    const html = renderToStaticMarkup(<VoiceCallButton enabled={false} active={false} onStart={() => {}} />);
    expect(html).toBe('');
  });

  test('renders an enabled, clickable affordance when voice is on and no call is active', () => {
    const html = renderToStaticMarkup(<VoiceCallButton enabled active={false} onStart={() => {}} />);
    expect(html).toContain('Start voice call');
    // The static `disabled:` Tailwind variant is always present in the class list; only the real
    // HTML attribute (`disabled=""`) reflects whether the button is actually disabled.
    expect(html).not.toContain('disabled=""');
  });

  test('disables (not hides) the button while a call is already active', () => {
    const html = renderToStaticMarkup(<VoiceCallButton enabled active onStart={() => {}} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('already in progress');
  });
});
