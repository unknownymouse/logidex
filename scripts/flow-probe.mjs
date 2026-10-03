#!/usr/bin/env node
/**
 * Google Flow probe — reverse-engineering / validation harness.
 *
 * Verifies that a Google account can reach Google Flow's private REST API and,
 * if it can, runs a real text-to-video job end to end.
 *
 * Usage
 * -----
 *   # 1) mint an access token from a refresh token (no browser needed)
 *   node scripts/flow-probe.mjs --refresh-token "<1//0g...>"
 *
 *   # 2) or pass an access token you already have (ya29....)
 *   node scripts/flow-probe.mjs --token "<ya29....>"
 *
 *   # options
 *   --prompt "..."              prompt for the test generation
 *   --model  veo_3_1_t2v_fast   Flow wire model key
 *   --aspect landscape|portrait landscape by default
 *   --credits-only              stop after the credits call
 *   --gen                       actually submit a generation (costs credits!)
 *
 * Raw request/response bodies are always printed, so a schema change is visible
 * immediately instead of being swallowed by an error message.
 *
 * The OAuth client credentials are read straight out of src/main/services/googleOAuth.ts
 * (where they stay XOR-42 obfuscated) instead of being duplicated here, so no plaintext
 * secret ever lands in a new file. Override with --client-id / --client-secret or
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
 */

import { readFileSync } from 'node:fs'

const FLOW_API = 'https://aisandbox-pa.googleapis.com/v1'

/**
 * Read the first-party Google OAuth client id/secret out of the app source,
 * where they are stored as `String.fromCharCode(...[...].map((c) => c ^ 42))`.
 */
function readOAuthCredsFromSource() {
  const srcFile = new URL('../src/main/services/googleOAuth.ts', import.meta.url)
  let src
  try {
    src = readFileSync(srcFile, 'utf8')
  } catch (e) {
    throw new Error(
      `Cannot read ${srcFile.pathname} - run this from the repo root, or pass ` +
        `--client-id and --client-secret explicitly.\n${e.message}`
    )
  }
  const decode = (name) => {
    const m = src.match(
      new RegExp(
        `${name}\\s*=\\s*String\\.fromCharCode\\(\\s*\\.\\.\\.\\[([^\\]]+)\\]\\s*\\.map\\(\\(c\\)\\s*=>\\s*c\\s*\\^\\s*(\\d+)\\)`
      )
    )
    if (!m) throw new Error(`${name} not found in googleOAuth.ts - source changed?`)
    const key = parseInt(m[2], 10)
    return String.fromCharCode(...m[1].split(',').map((n) => parseInt(n.trim(), 10) ^ key))
  }
  return { clientId: decode('CLIENT_ID'), clientSecret: decode('CLIENT_SECRET') }
}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const j = (o) => JSON.stringify(o, null, 2)

async function mintAccessToken(refreshToken, clientId, clientSecret) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const text = await res.text()
  console.log(`POST https://oauth2.googleapis.com/token -> HTTP ${res.status}`)
  if (!res.ok) {
    console.error(text.slice(0, 800))
    process.exit(1)
  }
  const data = JSON.parse(text)
  console.log(`token ok (${data.token_type || 'Bearer'}), expires_in=${data.expires_in}s, scope=${data.scope || 'n/a'}`)
  return data.access_token
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Origin: 'https://labs.google',
    Referer: 'https://labs.google/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'X-Goog-Api-Client': 'gl-js/ flow/1.0'
  }
}

async function call(token, path, body, method = 'POST') {
  const url = `${FLOW_API}${path}`
  const res = await fetch(url, {
    method,
    headers: headers(token),
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* not json */
  }
  console.log(`\n=== ${method} ${url} -> HTTP ${res.status} ===`)
  console.log(method === 'POST' ? `body: ${j(body)}` : '')
  console.log(text.slice(0, 3000) || '(empty)')
  return { status: res.status, ok: res.ok, parsed, text }
}

function findStrings(node, keys, out = [], depth = 0) {
  if (!node || depth > 8) return out
  if (Array.isArray(node)) {
    node.forEach((n) => findStrings(n, keys, out, depth + 1))
    return out
  }
  if (typeof node !== 'object') return out
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && keys.some((kk) => k.toLowerCase().includes(kk))) out.push(v)
    findStrings(v, keys, out, depth + 1)
  }
  return out
}

const main = async () => {
  let token = arg('token')
  if (!token) {
    const rt = arg('refresh-token')
    if (!rt) {
      console.error(
        'Need --token <access_token> or --refresh-token <refresh_token>.\n' +
          'Grab a refresh token once from the app (Pengaturan -> Google OAuth) or from an OAuth playground.'
      )
      process.exit(2)
    }
    const cid = arg('client-id', process.env.GOOGLE_CLIENT_ID)
    const csec = arg('client-secret', process.env.GOOGLE_CLIENT_SECRET)
    const src = cid && csec ? null : readOAuthCredsFromSource()
    token = await mintAccessToken(rt, cid || src.clientId, csec || src.clientSecret)
  }

  // 1. credits — cheapest authenticated call, proves reachability.
  const credits = await call(token, '/credits', undefined, 'GET')
  if (!credits.ok) {
    console.log(
      '\nAuth/authorisation failed. 401 = token rejected, 403 = account has no Flow access.\n' +
        'Check: the Google account is signed into labs.google/fx/tools/flow in a normal browser.'
    )
    if (credits.status === 401) process.exit(1)
  }
  if (arg('credits-only')) return

  // 2. submit a generation.
  if (!arg('gen')) {
    console.log(
      '\nCredits call reached the API. Re-run with --gen to submit a real generation ' +
        '(this spends Flow credits).'
    )
    return
  }

  const aspect = arg('aspect', 'landscape') === 'portrait'
    ? 'VIDEO_ASPECT_RATIO_PORTRAIT'
    : 'VIDEO_ASPECT_RATIO_LANDSCAPE'
  const body = {
    clientContext: { sessionId: String(Math.floor(Math.random() * 2147483647)), tool: 'PINHOLE' },
    requests: [
      {
        videoModelKey: arg('model', 'veo_3_1_t2v_fast'),
        aspectRatio: aspect,
        seed: Math.floor(Math.random() * 2147483647),
        textInput: { prompt: arg('prompt', 'A calm ocean wave at golden hour, cinematic slow motion') }
      }
    ]
  }

  const submit = await call(token, '/video:batchAsyncGenerateVideoText', body)
  if (!submit.ok) {
    console.log('\nSubmit failed. The raw error above names the field the server wants.')
    process.exit(1)
  }

  const names = findStrings(submit.parsed, ['name', 'operation'])
  console.log('\noperation candidates:', names)

  if (!names.length) return

  // 3. poll
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const st = await call(token, '/video:batchCheckAsyncVideoGenerationStatus', {
      operations: names.map((n) => ({ operation: { name: n } }))
    })
    const urls = findStrings(st.parsed, ['url', 'uri', 'fife'])
    if (urls.length) {
      console.log('\nMEDIA URLS:', urls)
      console.log('Done. Download the first URL with: curl -H "Authorization: Bearer <token>" -o out.mp4 "<url>"')
      return
    }
  }
  console.log('\nTimed out waiting for the job to finish.')
}

main().catch((e) => {
  console.error('probe failed:', e)
  process.exit(1)
})
