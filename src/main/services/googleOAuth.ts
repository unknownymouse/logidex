import http from 'http'
import crypto from 'crypto'
import { shell } from 'electron'
import { clearNamedSecret, getNamedSecret, recordCheck, setNamedSecret, setSecret } from '../secrets'

// Official public desktop client ID for Google Cloud SDK supporting PKCE on loopback
const CLIENT_ID = '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com'
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/cloud-platform'
].join(' ')

interface StoredTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  email?: string
  name?: string
  picture?: string
}

let activeServer: http.Server | null = null

function getStoredTokens(): StoredTokens | null {
  const raw = getNamedSecret('google_oauth')
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredTokens
  } catch {
    return null
  }
}

/**
 * Returns a currently valid access token. If expired and a refresh token is present,
 * it refreshes the token automatically.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = getStoredTokens()
  if (!tokens) return null

  // If token is still valid for at least 60 seconds
  if (tokens.expiresAt > Date.now() + 60 * 1000) {
    return tokens.accessToken
  }

  // If no refresh token, cannot renew
  if (!tokens.refreshToken) {
    return null
  }

  // Refresh token
  try {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken
    })

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    })

    if (!res.ok) {
      return null
    }

    const data = (await res.json()) as any
    const newAccess = data?.access_token
    if (!newAccess) return null

    const expires_in = Number(data?.expires_in) || 3600
    tokens.accessToken = newAccess
    tokens.expiresAt = Date.now() + (expires_in - 120) * 1000
    if (data?.refresh_token) {
      tokens.refreshToken = data.refresh_token
    }

    setNamedSecret('google_oauth', JSON.stringify(tokens))
    // Also keep gemini secret in sync so other components see it
    setSecret('gemini', newAccess)
    return newAccess
  } catch {
    return null
  }
}

export function getOAuthStatus(): { connected: boolean; email?: string; name?: string } {
  const tokens = getStoredTokens()
  if (!tokens) return { connected: false }
  return {
    connected: true,
    email: tokens.email,
    name: tokens.name
  }
}

export function disconnectOAuth(): void {
  if (activeServer) {
    try {
      activeServer.close()
    } catch {
      // ignore
    }
    activeServer = null
  }
  clearNamedSecret('google_oauth')
  recordCheck('gemini', false, 'OAuth diputuskan')
  recordCheck('antigravity', false, 'OAuth diputuskan')
}

/**
 * Initiates the Google OAuth 2.0 PKCE flow.
 * Starts a local HTTP server on an ephemeral port, opens the system browser,
 * waits for the callback, exchanges the code, and saves the tokens.
 */
export function startOAuthLogin(): Promise<{ ok: boolean; email?: string; message?: string }> {
  return new Promise((resolve) => {
    if (activeServer) {
      try {
        activeServer.close()
      } catch {
        // ignore
      }
      activeServer = null
    }

    const codeVerifier = crypto.randomBytes(32).toString('base64url')
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    const state = crypto.randomBytes(16).toString('hex')

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
        if (reqUrl.pathname !== '/oauth2callback') {
          res.writeHead(404)
          res.end('Not Found')
          return
        }

        const queryState = reqUrl.searchParams.get('state')
        const code = reqUrl.searchParams.get('code')
        const error = reqUrl.searchParams.get('error')

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderResultPage(false, `Login dibatalkan atau ditolak: ${error}`))
          cleanup()
          resolve({ ok: false, message: `Otentikasi ditolak: ${error}` })
          return
        }

        if (queryState !== state || !code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderResultPage(false, 'Parameter otentikasi tidak valid atau sudah kedaluwarsa.'))
          cleanup()
          resolve({ ok: false, message: 'State OAuth tidak cocok' })
          return
        }

        // Exchange code for token
        const tokenParams = new URLSearchParams({
          client_id: CLIENT_ID,
          code,
          code_verifier: codeVerifier,
          grant_type: 'authorization_code',
          redirect_uri: `http://127.0.0.1:${port}/oauth2callback`
        })

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString()
        })

        if (!tokenRes.ok) {
          const errText = await tokenRes.text().catch(() => '')
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderResultPage(false, `Gagal menukar token: HTTP ${tokenRes.status}`))
          cleanup()
          resolve({ ok: false, message: `Gagal menukar kode otorisasi: ${errText.slice(0, 200)}` })
          return
        }

        const data = (await tokenRes.json()) as any
        const accessToken = data?.access_token
        const refreshToken = data?.refresh_token
        const expiresIn = Number(data?.expires_in) || 3600

        if (!accessToken) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderResultPage(false, 'Proxy Google tidak mengembalikan access token.'))
          cleanup()
          resolve({ ok: false, message: 'Tidak ada access token yang diterima' })
          return
        }

        // Fetch user profile info
        let email = ''
        let name = ''
        let picture = ''
        try {
          const uRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
          })
          if (uRes.ok) {
            const uData = (await uRes.json()) as any
            email = uData?.email || ''
            name = uData?.name || ''
            picture = uData?.picture || ''
          }
        } catch {
          // non-critical
        }

        const stored: StoredTokens = {
          accessToken,
          refreshToken,
          expiresAt: Date.now() + (expiresIn - 120) * 1000,
          email,
          name,
          picture
        }

        setNamedSecret('google_oauth', JSON.stringify(stored))
        setSecret('gemini', accessToken)
        recordCheck('gemini', true, `Terhubung via Google OAuth (${email || 'Aktif'})`)
        recordCheck('antigravity', true, `Terhubung via Google OAuth (${email || 'Aktif'})`)

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderResultPage(true, email ? `Berhasil terhubung sebagai ${email}` : 'Login berhasil'))

        cleanup()
        resolve({ ok: true, email: email || 'Akun Google' })
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderResultPage(false, err?.message || 'Terjadi kesalahan internal'))
        cleanup()
        resolve({ ok: false, message: err?.message || 'Gagal login OAuth' })
      }
    })

    let port = 0
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        cleanup()
        resolve({ ok: false, message: 'Gagal membuka port loopback lokal' })
        return
      }
      port = addr.port
      activeServer = server

      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
        redirectUri
      )}&response_type=code&scope=${encodeURIComponent(
        SCOPES
      )}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}&access_type=offline&prompt=consent`

      void shell.openExternal(authUrl)
    })

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      cleanup()
      resolve({ ok: false, message: 'Waktu login habis (tidak ada respons selama 5 menit).' })
    }, 5 * 60 * 1000)

    function cleanup() {
      clearTimeout(timeout)
      if (activeServer) {
        try {
          activeServer.close()
        } catch {
          // ignore
        }
        activeServer = null
      }
    }
  })
}

function renderResultPage(success: boolean, detail: string): string {
  const icon = success
    ? `<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" style="margin: 0 auto 16px; display: block;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
    : `<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" style="margin: 0 auto 16px; display: block;"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`

  const title = success ? 'Login Google Berhasil!' : 'Login Belum Berhasil'
  const sub = success
    ? 'Akun Google kamu sudah terhubung ke <strong>Logidex</strong>. Kamu bisa menutup tab browser ini sekarang dan kembali ke aplikasi.'
    : 'Tidak dapat menyelesaikan login OAuth. Silakan tutup tab ini dan coba klik lagi di aplikasi Logidex.'

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Logidex</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0d0f14;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #f3efe8;
      padding: 24px;
    }
    .card {
      background: #161922;
      border: 1px solid #282c3c;
      border-radius: 20px;
      padding: 40px 32px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    p {
      margin: 0 0 16px;
      font-size: 14px;
      line-height: 1.6;
      color: #9ea4b6;
    }
    .badge {
      display: inline-block;
      background: ${success ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)'};
      color: ${success ? '#4ade80' : '#f87171'};
      border: 1px solid ${success ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'};
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="card">
    ${icon}
    <h1>${title}</h1>
    <p>${sub}</p>
    <div class="badge">${detail}</div>
  </div>
</body>
</html>`
}
