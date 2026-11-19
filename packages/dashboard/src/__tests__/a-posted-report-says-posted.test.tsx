import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../lib/api');

import type * as api from '../lib/api';
import { DeliveredPanel } from '../components/ReportDeliveryPanel';

const delivery = (over: Partial<api.ReportDelivery> = {}): api.ReportDelivery => ({
  status: 'posted', issueUrl: null, issueNumber: null, exportPath: null, ...over,
});

describe('the delivered report card', () => {
  it('says posted once there is an issue', () => {
    render(<DeliveredPanel delivery={delivery({ issueUrl: 'https://example.invalid/issues/7', issueNumber: 7 })} onDone={() => {}} />);
    expect(screen.getByText('Your report is posted')).toBeTruthy();
    expect(screen.queryByText('Your report is ready to post')).toBeNull();
  });
  it('CONTROL: says ready to post while it is not posted', () => {
    render(<DeliveredPanel delivery={delivery({ newIssueUrl: 'https://example.invalid/issues/new' })} onDone={() => {}} />);
    expect(screen.getByText('Your report is ready to post')).toBeTruthy();
  });
});
