// A chat image could only be opened with the mouse: the dojo3 media card drew its
// poster as a plain <div onClick>, which is not in the tab order and ignores
// Enter and Space, so a keyboard user could never reach the lightbox. The poster
// is now a real button; this file drives it from the keyboard.
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AttachmentChips } from '../components/AttachmentChips';

const image = {
  fileId: 'f1',
  filename: 'photo.png',
  mimeType: 'image/png',
  size: 1234,
  path: '/uploads/agent-1/1700000000000_photo.png',
  category: 'image',
};

describe('a chat image opens from the keyboard', () => {
  it('Enter opens the lightbox once', () => {
    render(<AttachmentChips variant="media" attachments={[image]} />);
    const poster = screen.getByRole('button', { name: 'Open photo.png' });
    fireEvent.keyDown(poster, { key: 'Enter' });
    // The real lightbox opened: its close control is on screen, exactly once.
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBe(1);
  });

  it('Space opens the lightbox once', () => {
    render(<AttachmentChips variant="media" attachments={[image]} />);
    const poster = screen.getByRole('button', { name: 'Open photo.png' });
    fireEvent.keyDown(poster, { key: ' ' });
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBe(1);
  });
});
