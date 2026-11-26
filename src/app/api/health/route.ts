import { NextResponse } from 'next/server';

function getApiBaseUrl(): string {
  return process.env.API_BASE_URL ?? 'http://localhost:4000';
}

export async function GET(): Promise<NextResponse> {
  let apiHealthy = false;
  try {
    const res = await fetch(`${getApiBaseUrl()}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    apiHealthy = res.ok;
  } catch {
    apiHealthy = false;
  }

  return NextResponse.json(
    {
      status: 'ok',
      service: 'ihda-web',
      apiHealthy,
      timestamp: new Date().toISOString(),
    },
    { status: 200 },
  );
}
