'use client';

import type { JobStatus } from '@/lib/types';

interface StatusBadgeProps {
  status: JobStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  if (status === 'FAILED') {
    return (
      <span className="badge badge--failed" data-status="FAILED">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="badge__icon">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span>FAILED</span>
      </span>
    );
  }

  if (status === 'QUEUED') {
    return (
      <span className="badge badge--queued" data-status="QUEUED">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="badge__icon">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span>QUEUED</span>
      </span>
    );
  }

  return (
    <span className="badge badge--healthy" data-status="HEALTHY">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="badge__icon">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 8.2l2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>HEALTHY</span>
    </span>
  );
}
