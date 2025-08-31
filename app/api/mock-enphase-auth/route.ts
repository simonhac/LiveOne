import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const state = searchParams.get('state') || ''
  
  // Generate mock authorization code
  const mockCode = `mock_auth_code_${Date.now()}`
  
  // Build the callback URL
  const callbackUrl = new URL('/api/auth/enphase/callback', request.url)
  callbackUrl.searchParams.set('code', mockCode)
  callbackUrl.searchParams.set('state', state)
  
  // Return an HTML page with auto-approval
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mock Enphase Authorization</title>
      <style>
        body {
          background: linear-gradient(to bottom right, #1f2937, #111827);
          color: white;
          font-family: system-ui, -apple-system, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
        }
        .container {
          background: #374151;
          border-radius: 0.5rem;
          padding: 2rem;
          max-width: 400px;
          text-align: center;
          border: 1px solid #4b5563;
        }
        h1 { margin-bottom: 1rem; }
        .warning {
          background: #7c2d12;
          border: 1px solid #ea580c;
          color: #fed7aa;
          padding: 1rem;
          border-radius: 0.25rem;
          margin: 1rem 0;
        }
        .info {
          background: #1e293b;
          padding: 1rem;
          border-radius: 0.25rem;
          margin: 1rem 0;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Mock Enphase Authorization</h1>
        <div class="warning">
          🧪 This is a mock authorization page for testing
        </div>
        <div class="info">
          <p>Auto-approving in 2 seconds...</p>
        </div>
        <script>
          setTimeout(function() {
            window.location.href = '${callbackUrl.toString()}';
          }, 2000);
        </script>
      </div>
    </body>
    </html>
  `
  
  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html',
    },
  })
}