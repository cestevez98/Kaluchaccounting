import { NextResponse, type NextRequest } from 'next/server';

/** Sin cookie de sesión → a la pantalla de acceso. La validez real la comprueba la API. */
export function middleware(req: NextRequest) {
  if (!req.cookies.get('kaluch_session')) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!login|api|_next|favicon.ico).*)'],
};
