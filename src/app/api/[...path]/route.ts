import { NextRequest, NextResponse } from 'next/server';

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

function getApiBaseUrl(): string {
  return process.env.API_BASE_URL ?? 'http://localhost:4000';
}

async function forwardRequest(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { path } = await context.params;
  if (path.some((segment) => segment === '..' || segment.includes('\\'))) {
    return NextResponse.json(
      { error: 'INVALID_PATH', message: 'Invalid API proxy path.' },
      { status: 400 },
    );
  }

  const targetUrl = `${getApiBaseUrl()}/api/${path.join('/')}${req.nextUrl.search}`;
  const headers = new Headers();

  const cookie = req.headers.get('cookie');
  if (cookie) {
    headers.set('cookie', cookie);
  }
  const authorization = req.headers.get('authorization');
  if (authorization) {
    headers.set('authorization', authorization);
  }
  const contentType = req.headers.get('content-type');
  if (contentType) {
    headers.set('content-type', contentType);
  }

  let body: string | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const text = await req.text();
    if (text.length > 0) {
      body = text;
    }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      cache: 'no-store',
    });

    const responseHeaders = new Headers();
    const upstreamContentType = upstream.headers.get('content-type');
    if (upstreamContentType) {
      responseHeaders.set('content-type', upstreamContentType);
    }
    const requestId = upstream.headers.get('x-request-id');
    if (requestId) {
      responseHeaders.set('x-request-id', requestId);
    }
    for (const setCookieHeader of upstream.headers.getSetCookie()) {
      responseHeaders.append('set-cookie', setCookieHeader);
    }

    const payloadText = await upstream.text();
    return new NextResponse(payloadText, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return NextResponse.json(
      {
        error: 'UPSTREAM_UNAVAILABLE',
        message: 'Could not reach the ihda-api backend service.',
      },
      { status: 502 },
    );
  }
}

export async function GET(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  return forwardRequest(req, context);
}

export async function POST(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  return forwardRequest(req, context);
}
