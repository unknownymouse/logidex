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

## 6. RPC surface, recovered from the app bundle

The web client does not call the `/v1/` REST routes at all — every RPC goes through
`batchexecute` at `${WIZ.eptZe}data/batchexecute` via the RPC's short id. Full map recovered
from `new _.Gx("<shortId>", …, ["/<Service>.<Method>"])`:

| short id | method |
| --- | --- |
| `YhhmEf` | `/VideoFxService.BatchAsyncGenerateVideoText` |
| `eb1hJf` | `/VideoFxService.BatchAsyncGenerateVideoStartImage` |
| `nprQif` | `/VideoFxService.BatchAsyncGenerateVideoStartAndEndImage` |
| `MZZa6b` | `/VideoFxService.BatchAsyncGenerateVideoReferenceImages` |
| `fZytfe` | `/VideoFxService.BatchAsyncGenerateVideoExtendVideo` |
| `jIps6` | `/VideoFxService.BatchAsyncGenerateVideoEditVideo` |
| `p0UkFb` | `/VideoFxService.BatchAsyncGenerateVideoUpsampleVideo` |
| `nzlxg` | `/VideoFxService.GetCredits` |
| `Yw72Rc` | `/VideoFxService.CreatePreamble` |
| `SPrCad` | `/FlowService.UpsampleImage` |
| **`maseQ`** | **`/FlowService.UploadImage`** |
| `as29s` | `/FlowService.GetMedia` |
| `Zzl0ze` | `/FlowService.GetProjectContents` |
| `jHPbke` | `/AiSandbox.CreateProject` |
| `ngNC2` | `/AiSandbox.GetProject` |

(69 pairs total; the rest are `InternalPeopleService` / `FlowCreationAgentService` and are
irrelevant here.)

### 6.1 Image-to-video payload

`BatchAsyncGenerateVideoStartAndEndImage` ships a plain JSON blob as the RPC argument
(the client logs it verbatim as `MEDIA_GENERATION_SETTINGS`), so the shape is exact:

```json
{
  "videoModelKey": "<wire key>",
  "aspectRatio": "<VIDEO_ASPECT_RATIO_LANDSCAPE|PORTRAIT>",
  "count": 1,
  "structuredPrompt": { "parts": [{ "text": "<prompt>" }] },
  "inputFrames": {
    "firstFrame": { "mediaId": "<id>", "cropCoordinates": { "top": 0, "left": 0, "bottom": 0, "right": 0 } },
    "lastFrame": null
  },
  "firstFrame": { "mediaId": "<id>", "cropCoordinates": { … } },
  "lastFrame": null,
  "referenceImages": [{ "mediaId": "<id>", "cropCoordinates": { … } }],
  "baseVideoId": "<id>"
}
```

Frame mode selects which keys are populated:

| mode | populated |
| --- | --- |
| `START_FRAME` | `firstFrame` |
| `START_END_FRAMES` | `firstFrame` + `lastFrame` |
| `REFERENCES` / `EXTEND_VIDEO` / `EDIT_VIDEO` | `referenceImages[]` |
| `TEXT` / `UPSAMPLE_VIDEO` | none |

**Frames are always references (`mediaId`), never raw image bytes.** That single fact is why
image-to-video cannot work from the app's OAuth token today.

### 6.2 Image upload (`/FlowService.UploadImage`, short id `maseQ`)

Request proto field numbers:

| field | meaning |
| --- | --- |
| 1 | context: project / collection / workflow |
| 2 | image bytes (base64) |
| 3 | mimeType |
| 4 | crop flag (default `true`) |
| 7 | crop coordinates |
| 8 | `isHidden` (default `false`) |
| 9 | fileName |
| 10 | dimensions `{ width, height }` |
| 11, 12, 14 | optional, unused by the UI |

Response field 1 is the created `Media` object — its id is the `mediaId` the generation call
needs.

### 6.3 Why an OAuth-only client cannot do image-to-video

* Every plausible REST upload path on `aisandbox-pa.googleapis.com` returns **404**
  (`/v1/media:upload`, `/v1/media:batchUpload`, `/v1/files:upload`,
  `/v1/flow/upload/image/*`, `/v1/upload:image`), while the known-good generation route
  returns **401**. The REST surface can *consume* a `mediaId` but has no way to *mint* one.
* The only upload path is the `batchexecute` RPC above, which the web client calls with
  **cookie auth** (`withCredentials` + `X-Framework-Xsrf-Token`) — a credential this desktop
  app does not hold.
* Video file upload is separate again: resumable Google upload at
  `/upload/v1/flow/upload/video/<projectId>`, also cookie-authenticated.

**Conclusion:** with an OAuth 2 Bearer token, Flow is **text-to-video only**. Full
image-to-video needs a logged-in Flow browser session. The app could obtain one by opening
its own `BrowserWindow` on `labs.google/fx/tools/flow` and reading the session cookies
(`SAPISIDHASH`) — that is a design decision, not a code detail, and is now implemented — see §7.

## 7. The cookie bridge (implementation)

`src/main/services/flowSession.ts` + `flowUpload.ts` implement the only route that can mint a
media id:

1. A hidden `BrowserWindow` (partition `persist:flow-bridge`, so the login survives restarts)
   loads `https://labs.google/fx/tools/flow`.
2. Per-session scalars are harvested from the live page instead of hardcoded — `eptZe` (RPC base
   path), `cfb2h` (build label), `FdrFJe` (`f.sid`). They are opaque ids that change between
   builds, so pinning them by name is how this kind of bridge rots.
3. Each call runs **inside the page** via `executeJavaScript`, so same-origin cookies, `Origin`
   and the framework XSRF token behave exactly as they do for the real client. No hand-rolled
   `SAPISIDHASH`, and no `at` token — this build does not use one (`xZbWve` turned out to be a
   reCAPTCHA site key, not an XSRF token).
4. `uploadImageToFlow()` sends `maseQ` with the positional field map from §6, then extracts the
   media id from the response.
5. Generation stays on the **OAuth REST** route
   (`/v1/video:batchAsyncGenerateVideoStartAndEndImage`) with `firstFrame: { mediaId }`. The split
   is deliberate: the REST surface can *consume* a media id but cannot *mint* one.

Login is lazy — the first image-to-video job opens the window, waits for Google, then continues
the job it was asked to do. `FLOW_DEBUG=1` dumps every RPC id, its HTTP status and the first 4 kB
of the raw response.

### Verified vs. not verified

Verified offline: the endpoint, the `f.req` envelope, the auth model, the `maseQ` field map, the
`Media`-id extraction, and that the whole chain typechecks and bundles.

Needs one live run: the per-session scalar harvest and the media-id position inside the upload
response. Run an image-to-video job with `FLOW_DEBUG=1`; the raw dump names the offending step
immediately.

