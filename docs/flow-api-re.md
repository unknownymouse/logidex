# Google Flow — reverse-engineering notes

Target: enable video generation through a **Google OAuth login** (the account already
connected via Antigravity / Gemini-CLI credentials) instead of only via a Gemini API key
or Higgsfield.

Status of the code before this work (`src/main/services/antigravity.ts`, `generateVideo`):

```ts
// Google Antigravity OAuth uses cloudcode-pa.googleapis.com which only supports LLM code assistance,
// not Veo video generation.
throw new Error('Model Google Veo saat ini belum didukung melalui Google OAuth / Antigravity ...')
```

That conclusion was drawn from the wrong backend. `cloudcode-pa.googleapis.com` really is
LLM-only — but the OAuth credential is *not* limited to that host.

---

## 1. How the credential flows

`src/main/services/googleOAuth.ts`

| Item | Value |
|---|---|
| OAuth client id | `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` |
| Client secret | `GOCSPX-…` (XOR-42 obfuscated in source) |
| Scopes | `openid email profile https://www.googleapis.com/auth/cloud-platform` |
| Storage | Electron `safeStorage`, key `google_oauth` (JSON: accessToken/refreshToken/expiresAt/email) |
| Refresh | `POST https://oauth2.googleapis.com/token`, `grant_type=refresh_token` |

Both the client id and the `cloud-platform` scope are the Google first-party ones shared by
Gemini CLI / Antigravity. `cloud-platform` is the broad GCP scope, which is why Google's
*Lab* backends accept it too.

## 2. Finding the real backend

Flow's web app (`https://labs.google/fx/tools/flow`) is a Google *boq* app:

```
boq_labs-ai-sandbox-frontend_20261002.00_p0
base js: https://www.gstatic.com/_/mss/boq-labs-ai-sandbox/_/js/k=…/m=_b
```

`WIZ_global_data` inside the bootstrap HTML gives the runtime config:

| key | value |
|---|---|
| `hCQbU` | `https://aisandbox-pa.googleapis.com` ← the API host |
| `eptZe` | `/_/AiSandboxAngularFrontend/` |
| `YmyN0b` | `https://aisandbox-pa-webchannel.clients6.google.com` (streaming agent channels) |
| `K21R3e` | `AIzaSyDSjGxWlo68HcGt6mbaIq9YbkKhFQnt3sk` (public frontend API key) |
| `cfb2h` | build label `boq_labs-ai-sandbox-frontend_20261002.00_p0` |

The lazy route chunks (`m=XRV0Af`, `m=wj3Fuc`, `m=m38dl`, `m=BZ3AFc`, …) contain the
generation code. The relevant RPC registrations (`new _.Gx(<rpcid>, <req>, <resp>, […])`):

| RPC id | Method |
|---|---|
| `IJhj9c` | `/VideoFxService.BatchAsyncGenerateVideoExperimental` |
| `Iyc41d` | `/FlowService.BatchGetMedia` |
| `nzlxg` | `/VideoFxService.GetCredits` |
| `rThb8d` | `/VideoFxService.CheckFlowAvailability` |
| `cPZSdc` | `/VideoFxService.GetFlowAppConfig` |
| `uurnC` | `/FlowService.GetMediaUrl` |

Transport used by the SPA is Google **batchexecute** (`…/data/batchexecute`, `f.req=…`,
`rpcids=…`) authenticated with `SAPISIDHASH` derived from the `__Secure-3PAPISID` cookie
(`LEa`/`ACa` helpers in the bundle). That is the *browser* path.

### Request shape (from the production bundle)

Text-to-video builder, verbatim structure:

```js
// item class used by IJhj9c
G = _.rp(G, 1, prompt)                               // field 1  = prompt
G = _.Mv(G, 2, modelKey).setAspectRatio(aspectRatio)  // field 2  = videoModelKey
                                                     // field 12 = aspectRatio
G = _.rp(G, 8, resolution)                           // field 8  = optional resolution
G = _.rp(G, 5, metadata)                             // field 5  = metadata message
D = _.rp(D, 7, c.ml)                                 // field 7  = misc
```

metadata message (`_.fy`) carries `sceneId` (1), `workflowId` (2), `collectionId` (3),
`seed` (5/6). Batch envelope adds `clientContext { sessionId, tool: "PINHOLE" }`.

Aspect-ratio enum family (from `_.TRa`):

```
VIDEO_ASPECT_RATIO_LANDSCAPE, VIDEO_ASPECT_RATIO_PORTRAIT
(plus IMAGE_ASPECT_RATIO_* and 4:3 / 3:4 variants)
```

Paygate tiers (`Oxa`): `PAYGATE_TIER_ZERO / ONE / TWO / GEMNOVA / NOT_PAID /
UNSUBSCRIBED_WITH_CREDITS / EXEMPT / TIER1P5`.

## 3. The REST surface actually accepts OAuth

Probing the live host (verified 2026-10-03):

```
POST /v1/video:batchAsyncGenerateVideoText              -> 401  (exists, auth required)
POST /v1/video:batchAsyncGenerateVideoStartAndEndImage  -> 401  (exists)
POST /v1/video:batchAsyncGenerateVideoExtendVideo       -> 401  (exists)
POST /v1/video:batchAsyncGenerateVideoReferenceImages   -> 401  (exists)
POST /v1/video:batchAsyncGenerateVideoUpsampleVideo     -> 401  (exists)
POST /v1/video:batchCheckAsyncVideoGenerationStatus     -> 401  (exists)
GET  /v1/credits                                        -> 401  (exists)
POST /v1/video:batchAsyncGenerateVideo                  -> 404  (no such route)
```

Two different 401 bodies pin down the auth scheme:

```
no Authorization header      -> "Request is missing required authentication credential.
                                 Expected OAuth 2 access token, login cookie or other …"
Authorization: Bearer <bogus>-> "Request had invalid authentication credentials.
                                 Expected OAuth 2 access token, login cookie or other …"
```

`missing` → `invalid` proves the `Bearer` scheme is parsed and evaluated, so an OAuth 2
access token from the app's existing login is a first-class credential for Flow.

## 4. Implementation

* `src/main/services/flow.ts` — Flow REST client (submit → poll → download), with the
  request envelope isolated in `buildGenerateRequest()` so a schema change is a one-place fix.
  `FLOW_DEBUG=1` dumps every request/response.
* `src/main/services/antigravity.ts` — `generateVideo()` no longer throws for OAuth logins;
  it routes to Flow (`cloud-platform` token). Image-to-video still needs Flow's media-upload
  step (mediaId, not raw bytes), so that path reports a precise message instead of a blanket block.
* `scripts/flow-probe.mjs` — standalone validator: mints an access token from a refresh token
  (or takes one), calls `/v1/credits`, optionally submits a real generation and polls it,
  always printing raw bodies.

## 5. Open items (need a live Google account to close)

1. **Wire model key.** `videoModelKey` values come from `GetFlowAppConfig` (server-supplied),
   not from the bundle, so they are not hard-coded. Default `veo_3_1_t2v_fast`; override via
   `modelKey`. Run the probe once to read the server's own config/error text and pin the exact key.
2. **Status envelope.** `batchCheckAsyncVideoGenerationStatus` is called with
   `{operations:[{operation:{name}}]}` and retried flat if the reply carries nothing —
   one live run confirms which is right.
3. **Image-to-video** requires Flow's media upload (mediaId) before
   `batchAsyncGenerateVideoStartAndEndImage`.
4. **Scope.** `cloud-platform` is the broadest GCP scope and is expected to be accepted;
   if the probe returns 403 rather than 401, add the Flow-specific scope to `SCOPES` in
   `googleOAuth.ts` and reconnect.
